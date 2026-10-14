# 本地发布准备

当前维护私有 tarball，`private: true`、`UNLICENSED`，没有 npm 发布、自动升级或远程发布步骤。公开发布前须另行确定唯一包名/scope、许可证、仓库地址、发布权限与受支持平台。

## 版本与变更记录

版本以 `package.json` 为准，CLI 从安装包清单读取。每个分发版本应有唯一版本号，并在 [CHANGELOG](../CHANGELOG.md) 记录用户可见行为、配置迁移和已知限制；不要向用户分发同版本但内容不同的 tarball。

正式准备下一版时，修改 package.json 的 version、对应版本测试、CHANGELOG 和安装示例；用项目指定 pnpm 正常更新必要的锁文件，不能手改锁文件。当前版本为 `1.0.2`，尚未公开发布。

版本号采用 `主版本.次版本.修订版本`，当前对应 Git 标签为 `v1.0.2`。安装包统一使用短文件名 `gcommit.tgz`；文件名不改变包内版本，Git 标签也不会自动更新 `package.json`。每个版本保留独立的 Release 附件或归档目录。命令仍为 `gcommit`，包名和仓库名仍为 `gcommit-cli`。

确认源码和包内版本一致、检查通过并提交代码后，再为该提交创建对应版本标签。

## 检查与打包

检查依赖本地完整的 `tests/`，该目录不随 Git 分发；仅克隆远程源码无法执行完整验收，需要另行取得测试文件。

在 gcommit-cli 源码目录执行：

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm pack --out gcommit.tgz
shasum -a 256 gcommit.tgz
```

`release:check` 按顺序执行：

1. `pnpm check`：类型、格式、构建及普通测试。
2. `pnpm test:e2e`：源码 CLI 的 PTY 流程与超时清理回归。
3. `pnpm test:package`：实际 tarball 文件集合、内容、bin 入口及私有包元数据。
4. `pnpm test:install`：临时全局安装/重复安装/升级/卸载与安装包完整 PTY 流程。

任何一步失败即停止。命令不发布包、不创建 Git commit/tag、不推送远程、不消耗真实 Codex 额度。`prepack` 仅构建，因此单独 `pnpm pack` 成功不能替代完整发布检查。验收会使用 registry 网络下载依赖；它不是离线供应链锁定流程。

打包白名单只包含编译后的 JavaScript、package.json、README、CHANGELOG 和用户文档；开发计划、src、tests、node_modules、用户配置与认证不入包。tarball 自带所有 gcommit 运行代码，第三方运行依赖在全局安装时下载，不要求目标项目提供依赖。

## 发布候选验收记录

保留版本、tarball 的 SHA-256、系统/架构、Node/pnpm/Git/Codex 版本以及每条验收命令的结果。对准备交付的同一 tarball，按 [安装说明](INSTALL.md) 在源码目录外核对 help/version/PATH，测试后再交付。

若修改 Codex 适配器、版本或平台，需要重新执行 [权限隔离和真实调用验收](CODEX_ISOLATION.md)，以及 `pnpm test:dry-run:live`、`pnpm test:e2e:live`。这些命令须显式运行，使用合成数据并消耗模型额度；不能把替身通过当作真实调用通过。

当前 macOS arm64 的实测与跨平台缺项见 [验收说明](ACCEPTANCE.md)。Linux、Windows、macOS x64 及真实 SSH/HTTPS 推送认证仍需对应环境验证，不能仅凭 tarball 安装成功宣布支持。
