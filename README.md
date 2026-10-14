# gcommit

通过本机已安装、已登录的 Codex CLI 生成 Git 提交建议。工具独立安装，目标 Git 项目不需要安装任何依赖。

当前版本 `1.0.0`，Git 版本标签使用 `v1.0.0`，分发安装包统一命名为 `gcommit.tgz`。包名和仓库名仍为 `gcommit-cli`，终端命令为 `gcommit`。

## 当前状态

正在按已确认方案分步实现。**已完成 Step 1–8**：CLI、只读 Git Context、Codex 受限适配器、敏感过滤、上下文预算、可用的 `--dry-run`、建议交互菜单、确认后的本地提交及单独确认的单分支推送，并提供异常恢复指引和有界脱敏 Debug。**Step 9 已推进 macOS 完整流程与真实 Codex 验收，跨平台实机验收仍待完成**，**Step 10 已提供安装、升级卸载验收与本地发布准备**；详见 [验收与平台支持](docs/ACCEPTANCE.md)。

`gcommit -d`（等同 `--dry-run`）默认生成中文建议，可以读取当前仓库，调用本机已登录 Codex，并生成一个经过结构和语义校验的提交建议；不会暂存、提交或推送。直接运行 `gcommit` 可使用、修改、重新生成、查看 Diff 或取消。选择使用后还需最终确认；确认后按工作树最终版本暂存并提交，保留 hooks 和签名。提交成功后可单独确认推送；非 TTY 使用 `--dry-run`。[dry-run 使用、过滤规则及限制](docs/DRY_RUN.md)。

## 开发环境

- Node.js 24 或更高版本。
- pnpm 12.5.1（packageManager 字段固定开发版本）。
- Git Context 测试需要本机 Git（当前验收版本 2.43.0）；运行 dry-run 还需要已登录的 Codex CLI。帮助和版本不要求 Git 或 Codex 存在。

```bash
pnpm install --frozen-lockfile
pnpm check
node dist/cli.js --help
node dist/cli.js --version
```

`pnpm check` 包含类型、格式、编译、行为测试及模型设置的真实 PTY 测试（开发验收需要 Python 3）；不调用真实模型或生产远程。`pnpm test:e2e` 显式运行真实 PTY 的 16 种完整流程，需要 Python 3 标准库。`pnpm test:e2e:live` 复用本机登录，使用少量模型额度处理合成上下文，推送仅到临时本地 bare 接收端。普通使用 gcommit 不需要 Python。安装包可通过同一套 E2E 入口从源码目录外验收，目标项目无需新增依赖。验收命令、结果和平台边界见 [验收说明](docs/ACCEPTANCE.md)。

## 本地全局安装

