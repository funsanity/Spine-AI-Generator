# Spine AI Generator

把一张 2D 立绘自动拆成部件、生成骨骼层级与网格权重，一键导出 **Cocos Creator / Unity (spine-unity) / Spine 编辑器** 各版本可直接使用的 Spine 资源。

---

## 简介（可直接用作仓库 About）

```
把一张 2D 立绘自动拆成部件、生成骨骼层级与网格权重，一键导出 Cocos Creator / Unity (spine-unity) / Spine 编辑器各版本可直接使用的 Spine 资源。
```

## 完整介绍

上传一张 2D 角色立绘，自动完成「拆部件 → 补遮挡 → 建骨骼 → 刷权重 → 出资源」全流程，
产出可直接导入引擎的 Spine 资源，外加一份能进 Spine 编辑器继续二次编辑的 `.spine` 工程。

### 支持的导出目标

| 目标 | 格式版本 | 导入方式 |
|---|---|---|
| **Cocos Creator 3.8.x** | Spine 3.8.75 | 内置 3.8 运行时；`.json` + `.atlas` + `.png` 三件套同名同目录 |
| **Unity (spine-unity)** | Spine 4.2.10 | 三件套一起拖进 `Assets` 下的同名文件夹，Unity 自动生成 `_SkeletonData` 资产 |
| **Spine 编辑器 4.0** | Spine 4.0.64 | 打开后可继续手工调整 |
| **Spine 编辑器 4.1** | Spine 4.1.23 | 打开后可继续手工调整 |
| **Spine 编辑器 4.2** | Spine 4.2.10 | 打开后可继续手工调整；Cocos Creator 3.8.4+ 也可用 4.2 运行时 |

**关于 Unity 为什么走 4.2 而不是 3.8**：Unity 没有内置 Spine 运行时，用的是官方 `spine-unity`
包，而这个包跟随 Spine 编辑器版本走、目前维护的是 4.x 线。发一份 3.8 的骨架过去，
`spine-unity` 要额外开兼容开关才读得进去；4.2 是它默认就吃下的版本，也是 Cocos Creator 3.8.6+
能切过去的那一档，两边都能用。

**三个目标互不覆盖**，各占一层目录：3.8 与 4.x 的骨架、图集格式互不兼容，平铺会互相覆盖 ——
重导 Cocos 时 Unity 那份原封不动。

### 它做了什么

| 步骤 | 手工做 | 这个工具 |
|---|---|---|
| 拆部件 | 抠图软件里一块块抠 | 视觉模型判断部件清单 + 像素级分割 |
| 定层级 | 逐个想谁是谁的父级 | 按遮挡关系自动推断 |
| 建骨骼 | 手动摆放、对旋转中心 | 从部件 bbox 和姿态推出 pivot |
| 做网格 | 沿接缝手动连线刷权重 | 栅格剖分 + 环带缝合，接缝共享权重 |
| 补遮挡 | 手工仿制图章补被压住的部分 | 图像生成模型按上下文补图 |
| 导出 | 逐个骨架/图集配置 | 一键出多目标格式 |

### 它不是什么

- **不是「一键出成品动画」。** 产出的是一个干净、可继续编辑的**工程起点**：部件分好了、
  层级建好了、权重刷好了，美术拿到手是接着调网格和 K 帧，而不是从空白开始。
- **质量取决于源图。** 角色立绘（部件边界清晰、遮挡关系明确）效果最好；部件互相穿插得很碎、
  或大量半透明的图，需要人工收尾。

### 运行方式

全部本地运行：**Node.js 20+**，无构建步骤，改完直接跑。AI 环节自己配 API Key，
图片不出本机磁盘。

---

## GitHub Topics 建议

```
spine   spine-animation   2d-animation   skeletal-animation   cocos-creator
unity   game-development  ai   claude   image-segmentation   mobile-sam
nodejs  texture-atlas     rigging       character-art
```

---

# English

A local tool that **splits a 2D illustration into parts, builds a skeleton, and exports a Spine
project** — automatically.

Upload an image → a vision model figures out which parts exist and what covers what → pixel-level
cutout → bone hierarchy is inferred → one click exports Spine assets for your target platform
(Cocos / Unity / Spine editor 4.0–4.2), plus a `.spine` project you can open directly in the editor.

## Export targets

| Target | Format version | How to import |
|---|---|---|
| **Cocos Creator 3.8.x** | Spine 3.8.75 | Built-in 3.8 runtime; `.json` + `.atlas` + `.png` with the same name in the same folder |
| **Unity (spine-unity)** | Spine 4.2.10 | Drag the three files into a same-named folder under `Assets`; Unity generates a `_SkeletonData` asset |
| **Spine editor 4.0** | Spine 4.0.64 | Open for further manual editing |
| **Spine editor 4.1** | Spine 4.1.23 | Open for further manual editing |
| **Spine editor 4.2** | Spine 4.2.10 | Open for further manual editing; Cocos Creator 3.8.4+ can also use the 4.2 runtime |

**Why Unity targets 4.2 rather than 3.8**: Unity has no built-in Spine runtime — it uses the
official `spine-unity` package, which tracks the Spine editor version and is maintained on the 4.x
line. A 3.8 skeleton needs an extra compatibility switch in `spine-unity`; 4.2 is what it reads out
of the box, and it's also the version Cocos Creator 3.8.6+ can switch to, so one export serves both.

**Targets never overwrite each other.** 3.8 and 4.x skeleton/atlas formats are incompatible, so each
target gets its own directory — re-exporting Cocos leaves Unity untouched.

## What it does

| Step | By hand | This tool |
|---|---|---|
| Split parts | Cut out each piece in an image editor | Vision model lists the parts + pixel-level segmentation |
| Order layers | Figure out each parent/child by hand | Inferred from occlusion relationships |
| Build bones | Place them and pick rotation centers manually | Pivot derived from each part's bbox and pose |
| Build meshes | Draw edges along seams and paint weights | Grid triangulation + annulus stitching, shared weights at seams |
| Fill occlusions | Clone-stamp the covered regions | Image generation model fills them from context |
| Export | Configure each skeleton/atlas by hand | One click, every target format |

## What it is not

- **Not "one click to a finished animation."** What you get is a clean, editable **project
  starting point** — parts split, hierarchy built, weights painted — so an artist starts by tweaking
  meshes and keyframes instead of from a blank canvas.
- **Quality depends on the source image.** Character illustrations with clear part boundaries and
  unambiguous occlusion work best; images with heavily interleaved parts or lots of semi-transparency
  need manual cleanup.

## Running it

Everything runs locally: **Node.js 20+**, no build step. Bring your own API key for the AI stages;
images never leave your disk.
