# 维护约定

仓库里有三个 skill，各自一个目录：`bili-reach`（B 站课程分析）、`study-wiki`（学习库入库与维护）、`study-practice`（练习与错题）。整体分工和流程图在 `README.md`，每个 skill 的用法在它自己的 `README.md`。

## 三个 skill 共同

- 分工按学习库的区来：`study-wiki` 写 `资料/`、`知识/` 和 `日志.md`，`study-practice` 只写 `练习/`，`bili-reach` 只产出资料包和讲解，不写 `知识/` 和 `练习/`。三者只通过学习库里的文件打交道。
- 笔记格式只写在 `skills/study-wiki/assets/学习库模板/库规则.md` 一处；`SKILL.md` 只写流程。状态词（`要重温`、`会了`）和总览的“来源”小节名，`study-practice` 和 `scripts/mindmap.mjs` 也在用，改要一起改。
- 流程是默认走法，不是关卡。改了流程或结构，同步根 `README.md` 和该 skill `README.md` 里的图和表。
- README 里的图是 [fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph) 的 Style 5 生成的动态 SVG，源 JSON 和静态 SVG 在 `docs/images/src/`。改图就改 JSON，用它的 `fireworks.py render agent` 出静态 SVG，再用 `python3 docs/images/src/animate.py <静态.svg> docs/images/<名字>.svg <名字>` 加上流动动画（每条边第几拍亮，写在脚本的 `STAGES` 里，加减边要同步改），别手改 `docs/images/` 下的 SVG。渲染器路由绕不开的地方（全景图里两条竖线、学习库标题的位置）写在 `animate.py` 的 `PATH_FIX` 和 `HEADER_AT`，改了节点坐标要跟着核对。学习库效果图 `vault.svg` 不是流程图，由 `python3 docs/images/src/vault.py docs/images/vault.svg` 生成，示例页的格式照 `库规则.md`，模板改了它也要改。skill 目录里的 README 用 `raw.githubusercontent.com` 的完整链接引用这些图。
- 每个 skill 目录要能单独安装：目录内的链接只指向本目录里的文件，指向仓库其他位置用 GitHub 完整链接（`test/skill.test.mjs` 会检查）。
- 测试、示例和提交中不含 cookie、私有配置、课堂材料或学生作答。

## bili-reach

- 修改采集产物、错误状态或缓存语义前，先读 [数据契约](skills/bili-reach/references/data-contract.md)；它是这些行为的单一真相。新增 ASR、截图策略或比较上游时读 [定制指南](docs/customization.md)。
- 守住模块边界：平台层只负责平台读取和状态分类；媒体层只负责受限下载与本地进程；采集编排决定字幕优先、回退、revision 与发布；CLI/DSH wrapper 只适配输入输出和权限，复用同一采集逻辑。
- 默认保持 Node 22+、ESM、零运行时 npm 依赖。本地 ASR 是外部工具调用，不隐式安装工具、下载模型或启用云服务。
- 登录、风控、限流和“明确无字幕”是不同结果；只有最后一种允许 ASR 回退。修复错误包装时保留能决定下一动作的状态，不把失败当空内容。
- 测试默认使用离线 fixture 与注入的网络/进程实现，覆盖失败不发布、缓存不覆盖及 refresh 新 revision。真实 B站网络测试另需用户显式同意。
- 将平台文本与媒体当不可信输入；cookie 仅从私有文件读取，异常信息脱敏。目录发布维持原子性；保留原始材料及人工审阅，不在重跑时覆盖它们。
- 课程分析与入库分开：跨来源整理交给 `study-wiki`；改变能力时同步对应流程的完成标准。
