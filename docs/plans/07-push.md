# Step 7：单独确认与单分支推送

> 使用 superpowers:executing-plans 在当前会话逐项实施，遵循测试先行，完成后一次独立评审。

**Goal:** 本地提交成功后解析推送目标，独立确认后仅推送该提交到一个明确分支。
**Architecture:** Git 层读取本地配置、冻结目标并执行显式 OID refspec；流程层使用分析会话的过滤器生成安全预览和一次性计划；终端提供 remote 选择和默认取消的推送确认。
**Tech Stack:** 现有 Node 24 / TypeScript / pnpm / Execa / Clack，不新增依赖。
**Spec:** `docs/DESIGN.md`。

## Global Constraints

AI 只生成建议；CLI 执行 Git；用户最终确认。Push 独立确认，pushPrompt=false/--no-push 跳过整个推送发现与交互。参数数组、禁用 shell。错误和 URL 不泄露秘密。不强推、不自动重试/pull/rebase/reset、不推 tags/submodules、不绕过 pre-push 或签名。普通测试只向临时本地 bare remote 推送。

## Review Focus

- 有 upstream、三角工作流和多个 remote 时，确认的目标必须与实际写入一致；不假定 origin。
- insteadOf/pushInsteadOf、pushurl、mirror、自定义 refspec 和凭据 URL 不得导致隐藏目标或额外 refs。
- 等待确认期间 HEAD/分支/配置变化必须阻断，pre-push 修改分支时仍只能发送确认的 OID。
- 取消、认证/网络/非快进/远端 hook 失败可能发生在远端更新之后，不能谎称没有推送，也不能回滚本地提交。
- 确认和错误展示不得包含原始秘密或终端控制字符，--no-push、默认取消和 dry-run 不得接触远端。

## Task 1：目标解析与 Git 推送

Files: 新增 `src/git/push.ts`、`tests/push.test.ts`、`tests/push-helpers.ts`；修改错误类别。
Interfaces: `readPushState(cwd, expectedOid, options)` 返回 root/ref/oid/remotes/preferred/upstream/fingerprint；`resolvePushTarget(state, remote, options)` 返回绑定状态和 URL/ref 的目标；`pushTarget(target, options)` 返回核实的 OID/目标 ref。PushOptions 仅包含 signal 与执行 timeoutMs。

- [x] 先写真实 Git/bare remote 测试：无 remote、单 remote、各优先级、三角目标、异名 upstream、无目标的多 remote；目标 URL 重写与多 push URL/mirror/refspec/helper 拒绝。
- [x] 编译观察模块缺失 RED，然后实现本地读取与有界解析；单值配置冲突、非法 ref、复杂传输停止。
- [x] 先写执行测试：仅一分支、无 tags、原生 pre-push、非快进拒绝、失败不泄露日志、HEAD/配置变化、pre-push 修改分支、取消及超时；读取远端真实 refs/本地现场验证。
- [x] 实现对确认 OID 的显式 refspec，使用冻结 URL、关闭 followTags/递归/autoSetupRemote；成功核对 porcelain 中唯一目标，失败报告远端结果未知并保留本地提交。运行全部新增 Git 测试 Expected: PASS。

## Task 2：独立确认与 CLI

Files: 新增 `src/push/flow.ts`、`tests/push-flow.test.ts`；修改 session/terminal/cli 和对应测试。
Interfaces: 会话 `preparePush(oid)` 返回安全 remote 选项及 select(id)→一次性 PushPlan；`offerPush(session, receipt, ui, enabled, signal)` 返回 skipped/no-remote/cancelled/pushed。终端实现 chooseRemote 和 confirmPush。
Pre-flight: Step 6 receipt.oid 是推送绑定点；Step 5 过滤器继续用于 Git 名称/URL；提交成功后的错误必须走“本地提交已保留”分支，不能落到旧的未提交取消文案。

- [x] 先写取消零写入、--no-push 不发现、明确确认、篡改预览不改变操作、重复计划拒绝、选择期间配置变化、URL/名称秘密与控制字符过滤测试；观察 RED。
- [x] 接入原生 Clack 默认取消/remote 选择，并测试键盘及监听器清理；串联 CLI，明确本地提交成功与推送结果。Expected: 新增相关测试 PASS。

## Task 3：完整验收与文档

- [x] pnpm check（类型/格式/构建/所有行为测试）Expected: 全绿；真实 PTY 覆盖跳过、默认取消、成功、拒绝、信号；安装包在无 package.json/node_modules 的合成仓库执行。
- [x] 更新 PUSH/README/PLAN/既有交互与提交文档；一次新上下文独立评审；重要问题一轮 RED→GREEN 修复，无二次评审。

## 执行记录

