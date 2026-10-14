# Step 5：建议交互

设计依据：`docs/DESIGN.md` 与原始需求。范围：使用、修改标题和正文、重新生成、查看 Diff、取消。Step 6 的最终确认、暂存和提交留待下一步。

## 任务与接口

1. 提取共享分析会话：dry-run 与交互共用原始快照、过滤、Prompt、Schema。会话负责初次生成、重新生成、编辑校验和快照复核；失败不覆盖已验证建议。
2. 接入 Clack 菜单与输入：默认取消；正文每行一条、可清空；编辑取消保留原建议；非 TTY 提示使用 dry-run。信号/EOF 结束，不执行 Git 写入。
3. 覆盖行为测试、文档、完整检查与安装包离开源码目录运行验证；进行一次独立评审。

Pre-flight：任务 1 提供会话和已过滤 Diff；任务 2 只展示验证后的建议，传递取消信号；重新生成把上一版建议计入同一字节预算；菜单退出前重新检查快照。接口无冲突。

## 验收

- 初次分析、编辑后使用、清空正文、重新生成携带上一版、重新生成失败保留原建议。
- 编辑格式/秘密/控制字符/长度校验，净变化 Diff 过滤旧行及历史秘密，二进制/敏感删除仅元数据。
- 菜单等待或重新生成期间 HEAD/index/工作树改变时旧建议失效。
- 非 TTY 不启动 Git/Codex；真实终端菜单选择、编辑、取消、EOF、信号清理；dry-run 回归。
- `pnpm check` 全绿；临时全局安装后从无 package.json/node_modules 的目标仓库运行。

## Review Focus

重点检查交互状态转换、编辑内容进入输出/Prompt 的信任边界、重新生成的总预算与失败保留、快照复核时机、Clack EOF/信号清理和终端控制字符。确认所有分支均无 Git 写操作。

## 执行记录

- Ruling: 未出生分支以临时基线快照替代基于 HEAD 的工作树与评审脚本，不新增提交 — 延续前四步现状 — 代价是暂时没有提交级回退点；基线保存在 `/private/tmp/gcommit-step5.sF6tnW/baseline`。
- Ruling: Step 5 的“使用”只输出选定建议；Diff 用有行号的变更前后区间，明确不是最小 unified diff — 保持 Step 6 边界并复用已验证的脱敏区间 — 代价是本步仍不能实际提交，较大 Diff 需要终端滚动。
- 已通过 pnpm 添加计划内运行依赖 @clack/prompts 1.8.1；只安装到独立工具。

- Task 1: complete，新增会话测试先因缺失接口失败，实现后 16/16 通过。编辑、净变化 Diff、秘密校验、重新生成反馈及预算、快照变化均使用真实 Git 和隔离 Codex 替身。
- Task 2: complete，新增菜单/终端测试先因缺失接口失败；实现后 11/11 通过。测试曾假定多行输入支持 Ctrl-U，检查 Clack 实现确认其作为普通字符；改用实际支持的退格清空，未修改产品语义。
- 全量回归首次 166/170，发现 Diff 对脱敏后的单行 YAML/多行秘密重新解析导致误拒绝。已将“全文过滤”和“片段终端转义”分开；原 4 个失败用例恢复通过，全量 `pnpm check` 170/170。
- Task 3: complete，文档、真实 PTY、独立评审与安装包验收已完成。

- Final review: 独立 gpt-6-astra/high 只读评审，Critical/Important/Minor 均为 0；复跑 27/27 交互测试。
- Final: Ruling: 评审搁置的 Step 6、最小 unified diff/pager 沿用上述阶段与视图裁定；本地编辑回显保留，接受前校验 — 普通终端编辑应能看见用户输入 — 代价是用户自己键入的文字会出现在本机终端；不扩大平台或 Codex 版本支持 — 适配器未变 — 代价是其他环境仍不能运行；PTY 和打包由主执行者验收，不省略。
- 真实 PTY 揭示验收宿主 TERM=dumb 会令 Node 标题编辑把退格当普通字符。标准 TERM=xterm-256color 的完整流程通过；新增“不支持终端在分析前拒绝”检查，先在 PTY 失败后修复；补充真实 Clack 标题编辑/校验恢复测试。仅为无法正常编辑的终端提示 dry-run，不修改用户环境。

- 最终 `pnpm check`：类型、格式、构建及 171/171 普通测试通过，日志 `/private/tmp/gcommit-step5.sF6tnW/final-check.log`。本步不重复消耗真实 Codex 额度，保留前一步真实调用与原有隔离验收。
- 最终 PTY：标准终端下查看 Diff → 修改标题正文 → 重新生成 → 使用；菜单取消、Ctrl-C、SIGTERM 分别以 0/130/143 退出；HEAD/index/工作树快照不变。不支持的 TERM=dumb 在分析前退出 2，独立用例 RED→GREEN。
- 最终打包：`pnpm pack` 成功，全新临时 PNPM_HOME 全局安装 27 个包；安装后的 gcommit 可执行入口、help/version/dry-run 及 PTY 操作均通过。源码外目标没有 package.json/node_modules，发送给替身的上下文不含合成秘密，Git 快照不变。日志 `/private/tmp/gcommit-step5.sF6tnW/package-final.log`。
- 无待处理的 Critical/Important/Minor。当前独立仓库没有 HEAD/remote，按原范围保留文件，不创建提交、合并、推送或发布；基线与验收记录保留在本步临时目录，直到后续建立提交历史。