在 **gcommit-cli 自己的目录**执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack --out gcommit.tgz
pnpm add -g ./gcommit.tgz --ignore-scripts
type -a gcommit
gcommit --version
```

安装后可以随时 `cd` 到任意 Git 项目执行 `gcommit` 或 `gcommit --dry-run`，目标项目无需依赖。升级使用新版本 tarball 重复全局安装；卸载使用 `pnpm remove -g gcommit-cli`，保留 `~/.gcommit/config.json`。

当前包为 `private: true`、`UNLICENSED`，未公开发布。使用已构建 tarball 安装，避免依赖源码工作目录。pnpm 12 的全局命令位于 `PNPM_HOME/bin`；PATH、重复命令、Node 环境切换及失败处理见 [安装、升级与卸载](docs/INSTALL.md)。

开发者交付前运行 `pnpm release:check`，覆盖普通检查、源码终端验收、包内容以及真实全局安装/升级/卸载和安装包终端验收；该命令不会发布包或调用真实模型。详见 [发布准备](docs/RELEASE.md) 和 [变更记录](CHANGELOG.md)。

## 参数

| 参数                  | 作用                                       |
| --------------------- | ------------------------------------------ |
| `--help` / `-h`       | 显示帮助，当前可用                         |
| `--version` / `-v`    | 显示安装包版本，当前可用                   |
| `--model <name>`      | 临时指定模型                               |
| `--reasoning <level>` | 临时指定推理强度                           |
| `--language <value>`  | `zh-CN`（默认）、`en`、`auto`              |
| `--style <value>`     | `auto`、`conventional`、`repository`       |
| `-d` / `--dry-run`    | 当前可用：只分析，不暂存、提交或推送       |
| `--no-push`           | 提交后不询问推送，从不表示自动推送         |
| `--debug`             | 固定命令类别、耗时和错误码，不输出原始内容 |

模型、推理、语言、风格和 debug 参数已接入交互和 dry-run；`--no-push` 跳过推送发现及交互。不提供 `--yes`、`--force` 或自动推送入口。

## 建议交互

```bash
cd /path/to/your/project
gcommit
```

建议菜单默认选中“取消”。“使用此 Commit”进入默认取消的最终确认；确认前会说明全量提交及部分暂存边界；“修改”编辑完整标题与逐行正文，清空正文可删除要点，Tab 切到保存按钮后 Enter 保存，Esc 放弃本次编辑；“重新生成”携带上一版建议再次调用模型；“查看 Diff”显示脱敏后的净变化区间。

新增交互依赖 Clack 只安装在工具自身。详情、退出方式与限制见 [交互说明](docs/INTERACTION.md)。

## 切换模型和推理档位

```bash
gcommit model
```

可在任意目录运行，无需进入 Git 项目。先显示当前设置，再用方向键和回车选择模型、选择推理档位；两次选择完成后立即保存到 `~/.gcommit/config.json`，后续 `gcommit` 和 `gcommit -d` 共用。只更新 `model` 与 `reasoningEffort`，保留语言、预算等其他配置；不会修改 Codex 自身配置。

- 模型来自本机 Codex bundled 目录，推理档位仅列出该模型支持且工具可识别的值。保持模型时预选原档位，切换模型后预选 `auto`。
- 选择“跟随 Codex 默认”与 `auto` 可恢复默认；这使用受限调用的内置目录默认值，不继承日常 Codex 的模型设置。
- Esc、Ctrl+C、Ctrl+D 或输入结束可在保存前取消；取消不写配置。此命令需要交互终端，`gcommit model --help` 可查看帮助。
- 读取目录不检查登录、不读取 Git、不发起模型生成，不消耗模型调用额度；目录不代表当前账号已经获得每个模型的使用权限。实际生成仍需要有效登录及对应模型权限。
- 临时指定仍可用 `gcommit -d --model <名称> --reasoning <档位>`，不会改写已保存设置。

保存时会检查配置是否被其他终端修改，并原子替换文件；损坏配置、符号链接、写入冲突或无权限会停止，按错误提示处理后重试。

## 全局配置

可选位置：`~/.gcommit/config.json`。普通生成时文件不存在即使用默认值；`gcommit model` 完成选择后会创建该文件。

优先级：CLI 参数 > 全局配置 > 默认值。目标项目配置留待 V2。

```json
{
  "model": null,
  "reasoningEffort": "auto",
  "language": "zh-CN",
  "commitStyle": "auto",
  "pushPrompt": true,
  "codexTimeoutMs": 120000,
  "maxContextBytes": 1048576,
  "maxFileBytes": 10485760,
  "maxReadBytes": 20971520
}
```

- `model` 在此文件配置，也可以用 `--model <名称>` 临时覆盖；优先级为 CLI > 全局配置 > 默认。不配置或设为 `null` 时不传模型覆盖，使用本机 Codex 内置模型目录的默认选择，不直接继承 `~/.codex/config.toml` 的模型设置。`reasoningEffort: auto` 同样不覆盖模型默认推理强度。
- 每次生成前会显示当前模型和推理档位；未显式设置时分别标注“默认”和“模型默认”，档位从当前模型目录解析。目录无法确认档位时显示“auto（由 Codex 决定，具体档位未知）”，不会猜测或新增默认覆盖。
- 默认 `language: zh-CN`，日常预览只需 `gcommit -d`。已有配置明确设置 `en` 或 `auto` 时继续生效；要恢复默认中文，可删除配置中的 language 字段或改为 `zh-CN`。临时切换使用 `--language en` 或 `--language auto`。
- 推理值支持 `auto / none / minimal / low / medium / high / xhigh / max / ultra`；Codex 适配器会核对本机 bundled 模型目录，不支持的组合明确拒绝。
- `pushPrompt: false` 仅关闭询问，绝不自动推送。
- 超时限制为 1,000–600,000 毫秒。
- 本地单文件 `maxFileBytes` 为 1 KiB–10 MiB，本地总读取量 `maxReadBytes` 为 1 KiB–20 MiB；默认分别为 10 MiB、20 MiB。总量包含 patch、历史以及变更前后的文件版本，同一个文件的旧版和新版分别计入。
- 模型上下文 `maxContextBytes` 独立控制完整 Prompt 的 UTF-8 字节数，范围 8 KiB–8 MiB，默认 1 MiB；不要求单文件读取预算小于模型预算。调整读取预算不会增加发送给模型的预算。
- 文本统一使用真实 Diff 变更块，通常保留前后各三行，只省略未变化内容。所有文件在一次调用中完整分析，不自动分批或生成分批摘要；修改行超预算时整次停止。该预算控制发送量和资源开销，不是推理档位或模型官方 token 容量，实际可接受输入还取决于所选模型。
- 升级保留已有显式配置；`maxContextBytes: 196608` 仍按旧值生效，删除该项可使用新的 1 MiB 默认值。若之前填写了 `maxFileBytes: 65536`，需删除该项以采用新默认值，或改为 `10485760`。新增的 `maxReadBytes` 未配置时采用默认值。
- 配置文件最大 64 KiB。未知字段、错误类型、非法 JSON 或超限配置会报错；CLI 覆盖不能掩盖损坏的全局配置。
- 不在此文件保存 Token、密码或 Codex 认证文件副本。

## Git Context 模块

内部入口：`src/git/context.ts`；构建后为 `dist/git/context.js`。

- `readGitContext(cwd, options?)`：从任意子目录定位仓库根目录，读取分支、HEAD、porcelain v2 状态、staged/unstaged patch、untracked 文件和最近 10 条提交标题。
- `netChanges`：逐文件对比 HEAD 与工作树最终版本，提供 `before`、`after` 和新增/修改/删除/类型变化。重命名原路径在 `changes.oldPath` 中保存；净变化按原路径删除、新路径新增表示。
- `assertGitContextUnchanged(context, options?)`：复核 HEAD、index、状态和工作树原始字节摘要；内容变化使旧快照失效。读取本身也做两遍采集核对。

暂存后撤销、暂存删除后同名重建、首次提交和部分暂存分别有测试，不能把 staged 与 unstaged patch 简单相加。已跟踪文件的净变化由 Git 相对 HEAD 的比较确定，沿用实际 index 的 CRLF 规则。HEAD 版本包含真实 blob OID，工作树版本的 oid 为 null，使用原始字节摘要复核，不提前声称最终暂存 OID。untracked 尊重 Git 忽略规则；路径使用 NUL 分隔及 literal pathspec，保留中文、空白、换行和选项形状的文件名。

单文件版本中的二进制与符号链接只提供大小、模式和摘要，`content` 为 null；不读取符号链接指向的内容。stagedDiff 和 unstagedDiff 使用 Buffer 无损保存原始 patch，不能假定为 UTF-8；它们遵循 Git 的输出语义，仍可能包含旧行、非 UTF-8 字节和符号链接目标字符串。**整个返回值都是未经敏感过滤的内部数据，不可直接打印或发给模型。** Step 4 的 `src/analysis` 负责过滤和 AI 上下文构造。

默认读取上限为 200 个候选路径、单文件版本 10 MiB、patch/历史/文件版本合计 20 MiB；元数据命令单流和 index 仍为 4 MiB。`maxFileBytes`、`maxReadBytes` 可分别下调本地预算；模型发送预算另由 `maxContextBytes` 控制。超限明确失败，提示来源、候选文件编号（文件超限时）、实际大小、上限及配置项；流式 Git 输出提前停止时说明完整大小未知。不会返回截断的上下文。

当前明确拒绝冲突、Detached HEAD、merge/rebase/cherry-pick/revert/am/bisect 等进行中状态，以及 submodule、sparse checkout、assume-unchanged、skip-worktree、自定义 filter/working-tree-encoding、部分克隆、非法 UTF-8 路径和不支持的特殊文件。超大二进制也先拒绝，后续需要单独设计有界摘要策略。

读取关闭 Git 可选锁、fsmonitor、外部 diff、textconv 和远程传输；不暂存、提交或修改 index。配置与文件在读取期间被恶意并发替换不属于已建立的安全隔离边界；两遍采集用于检测通常的并发编辑，不能代替后续提交前复核或系统级隔离。

## Codex 适配器

内部入口：`src/codex/adapter.ts`；构建后为 `dist/codex/adapter.js`。`runCodex(prompt, schema, config, { signal? })` 接收已过滤文本和 Zod Schema，返回通过校验的结构化结果。支持模型配置、整次超时和取消；使用私有临时目录，结束后清理。

当前隔离仅验收 **macOS arm64 + Codex 0.162.0-alpha.17.2**；未知版本与平台拒绝运行。本机真实二进制的无工具/伪造工具调用测试和真实登录请求已通过。适配器不直接接收原始 Git Context；dry-run 已通过 Step 4 过滤和 Prompt 接入。详情及显式复验命令见 [Codex 隔离说明](docs/CODEX_ISOLATION.md)。

## 完整流程

读取 Git 变更 → 本地安全过滤 → Codex 生成一个建议 → 使用/修改/重新生成/查看 Diff/取消 → 最终确认 → 暂存与提交 → 单独确认推送。

全量提交按确认时的整个仓库快照进行，包括工作树最终版本。分析后内容发生变化，原确认失效。敏感内容保护、Git 异常状态和 hooks 行为详见 [提交说明](docs/COMMIT.md)。

这是本地 CLI，不代表模型在本地运行。dry-run 会发送过滤后的上下文，可能访问网络并消耗额度；仍会使用并清理私有临时文件。

## 项目文档

- [安装、升级与卸载](docs/INSTALL.md)
- [本地发布准备](docs/RELEASE.md)
- [变更记录](CHANGELOG.md)
- [dry-run 使用与边界](docs/DRY_RUN.md)
- [交互说明](docs/INTERACTION.md)
- [最终确认与提交](docs/COMMIT.md)
- [单独确认与推送](docs/PUSH.md)
- [异常恢复与安全 Debug](docs/TROUBLESHOOTING.md)
- [验收命令与平台矩阵](docs/ACCEPTANCE.md)

设计、进度与逐步开发记录在源码仓库的 `docs/DESIGN.md`、`docs/PLAN.md`、`docs/plans/` 中维护，不进入安装包。