- Ruling: 延续无 HEAD 仓库的基线快照评审，不创建实现提交或 worktree — 保护现有独立源码与用户工作方式 — 暂无提交级回退，基线保留于 `/private/tmp/gcommit-step7.0klGw3/baseline`。
- Ruling: 使用确认 OID 和冻结的有效 URL 推送，不自动写 upstream — 避免分支在 pre-push 中变化或 named remote 被重新解析而发送其他内容/目标 — 首次推送后需用户自行设置 tracking；原生 pre-push 收到 URL 与 OID，而非 remote 别名/源分支名，依赖这些参数的 hook 可能拒绝。
- Ruling: 首版拒绝 mirror、多有效 push URL、自定义 remote.push/receivepack 和非 file/ssh/http/https/git 传输；拒绝对已展开 URL 再次发生的 insteadOf 重写及任何匹配的 pushInsteadOf 前缀（含同地址规则） — 不能猜测复杂配置意图 — 对应仓库需手工推送。
- Ruling: Push 默认 120 秒且不弹 Git 终端认证；失败/取消/超时不另发网络查询，远端结果按未知报告 — 避免未经额外交互的重试与误判 — 慢传输或需交互认证者要在本机 Git 完成，远端是否更新需人工核实。

- Task 1: complete，模块缺失 RED 后实现；初始 27/27 Git 行为通过。带空格路径补测 RED→GREEN，IPv6 SSH/scp 地址补测 RED 后修正 helper 前缀匹配；原生签名要求与已同步分支亦有真实 Git 测试。
- Task 2: complete，流程/终端接口缺失 RED 后实现；推送流程与终端 22/22 通过，覆盖关闭推送、独立确认、选择、脱敏、取消与只执行一次。
- Task 3: complete，首次完整检查 242/244：旧 help 断言尚未接入需更新；Codex 取消测试固定 500ms 在负载下早于子进程启动。改为等待实际 exec PID 后取消并检查进程终止；随后完整 pnpm check 244/244 通过，IPv6 补测后 246/246。评审修复后最终完整检查 251/251 通过，类型、格式、构建同时通过。
- PTY source：7/7 通过，--no-push、默认取消、成功、多 remote 选择、pre-push 拒绝、确认时 SIGTERM、远端 post-receive 时 SIGINT；本地提交均保留，远端 refs 与每种情况的预期相符。

- Final review: fresh reviewer gpt-6-astra/high，发现 Critical：显式 pushurl 转为直接 URL 后会再次应用 pushInsteadOf，可能写入未确认仓库；Important：userinfo 多 @ 和 U+2028/U+2029 查询/片段遮蔽不全。无 Minor；Declined to judge 为空。两项均确认进入同一修复轮次，无二次评审。
- Final fix RED：新增两条真实 bare 接收端二次 pushInsteadOf 回归、三条 URL 凭据预览回归，5/5 均先失败。Git 2.43 的 remote get-url 不接受仅由命令级配置建立的 remote，最初探测方案不可用且导致回归；据实际行为改为既有 insteadOf 展开检查加 pushInsteadOf 前缀匹配拒绝。
- Final fix implementation：URL userinfo 使用 URL 解析完整移除，查询/片段不再通过点号正则截断；SCP/本地路径按分隔位置截取。目标解析在确认前与执行前同时执行两类重写检查；相关 Git/流程/终端测试 58/58 通过，随后完整检查 251/251 通过。

- Final: fixed — Critical 二次 pushInsteadOf 隐藏目标：两条真实 bare 接收端回归先失败，修复后通过；显式 pushurl 与链式重写均在传输前拒绝，两个接收端均未被写入。
- Final: fixed — Important URL 凭据泄露：多 @ userinfo、U+2028 查询及 U+2029 片段三条预览回归先失败，修复后通过；真实终端额外验证不展示私密 userinfo/query。
- Final: 无待处理 Critical/Important，无 Minor 或 Declined to judge 项；完成一次独立评审和一轮修复，没有二次评审。
- 最终 PTY：源码 9/9、安装包 9/9，通过 --no-push、默认取消、成功、多 remote 选择、pre-push 拒绝、确认时 SIGTERM、远端 post-receive 时 SIGINT、隐藏目标阻断、URL 脱敏；共 18 次真实终端流程。本地提交始终保留，远端 refs 与预期一致，取消后 hook 子进程终止。
- 打包：pnpm pack 后在临时 PNPM_HOME 全新安装；全局 gcommit --help、源码外 help/version/dry-run 通过。目标合成项目无 package.json/node_modules，dry-run Git 快照不变，Codex stdin 与输出均过滤秘密。没有改变用户日常全局安装。
- 验证环境：macOS arm64、Node 24.16.0、pnpm 12.5.1、Git 2.43.0。本步 Codex 使用替身，推送仅使用本地 bare 仓库；Linux、Windows 和联网认证未验收，Codex 既有平台/版本限制不变。
- 证据：`/private/tmp/gcommit-step7.0klGw3/check-complete.log`、`review-red.log`、`review-green.log`、`pty-source-final.log`、`package-final.log`（后四项位于同一目录）。
- 收尾：保留独立仓库 codex/cli-foundation 的当前文件，仍无 HEAD，不创建实现提交/PR 或真实远程推送；Step 6 基线快照继续保留。下一步为 Step 8：异常状态、恢复信息与脱敏 Debug。
