# Step 1：独立 CLI 骨架

**目标：** 在独立仓库提供可构建、可打包、脱离业务项目运行的基础入口。当前阶段明确拒绝执行尚未接入的分析、提交和推送。

**设计：** [已确认设计](../DESIGN.md)。本步骤只交付总体计划的 Step 1。

## 接口与文件

- src/cli.ts：bin 入口、参数解析、帮助版本、全局配置调用、受控退出。
- src/config.ts：loadConfig(configPath, overrides) → Promise<Readonly<Config>>；输入先校验，配置缺失不创建文件。
- src/process.ts：runProcess(executable, args, options) → Promise<ProcessResult>；不拼 shell，支持 stdin、超时、取消及限额。
- src/errors.ts：稳定错误类别，不保存含秘密的完整子进程错误。
- tests/cli.test.ts、config.test.ts、process.test.ts：外部可观察行为测试。
- package.json、tsconfig*.json、格式配置和 README：独立构建、安装与检查入口。

## 实施与验收

1. 初始化独立仓库，在 codex/cli-foundation 实现，不复用业务项目工作树。
2. 先写测试与接口桩，执行测试并确认失败原因来自未实现行为。
3. 实现参数、配置和进程封装；覆盖参数字面值、中文换行、NUL、错误输出脱敏、配置优先级、异常配置、超时、取消、输出限额。
4. 运行 pnpm check，类型、格式、编译与行为测试全部通过。
5. 使用 pnpm pack 制作产物，在隔离目录安装并启动包的 bin；该目录没有业务源码或业务依赖。
6. 完成一次独立代码评审，修复重要问题，记录检查结果与平台限制。

## Review Focus

- 缺少配置时不能创建 ~/.gcommit 或目标项目文件。
- CLI 临时覆盖不能掩盖全局配置的错误类型。
- 参数、配置、stderr 中的敏感字符串不能进入默认错误消息。
- 进程末尾换行和 NUL 不能被自动剥离，后续 Git 解析依赖原始分隔符。
- 安装包必须独立定位自身版本，不能意外读取当前业务项目 package.json。

## 实施决定

- 使用用户指定的新独立仓库作为隔离边界，不创建 wanxuan-admin 的 worktree；否则会错误耦合两个项目。
- Clack 留到 Step 5 再安装，Step 1 只引入已实际使用的 Execa 和 Zod。
- Zod 固定 4.6.5，保留 minimumReleaseAgeStrict，移除安装器为过新版本生成的豁免；代价是暂不使用较新补丁版本。
- 先保持 private/UNLICENSED，不擅自选公开许可证或发布包名；代价是发布前需单独确认。
- 新仓库还没有历史提交，本步骤直接评审完整文件集，不用依赖已有 BASE 的工作树脚本。

## 验证记录

- RED：19 项行为测试中首轮 16 项失败；将 3 项过宽的异常断言收紧后，配置模块 7 项全部按未实现行为失败。
- 评审回归 RED：追加 stdout、stderr 中文输出越限和恰好达到字节上限的 4 项测试，其中 2 项越限测试按预期失败。
- GREEN：改为原始字节缓冲后再解码，23 项行为测试全部通过；原有换行与 NUL 测试仍通过。
- 完整检查：pnpm check 通过，包括类型、格式、构建与全部测试。
- 打包安装：pnpm pack 通过；安装包只包含 dist、文档、README 和 package.json。在临时全局目录分别用 pnpm 11.18.0、12.5.1 安装，通过 bin 启动帮助和版本。
- 运行隔离：空工作目录中运行帮助不创建文件、不需要目标项目依赖；目录中存在非法 package.json 时仍能读取安装包自身版本。
- 独立评审：1 项 Important 问题（中文输出按字符数而非字节数限制）已修复并补测试；无 Critical 或 Minor 项。评审未覆盖尚未实现的 Git/Codex 流程。
- 平台范围：仅在当前 macOS、Node.js 24.16.0 验证；Linux、Windows 和真实 Codex 调用尚未验收。
- 安装验证只使用临时全局目录，未把开发版本安装进用户日常使用的全局命令目录。
