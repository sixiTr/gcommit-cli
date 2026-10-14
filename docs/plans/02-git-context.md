# Step 2：Git Context 实施计划

> 使用 superpowers:executing-plans 按任务实施，以 superpowers:test-driven-development 验证。

**目标：** 只读收集仓库根目录、分支、HEAD、staged/unstaged、untracked、最近 10 条历史和最终净变化，提供可复核的内容快照。

**架构：** Git 命令使用参数数组和受限环境；porcelain v2 / NUL 解析路径。净变化以 HEAD 与工作树最终内容对比，暂存区差异单独保留。文件读取不跟随符号链接，所有输入和输出均有限额。

**技术：** Node.js 24+、TypeScript、已有 Execa，不增加依赖。设计依据：../DESIGN.md。

## 全局约束

- 只修改 gcommit-cli；目标仓库读取不写 index、对象、配置或工作区，不执行 hooks、外部 diff 或自定义 filter。
- 默认最多 200 个候选路径，单文件 64 KiB、上下文 192 KiB、历史标题 10 条；超限明确失败，不静默截断。
- 单文件版本中的二进制和符号链接只返回元数据，不提供内容；原始 Git patch 尚未脱敏；当前阶段对超过单文件上限的文件保守拒绝。
- 所有返回内容属于尚未脱敏的内部数据；Step 4 完成前不输出 diff/历史/文件内容、不发给模型。CLI 继续明确报告后续能力未接入。
- 只支持能无损解码为 UTF-8 的路径，非法编码明确拒绝；空格、换行、中文和选项形状的路径保持原样。

## Review Focus

- 暂存删除后重新创建同名文件，净变化必须反映最终内容，不能重复计为删除与新增。
- 读取命令不能被 GIT_DIR、GIT_INDEX_FILE、fsmonitor、external diff、textconv、clean filter 重定向或执行额外程序。
- 子目录、linked worktree 与首次提交必须正确定位，不能假定 .git 是目录。
- 符号链接、目录替换、非法 UTF-8、NUL 路径和特殊文件不得被当作普通文本读取。
- 同一状态码下文件内容、index 或 HEAD 变化必须使旧快照失效；无法支持的特殊 index 状态明确停止。

## Task 1：无损进程输出与 Git 状态读取

文件：src/process.ts、src/errors.ts、src/git/types.ts、src/git/command.ts、src/git/status.ts；tests/process.test.ts、tests/git-context.test.ts、tests/git-helpers.ts。

接口：runProcessBytes(executable, args, options) 返回 Buffer 输出；readGitContext(cwd, options?) 返回 Promise<GitContext>。

- [x] RED：原始非 UTF-8 字节、非仓库、空仓库、子目录、历史顺序、MM/删除/重命名/特殊路径、外部环境重定向的行为测试先失败。
- [x] GREEN：进程原始字节接口；安全 Git 环境；仓库定位；状态和历史 NUL 解析；操作进行中和特殊 index 状态阻断。
- [x] 验证：pnpm test，当前全套 66 项通过。

## Task 2：有界内容、净变化与快照

文件：src/git/files.ts、src/git/context.ts；tests/git-context.test.ts。

接口：GitContext 包含 repository、changes、stagedDiff、unstagedDiff、untracked、netChanges、history、snapshot；assertGitContextUnchanged(context, options?) 验证快照。

- [x] RED：untracked/ignore、文本/二进制/符号链接、staged 后撤销、删除再创建、首次提交、CRLF、大小和数量预算、快照变化与只读性先失败。
- [x] GREEN：先检查属性与 index，有限读取 HEAD/工作树，按 Git 对 HEAD 的比较及最终文件模式判定净变化，index 删除后的同名重建单独核对；净变化保留 before/after，重命名状态保留 oldPath。
- [x] GREEN：两遍收集核对快照；独立复核函数检测后续变化。工作区快照包含原始字节摘要，不仅依赖 stat 或状态码。
- [x] 验证：pnpm test，当前全套 66 项通过。

## Task 3：文档、完整验收与独立评审

- [x] 更新 README、实施进度及 CLI 阶段说明，保留尚未实现能力的明确边界。
- [x] pnpm check、冻结锁文件、pnpm pack 和脱离源码目录运行验证。
- [x] 一次独立评审，Important/Critical 按 RED→GREEN 修复，记录实际平台限制。

