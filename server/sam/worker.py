#!/usr/bin/env python3
# MobileSAM 常驻 worker。
#
# 为什么是常驻而不是每次调一次进程：
#   SAM 的耗时结构是「编码贵（首次含图编译 0.4s）、解码便宜（10~25ms）」。
#   每次生成都新起进程的话，光 import torch + 加载权重 + 首次编码就要 2.07s。
#   常驻之后，编码结果按图缓存，第二次开始每张图只剩 0.08s 编码 + 每部件
#   十几毫秒解码。
#
# 通信协议：stdin 收一行一个 JSON 请求，stdout 回一行一个 JSON 响应。
# 选行分隔 JSON 而不是 HTTP：不用端口、不用处理端口占用、父进程一死
# worker 自然收到 EOF 退出，不需要额外的清理逻辑。
#
# 请求：
#   {"id":1,"cmd":"ping"}
#   {"id":2,"cmd":"encode","image":"/abs/path.png"}
#   {"id":3,"cmd":"segment","image":"...","parts":[{"name":"tomato","box":[x0,y0,x1,y1]}]}
#
# 响应：
#   {"id":1,"ok":true,"pong":true,"device":"mps"}
#   {"id":2,"ok":true,"encodeSec":0.08}
#   {"id":3,"ok":true,"masks":[{"name":"tomato","png":"<base64>","width":300,"height":300,
#                               "area":7720,"score":0.96}]}
#
# 掩码用 base64 PNG（灰度，255=属于该部件，0=不属于）而不是原始位图：
# 一张 300x300 的原始掩码 90KB，PNG 后通常几 KB，行长度小一个量级。

import base64
import io
import json
import sys
import time
import traceback
from pathlib import Path

import numpy as np
from PIL import Image

# alpha 低于此值算透明。与 server/api/cutter.js 的 ALPHA_CUTOFF 保持一致，
# 两边对「不透明」的判定必须同步，否则覆盖率算出来和切图看到的不是一回事。
ALPHA_CUTOFF = 8


class Worker:
    def __init__(self, weights, repo_dir, device=None):
        self.weights = Path(weights)
        self.repo_dir = Path(repo_dir)
        self.device = device
        self.predictor = None
        self.sam = None
        self.device_name = None
        # 编码缓存：图片指纹 -> 已编码状态。同一张图切 20 个部件只编码一次。
        self.encoded_key = None
        self.encoded_sec = None
        # 源图不透明区域，算掩码覆盖率的分母。与编码缓存同生命周期
        self.opaque = None

    def load(self):
        sys.path.insert(0, str(self.repo_dir))
        import torch
        from mobile_sam import sam_model_registry, SamPredictor

        self.torch = torch

        if self.device is None:
            self.device_name = 'mps' if torch.backends.mps.is_available() else 'cpu'
        elif self.device == 'mps' and not torch.backends.mps.is_available():
            self.device_name = 'cpu'
        else:
            self.device_name = self.device

        t0 = time.perf_counter()
        sam = sam_model_registry['vit_t'](checkpoint=str(self.weights))
        sam.eval()
        sam.to(self.device_name)
        self.load_sec = time.perf_counter() - t0
        self.sam = sam
        self.predictor = SamPredictor(sam)
        return self.load_sec

    def _fingerprint(self, image_path):
        """图片指纹 = 路径 + 大小 + mtime。

        不用文件内容哈希：几十 MB 的图每次读一遍算哈希，比编码本身还慢。
        mtime 变了说明文件被改过，足够可靠。
        """
        st = Path(image_path).stat()
        return f'{image_path}:{st.st_size}:{st.st_mtime_ns}'

    def encode(self, image_path):
        key = self._fingerprint(image_path)
        if key == self.encoded_key:
            return 0.0, True   # 缓存命中，0 开销

        src = Image.open(image_path)
        img = np.array(src.convert('RGB'))
        # 顺手记下不透明区域：判断掩码是否「几乎什么都没找到」要用它当分母。
        # 跟编码一起算，每张图一次，不额外读盘。
        self.opaque = np.array(src.convert('RGBA'))[:, :, 3] >= ALPHA_CUTOFF
        self.torch.mps.synchronize() if self.device_name == 'mps' else None
        t0 = time.perf_counter()
        self.predictor.set_image(img)
        if self.device_name == 'mps':
            self.torch.mps.synchronize()
        sec = time.perf_counter() - t0
        self.encoded_key = key
        self.encoded_sec = sec
        self.image_hw = img.shape[:2]
        return sec, False

    def segment(self, image_path, parts):
        if not self.sam:
            raise RuntimeError('模型未加载')
        self.encode(image_path)
        H, W = self.image_hw

        out = []
        for part in parts:
            box = part.get('box')
            if not box or len(box) != 4:
                out.append({'name': part.get('name'), 'error': 'box 缺失或格式不对'})
                continue
            x0, y0, x1, y1 = [float(v) for v in box]
            # 夹到图内，SAM 拿到越界坐标会退化
            x0 = max(0.0, min(W - 1.0, x0))
            y0 = max(0.0, min(H - 1.0, y0))
            x1 = max(x0 + 1.0, min(float(W), x1))
            y1 = max(y0 + 1.0, min(float(H), y1))

            box_arr = np.array([x0, y0, x1, y1])
            if self.device_name == 'mps':
                self.torch.mps.synchronize()
            t0 = time.perf_counter()
            masks, scores, _ = self.predictor.predict(
                box=box_arr[None, :], multimask_output=True)
            if self.device_name == 'mps':
                self.torch.mps.synchronize()
            dec = time.perf_counter() - t0

            best = int(np.argmax(scores))
            # 只保留最大连通块：SAM 偶尔会在框角带出几个像素的碎屑，
            # 实测番茄掩码 7720px 里 19px 是这种噪点，砍掉更干净。
            mask = _largest_component(masks[best])
            cov = _coverage(mask, self.opaque, int(x0), int(y0), int(x1), int(y1))

            buf = io.BytesIO()
            Image.fromarray((mask * 255).astype(np.uint8)).save(buf, format='PNG', optimize=True)
            out.append({
                'name': part.get('name'),
                'png': base64.b64encode(buf.getvalue()).decode('ascii'),
                'width': int(W),
                'height': int(H),
                'area': int(mask.sum()),
                'score': float(scores[best]),
                # 掩码盖住了框内多少不透明像素。调用方用它判断这次分割是不是
                # 基本失败了（见 server/sam/segment.mjs 的 MIN_COVERAGE）
                'coverage': round(float(cov), 4),
                'decodeSec': round(dec, 4)
            })
        return out


