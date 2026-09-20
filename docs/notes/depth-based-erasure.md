# 深度排序擦除方案

## 问题

原方案让 AI 逐对声明 `occludes: ["部件A", "部件B"]`，再靠共享面积比例阈值判断是否执行擦除。两个根本缺陷：

1. **逐对声明会成环**：AI 实测输出 `A occludes B` 和 `B occludes A`，成环后两个部件互相擦除，双双消失（围裙 0%、身体 6%）
2. **面积阈值区分不了两件事**：篮筐前后层（同一物体深度切片）和围裙+裙子（两个物体矩形相交）的 bbox 面积比长得一样，调到 0.95 仍有部件被擦空

## 新方案：全局深度序号

让 AI 给每个部件标注一个整数 `depth`：

- 0 = 最靠后（篮筐后景、躯干、背景）
- 每往外一层 +1：水果 1、篮筐前层 2
- 同层部件用相同数字（西瓜和西红柿都是 1）

切图时单向规则：**擦掉所有 depth 比自己大、且 bbox 与自己相交的部件的不透明像素**。

## 为什么能解决问题

1. **天然无环**："比我靠前的"是一个全序，不存在互相擦
2. **判据简单可靠**：只看数字大小，不依赖面积启发式猜测

## 实现改动

### 1. `server/ai/claude.js` — Prompt

```diff
-7. **声明 occludes —— 这个部件盖住了哪些部件**
-   occludes 列出「被本部件遮挡、且其可见像素落在本部件绘制范围内」的部件名
-   篮筐前景层盖住水果 → basket_front 的 occludes = ["watermelon", "tomato"]
+8. **声明 depth —— 这个部件在深度排序里的位置（最重要的一条）**
+   depth 是一个整数，表示"离镜头多近"，越小越靠后、越大越靠前。
+   - 最里层（篮筐后景、躯干、背景）= 0
+   - 每往外一层 +1：水果 1，篮筐前层 2
+   - 同一层的部件用**相同的数字**
+   - 数字必须从 0 开始连续
```

新增 `validateDepths(parts)` 做规范化：

- 缺失值补 0
- 跳号压紧（0,1,5 → 0,1,2）
- 全同值时按 bbox 面积兜底排序（面积大的 depth 小，通常是被装在里面的后景）

### 2. `server/api/cutter.js` — 擦除逻辑

```diff
-const occludersByPart = new Map();
-for (const part of parts) {
-  const declared = (part.occludes ?? [])
-    .map(n => byName.get(n))
-    .filter(o => overlaps(part.bbox, o.bbox));
-  const keep = declared.filter(occ => sharedAreaRatio(occ.bbox, part.bbox) >= SHARED_AREA_MIN);
-  occludersByPart.set(part.name, keep);
-}
+const depthOf = new Map(parts.map(p => [p.name, p.depth ?? 0]));
+const frontOf = new Map();
+for (const part of parts) {
+  const myDepth = depthOf.get(part.name);
+  const ahead = parts.filter(o =>
+    o !== part &&
+    depthOf.get(o.name) > myDepth &&
+    overlaps(part.bbox, o.bbox));
+  frontOf.set(part.name, ahead);
+}
```

擦除循环：

```javascript
const ahead = frontOf.get(name) ?? [];
if (ahead.length) {
  for (const occ of ahead) {
    // 遍历 occ.bbox 与本部件切图的交集，擦掉 occ 的不透明像素
  }
}
```

## 测试结果

### 篮筐图（12.png）

生成 6 个部件，4 层深度：

```
basket_back (depth=0) → basket_handle (depth=1) → watermelon/tomato/paper_wrapped (depth=2) → basket_front (depth=3)
```

擦除量：

- `basket_back` 擦除 31486px（前方所有部件）→ 填充率 0.3%（只剩底圈边缘）
- `basket_front` 不擦除（最前）→ 填充率 69.4%（干净的前圈）
- `tomato` 擦除 5330px（basket_front）→ 填充率 58.5%（完整西红柿，底部留白等补图）

**效果**：每张图只留自己，无混入部件，无过度擦除。

### 角色图（test_role_arbg.png）

生成 14 个部件，5 层深度。填充率对比：

| 部件 | 旧方案（占比阈值） | 深度排序 |
|---|---|---|
| glasses | 0%（被擦空） | 100% |
| left_arm | 0%（被擦空） | 62.7% |
| apron | 42.5%（过度擦除） | 96.6% |
| body | 90.3%（未擦除） | 31.3%（正确擦除前方） |

**效果**：无部件被擦空，该擦的擦了，不该擦的保留。

### 补图配合（深度擦除的第二个坑）

擦除之后要补图把挖掉的地方填回来。补图模块靠「透明区连不连到图边」区分两类区域：

- 连到图边 → bbox 外扩的 padding，保持透明（否则部件变成实心矩形）
- 连不到边 → 被内容围住的内部孔洞，填实

深度擦除造出了**第三种**区域：被前方部件挖掉的一大片。它按定义连到图边，却正是最该填的地方。结果补图报告"补了 99%"，落盘却只有 0.8% 不透明——模型补出来的内容被整片丢弃。

#### 修法 1：擦除掩码（`.erased.png`）

`cutter.js` 在擦除时记下哪些像素被挖掉，写成 `.erased.png` 存在切图旁边。

`inpaint.js` 读这张掩码，在算 `exterior` 时豁免这些像素：

```javascript
const exterior = markExteriorGap(base.data, width, height);
if (erased) {
  for (let i = 0; i < width * height; i++) {
    if (erased[i]) exterior[i] = 0;  // 擦除区不当外部留白，允许填实
  }
}
```

修完 basket_back 从 0.8% 恢复到完整篮筐。

#### 修法 2：洋红斜纹占位符

擦除区送给模型前会被 `bleedAlpha` 摊平到"周围边缘色"。如果邻接的是棕色编织纹理，整片擦除区就被染成棕色——模型看图以为"这里本来就有内容"，于是不补形状、只顺着涂一片同色。实测 tomato 补成暗红块、watermelon 补成棕块。

改成在擦除区盖**洋红/白斜纹**：

```javascript
const STRIPE = 10;
const on = (((x + y) / STRIPE) | 0) % 2 === 0;
// 洋红 (255,0,255) / 白 (255,255,255) 交替
```

洋红在自然图里不可能出现，模型不会误认成内容，只能当作"这里的形状要靠我推出来"的信号。配合 prompt 里的显式说明：

```
The magenta/white striped areas are NOT part of the artwork — they are placeholder
markers showing where this object was covered by parts in front of it and is now
missing. Replace every striped pixel with the object's own content: continue its
silhouette, outline and internal texture across the gap so the shape closes naturally.
A round object must stay round, a woven basket must keep its weave.
```

（先用中性灰棋盘试过，模型把灰白当成内容的一部分，顺着涂了同色。）

## 文件清单

- `server/ai/claude.js` — `ANALYSIS_PROMPT` 用 depth 替代 occludes；新增 `validateDepths()`
- `server/api/cutter.js` — `frontOf` 表替代面积阈值判据；擦除时写 `.erased.png`
- `server/api/inpaint.js` — 读 `.erased.png` 豁免擦除区；送模型前盖洋红斜纹
- `docs/depth-based-erasure.md` — 本文档

