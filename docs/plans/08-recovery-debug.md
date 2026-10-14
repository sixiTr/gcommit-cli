# Step 8：异常状态、恢复信息与脱敏 Debug

> 使用 superpowers:executing-plans 按任务实施；测试先行，一次独立最终评审。

**Goal:** 在现有停止与现场保留机制上提供可执行的恢复指引和有界安全诊断。
**Architecture:** 独立 diagnostics 模块使用异步作用域收集白名单事件；process 只记录显式命令类别、结果及耗时。Git 状态错误保留机器可读原因，recovery 模块据稳定类别返回静态建议，CLI 和建议交互共用。
**Tech Stack:** 现有 Node 24 / TypeScript / pnpm，使用 node:async_hooks；不新增依赖。
**Spec:** docs/DESIGN.md；原始需求异常状态及 Debug 章节。

## Global Constraints

无确认不写 Git，push 单独确认；不重试/回滚/删除锁/中止 Git 操作，不绕过 hooks/签名。Debug 不接收命令参数、路径、环境、stdin/stdout/stderr、模型内容或原始 Error。普通测试只使用临时本地仓库与替身 Codex。未知 Codex 版本/平台继续停止。

## Review Focus

- 配置或 Git 读取在分析前失败，也必须有恢复提示且不泄露原始输入。
- 失败恢复不得把已经暂存/提交/推送的状态改写成零写入，也不得诱导盲目重试。
- rebase/cherry-pick/merge 重叠标记、冲突和锁需要准确区分，不猜测用户应选择继续还是放弃。
- 并发分析、关闭 Debug、日志接收器失败不能污染别的会话或改变 Git 操作结果。
- 异常字符串、秘密 argv/env/stdin/output、Unicode/控制符不能进入诊断；有界截断不能隐藏最终结束事件。

## Task 1：有界诊断与进程接入

Files: 新增 src/diagnostics.ts、tests/diagnostics.test.ts；修改 src/process.ts、src/git/command.ts、src/git/commit.ts、src/git/push.ts、src/codex/adapter.ts。
Interfaces: withDiagnostics<T>(enabled, write, run): Promise<T> 建立异步作用域；diagnosticPhase(phase)、diagnosticFailure(error)、diagnosticCoverage(coverage) 记录固定事件；ProcessOptions.operation 为固定枚举，gitOperation 只接收并映射子命令白名单。命令结束记录 command/result/elapsedMs/exitCode；单次最多 500 条普通事件，额外一次截断提示、最多四条写操作摘要、最后一个错误与结束事件，总计最多 507 行。

- [x] 写禁用零日志、真实进程成功/失败/超时/取消、秘密隔离、异步会话隔离、接收器失败不改变返回值、日志上限测试；编译观察新模块缺失 RED。
- [x] 实现异步作用域与命令类别接入；不得记录可执行路径或参数。运行新增测试 Expected: PASS；运行全套测试 Expected: PASS。

## Task 2：异常原因、恢复建议及 CLI

Files: 新增 src/git/state-error.ts、src/recovery.ts、tests/recovery.test.ts、tests/cli-recovery.test.ts；修改 src/git/status.ts、src/git/commit.ts、src/cli.ts、src/interaction/flow.ts 和既有锁测试。
Interfaces: GitStateError.reason 为 merge/rebase/am/cherry-pick/revert/sequencer/bisect/conflict/index-lock；保持 GIT_STATE_BLOCKED，锁使用 GIT_INDEX_LOCKED；缺少 Git 身份使用 GIT_IDENTITY_INVALID。recoveryAdvice(error: unknown): readonly string[] 只返回静态行动建议，不接收仓库路径或凭据。

- [x] 写真实 Git 操作标记/冲突/锁/缺失身份、启动配置失败、非仓库/Detached HEAD、Codex 缺失/未登录/非法响应/超时的 CLI 恢复及 Debug 测试；验证状态未变和未误调用 Codex；观察 RED。
- [x] 实现原因分类（rebase/am 先于 cherry-pick）、index.lock 提前阻断、身份失败分类；不删除锁，不自动结束操作。保持提交/推送现场报告，追加相应建议。
- [x] CLI 在加载配置前启动诊断作用域，记录配置/分析/交互/提交/推送阶段与失败；原有 debug coverage 改用安全结构事件。恢复到旧建议时说明可选下一步。相关测试与全套测试 Expected: PASS。

## Task 3：验收、文档与最终评审

- [x] pnpm check 全绿；源码真实 PTY 验证提交/hook 拒绝/推送取消与失败/信号后的 Debug 与恢复；临时全局安装包验证源码外错误、dry-run 与终端流程，目标项目无依赖。
- [x] 新增 TROUBLESHOOTING，更新 README/PLAN/相关说明；逐项列异常推荐行为、日志字段、退出码和已验证平台。
- [x] 用 Step 7 基线制作完整差异包，fresh reviewer 一次独立评审；Critical/Important 一轮 RED→GREEN 修复并跑全套；记录最终结果。

## 执行记录

