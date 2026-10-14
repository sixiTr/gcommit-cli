# Codex 接入与隔离验收

## 已支持的运行时

2026-10-13 在 macOS arm64、Node.js 24.16.0、`codex-cli 0.162.0-alpha.17.2` 上通过验收。其他版本、Linux、Windows 和 Intel Mac 明确返回 `CODEX_UNSUPPORTED`，升级后需要重新验证，不能仅扩大版本范围。

调用已有 `codex`，复用其现有登录位置，不复制认证文件，不要求 API Key，不改写用户配置。只读解析原有 `config.toml`，提取 `cli_auth_credentials_store`（file/keyring/auto），并在登录检查和 exec 中显式使用同一存储方式；其他设置不继承。TOML 使用 smol-toml 解析，配置限 1 MiB，拒绝链接、特殊文件、非法内容和不能跨进程复用的 ephemeral 存储；错误不回显原文。内部接口为 `runCodex(prompt, schema, config, options?)`，位于 `src/codex/adapter.ts`。`schema` 是调用方的 Zod Schema；结果经过 JSON 与该 Schema 校验。`options.signal` 接受 AbortSignal；`options.executable` 可指定可信的绝对可执行路径，默认从过滤后的 PATH 查找 Codex。

只接受已经过滤的文本；模块本身不执行 Step 4 的敏感信息过滤和提交说明语义校验。默认命令与 dry-run 已通过 `src/analysis` 的过滤和校验接入。Git 写操作由本机 CLI 在最终确认后执行，模型权限不因此扩大。

## 调用边界

- 每次建立权限为 0700 的私有临时目录。模型目录、响应 Schema 和结果文件为 0600，prompt 仅走 stdin；不在 argv 中放源码。
- `--ignore-user-config`、`--ignore-rules`、`--strict-config`、`--ephemeral`、`--sandbox read-only`、`approval_policy=never` 固定启用；所有调用都从私有目录启动。
- 固定关闭当前版本的 shell、unified exec、Code Mode host、MCP 来源、Apps、plugins、hooks、web、browser、computer use、subagents、skills discovery、memories 等能力；MCP、plugins、hooks 配置表清空。关闭 AGENTS.md、技能、环境和其他自动上下文注入。
- 实测发现仅禁用 feature 仍会暴露模型目录要求的 Code Mode。适配器读取同一二进制的 `debug models --bundled`，仅在私有副本中设 `tool_mode=disabled`、`shell_type=disabled`、禁用 patch、额外工具与工具相关指令。保留模型元数据和排序，不改用户模型缓存。
- 未指定模型不传 `--model`，使用这份本机 bundled 目录的默认选择；`auto` 不传推理覆盖。不继承日常用户配置中的默认模型。显式模型及推理强度必须在目录中受支持，未知项不静默回退。认证过期、网络或服务不可用会明确失败。
- 环境仅保留 HOME、现有 CODEX_HOME、用户标识、语言、TMPDIR 和过滤后的 PATH；删除相对 PATH、项目 node_modules 路径，以及父会话、运行时注入、API Key、端点覆盖和业务秘密等环境变量。企业 provider 和代理配置不在此版适配范围内。
- 版本/登录检查、目录读取和分析共享总超时，默认 120 秒；超时或取消会终止子进程及其后代。取消、失败、超限与成功都清理本次目录，不返回半成品。
- stdout/stderr 有字节上限，最终结果限 16 KiB。结果文件不跟随符号链接；拒绝特殊文件、非法 UTF-8、非法 JSON、Schema 不匹配、不完整或矛盾的事件流。未知工具/事件失败关闭，不打印原始命令、输入、模型输出和子进程错误。

分析开始后的顶层 `error` 只记录为中途错误：必须随后收到 `turn.completed`、唯一完整建议消息，且消息与结果文件一致并通过 JSON/Schema 校验，才能采用结果。`turn.failed`、失败条目、没有成功结束的错误、工具/未知事件以及完成后的额外事件仍拒绝。gcommit 不额外发起分析请求；Codex 自身可能在同次调用内重连。

事件验证发生在进程结束后，是结果完整性检查；真正阻止执行的边界是调用前的无工具目录、关闭处理器和配置隔离。提示词要求“不使用工具”本身不算安全边界。

## 实测证据与复验

普通 `pnpm check` 使用真实 Node 子进程替身，不访问真实模型。两条独立验收命令必须明确执行：

```bash
pnpm test:codex:isolation
pnpm test:codex:live
```

第一条使用真实 Codex 二进制和无认证的本机回环服务，不转发请求、不读取或保存凭据。检查请求中的 tools 和 additional_tools 为空、模型只接收固定指令及合成 stdin、父目录和工作目录 AGENTS.md 标记不进入请求、MCP 和 hooks 启动诱饵不执行。

服务还故意返回 exec_command、shell、apply_patch、read_file、MCP、spawn_agent、browser、computer 和 Code Mode exec 共 9 个伪造调用。已验证每个处理结果均为不支持/禁用，合成秘密未被读取，标记文件未创建，原文件未改变。这比让模型自行回答“没有权限”提供更直接的证据。另一个回环用例只发送响应开始事件后断流，再返回正常响应，验证真实 Codex 的中途错误及成功完成事件能通过校验。

第二条会使用当前登录访问 OpenAI 并消耗少量额度，只发送固定合成文本和 `{ok: boolean}` Schema；已验证得到 `{ok: true}`。不会分析业务项目或执行 Git 写操作。认证存储 file/keyring/auto 的解析和传参一致性由回归测试覆盖；未切换用户认证存储来做真实钥匙串登录测试。

验收限于上述版本、平台和可复现夹具，不能声称隔离了被替换的 Codex 可执行文件、被攻陷的本机账号或恶意并发文件替换。Codex 仍需读取现有认证并访问模型服务，可能维护自己的认证/运行缓存；`ephemeral` 不意味着整个进程零磁盘写入。系统或账号强制要求与固定隔离配置冲突时，不应放宽配置来运行。

## 参考

- [OpenAI 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)：exec、配置隔离、JSONL 与 Schema 输出。
- [OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) 与 [配置 Schema](https://learn.chatgpt.com/docs/config-schema.json)：配置字段含义。
- 具体工具目录禁用枚举及处理器拒绝行为以本机上述版本的真实夹具结果为依据，不能外推到其他版本。

Step 9 同时提供真实 PTY 的完整建议 → 确认提交 → 单独确认本地 bare 推送验收：`pnpm test:e2e:live`；该命令使用合成仓库，消耗少量额度。所有可复验入口和未验收平台见 [验收说明](ACCEPTANCE.md)。

## 模型设置命令

`gcommit model` 使用 `src/codex/catalog.ts`，只运行版本检查和 `debug models --bundled`，复用白名单环境、私有工作目录和隔离参数；不读取认证存储配置，不执行 login status 或 exec。目录输出受 4 MiB 限制，两次探测合计最多 10 秒（若 codexTimeoutMs 更短则采用该值），可取消；菜单等待时间不计入探测期限。未知版本、平台或不兼容目录停止，不回退到未经验证的调用。

模型目录解析与生成适配器共用；默认模型遵循可见性与 priority，档位来自目录与配置枚举的交集。菜单显示目录不保证账号对每项模型的授权，生成时仍执行既有登录与隔离验证。保存只涉及 `~/.gcommit/config.json`，不修改 Codex 的模型缓存或配置。
