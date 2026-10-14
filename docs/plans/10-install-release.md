# Step 10：全局安装、升级卸载与发布准备

> 使用 superpowers:executing-plans 原地执行已授权的 Step 10；一次 fresh-context 最终评审。

**Goal:** 以实际 tarball 验证本机安装生命周期，提供可重复的发布检查和操作文档。
**Architecture:** 复用 pnpm 12.5.1 的全局安装，不添加安装器或自更新器；Node 测试驱动临时 HOME/PNPM_HOME，真实执行包管理器和安装后的 CLI。
**Tech Stack:** Node 24、TypeScript、pnpm 12.5.1、node:test、execa、已有 PTY 验收。
**Spec:** docs/DESIGN.md 与 docs/PLAN.md 的 Step 10。

## Global Constraints

当前支持 macOS arm64 + Codex 0.162.0-alpha.17.2。不扩大平台门禁，不发布 npm、不推送远程、不操作日常全局安装或用户配置。目标 Git 项目不安装依赖。保留 private: true、UNLICENSED、0.1.0-dev.1。不新增依赖，不手改锁文件或 dist。

## Tasks

- [x] Task 1：新增 tests/package.integration.ts（显式打包检查）和 tests/install.integration.ts（真实安装生命周期），可共享 tests/package-helpers.ts。先用包内容断言发现开发计划被打入包、缺少安装/变更文档；再收窄 package.json files 并补齐文档。Expected: RED 为包内容契约，GREEN 为完整运行文件与必需用户文档存在、src/tests/plans/依赖目录均不进入包。
- [x] Task 2：新增 test:package、test:install、release:check。安装验收使用隔离 HOME/PNPM_HOME/store/state/config；验证全新安装、重复安装、旧版本夹具升级、help/version、配置读取与保留、PATH 失配、卸载命令移除及其他全局包保留。沿用 GCOMMIT_TEST_CLI 运行安装包 16 个 PTY 场景。Expected: 真实 pnpm 12.5.1、包入口确实脱离源码、目标目录无依赖，生命周期全绿。
- [x] Task 3：完善 README、docs/INSTALL.md、docs/RELEASE.md、CHANGELOG.md、AGENTS.md、验收与进度。执行 pnpm release:check；最后一次独立评审，Important/Critical 同轮 RED→GREEN 修复，完整检查通过。Expected: 本地发布准备可复验；公开发布、跨平台和远程认证仍明确未验收。

## Interfaces

- package-helpers 负责从仓库定位实际 pnpm 版本、pack 到唯一临时目录、验证包内容并提取到临时目录。所有外部命令使用参数数组和时限；不能改变日常全局目录。
- package.integration 只做打包内容验收；install.integration 消费 tarball 和 manifest，调用真实全局安装，然后以实际安装 dist/cli.js 调用已有 GCOMMIT_TEST_CLI 验收入口。
- release:check 顺序执行普通 check、源码 test:e2e、test:package、test:install；不执行真实模型请求或 publish。

## Review Focus

- PATH 遮蔽、Node 版本管理器变化：必须核对实际命令，不能把别处 gcommit 当作安装成功。
- 全局卸载只移除本工具，保留用户配置和其他全局命令；不能把包缓存仍存在描述成卸载失败或零痕迹删除。
- 安装使用 tarball 中完整运行文件，不通过源码 link、开发依赖或目标项目依赖掩盖缺包。
- 测试环境、包管理器缓存/配置、失败清理边界；错误退出不得对日常全局安装做补救性删除。
- 发布命令停止于检查，public 名称、scope、许可证与额外平台没有被默认为已确认。

## Ledger

- Ruling: 沿用无 HEAD 的 codex/cli-foundation，以 /private/tmp/gcommit-step10.dkks8cav/baseline 保存 Step 9 基线，不创建提交/worktree — 独立仓库尚无初始提交，避免把先前未提交成果混入本步 — 无提交级回退，需保留基线。
- Ruling: 已授权的 Step 10 使用现有版本和私有 tarball，公开包名与许可证留待真正发布时确定 — 安装/发布准备不等于公开发布授权 — 暂不能从公共 registry 安装本工具。
- Ruling: 生命周期是既有安装行为的验收，不人为破坏产品制造失败；包内容调整先验证 RED→GREEN — 无新运行时业务逻辑 — 测试之外的包管理器/平台组合仍未保证。
- Pre-flight: package 生成 tarball 供 install 消费；pack 的 prepack 只 build，release:check 不与 prepack 循环调用。配置保持原字节，旧版本夹具仅验证替换行为，不冒充历史公开发布。安装成功不扩大 Codex 平台门禁。

