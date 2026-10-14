# 安装、升级与卸载

## 支持范围

当前完整功能已验收 **macOS arm64、Node.js 24+、pnpm 12.5.1、Git、Codex 0.162.0-alpha.17.2**。Codex 须已安装、可从 PATH 找到并已登录；无需另填 API Key。不支持的 Codex 版本或平台会明确拒绝分析，不应通过修改版本号绕过门禁。[验收范围](ACCEPTANCE.md)。

gcommit 的依赖只安装在工具自身的全局目录。目标项目可以不是 Node 项目，不需要 package.json、node_modules 或项目内配置。运行 gcommit 不需要 Python；开发者运行 PTY 验收才需要 Python 3。

当前是私有开发包 `0.1.0-dev.8`，未发布到 npm。请使用本仓库生成的 tarball，不要执行 `pnpm add -g gcommit-cli` 从公共 registry 查找同名包。

## 从源码全局安装

在 **gcommit-cli 自己的目录**执行。先确认 `node --version` 至少是 24、`pnpm --version` 是 12.5.1：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack
pnpm add -g ./gcommit-cli-0.1.0-dev.8.tgz --ignore-scripts
pnpm bin -g
type -a gcommit
gcommit --version
gcommit --help
```

tarball 已包含编译结果，全局安装不需要再运行构建脚本。运行依赖仍需由 pnpm 安装；首次安装可能访问 registry，需要正常网络。固定的直接依赖版本不等于冻结所有传递依赖；本地 tarball 安装不会使用源码的锁文件来锁住整个全局依赖树。

`type -a gcommit` 显示的首个路径应位于 `pnpm bin -g` 输出的目录，版本应为 `0.1.0-dev.8`。这一步用于发现旧安装、alias 或另一个 Node 环境中的同名命令。不要在确认路径前删除其他命令。

安装完成后，可先在任意目录运行 `gcommit model` 选择并保存模型与档位，再到项目中生成：

```bash
cd /path/to/any/git-project
gcommit -d
# 查看、编辑建议后确认提交；推送仍需单独确认
gcommit
```

从 0.1.0-dev.2 起，`gcommit -d` 是中文预览短命令；长参数 `--dry-run` 继续可用。默认语言为中文，已有全局 language 配置和临时 `--language` 参数仍优先。直接 `gcommit` 仍进入交互提交。

安装的是 tarball 的独立副本。后续修改 gcommit 源码不会自动改变已安装命令，必须重新打包安装。

## PATH 与常见问题

- pnpm 12 使用 `PNPM_HOME/bin` 放置全局命令。若报 `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`，先通过 `pnpm setup` 配置当前用户的终端环境，再重开终端；此命令可能调整 shell 配置，检查其输出。已手动设置 PNPM_HOME 时，确保 PATH 包含其 **bin 子目录**。不要直接套用旧版 pnpm 的目录布局。
- `gcommit: command not found`：检查 `pnpm --version`、`pnpm bin -g`、`type -a gcommit`。调整 PATH 后开新终端；不要在业务项目执行 add 来解决全局命令问题。
- 升级后仍显示旧版本：检查 alias/function 与 PATH 中更靠前的 gcommit；必要时新开终端清除命令路径缓存，再用全局 bin 中的完整路径核对。
- 切换 nvm 等 Node 环境后，重新检查 Node 版本、pnpm 版本和全局 bin。不同包管理器/Node 环境的全局安装可能互相独立。
- 安装因下载失败或损坏 tarball 中止：保留错误输出，确认网络、包路径和版本，再用 `gcommit --version` 检查现有安装；不要手动删除整个全局目录。测试覆盖损坏 tarball 时旧命令仍可用，但不保证断电/磁盘满等任意中断都可自动恢复。
- `CODEX_UNSUPPORTED`：安装 gcommit 成功不代表 Codex 版本已通过权限隔离验收。使用当前支持组合，或为新组合补充验收，不能关闭安全门禁。[其他运行问题](TROUBLESHOOTING.md)。

## 升级

1. 更新 gcommit-cli 的源码；在该目录执行 `pnpm install --frozen-lockfile` 和 `pnpm release:check`。
2. 执行 `pnpm pack`，使用实际新版本文件名安装：`pnpm add -g /absolute/path/to/new-package.tgz --ignore-scripts`。
3. 新开终端，用 `type -a gcommit` 和 `gcommit --version` 确认运行的是新包，再到合适的 Git 仓库执行 `gcommit -d`。

升级不会修改 `~/.gcommit/config.json`。当前版本没有配置迁移器；新版本如果改变配置协议，须在变更记录中明确迁移方式。保留上一个已验证 tarball，可以用相同安装命令恢复该包版本；配置不兼容时须按相应版本说明处理。

## 卸载

先回到 gcommit-cli 源码目录，确认 `pnpm --version` 仍为 12.5.1，再在同一个 PNPM_HOME 环境执行；Corepack 在其他目录可能选中不同 pnpm 版本：

```bash
pnpm --version
pnpm remove -g gcommit-cli
type -a gcommit
```

该全局环境中的 gcommit 命令和包登记会移除。若仍能找到 gcommit，检查是否来自 alias、另一个包管理器或 Node 环境，不要直接删除来源不明的文件。

卸载保留 `~/.gcommit/config.json`、Codex 登录、Git 仓库及其他全局工具。是否删除自己的 gcommit 配置由用户决定；无需删除 Codex 配置。pnpm 的共享 store/cache 可能保留可复用内容，卸载不承诺擦除所有缓存，也无需为此清空 store。

## 开发验收

`pnpm test:package` 验证真实 tarball 的完整运行文件和文档、禁止携带源码/测试/开发计划；`pnpm test:install` 使用临时 HOME、PNPM_HOME、store、state 和空 npmrc，执行全新/重复安装、旧版夹具升级、配置保留、损坏包失败、卸载及其他命令共存，再从实际安装入口运行模型设置命令与真实 PTY、6 个预览语言回归和 16 个提交推送 PTY 场景。旧版是合成夹具，不代表已有历史公开版本。

安装验收需要 registry 网络、已缓存可用的 pnpm 12.5.1、Python 3 与当前支持平台。不会调用真实模型、不读取 Codex 凭据、不操作日常全局安装；结束后清理临时目录。Corepack 仅复用本机已有包管理器缓存，禁用自动下载/更新。它是显式验收，不包含在普通 `pnpm check` 中。
