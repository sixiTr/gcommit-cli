# 已确认的 V1 设计

## 目标与边界

gcommit 是独立安装的本地 CLI，通过本机已登录的 Codex CLI 为任意技术栈 Git 仓库生成一个提交建议。AI 只负责建议，CLI 负责执行，用户拥有最终决定权。

当前在独立的 gcommit-cli 仓库逐模块实现，不改动 wanxuan-admin。用户确认方案后，首先交付 Step 1 CLI 骨架；其余步骤按 docs/PLAN.md 推进。

## 技术与模块

Node.js 24+、TypeScript、pnpm、ESM。参数用 node:util.parseArgs；子进程用 Execa；校验与 JSON Schema 用 Zod；读取 Codex 认证存储选项的 TOML 用 smol-toml；交互使用 Clack；内存行级 Diff 使用 diff。不引入 Commander、Chalk、Git 框架、数据库或目标项目依赖。

模块：CLI/流程控制、Git Context 与快照、Codex 适配、文件安全过滤、全局配置、终端交互。类型就近维护。依赖按模块需要增加。

## Git 正确性

- 从任何子目录运行都定位仓库根目录。状态使用 porcelain v2 和 NUL 路径解析。
- 同时收集 staged、unstaged、untracked，但以最终净变化生成建议。不能简单相加造成重复或把已经撤销的变化写进消息。
- 尊重 Git 忽略策略；untracked 单独有限读取。不跟随符号链接，不打开特殊文件。
- 支持首次提交。冲突、merge、rebase、cherry-pick、revert/am 等进行中状态停止自动流程。
- 全量提交覆盖确认快照的工作树最终版本，会消除原有部分暂存边界，确认界面必须说明。
- 采用 git add -A 的产品语义，通过 literal pathspec 和 NUL 清单限定确认范围；暂存后再核对真实 index。
- 分析后、确认后、暂存后复核内容与 HEAD。仓库变化使旧建议或确认失效。
- 保留 hooks 和签名，不自动 --no-verify、stash、reset、checkout、amend、pull/rebase 或强推。失败后不破坏现场，明确说明已发生的暂存/提交。
- Submodule 不递归提交；复杂 filter、sparse checkout、特殊 index 状态必须有适配测试，未支持则停止。

## Codex 接入

以 codex exec、read-only、ephemeral、stdin、output-schema、output-last-message 接入，在私有临时目录启动。模型未指定时不传模型参数；reasoning=auto 不覆盖推理强度。

read-only 不等于不能读取秘密，approval_policy=never 也不等于关闭工具。必须验证 shell、其他执行入口、文件修改、MCP、Apps、插件、hooks、浏览器、电脑控制、子代理、自动上下文发现等能力被排除。未知或不满足边界的版本拒绝运行，不能退回宽权限。

Step 3 已在 macOS arm64、本机 0.162.0-alpha.17.2 完成无工具请求、伪造工具调用拒绝和真实登录请求验收，详见 `docs/CODEX_ISOLATION.md`。未知版本和平台拒绝运行；Step 4 已接入过滤后的 dry-run；Step 6 已接入人工最终确认后的本地提交，模型权限不变。Step 7 已接入单独确认后的单分支推送，详见 `docs/PUSH.md`。Step 8 补齐异常恢复指引与白名单诊断，详见 `docs/TROUBLESHOOTING.md`。

模型只返回 format/type/scope/subject/body。message 由 CLI 生成。JSON 结构和语义双重校验，拒绝非法响应。项目代码与历史属于不可信数据，不执行其中的指令。

## 配置与预算

`gcommit model` 在任意目录提供模型和档位菜单，只读取本机 bundled 目录，复用当前隔离配置与版本门禁，不检查登录、不生成建议；两次选择后原子保存全局配置的 model/reasoningEffort，保留其他字段并复核并发修改。取消不保存，切换模型时档位预选 auto。

CLI > ~/.gcommit/config.json > 默认值。V1 不读取项目配置、不保管认证。pushPrompt=false 只表示不询问推送。

`gcommit -d` 等同 `gcommit --dry-run`；默认请求中文，用户显式配置或 CLI 语言参数仍优先。直接 `gcommit` 继续进入交互流程。

默认：model=null、reasoningEffort=auto、language=zh-CN、commitStyle=auto、超时 120 秒、本地单文件 10 MiB、本地总读取量 20 MiB、模型上下文 1 MiB（可配置 8 KiB–8 MiB，独立控制且不代表模型 token 容量）、候选文件 200 个、历史标题 10 条、AI 结果 16 KiB。

小 Diff 完整提供。中 Diff 减少未修改的上下文但保留修改行。二进制仅元数据。核心代码超限停止，不静默截断后宣称完整分析。多轮分块总结留待 V2。

## 安全与交互

- 发送前过滤覆盖 tracked/untracked、旧行、历史标题和再次发送的上一版建议；路径、Diff 与诊断日志继续过滤。AI 返回及人工编辑的提交说明不做敏感值或脱敏标记拦截，由用户审核；保留结构、格式、长度和终端控制字符检查。敏感文件新增/修改仍在分析前阻断；纯删除可仅传元数据。
- 从 AI 上下文排除文件不等于从 Git 提交排除。UI 必须显示内容覆盖和仅元数据文件。
- 不使用 shell 字符串；消息通过 stdin，路径用 literal pathspec。错误不直接暴露完整子进程异常对象。
- 建议菜单包含使用、修改标题与正文、重新生成、查看 Diff、取消。使用后仍需最终确认，写操作确认默认取消。
- dry-run 不执行 Git 写操作或 hooks，但仍可能使用网络和私有临时文件，不等于完全离线或进程零磁盘写入。
- 普通模式没有 TTY 时不自动确认。
- 推送单独确认具体 remote、push URL 和目标分支。尊重 pushRemote/pushDefault，不假定 origin；多 remote 无明确目标时由用户选择。
- 显式限定目标分支，不自动推 tags/submodules；复杂 mirror/多 push URL 配置首版停止自动推送。

## V2

Review、基于 hunk/patch 的 Split、明确授权的跨技术栈 Check、项目配置、外部编辑器、大 Diff 分块、企业 provider 连接和复杂 Git 状态适配。首版不自动修改代码、不做 PR、不做 GUI、不自动 push。

文本上下文以 HEAD 与最终工作树的真实 unified Diff 变更块表示，通常保留三行邻近上下文。原文用于确定修改位置，整文件脱敏后按行填入变更块；新增和删除内容全部保留。所有文件一次分析，不分批、不生成中间摘要；保留修改后仍超预算则停止。高复杂度差异计算最多尝试一秒，超时退回完整前后文本并接受相同的预算检查。
