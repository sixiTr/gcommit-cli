# Step 6：最终确认与 Commit

依据 `docs/DESIGN.md`，本步接入最终确认、限定范围全量暂存、提交、hooks/签名及失败现场说明；Push 留待 Step 7。

## 任务与接口

1. Git 提交执行器：接收已经分析的快照和已验证消息；暂存前复核；按候选文件 NUL 清单执行 literal `git add -A`；暂存后核对净变化、真实 index 和 HEAD；`git commit --file=- --cleanup=verbatim`。所有命令为参数数组。
2. 最终确认流程：分析会话生成不含原始秘密的预览与一次性执行计划；UI 显示分支、文件、完整消息及部分暂存边界警告，默认取消。只有确认才调用执行器。CLI 区分未写入、暂存后失败、已创建提交和结果不确定。
3. 真实 Git/hooks/签名/取消测试、Clack 确认测试、完整检查、独立评审、真实 Codex 隔离复验、PTY 与独立安装包验收。

Pre-flight：任务 1 使用 Step 2 快照和进程封装；任务 2 使用 Step 5 当前有效建议和安全过滤器。暂存会改变 index，暂存后不能直接比较旧 snapshot；须先验证净变化及无未暂存内容，再生成暂存后的快照供 commit 前复核。

## 验收

- 最终取消无 Git 写入、无 hooks；确认后才暂存；干净仓库不提交。
- 首次提交、staged/unstaged/untracked、部分暂存、净零变化的暂存中间版本、重命名、删除、忽略同名重建、特殊路径、CRLF/模式/二进制/符号链接。
- 确认期间修改内容/HEAD/index、暂存后内容变化、index.lock、配置/身份问题，均停止或准确报告现场，不回滚或重试。
- 保留 pre-commit/prepare-commit-msg/commit-msg/post-commit 与签名；非零退出、hook 格式化后失败、hook 改变消息/index、提交后 hook 卡住再取消均核实提交状态。输出不含原始 hook 日志/秘密。
- 消息只走 stdin，路径为 literal NUL 清单；不执行目标项目检查、不绕过 hooks、不推送。
- `pnpm check` 全绿；合成仓库真实 PTY 最终确认和安装包脱离源码运行。

## Review Focus

检查最终确认与写操作的绑定、净零暂存与重命名路径遗漏、CRLF/文件模式导致的 index 差异、hooks 修改文件/index/消息与签名行为、取消后提交可能已成功、错误状态的真实性、原始输出/路径秘密泄露、Git 环境覆盖及并发边界。所有异常都不得自动 reset/stash/amend/retry/push。

## 执行记录

- Ruling: 无 HEAD 的独立仓库继续用本步基线快照做评审，不创建实现提交 — 延续既有工作方式 — 暂无提交级回退点，基线保留在 `/private/tmp/gcommit-step6.L4S2t1/baseline`。
- Ruling: 保留 Git 原生 hooks 和签名；如果 hook 已改变并提交内容或消息，在结束后报告实际提交及不匹配，不能声称原确认仍有效 — 不替换/绕过 hooks，也不自动回滚 — 代价是受信任 hook 可能已创建需要人工检查的提交；不承诺隔离恶意 hook 或恶意并发替换。
- Ruling: Git commit 采用独立 5 分钟执行上限，取消/超时后重新读取 Git 状态，失败输出仅受控摘要 — 避免无限等待及泄露 hook 日志 — 超长 hooks 可能中断，具体诊断需要用户在本机复查；配置化超时留待需要时引入。
- Ruling: Push 留在 Step 7，不扩大平台/Codex 版本支持 — 按步骤交付 — 本步只创建本地提交，未验收环境继续拒绝。

- Task 1: complete，真实 Git 执行器测试先因模块缺失失败，实现后 21/21 通过。首次 GREEN 发现 verbatim 不会补尾换行，依据真实 cat-file 结果在 stdin 显式补齐，成功路径恢复；签名设置测试改用 config --local 查询，避免测试夹具命令级 signing=false 掩盖真实配置。
- Task 2: complete，确认流程/Clack 接口先因缺失失败；实现后提交、确认和终端相关 37/37 通过。含取消零写入、确认中快照变化、一计划仅执行一次、控制字符与秘密边界、默认取消。
- Task 3: complete，pnpm check 202/202，真实 Codex 隔离 2/2，源码/安装包各 5 项真实 PTY 场景及脱离源码目录验收全部通过；独立评审无待修复项。

- 验证补充：提交身份为空时在暂存前失败，保持 HEAD/index；该既有防线补充真实 Git 测试并通过。首次完整 pnpm check 为 201/201，新增该项后最终完整检查 202/202 通过。
- 真实 Codex 隔离复验：pnpm test:codex:isolation，2/2 通过；真实 CLI 工具清单为空，伪造执行/文件/外部工具调用被拒绝。
- Final review: fresh reviewer，gpt-6-astra/high；基于 Step 5 快照审查 Step 6 全部改动，独立复跑已有编译产物中提交/确认/终端 37/37 通过。Critical/Important/Minor 均无，无需修复轮次。
- Final: Ruling: 评审未判断恶意 hook、恶意并发替换及 Git 程序替换的隔离 — 延续本地受信任程序边界，普通变化及 hook 结果已审查 — 代价是本工具不能对这些攻击提供事务或系统级隔离保证。
- Final: Ruling: 评审未判断 Push 目标选择与执行 — 继续留在 Step 7，当前命令无推送路径 — 代价是本步只完成本地提交。
- Final: Ruling: 评审未判断未验收平台及其他 Codex 版本 — 保留精确版本/平台门禁，不借本步扩大支持声明 — 代价是这些环境需后续独立验收才能使用。

- 真实 PTY：源码和临时 PNPM_HOME 全局安装包分别通过默认取消、确认成功、hook 失败、pre-commit SIGINT、post-commit SIGTERM 共 10 项；核实 0/2/130/143 退出码、真实 HEAD/index/内容、敏感值不展示、hook 子进程终止及本地 bare remote 引用未变化。测试脚本等待 hook 标记时须持续读取 PTY，避免输出缓冲阻塞被测进程；修正验收脚本后各项通过，生产代码未因此修改。
- 安装包：pnpm pack、临时全局安装、实际 gcommit bin --help、help/version/dry-run 及上述完整终端场景通过；目标 Git 仓库无 package.json/node_modules，dry-run 快照保持不变。
- 最终检查：pnpm check 通过类型、格式、编译及 202/202 行为测试，零失败/跳过。日志保存在 `/private/tmp/gcommit-step6.L4S2t1`，普通测试不消耗真实模型额度、不向真实远程推送。
- 收尾：保留独立仓库 codex/cli-foundation 的当前文件；仍无 HEAD，不生成实现提交/PR 或删除唯一基线。下一步为 Step 7。