## 执行记录

- Ruling: 继续使用用户指定的独立仓库；现有 codex/cli-foundation 无历史提交，保留未提交基线，不额外创建 worktree 或初始提交。使用临时 tar 基线和本文记录替代依赖 HEAD 的执行脚本；代价是评审需显式对照文件集。
- Ruling: 净变化采用每文件 before/after，重命名在状态层记录；不拼接 staged/unstaged patch。代价是 Step 4 需消费此结构。
- Ruling: 超大文件、submodule、sparse/assume-unchanged/skip-worktree、自定义 filter/working-tree-encoding 先明确拒绝；代价是这类仓库暂不能进入后续自动流程。
- Pre-flight: Task 1 原始字节输出供 Task 2 文件/路径解析；Task 2 的 GitContext 供 Task 3 文档和后续步骤，接口一致。

- 基线：23/23 项测试通过，既有文件保存到本轮临时 baseline.tar。
- Task 1/2 RED：31 项新增测试失败；APFS 不接受非法 UTF-8 路径的夹具改为真实 index 记录后，所有失败均来自未实现行为。
- Task 1/2 GREEN：54/54 项测试通过。
- 边界回归 RED：新增测试发现暂存删除后被忽略的同名文件误判为修改，以及部分克隆未阻断。
- 边界回归 GREEN：按 index/未忽略 untracked 判断最终收集范围；阻断部分克隆，并禁止 Git 远程传输。61/61 项通过，pnpm check 通过。
- Ruling: 部分克隆先拒绝，以避免缺失对象隐式拉取造成网络与对象库写入；代价是需要完整本地对象的仓库才能使用。
- 安全范围：未将双遍读取声明为对抗恶意并发配置/路径替换的系统级沙箱；后续 Git 写操作仍需重新核验。

- Final review: 独立评审 4 项 Important，0 项 Critical，0 项 Minor；未进行第二轮评审。
- Final: fixed CRLF 回撤误报 — 真实 add -A 对照测试 RED→GREEN。
- Final: fixed core.symlinks=false 类型与内容泄漏语义 — 保留 index 的 120000 与 content=null，对照测试 RED→GREEN。
- Final: fixed 非 UTF-8 patch 提前失败 — staged/unstaged patch 改为 Buffer，原始字节测试 RED→GREEN，路径仍严格检查 UTF-8。
- Final: fixed group/other 执行位误判 — 只检查 owner 执行位，0645/0654 对照测试 RED→GREEN。
- 修复后完整验证：pnpm check 通过，66/66 项行为测试通过。
- Ruling: 已跟踪文件净变化直接使用 Git 相对 HEAD 的比较，工作树 oid 为 null，patch 为原始 Buffer；避免伪造未来暂存 OID 和有损解码，代价是后续模块必须按字节处理 patch，并在真实暂存后读取 OID。
- Final: Ruling: 秘密过滤、Codex 隔离、交互与 Git 写操作仍留到已确认的后续步骤，CLI 继续关闭该流程；代价是当前不能作为完整提交助手使用。
- Final: Ruling: 对抗恶意并发替换的系统级隔离未建立，双遍核对仅处理通常并发编辑；代价是不能把本模块当作不可信仓库的安全沙箱。
- Final: Ruling: 保留已声明的复杂状态拒绝策略，Linux/Windows 未验收；代价是这些状态或平台不能宣称已支持。

- Task 3 complete：最终 tarball 在新的临时 pnpm 全局目录安装；从独立临时仓库读取 staged、unstaged、untracked、历史和净变化，并验证快照与 index 字节不变。安装包 bin 的帮助与版本通过。
- 验收环境：macOS，Node.js 24.16.0，Git 2.43.0，pnpm 12.5.1。冻结锁文件安装通过，无新增依赖。
- 本轮保留源文件与既有未提交基线；未关联远程、提交、推送或修改用户日常全局命令目录。
- 完成状态：Step 2 已验收。后续按 Step 3 接入 Codex，Step 4 处理敏感过滤与 AI 上下文；不将本步骤原始数据直接暴露给模型。