- Task 1: complete — 实际 tarball 内容测试先 RED（开发计划被打入、缺安装/发布文档与 CHANGELOG），调整 files 白名单和文档后 GREEN 1/1。运行文件逐字节核对，未修改生产源码或依赖版本。
- Task 2 首轮：全新/重复安装、合成旧版升级、配置读取与保留、损坏 tarball 失败、PATH 缺失均符合预期；两个后续检查因 pnpm 的全局模式警告进入 stdout 使 JSON.parse 失败。通过实际命令确认 list 增加 --loglevel error 后只输出 JSON，不用字符串截取猜测数据边界。

- Task 2: complete — test:install 7/7（父测试 + 6 个生命周期检查），其中实际安装入口 PTY 16/16。PATH 缺失正确失败，全新/重复安装和旧版夹具升级成功，损坏包未破坏当前命令，卸载移除本工具且保留配置与另一个全局夹具。证据：install-green.log；未调用真实模型。

- Task 3 首轮 release:check 被基线已有格式问题拦截：src/analysis/session.ts 的 body 三元表达式缩进，以及用户全局 Git ignore 已排除的 .claude/settings.local.json。
- Ruling: 仅格式化 session.ts 的七行缩进，并将机器专用 .claude/settings.local.json 登记到仓库 Git/Prettier 忽略 — 恢复完整检查且保留本机设置和原逻辑，不读取或改写设置内容 — 增加一处格式 diff 与本机配置忽略规则，不改变运行行为。

- Task 3 实现与验收完成，待最终评审：pnpm release:check 全绿，pnpm check 299/299，源码 PTY 18/18，tarball 1/1，安装生命周期 7/7（含安装包 PTY 16/16）。证据：release-check-final.log。38 个包内相对文档链接全部闭合，依赖锁和本机 .claude/settings.local.json 字节未变。

- Final review: 一次 fresh-context gpt-6-astra/high 只读评审完成；Critical/Important/Minor 均无，无需修复或二次评审。
- Final: Ruling: 其他平台及 Node/pnpm/Codex 组合未评价 — 保持当前实机支持矩阵与版本门禁，不把安装通过扩张为全平台支持 — 其他组合仍需对应环境验收。
- Final: Ruling: 公共 registry 发布、包名归属和许可证未评价 — 保持 private: true、UNLICENSED 与开发版本，未执行 publish — 仍不能宣称公共安装可用或开源许可证已确定。
- Final: Ruling: 真实 SSH/HTTPS 推送认证及新增真实模型验收未评价 — 本步只改安装/文档/测试和源码格式，沿用 Step 9 已有真实 Codex 证据，联网推送认证保持待验收 — 不新增真实认证覆盖，不能保证任意远程环境。
- Final: Ruling: 断电、磁盘满等任意中断恢复未评价 — 仅承诺已测的损坏 tarball 失败后原命令可用，文档明确限制 — 任意系统中断仍可能需要人工修复安装。
- Final: Ruling: 历史配置迁移未评价 — 尚无历史公开版本与配置协议变更，旧版夹具只证明包替换；保留配置原字节 — 未来协议改变时必须另加迁移设计与回归。
- Final: Ruling: 本机 .claude/settings.local.json 内容未评价 — 不读取或改写其内容，逐字节核对相对基线未变，排除 Git/Prettier — 本工具不保证该外部工具配置的有效性。
- Task 3: complete — 完整 release:check 与独立评审通过，当前 macOS 私有分发准备完成；没有延期 Minor。
- 收尾：按 finishing-a-development-branch 保留 codex/cli-foundation 原地成果；仓库无 HEAD/remote，不创建提交、PR、远程推送或公开发布。本步基线与检查记录继续保留于 /private/tmp/gcommit-step10.dkks8cav，避免无提交记录时失去回退依据。

- 最终交付包：gcommit-cli-0.1.0-dev.1.tgz，40 个文件，SHA-256 为 `4cc7709d37aa33bad11a704ad3f74e51bd461e8ac04a0eabb59de96079290169`。最终文档更新后重新 pack，并用同一包内容断言核对实际交付 tarball，PASS；format:check 全绿。证据：format-final.log、pack-final.log、package-final.log。
