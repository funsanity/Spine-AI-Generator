#!/usr/bin/env python3
# SAM 3 常驻 worker（文本提示分割）。
#
# 和 worker.py（MobileSAM）**协议完全一致**：stdin 一行一个 JSON 请求，
# stdout 一行一个 JSON 响应。这么设计是为了让 client 那侧的失败路径处理
# （就绪信号、崩溃拒绝 pending、空闲超时）能原样复用一套逻辑。
#
# 为什么是文本提示而不是框提示：
#   MobileSAM 只吃 bbox，而 bbox 是矩形，框里几乎总是装着好几件东西。
#   SAM 会挑「框里最主要的那件」—— 实测眼镜的框里它挑中了整张脸
#   （覆盖率 77.3%，密实地盖错了地方，覆盖率兜底抓不到）。
#   换文本提示就绕开了：给 "glasses" 它返回眼镜，给 "eye" 它返回眼睛，
#   压根不需要框。
#
# dtype 必须是 bf16，不能用 fp16：
#   MPS 上 fp16 会挂在 slow_conv2d —— 报错长这样：
#     slow_conv2d_forward_mps: input(device='cpu') and weight(device='mps:0')
#     must be on the same device
#   看着像设备不匹配（会让人去查 .to('mps')），实际是 MPS 缺 fp16 卷积算子。
#   bf16 算子覆盖完整，实测可用。
#
# 请求：
#   {"id":1,"cmd":"ping"}
#   {"id":2,"cmd":"encode","image":"/abs/path.png"}
#   {"id":3,"cmd":"segment","image":"...","parts":[{"name":"glasses","box":[x0,y0,x1,y1]}]}
#
# 响应：
#   {"id":1,"ok":true,"pong":true,"device":"mps"}
#   {"id":2,"ok":true,"encodeSec":0.05}
#   {"id":3,"ok":true,"masks":[{"name":"glasses","png":"<base64>","width":298,"height":838,
#                               "area":1291,"score":0.91,"coverage":0.62,"presence":6.38}]}

import base64
import io
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np
from PIL import Image

# alpha 低于此值算透明。与 server/api/cutter.js 的 ALPHA_CUTOFF 保持一致，
# 也和 worker.py 保持一致 —— 三处对「不透明」的判定必须同步，否则覆盖率
# 算出来和切图看到的不是一回事。
ALPHA_CUTOFF = 8

# 命中阈值。实测正常命中在 0.73~0.97，用词不对时 presence_logits 会明显为负，
# 0.5 这个门槛在两张测试图上都没有误报也没有漏报。
SCORE_THRESHOLD = 0.5
# 掩码二值化阈值，post_process 内部用的
MASK_THRESHOLD = 0.5


