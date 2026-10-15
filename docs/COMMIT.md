# 最终确认与本地提交

Step 6 在建议菜单选择“使用此 Commit”后，展示分支、候选文件、净变化数量及完整消息，再次询问是否暂存并提交。默认取消；取消/关闭输入不修改仓库。确认等待期间仓库变化会使原计划失效。

```bash
gcommit
gcommit --language zh-CN --style conventional
```

## 全量提交的含义

确认范围覆盖当前仓库 staged、unstaged 和未忽略的 untracked，以工作树最终版本为准，包括运行目录之外的仓库文件。已有部分暂存边界会被覆盖，确认界面会说明。同一文件的暂存中间版本若最终已撤回到 HEAD，也会整理回最终版本；它可以出现在候选清单中，但不形成提交净变化。

敏感内容过滤作用于 AI 上下文以及路径、Diff 和诊断日志，不从 Git 提交中排除文件。提交消息按用户审核后的内容展示和提交，不做敏感值或脱敏标记拦截。新增/修改的敏感路径仍在分析阶段阻断；普通源码中识别到的凭据仅脱敏给 AI，不代表实际文件已经安全或被修改。规则见 [dry-run](DRY_RUN.md)。

## 执行与复核

1. 复核原始 HEAD、分支、index、状态与工作树快照，检查提交身份和支持的 Git 状态。
2. 用已确认的候选路径构成 NUL 清单，通过 stdin 执行 `git --literal-pathspecs add -A --pathspec-from-file=- --pathspec-file-nul`。已经从 index 删除且不需重新加入的旧路径不再次传入，不加 `--force`。
3. 用 `git write-tree` 读取真实 index 对应树，再读取 Git Context：净变化必须仍与原确认一致，且没有未暂存/未跟踪的候选变化；commit 前再核对这个新快照。
4. 用 stdin 向 `git commit --quiet --file=- --cleanup=verbatim` 提供完整消息及末尾换行，按 UTF-8 保存，不拼 shell，也不把消息放入参数。
5. 读取原分支的新提交，核对 parent、tree、message 和当前分支。随后报告提交标识与是否仍有未提交变化。不能读取后续工作树时明确说明，不能声称干净。

可处理首次提交、特殊文件名、重命名/删除、部分暂存、二进制、符号链接和已支持的 CRLF/文件模式语义。既有冲突、进行中的 Git 操作、submodule、sparse checkout、自定义 filter/encoding 和特殊 index 状态继续拒绝。

## Hooks、签名与失败

保留 Git 的 hooks（含 core.hooksPath）与签名设置，不使用 `--no-verify` 或关闭签名。工具自身不会运行目标项目测试/构建；仓库自有 hooks 仍按其配置执行。消息、路径、原始 Git 和 hook 输出不会直接作为 shell 片段或诊断输出。

Git 写命令关闭 fsmonitor、可选锁刷新及隐式远程对象拉取；不继承父进程的 GIT_* 仓库/index/配置/trace 覆盖。保持用户配置中的作者、hooks 和签名；Git 内部为 hooks 设置所需环境。工具本身不执行 Push；hooks 是用户信任的本地程序，不能把它们视为受限 Codex 进程。

暂存与 write-tree 最多 10 秒，commit 最多 5 分钟。Ctrl-C/SIGTERM 或超时会终止子进程，并使用独立的只读查询检查现场。取消/超时发生在 post-commit 中时，提交可能已经创建，不能简单重试。

| 结果                                | 行为与提示                                                    |
| ----------------------------------- | ------------------------------------------------------------- |
| 确认前或快照复核失败                | 不开始暂存；原计划失效，需要重新分析。                        |
| 暂存失败                            | 读取 index 是否改变及原分支是否前移，保留 index.lock 等现场。 |
| 暂存后校验失败                      | 停止 commit；保留已经发生的暂存与其他修改。                   |
| hook/签名失败，原分支未前移         | 报告未检测到新提交与暂存区状态；不绕过、不重试。              |
| hook 修改 tree/message 后已创建提交 | 报告已创建的提交标识和确认不匹配，停止后续流程。              |
| 无法确认提交结果                    | 提示检查 git log/status，禁止声称未提交或直接重试。           |
| 提交成功后还有文件变化              | 明确提示检查 git status，不把后续变化纳入已完成提交。         |

失败消息不回显原始 hook 日志，避免泄露秘密；可在本机检查 `git status`、`git diff --cached`、`git log -1`，确认现场后自行诊断。gcommit 不自动 reset、stash、checkout、amend 或回滚。

复核检测通常的并发编辑，不是操作系统事务隔离。原生 hooks 可以修改文件/index/message；修改已经写入提交时只能如实报告，不悄悄撤销它。恶意 hook、被替换的 Git 程序和恶意并发替换不在安全承诺内。

## 推送与验证

本地提交成功后由 Step 7 提供独立推送确认；`--no-push` 跳过推送发现和交互。见 [推送说明](PUSH.md)。

`pnpm check` 使用真实临时 Git 仓库、原生 hooks、受控签名程序和假 Codex；另执行 macOS 伪终端确认/失败/信号验收及安装包脱离源码目录运行。Codex 权限验证见 [隔离说明](CODEX_ISOLATION.md)。

命令行为参考 [git add](https://git-scm.com/docs/git-add)、[git commit](https://git-scm.com/docs/git-commit) 和 [Git hooks](https://git-scm.com/docs/githooks)，实际验收 Git 2.43.0。