def _coverage(mask, opaque, x0, y0, x1, y1):
    """掩码盖住了框内不透明像素的多少。

    分母只取框内，且只取不透明处：框外的东西本来就不该算，
    透明背景也不该算——否则细长部件的分母里塞满空白，覆盖率永远很低。

    这个数是用来识别「SAM 基本没找到东西」的。实测 9 个部件：
    正常的落在 22%~80%，而彻底失败的 left_arm 只有 5.4%，区分得很干脆。
    """
    if opaque is None:
        return 1.0
    sub_op = opaque[y0:y1, x0:x1]
    denom = int(sub_op.sum())
    if denom <= 0:
        return 1.0
    inter = int((mask[y0:y1, x0:x1] & sub_op).sum())
    return inter / denom


def _largest_component(mask):
    """8 邻域取最大连通块。纯 numpy 实现的洪水填充比 cv2 慢，
    但掩码只有几十万像素，实测毫秒级，不值得为此多引一个依赖。"""
    if not mask.any():
        return mask
    H, W = mask.shape
    lab = np.zeros((H, W), np.int32)
    best_id, best_size = 0, 0
    cur = 0
    for sy in range(H):
        row = mask[sy]
        for sx in range(W):
            if not row[sx] or lab[sy, sx]:
                continue
            cur += 1
            size = 0
            stack = [(sy, sx)]
            lab[sy, sx] = cur
            while stack:
                y, x = stack.pop()
                size += 1
                for dy in (-1, 0, 1):
                    ny = y + dy
                    if ny < 0 or ny >= H:
                        continue
                    for dx in (-1, 0, 1):
                        nx = x + dx
                        if nx < 0 or nx >= W:
                            continue
                        if mask[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = cur
                            stack.append((ny, nx))
            if size > best_size:
                best_size, best_id = size, cur
    return lab == best_id


def main():
    if len(sys.argv) < 3:
        print('用法: worker.py <权重的绝对路径> <MobileSAM 仓库的绝对路径> [device]',
              file=sys.stderr)
        return 2

    weights = sys.argv[1]
    repo = sys.argv[2]
    device = sys.argv[3] if len(sys.argv) > 3 else None

    w = Worker(weights, repo, device)
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

    # 就绪信号：父进程靠它判断"可以发请求了"，而不是盲目 sleep
    print(json.dumps({
        'id': 0, 'ok': True, 'ready': True,
        'device': w.device_name, 'loadSec': round(load_sec, 3)
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
                resp = {'pong': True, 'device': w.device_name}
            elif cmd == 'encode':
                sec, cached = w.encode(req['image'])
                resp = {'encodeSec': round(sec, 4), 'cached': cached}
            elif cmd == 'segment':
                resp = {'masks': w.segment(req['image'], req.get('parts') or [])}
            elif cmd == 'shutdown':
                print(json.dumps({'id': rid, 'ok': True}), flush=True)
                return 0
            else:
                resp = None
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
