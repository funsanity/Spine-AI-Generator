# Spine AI Generator - Web 服务

基于 AI 的 Spine 骨骼自动生成工具，美术和策划开箱即用。

## 功能特性

- 🤖 **AI 驱动** - 上传图片 + 提示词，自动分析部件结构
- 🦴 **自动生成骨骼** - 智能推断骨骼层级关系
- 👁️ **可视化预览** - 实时查看生成的骨骼结构
- 📦 **一键导出** - 生成标准 Spine JSON 工程文件
- 🔌 **可换接入点** - 直连 Anthropic 官方，或接自建网关/中转服务

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API（可选）

复制配置文件模板：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 API 配置：

```
ANTHROPIC_BASE_URL=            # 留空 = 直连 Anthropic 官方
ANTHROPIC_API_KEY=your_api_key_here
```

**注意**：也可以直接在网页界面配置，不需要 .env 文件。

### 3. 启动服务

```bash
npm run web
```

服务启动后，浏览器访问：**http://localhost:3000**

## 使用流程

### 步骤 1：上传图片

点击上传区域，选择角色/部件图片（支持 PNG、JPG）。

### 步骤 2：输入提示词

描述部件的结构和层级关系，例如：

```
这是一个机械手臂，需要分成三个部件：
- 上臂（根部件）
- 前臂（连接上臂）
- 手掌（连接前臂）
上臂的旋转中心在顶部，前臂在肘部，手掌在腕部。
```

### 步骤 3：配置 API

**接入点**：

- **API Key**: 你的 API Key（`.env` 里填过就不用在这儿再填）
- **Base URL**: 留空走 Anthropic 官方；用自建网关/中转服务就填它给你的地址

表单里显示的默认值来自 `config/api-defaults.json`，换服务商只改那一个文件。

### 步骤 4：生成骨骼

点击"🚀 生成骨骼"按钮，等待 AI 分析（通常 5-15 秒）。

### 步骤 5：预览和调整

- 右侧预览区显示骨骼层级结构
- 查看骨骼数量和槽位统计
- 确认结构正确

### 步骤 6：导出工程

点击"📦 导出 Spine 工程"，文件将保存到指定目录。

## 输出文件

导出后会生成以下文件结构：

```
output/
├── generated.json        # Spine 骨架文件
└── images/              # 图片目录（需手动放入分层图片）
```

## 后续步骤

1. **拆分图片** - 使用 Photoshop 等工具将原图按部件拆分成透明 PNG
2. **放入 images 目录** - 文件名与生成的部件名对应
3. **导入 Spine** - 在 Spine 编辑器中打开 `.json` 文件
4. **调整和绑定** - 微调骨骼位置，设置权重

## 提示词技巧

四类内置模板（角色 / 道具 / 特效 / 物品）在 `config/prompt-templates.json`，界面上点
「2. 提示词」旁的**设置**按钮可改。模板内容和一组实测参数见根目录
[README](../../README.md#内置模板) 的「内置模板」「一组实测参数」两节。

要点：

- ✅ 说清有哪些部件、谁是谁的父级、旋转中心在哪
- ✅ 被遮住的部件要框进 bbox（补图会把没露出来的部分还原出来）
- ❌ 不要只说"分成几段"而不描述结构
- ❌ 不要描述画面内容（"一个生气的女人"）——模型需要的是结构

## 常见问题

### Q: API Key 是什么？

A: 需要一把 Anthropic API Key，或者任意兼容 Anthropic 协议的网关/中转服务地址与 Key。

### Q: 可以离线使用吗？

A: 不行，需要联网调用 AI 服务进行图像分析。

### Q: 生成的骨骼不准确怎么办？

A: 尝试优化提示词，更详细地描述部件结构和层级关系。

### Q: 能直接在 Spine 里打开吗？

A: 生成的是 JSON 格式骨架，需要先手动拆分图片并放入 `images/` 目录，然后在 Spine 中导入。

### Q: 支持哪些图片格式？

A: PNG 和 JPG，推荐使用透明背景的 PNG。

## 技术架构

```
┌─────────────┐
│   前端界面   │ (HTML + Canvas)
└──────┬──────┘
       │ HTTP POST
┌──────▼──────┐
│ Express 服务 │
└──────┬──────┘
       │
   ┌───▼───┐
   │  AI   │ (Anthropic 官方 / 自建网关)
   └───┬───┘
       │
┌──────▼──────┐
│ 骨骼生成器   │
└──────┬──────┘
       │
┌──────▼──────┐
│ Spine JSON  │
└─────────────┘
```

## 开发命令

```bash
# 安装依赖
npm install

# 启动 Web 服务
npm run web

# 运行测试
npm test

# CLI 工具（原有功能）
node bin/spine-tool.js doctor
node bin/spine-tool.js inspect <file>
node bin/spine-tool.js roundtrip --project <file> --execute
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `ANTHROPIC_BASE_URL` | 自建网关/中转服务地址，留空直连 Anthropic 官方 | - |
| `ANTHROPIC_API_KEY` | API Key | - |
| `OUTPUT_DIR` | 默认输出目录 | ./output |

## 许可证

见仓库根目录的 [LICENSE](../../LICENSE)（Apache-2.0）。
