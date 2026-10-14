# Step 9：完整流程与真实 Codex 验收

> 使用 superpowers:executing-plans 执行；沿用已确认设计，不增加业务功能。一次独立最终评审。

Spec: docs/DESIGN.md。目标：把临时终端测试变为维护中的验收入口，复验真实 Codex 隔离、登录、dry-run，以及模型建议到本地提交/本地 bare 推送的完整流程；如实记录平台覆盖。

## Global Constraints

所有 Git 写入仅作用于合成临时仓库和本地 bare remote。普通 check/e2e 使用 Codex 替身，不联网、不用真实凭据；live 入口明确区分，使用既有登录只发送合成上下文。不放宽 Codex 版本/平台门禁，不在目标项目安装依赖，不更改用户全局配置或安装。

## Tasks

- [x] Task 1：维护 POSIX PTY 驱动、TypeScript 夹具与断言、显式 test:e2e 入口。覆盖三层默认取消、提交成功、部分暂存与 untracked/中文/选项形状路径、首次提交、子目录启动、Diff/重新生成/编辑、过期确认、hooks 拒绝、推送目标与信号取消。Expected: 全部通过，确认前 HEAD/index/remote 不变，最终 Git 状态与输出一致。
- [x] Task 2：运行真实 Codex 隔离、登录和 dry-run；新增 test:e2e:live 复用同一 PTY 驱动，在合成仓库生成消息、确认提交并推送本地 bare。Expected: 结构化建议有效，确认前零写入，远端仅更新已确认分支。
- [x] Task 3：pnpm check、pnpm pack、临时全局安装后离开源码目录运行 E2E；维护验收说明和平台矩阵。一次最终评审，Important/Critical 一轮回归修复。Expected: macOS 已验证项全绿；无法执行的平台明确待验收。

## Review Focus

- 验收实际启动发布 CLI 和真实终端，不能仅验证替身或绕过确认函数。
- 隔离用户 Git/global config/hooks/signing，测试失败与取消也清理子进程和临时文件；live 只能发送合成数据且不能推送真实远程。
- 三次默认取消、确认前零写入、净变化提交及远端 refs 的断言能发现用户可见回归；不硬编码真实模型文案。
- package 路径替换确实测试安装包，未误用源码模块代替被测 CLI。
- 平台矩阵区分实机执行与参数门禁测试；不扩大权限或暗示 Linux/Windows 已支持。

## Ledger

- Ruling: 延续无 HEAD 的 codex/cli-foundation 原地工作，以 `/private/tmp/gcommit-step9.x8vrca7l/baseline` 记录 Step 8 基线，不创建实现提交/worktree — 用户授权按步实现，独立仓库尚无提交 — 无提交级回退，保留基线和证据。
- Ruling: 本步新增的是既有行为验收，先写断言再运行；没有生产改动时不人为制造功能失败，发现产品缺陷才执行 RED→GREEN — Step 9 是验收步骤 — 验收范围之外仍可能有遗漏。
- Ruling: PTY 驱动使用 Python 3 标准库，仅供显式开发验收，不增加运行时依赖 — Node 标准库没有 PTY API，本机已有 Python — 验收需要额外 Python，且该驱动不适用于 Windows。
- Ruling: Linux/Windows/macOS x64 在没有实机证据前保持拒绝；Step 9 总状态只能部分完成 — 当前仅 macOS arm64，未找到 Docker/Podman/QEMU/Wine 运行环境 — 跨平台验收仍需后续主机，不能宣称完成。
- Pre-flight: 真实 CLI 的终端文案由 Python 驱动读取，真实 Git 状态由 TypeScript 断言；Codex 替身沿用已有认证/目录协议，live 不注入替身路径。显式安装包入口只替换 CLI 路径，不替换受测逻辑。普通 pnpm check 不包含 e2e/live。

- Task 1 首轮：14/16 通过；两项失败来自验收驱动，正文 Ctrl-A/Ctrl-K 被 multiline 当作控制字符并正确拒绝，过期确认实际返回 GIT_CONTEXT_CHANGED。改用 Backspace 与正确错误码后，过期确认通过；编辑流程复跑发现把已选择后的 ◇ 提示误认成新菜单，改为只等待 ◆ 活跃提示，不增加固定 sleep。
- Task 2: complete — 真实 Codex 隔离 2/2、登录结构化请求 1/1、CLI dry-run 1/1、真实 PTY 完整提交/本地 bare 推送 1/1 通过。没有修改生产权限配置，也没有发送真实项目上下文。

