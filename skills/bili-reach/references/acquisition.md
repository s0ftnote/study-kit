# 采集分支

需要本地转写、登录、截图、重取、媒体保留或处理采集错误时，只读对应部分。将 `<skill目录>` 替换为当前 SKILL.md 所在目录的绝对路径；沿用本次已授权的来源、分 P 和私有输出根。

BV 和分 P 已明确时直接 `collect`；需要选集或核对不明确的来源时才用 `inspect`：

```sh
node '<skill目录>/scripts/bili-reach.mjs' inspect '<BV或URL>' --part '<P>'
```

## 本地转写与只取字幕

1. **按需检查环境。** 正常采集由脚本预检本次所需工具；需要排查环境时再用 `doctor`，已有模型路径时一并检查。它不联网、不推理，`ok: true` 仅表示检查完成，要逐项看 `available`；`null` 表示超时或探测不确定。只取平台字幕不要求 FFmpeg 或模型。**完成标准：**区分已就绪、缺项与未确认，缺模型不阻断有字幕的路径。
2. **选策略。** 默认 `--asr local`：明确无字幕时才用本地 whisper.cpp，工具和模型由用户准备。只接受平台字幕就设 `--asr none`。**完成标准：**策略与模型路径明确，本地缺项已告知用户。

```sh
node '<skill目录>/scripts/bili-reach.mjs' doctor --model '<私有模型路径>'
node '<skill目录>/scripts/bili-reach.mjs' collect '<BV或URL>' --part '<P>' --output '<私有材料目录>' --asr local --model '<私有模型路径>' --language zh --glossary '术语1,术语2'
# 仅平台字幕，不要求本地模型：
node '<skill目录>/scripts/bili-reach.mjs' collect '<BV或URL>' --part '<P>' --output '<私有材料目录>' --asr none
```

`--glossary` 为本地 ASR 提供术语提示。平台字幕沿用原文并记录来源；数字、公式等疑点结合画面核对。

## 登录与私有配置

在采集命令追加 `--cookie-file '<私有Cookie文件>'`；Cookie 文件接受纯请求头或 Netscape 格式，不接受浏览器数据库。agent 只传文件路径，不读取并展示凭据，也不自动提取浏览器登录态。

路径、模型、术语和工具位置可通过 `--config '<私有JSON配置>'` 提供，命令行选项优先。字段见随附[配置示例](<../assets/config.example.json>)，完整选项见 CLI `--help`。

**完成标准：**用户自行提供所需访问权限与私有文件，采集仅使用路径；没有登录态或无权访问就停止，不将其归类为无字幕。

## 独立截图或取稿附图

仅需截图就用 `frames`，不先取稿；该任务不请求字幕、不做 ASR、不需要模型。若本来就要取稿，可在 `collect` 附加 `--frames`：

```sh
node '<skill目录>/scripts/bili-reach.mjs' frames '<BV或URL>' --part '<P>' --frames 30,90 --output '<私有材料目录>'
node '<skill目录>/scripts/bili-reach.mjs' collect '<BV或URL>' --part '<P>' --output '<私有材料目录>' --asr none --frames 30,90
```

同轮需要的时间点尽量合成一次调用：至少一个、最多 12 个，均小于所选 P 的时长。截图需 FFmpeg，每次新取图都会下载视频流；`--keep-media` 只控制文件保留，不会让下一次取图自动复用视频。

分析中需要补图时，先查看已有截图。缓存没有本轮所需时间点，就用 `frames --refresh` 新建截图版本，沿用原稿与旧图；同一任务、已授权来源内的正常补图直接执行。需要扩大来源或超出已约定的资源范围时再确认。

```sh
# 例如在原时间点附近补取画面，旧版本保留：
node '<skill目录>/scripts/bili-reach.mjs' frames '<BV或URL>' --part '<P>' --frames 32,92 --output '<私有材料目录>' --refresh
```

**完成标准：**所需图片已取得；分析时实际查看，用返回的路径和时间引用。新截图 run 没有 transcript，继续使用原来的成功转写；只有截图的请求则仅交付其画面和位置。

## 缓存、重取与媒体保留

- 默认按 BV+cid 和任务类型复用最后成功版本；`frames` 与 `collect` 各自保存成功指针，互不覆盖。缓存检查前仍会联网，已有材料只需阅读时直接打开文件。
- 缓存不含请求的截图，或未按新要求保留媒体时，返回 `CACHE_OPTIONS_CHANGED`；补图按上节处理。其他策略变化先核对本次请求，未明确的重取或大媒体保留需求再确认。`--refresh` 始终新建版本；换模型/术语不会自动重算。
- 默认清理本次中间音视频、WAV 和重复 Whisper JSON；原始 ASR 保留为 `raw/asr.json`，原始字幕与 PNG 也长期保留。需保留中间媒体时加布尔开关 `--keep-media`，或在私有 JSON 设 `"keepMedia": true`；保留文件全量哈希。

**完成标准：**本次任务类型、重取成本及保留选择明确。采集状态和清理范围按[数据契约](<data-contract.md>)；分析使用已确认的成功材料，并说明缺口。

## 错误后的下一动作

| 实际结果 | 下一动作 |
| --- | --- |
| `NEED_SETUP`，或本地工具探测失败/超时 | 缺工具/模型时下载前停止；`available: null` 仅说明未确认，先查路径或探测原因，不直接断言未安装。用户准备就绪后再试；真实执行失败/超时保留原错误类别。 |
| `NEED_LOGIN` / `LOGIN_REQUIRED` | 用户准备私有登录态与所需权限后显式重试；不启动 ASR 绕过。 |
| `PLATFORM_BLOCKED` / `RATE_LIMITED` | 停止本次访问，交由用户在官方页面处理或等待；不循环重试、不换接口绕过。 |
| `NO_SUBTITLES`（只取字幕） | 说明无正文；由用户选择本地 ASR 或提供已有材料。 |
| `CACHE_OPTIONS_CHANGED` | 需要新时间点时按截图部分直接补图；其他变化核对策略及成本，超出本次已明确需求时再确认。 |
| `BUSY` | 不开同来源并发；异常退出遗留锁时，确认无运行任务后由用户手工处理。 |
| 网络/API、坏字幕、无效时间轴、媒体/转写/截图错误 | 报告失败与下一步，不当作无字幕，不用失败版本拼课程正文。 |

失败时交付实际返回的错误与路径；早期停止可能只有错误返回。