class Sam3Worker:
    def __init__(self, model_dir, device=None):
        self.model_dir = Path(model_dir)
        self.device_req = device
        self.device = None
        self.model = None
        self.processor = None
        self.torch = None
        # 编码缓存：同一张图切 N 个部件只编码一次
        self.encoded_key = None
        self.opaque = None
        self.image_hw = None

    def load(self):
        import torch
        from transformers import Sam3Model, Sam3Processor

        self.torch = torch
        if self.device_req:
            self.device = self.device_req
        else:
            self.device = 'mps' if torch.backends.mps.is_available() else 'cpu'

        t0 = time.perf_counter()
        # bf16：见文件头的说明，fp16 在 MPS 上跑不起来
        dtype = torch.bfloat16 if self.device == 'mps' else torch.float32
        self.dtype = dtype
        self.model = Sam3Model.from_pretrained(
            str(self.model_dir), dtype=dtype, low_cpu_mem_usage=True
        )
        self.model = self.model.to(self.device).eval()
        self.processor = Sam3Processor.from_pretrained(str(self.model_dir))
        self.load_sec = time.perf_counter() - t0
        return self.load_sec

    def _to_device(self, batch):
        torch = self.torch
        out = {}
        for k, v in batch.items():
            if torch.is_tensor(v):
                v = v.to(self.device)
                if torch.is_floating_point(v):
                    v = v.to(self.dtype)
            out[k] = v
        return out

    def _fingerprint(self, image_path):
        """图片指纹 = 路径 + 大小 + mtime。与 worker.py 用同一套判据。"""
        st = Path(image_path).stat()
        return f'{image_path}:{st.st_size}:{st.st_mtime_ns}'

    def encode(self, image_path):
        key = self._fingerprint(image_path)
        if key == self.encoded_key:
            return 0.0, True

        src = Image.open(image_path)
        # 透明底要换掉：模型看到棋盘格或纯黑会把它当内容。
        # 换成白底和训练分布更接近，实测两张图都正常。
        rgba = src.convert('RGBA')
        alpha = np.array(rgba)[:, :, 3]
        self.opaque = alpha >= ALPHA_CUTOFF
        bg = Image.new('RGB', rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        self.image = bg
        self.image_hw = (bg.size[1], bg.size[0])   # (H, W)

        t0 = time.perf_counter()
        if self.device == 'mps':
            self.torch.mps.synchronize()
        self.encoded_key = key
        self.encode_sec = time.perf_counter() - t0
        return self.encode_sec, False

    def segment(self, image_path, parts):
        if self.model is None:
            raise RuntimeError('模型未加载')
        torch = self.torch
        self.encode(image_path)
        H, W = self.image_hw

        out = []
        for part in parts:
            name = part.get('name')
            if not name:
                out.append({'name': name, 'error': 'name 缺失'})
                continue
            # 提示词就是部件名本身。
            #
            # 试过让调用方另给一个 hint（"left arm" 之类），实测反而更差：
            # arm→"left arm" 分数 0.81→0.75，person→"torso" 直接 0 命中。
            # 方位词会改变模型对类别的判断，不如就用名字，多实例的选择
            # 交给下面的 bbox 就近规则。
            prompt = str(name).replace('_', ' ').strip()

            try:
                t0 = time.perf_counter()
                batch = self._to_device(
                    self.processor(images=self.image, text=prompt, return_tensors='pt')
                )
                with torch.no_grad():
                    raw = self.model(**batch)
                if self.device == 'mps':
                    torch.mps.synchronize()
                infer_sec = time.perf_counter() - t0

                presence = float(
                    raw.presence_logits.float().cpu().numpy().reshape(-1)[0]
                )
                # post_process 把 288x288 的低分辨率 mask 还原到源图尺寸，
                # 所以下面不用再缩放，decodeMask 走的是精确分支
                res = self.processor.post_process_instance_segmentation(
                    raw, threshold=SCORE_THRESHOLD,
                    mask_threshold=MASK_THRESHOLD,
                    target_sizes=[self.image.size[::-1]]
                )
                res = res[0] if isinstance(res, list) else res
                scores = res['scores'].float().cpu().numpy()
                masks = res['masks'].cpu().numpy()
                boxes = res['boxes'].float().cpu().numpy()

                keep = [i for i in range(len(scores)) if scores[i] > SCORE_THRESHOLD]
                if not keep:
                    # 没命中不是错误：图里可能真的没有这件东西。
                    # presence_logits 是模型自己的"有没有"判断，带回去让调用方区分
                    # 「不存在」和「存在但没切出来」。
                    out.append({
                        'name': name, 'empty': True, 'presence': round(presence, 3),
                        'inferSec': round(infer_sec, 3),
                        'reason': f'"{prompt}" 无命中（presence={presence:+.2f}）'
                    })
                    continue

                # 一次提示可能返回多个实例（比如 "eye" 返回左右眼、"arm" 返回双臂）。
                # 用 bbox 就近挑属于这个部件的那一个 —— 这是**选择**，不是提示，
                # 所以不受前面"方位词反而更差"的影响。
                pick = self._pick_instance(keep, boxes, masks, part.get('box'))

                mask = masks[pick].astype(bool)
                area = int(mask.sum())
                cov = self._coverage(mask, part.get('box'))

                buf = io.BytesIO()
                Image.fromarray((mask * 255).astype(np.uint8)).save(
                    buf, format='PNG', optimize=True
                )
                out.append({
                    'name': name,
                    'png': base64.b64encode(buf.getvalue()).decode('ascii'),
                    'width': int(W), 'height': int(H),
                    'area': area,
                    'score': float(scores[pick]),
                    'coverage': round(float(cov), 4),
                    'presence': round(presence, 3),
                    'candidates': len(keep),
                    'inferSec': round(infer_sec, 3),
                    'decodeSec': round(infer_sec, 3),
                })
            except Exception as e:
                out.append({
                    'name': name, 'error': f'{type(e).__name__}: {e}',
                    'trace': traceback.format_exc()
                })
        return out

    def _pick_instance(self, keep, boxes, masks, box):
        """
        多个候选里挑一个。判据优先级：

          1. 有 bbox 就选与 bbox 交集最大的 —— 这个部件在哪块区域是已知的
          2. 没有 bbox 就选面积最大的

        为什么不用分数最高的：同一个词的两个实例分数往往非常接近
        （实测左右眼 0.906 / 0.910），按分数挑等于抛硬币。
        """
        if not box or len(box) != 4:
            return max(keep, key=lambda i: int(masks[i].sum()))

        x0, y0, x1, y1 = [float(v) for v in box]

        def iou_like(i):
            bx0, by0, bx1, by1 = boxes[i]
            ix0, iy0 = max(x0, bx0), max(y0, by0)
            ix1, iy1 = min(x1, bx1), min(y1, by1)
            if ix1 <= ix0 or iy1 <= iy0:
                return -1.0
            inter = (ix1 - ix0) * (iy1 - iy0)
            union = (x1 - x0) * (y1 - y0) + (bx1 - bx0) * (by1 - by0) - inter
            return inter / union if union > 0 else -1.0

        return max(keep, key=iou_like)

    def _coverage(self, mask, box):
        """
        掩码盖住了框内不透明像素的多少。分母只取框内、且只取不透明处 ——
        和 worker.py 完全一致，两边算出来的数才可比。

        注意这个指标治不了「盖错了东西」：眼镜切成整张脸时覆盖率高达 77.3%。
        它只能识别「基本什么都没找到」。真正的质量信号是 score 和 presence。
        """
        if self.opaque is None:
            return 1.0
        H, W = self.opaque.shape
        if not box or len(box) != 4:
            sub = self.opaque
            m = mask
        else:
            x0 = max(0, min(W, int(box[0]))); y0 = max(0, min(H, int(box[1])))
            x1 = max(x0, min(W, int(box[2]))); y1 = max(y0, min(H, int(box[3])))
            sub = self.opaque[y0:y1, x0:x1]
            m = mask[y0:y1, x0:x1]
        denom = int(sub.sum())
        if denom <= 0:
            return 1.0
        return int((m & sub).sum()) / denom


def main():
    if len(sys.argv) < 2:
        print('用法: worker_sam3.py <模型目录> [device]', file=sys.stderr)
        return 2
    model_dir = sys.argv[1]
    device = sys.argv[2] if len(sys.argv) > 2 else None

    w = Sam3Worker(model_dir, device)
    try:
        load_sec = w.load()
    except Exception as e:
        # 加载失败要让父进程立刻知道，别让它在那儿等超时
        print(json.dumps({
            'id': 0, 'ok': False, 'fatal': True,
            'error': f'模型加载失败: {e}',
            'trace': traceback.format_exc()
        }), flush=True)
        return 1

    print(json.dumps({
        'id': 0, 'ok': True, 'ready': True,
        'device': w.device, 'dtype': str(w.dtype), 'loadSec': round(load_sec, 3)
    }), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({'id': None, 'ok': False, 'error': f'JSON 解析失败: {e}'}),
                  flush=True)
            continue

        rid = req.get('id')
        cmd = req.get('cmd')
        try:
            if cmd == 'ping':
                resp = {'pong': True, 'device': w.device}
            elif cmd == 'encode':
                sec, cached = w.encode(req['image'])
                resp = {'encodeSec': round(sec, 4), 'cached': cached}
            elif cmd == 'segment':
                resp = {'masks': w.segment(req['image'], req.get('parts') or [])}
            elif cmd == 'shutdown':
                print(json.dumps({'id': rid, 'ok': True}), flush=True)
                return 0
            else:
                print(json.dumps({'id': rid, 'ok': False,
                                  'error': f'未知命令 {cmd}'}), flush=True)
                continue
            print(json.dumps({'id': rid, 'ok': True, **resp}), flush=True)
        except Exception as e:
            print(json.dumps({
                'id': rid, 'ok': False, 'error': str(e),
                'trace': traceback.format_exc()
            }), flush=True)

    return 0


if __name__ == '__main__':
    sys.exit(main())