- Task 1: complete — 活跃提示同步修正后，源码 CLI 16/16 真实 PTY 验收通过。只调整测试驱动，未改变产品控制字符校验或快照门禁。
- 完整检查：pnpm check 290/290，通过类型、格式和编译；新增 Linux x64 / Windows arm64 拒绝测试，两者仅为参数门禁测试。Python 驱动语法编译通过，不生成缓存。
- 打包：pnpm pack 已完成。临时安装首次缺 PATH 后补齐；离线安装缺 smol-toml 元数据，改为正常 registry 安装，仍使用临时 PNPM_HOME/global-dir/bin，未更改日常全局安装。安装包验收结果见下方。

- Task 3 验收：项目 pnpm 12.5.1 构建、检查和 pack 通过；首次源码外安装由系统 pnpm 11.18.0 执行，E2E 16/16 通过，仅作补充证据。已按本机帮助确认 pnpm 12 的 PNPM_HOME/bin 规则，在第二个临时目录使用 12.5.1 全新安装，源码外 E2E 16/16 和实际 gcommit shim help/version 均通过。28 个安装运行文件逐字节等于源码构建产物，包中无 src/tests/node_modules。
- 主要证据：`check.log`（290/290）、`e2e-final.log`（源码 16/16）、`codex-isolation.log`（2/2）、`codex-live.log`、`dry-run-live.log`、`e2e-live.log`（各 1/1）、`install-pnpm12.log` 和 `package-pnpm12.log`（安装包 16/16），均位于 `/private/tmp/gcommit-step9.x8vrca7l`。
- Task 3 独立评审：一次 fresh-context gpt-6-astra/high 只读评审发现两项 Important，无 Critical/Minor；已进入同一轮回归修复，不做第二次评审。

- Final: fixed（针对性验证）— 空 PID 标记清理：先抽取原清理逻辑复现，8 条非法 PID 回归全部 RED；随后校验安全整数与单进程范围（>1 且 <=2147483647），空/非法/缺失标记不发信号，hook 原子 rename 发布完整 PID，驱动等待合法内容。8 条转绿，并补真实有效子进程清理验证。
- Final: fixed（针对性验证）— 外层超时绕过 PTY finally：协作清理和忽略终止信号两条受控进程回归均先 RED，确认独立会话/子进程残留。Python 捕获 SIGTERM/SIGINT 进入清理，三秒后兜底杀死终端进程组，外层强杀宽限五秒；两条转绿，验证进程全退出，协作 CLI 的临时目录已清理。忽略信号时强杀不承诺执行其应用清理。
- Final: Ruling: 评审未判断 Linux、Windows、macOS x64 实际行为 — 继续拒绝这些平台且保持 Step 9 部分完成 — 跨平台用户仍无法使用分析，需补实机验收。
- Final: Ruling: 评审未判断真实 SSH/HTTPS 认证推送 — 本步只推送临时本地 bare，保持未验收说明 — 不能据此保证生产远程认证可用。
- Final: Ruling: 评审未判断真实模型具体措辞及普遍质量 — 验收结构、过滤及人工确认链路，不硬编码文案 — 用户仍需审核每次建议内容。
- Final: Ruling: 评审未全面审计 Step 1–8 — 本步评审 Step 9 与关联调用，旧测试全部继续运行 — 既有实现仍可能有未覆盖缺陷。

- Final: fixed（最终全套）— 两项 Important 均完成同一轮修复：针对性 10/10 从 RED 转 GREEN，另加有效 PID 真实子进程验证。最终 pnpm check 299/299（类型/格式/编译通过），pnpm test:e2e 18/18（16 个产品流程 + 2 个外层超时回归），pnpm 12 安装包离开源码目录后 16/16，安装包真实 Codex 完整终端链路 1/1 通过。没有待处理 Critical/Important/Minor，未做第二次评审。
- Task 3: complete（当前 macOS 范围）— 验收和文档落地；跨平台仍未完成，docs/PLAN.md 保持 Step 9 部分完成。生产 src 和依赖锁逐字节等于 Step 8 基线，本轮仅修改验收脚本/测试/文档。
- 最终证据：`review-red.log`（10 条失败）、`review-green.log`（10/10）、`check-reviewed.log`（299/299）、`e2e-reviewed.log`（18/18）、`package-reviewed.log`（安装包 16/16）、`package-live-reviewed.log`（安装包真实模型 1/1）。此前 Codex 隔离/登录/dry-run 结果仍有效，相关生产实现无改动。
- 收尾：继续保留无 HEAD 的 codex/cli-foundation 及证据基线；不创建实现提交/PR，不推送生产远程，不更改日常全局安装。下一步可按当前 macOS arm64 支持范围推进 Step 10：全局安装、升级卸载与发布准备。其他操作系统需提供对应主机补验。
