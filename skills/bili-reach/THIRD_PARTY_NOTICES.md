# 来源与第三方声明

bili-reach 的代码、skill 和文档使用 [MIT 许可证](<LICENSE>)。平台访问与字幕选路参考了下列项目；本项目重实现了轻量客户端及本地处理流程，不要求安装这些项目。为保留来源及相关许可声明，两份上游 MIT 许可证原文随 skill 一并分发。

## 发布时核对的参考快照

以下 commit 为 2026-11-11 发布时核对的来源快照，不表示本项目包含其整个代码库或已追平所有功能。

| 项目 | 固定来源与参考范围 | 许可 |
| --- | --- | --- |
| CZX2244/dsh-bilibili | [`c53af9dee30cf04ee759ac6857d5803196fb2a95`](https://github.com/CZX2244/dsh-bilibili/tree/c53af9dee30cf04ee759ac6857d5803196fb2a95)，参考 [`lib/extractor.js`](https://github.com/CZX2244/dsh-bilibili/blob/c53af9dee30cf04ee759ac6857d5803196fb2a95/lib/extractor.js) 的平台 API 获取流程 | [MIT 原文](<licenses/dsh-bilibili.MIT.txt>)，Copyright (c) 2026 CZX2244 |
| Panniantong/Agent-Reach | [`c70ae6da5d39bc90e09ad2ae0575ccc89f31e284`](https://github.com/Panniantong/Agent-Reach/tree/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284)，参考 [`agent_reach/channels/bilibili.py`](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/bilibili.py) 的来源识别与字幕优先思路 | [MIT 原文](<licenses/agent-reach.MIT.txt>)，Copyright (c) 2025 Agent Eyes |

本项目的平台客户端见 [platform.mjs](<scripts/platform.mjs>)；没有包含上游的云转写服务、完整插件或浏览器凭据提取逻辑。

## 外部工具与内容

Node.js、FFmpeg、whisper.cpp、DSH SDK 和识别模型均为外部运行环境或可选工具；本仓库不包含它们的二进制、模型权重或 SDK 源码。获取和使用这些工具时应分别遵守其许可证。

B站平台及视频、字幕、板书等内容的权利属于其各自权利人。本项目的 MIT 授权不授予对第三方课程内容的转载或再分发权；仓库仅包含代码、模板和虚构测试材料。
