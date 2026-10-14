# Step 3：Codex 接入

## 范围

实现独立 Codex 适配器，复用本机登录；接收已过滤的 prompt 和调用方的 Zod schema，支持模型、推理强度、整次调用超时和 AbortSignal 取消。普通 CLI 仍等待 Step 4 的过滤、Prompt 和建议语义校验，不发送原始 Git Context。

## 任务与验收

1. 固定本机已验证的 Codex 版本与平台；构造无工具模型目录和受限 exec 配置，保留模型默认选择。无网络测试覆盖未知版本、目录/模型/推理强度校验和环境隔离。
2. 实现 stdin、私有临时目录、Schema、最后响应文件、事件校验、错误脱敏、整次超时与取消、所有出口清理。使用独立假 CLI 子进程验证行为，普通测试不调用真实 Codex。
3. 使用真实二进制与无认证回环服务验证实际工具目录、输入上下文和伪造工具调用拒绝，再用已登录 Codex 完成最小真实 JSON 请求。更新使用与隔离边界文档。
4. 一次独立评审；修复重要问题后运行 pnpm check，打包并从源码以外目录验证安装包。

## Review Focus

- 版本和模型元数据是否能重新开启工具；仅隐藏工具名称是否仍能调用处理器。
- 继承环境、模型目录、自动文档/技能、MCP/Apps/plugins/hooks 是否绕过受限配置。
- 子进程退出、响应事件、结果文件和清理之间是否会接受不完整结果或遗留私有内容。
- 未指定模型、auto 推理、未登录、未知版本、超时和取消是否有可理解且脱敏的行为。

## 执行记录

- 基线：pnpm check，66/66 通过。
- Task 1: Ruling: 当前仓库尚无 HEAD；沿用已授权的独立仓库，以临时 tar 基线和本文件记录验收，代替依赖提交区间的技能脚本。代价：尚不能按提交定位变更。
- Task 1: Ruling: 本机 0.162.0-alpha.17.2 的 feature 禁用不足以移除模型目录强制暴露的 Code Mode；使用同一二进制的 bundled catalog，在本次私有副本中关闭 tool_mode/shell/patch/额外工具，并关闭自动上下文。不会修改用户 Codex 配置；不在目录中的模型拒绝运行。代价：Codex 升级、新模型或其他平台须重新验收。

状态：已完成。

- Task 1–2: complete，28 个适配器测试先在 FEATURE_UNAVAILABLE 骨架上失败；环境与平台测试及模型元数据回归补充后，pnpm check 为 99/99。元数据说明字段丢失测试 RED→GREEN；超限替身改为刷新 stdout 后退出，避免测试进程自身截断输出。
- Task 3: complete，真实二进制的无认证回环隔离测试 2/2，通过空工具目录、无自动上下文、MCP/hooks 启动诱饵及 9 种伪造工具调用拒绝验证；真实登录 JSON 请求 1/1 通过，仅发送合成文本。
- 独立评审：一次全量只读评审，Critical 0、Important 1、Minor 0。重要问题为 keyring/auto 认证预检与 exec 存储不一致。

- Final: fixed 认证存储不一致 — file/keyring/auto 解析与调用参数回归测试 RED→GREEN，新增只读 TOML 解析依赖 smol-toml 1.9.0，pnpm check 109/109。只保留认证存储枚举，不继承其他用户配置。
- Final: Ruling: 评审列出的 Step 4 过滤/语义校验/CLI 接线仍按计划留在下一步；本轮只交付适配器。代价：当前默认命令和 dry-run 仍不可分析。
- Final: Ruling: 评审列出的其他版本、平台、企业 provider/代理沿用明确拒绝或未适配范围；不扩大支持声明。代价：这些环境需另行验收。
- Final: Ruling: 评审列出的可信二进制被替换、恶意并发替换仍属于本机信任边界之外。代价：不能以本模块代替被攻陷主机的系统级隔离。

- Task 4: complete，最终 pnpm check 109/109；修复后 pnpm test:codex:isolation 2/2、pnpm test:codex:live 1/1。冻结锁文件离线安装通过；最终 tarball 在全新临时 pnpm 全局目录安装成功，从源码目录之外运行帮助、版本和 Codex 适配器成功，目标目录保持不变。
- 评审无遗留 Critical、Important 或 Minor。未修改用户认证存储、日常全局安装、Shell 配置或业务仓库；未创建提交、推送或 PR。