- Ruling: 延续独立仓库原地开发，不创建实现提交/worktree；以 Step 7 基线快照代替 HEAD 评审范围 — 当前无 HEAD，用户已授权逐步实现 — 没有提交级回退，保留 /private/tmp/gcommit-step8.mqr8Lr/baseline。
- Ruling: Debug 展示固定命令类别、数字指标和受控错误码，不展示原始命令或原始错误 — 原始错误可能含路径、配置与凭据，服从已确认安全设计 — 排查具体网络/hook 问题仍需用户在本机检查 Git/Codex。
- Baseline: Step 7 最终 pnpm check 251/251 通过，源码/安装包 18 次 PTY 通过；本步开始时源码未变。
- Pre-flight: 既有 CommitExecutionError.report / PushExecutionError 是写入结果依据；不改变其恢复语义。既有 runGit 的可选查询依赖退出码 1，不能把每次非零子进程认作流程失败。恢复信息必须区分进程事件与最终失败。

- Task 1: complete — 新诊断模块和 ProcessOptions.operation 缺失 RED；8/8 诊断行为通过，完整 pnpm check 259/259 通过。
- Task 2: complete — 新状态/恢复模块缺失 RED，11/11 CLI 新测试接入前全部失败；接入后相关 25/25 通过。首次完整检查 283/284，唯一失败为已有身份测试仍期待旧的 PROCESS_EXIT_FAILED，实际为计划中的 GIT_IDENTITY_INVALID；同步分类预期，保持 HEAD/index 验证。
- Task 2 补充：推送确认失效后不能要求重新生成已提交内容；新增回归 RED 后分离推送恢复建议，引导检查已有提交与配置后手工推送。相关 2/2 通过，最终完整 pnpm check 285/285 通过。
- Task 3: complete — 文档、真实终端、安装包和一次独立评审完成；最终结果见下方记录。

- Task 3 PTY 发现：500 条常规日志会在普通提交推送链路中用尽，导致 push 命令被截断。新增回归先 RED；保留有界摘要后诊断 9/9 通过，完整 pnpm check 286/286 通过，源码与安装包真实终端各 10/10 通过。
- Ruling: 截断后保留最多四种 Git 写命令各自的最后结果、最后一个错误与结束事件，总计最多 507 行 — 真实 PTY 证明常规读取会消耗原日志预算，不能丢失关键写入结果 — 更早的同类结果仍只保留在截断前日志中，不承诺完整命令追踪。

- Task 3 QA: pnpm check 286/286 通过；源码与隔离全局安装包各 10/10 真实 PTY 通过，覆盖 no-push、默认取消、成功、多 remote、pre-push 拒绝、确认时 SIGTERM、远端更新后 SIGINT、隐藏目标阻断、URL 脱敏及 pre-commit 拒绝。实际 HEAD/index/远端 refs 与报告一致，秘密不出现在输出中。
- Package QA: 临时 PNPM_HOME 全新安装打包产物；源码外错误恢复/Debug、help/version/dry-run 通过，目标无 package.json/node_modules，dry-run Git 快照不变；未改变用户日常全局安装。
- 验证环境：macOS arm64、Node 24.16.0、pnpm 12.5.1、Git 2.43.0。Codex 使用替身，推送仅使用本地 bare 接收端；未扩大既有 Codex 平台/版本边界，Linux/Windows、真实网络认证仍留待 Step 9。
- Final review: 一次 fresh-context gpt-6-astra/high 只读评审发现 1 项 Important：真实 rebase 的 detached HEAD 在检查操作标记前被拒绝，误导用户切换分支；无 Critical/Minor。使用 receiving-code-review 核对调用顺序，真实 rebase 和 bisect 两条 CLI 回归均先失败。进入同一轮修复，不做二次评审。

- Final: Ruling: 评审未判断真实 Codex、联网认证及 Linux/Windows — 继续保留既有平台/版本门禁和未验收说明，留待 Step 9 — 本步不能证明这些集成或平台可用。
- Final: Ruling: 评审未重新审计 Step 1–7 的全量实现 — 本步审查变更及相关调用链，全部旧行为测试继续运行 — 旧模块仍可能存在全套测试未覆盖的缺陷。
- Final: Ruling: 评审采用本会话完整检查和安装包 PTY 证据，未重复构建验收 — 验证命令与输出由本会话实际执行并保留，评审集中检查实现 — 验收没有第二位执行者独立重跑。

- Final: fixed — Important 真实 rebase 的 Detached HEAD 遮蔽原操作：新增真实冲突 rebase 与真实 bisect CLI 回归，两条均先得到 GIT_DETACHED_HEAD 而失败。将锁与操作标记检查移至读取分支/拒绝 Detached HEAD 前，同时保留写入前复核；两条转绿，相关 17/17 通过，完整 pnpm check 288/288 通过。HEAD/index/工作树/操作标记均保留，未调用 Codex。无待处理 Critical/Important/Minor；未做二次评审。

- 最终复验：评审修复后完整 pnpm check 288/288（类型/格式/构建均通过）；当前源码 10/10 PTY、全新临时全局安装包 10/10 PTY，再验证安装包真实冲突 rebase 与 bisect 均识别原操作，保持 HEAD/index，未调用 Codex。源码外错误恢复/Debug、help/version/dry-run 均通过。
- 证据目录：`/private/tmp/gcommit-step8.mqr8Lr`；完整检查 `check-complete.log`，评审回归 `review-red.log` / `review-green.log`，最终终端与安装包 `pty-reviewed.log` / `package-final.log`。其他阶段日志和 Step 7 基线一并保留。
- 收尾：保持 codex/cli-foundation 的现有源码，仍无 HEAD；不创建实现提交/PR/真实远程推送，不删除唯一基线。下一步为 Step 9：完整流程、真实 Codex 与跨平台验收。
