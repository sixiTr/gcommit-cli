# 异常处理与恢复

错误提示分为原因、已经发生的 Git 操作和“下一步”。恢复提示只提供指引，不会自动重试、删除锁、切换分支、结束 Git 操作、回滚暂存或强推。

## 常见情况

| 情况                                                                   | 工具行为与建议                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不是 Git 工作树                                                        | 停止；进入已有工作树再运行，不自动 git init。                                                                                                             |
| 没有净变化                                                             | 正常结束，不调用 Codex，不创建空提交。                                                                                                                    |
| Detached HEAD                                                          | 停止；先检查 git status、git log -1，保护已有提交后自行选择分支。                                                                                         |
| merge / rebase / cherry-pick / revert / am / sequencer / bisect 进行中 | 显示具体操作并停止；按 git status 和原操作提示自行选择后续处理。进行中操作优先于其引起的 Detached HEAD；rebase/am 优先于可能同时存在的 cherry-pick 标记。 |
| 未解决冲突                                                             | 停止；解决原操作的冲突后重新运行，不自动选择冲突一侧。                                                                                                    |
| index.lock 存在                                                        | 读取阶段及写入前复核均停止；确认是否有 Git 进程仍在工作。仅确认遗留锁后手工处理，不自动删除。                                                             |
| Git 身份不可用                                                         | 暂存前停止，返回 GIT_IDENTITY_INVALID；检查 user.name、user.email 等配置，不代填身份。                                                                    |
| 配置损坏或不可读                                                       | 停止；检查 ~/.gcommit/config.json；CLI 覆盖不能掩盖损坏的全局配置。                                                                                       |
| 不支持的 index、submodule、filter、部分克隆或特殊文件                  | 停止；按既有支持边界使用 Git 手工处理，不静默漏掉内容。                                                                                                   |
| 分析后仓库变化                                                         | 原建议/确认失效，停止；检查现场后重新分析，不自动采用旧建议。                                                                                             |
| 敏感文件或上下文超限                                                   | 停止；检查内容和预算。AI 过滤不等于从 Git 提交排除，工具不静默截断修改内容。                                                                              |
| Codex 未安装 / 未登录                                                  | 停止；检查 codex --version / PATH，或运行 codex login。                                                                                                   |
| Codex 版本、平台或隔离校验不支持                                       | 停止；核对 [隔离说明](CODEX_ISOLATION.md)，不降级到更宽权限。                                                                                             |
| Codex 执行失败、网络不可用                                             | 提示检查登录、网络、服务和模型配置，不依据原始 stderr 猜测精确原因，也不自动重试。                                                                        |
| Codex 非法 JSON、结构无效或输出超限                                    | 拒绝结果；用户可自行重新生成，不执行或展示原始响应。                                                                                                      |
| Codex 超时                                                             | 终止受控进程；检查网络或在允许范围内调整 codexTimeoutMs，由用户决定是否重试。                                                                             |
| 编辑无效 / 重新生成失败                                                | 可恢复的错误保留上一版建议，仓库仍须通过快照复核；用户自行选择编辑、重新生成或取消。                                                                      |
| 没有 remote                                                            | 本地提交保留，正常结束，不推送。                                                                                                                          |
| 没有 upstream / 分支尚未 push                                          | 单独确认所选 remote 的同名分支；不自动设置 tracking，详见 [推送说明](PUSH.md)。                                                                           |
| 多个 remote                                                            | 有配置目标时遵循优先级，无明确目标时让用户选择，默认取消。                                                                                                |
| 推送配置不支持或推送确认失效                                           | 不开始传输，本地提交保留；检查 git log -1 与推送配置后可自行手工推送，无需重新生成提交。                                                                  |

## 写入失败与现场

提交前的只读错误不会让 CLI 开始暂存。`git add` 启动之后的失败由现场检查报告暂存区是否变化，以及原分支 HEAD 未变、已创建直接后继提交或无法确定。

- 暂存/提交/hook/签名失败：先检查 `git status`、`git diff --cached` 和 `git log -1`，不要直接重试。错误可能发生在已暂存或已提交之后，工具不清理现场、不跳过 hook 或签名。
- 本地提交成功后：后续错误明确保留提交 OID。推送发现、选择或确认失败，提示尚未开始推送。
- 推送开始后的认证、网络、非快进、hook、超时或取消：保守报告远端可能已更新；需自行核对远端分支。工具不会为了判断结果再次联网，也不会自动 pull/rebase/重试。

退出码：正常结束、无变化、菜单取消或跳过推送为 `0`；受控失败为 `2`；捕获到 Ctrl-C/SIGTERM 时为 `130`/`143`。帮助、版本和参数解析发生在工作流诊断之前，不读取项目或全局配置。Git/Codex 子进程退出码只作为诊断字段，不直接充当 CLI 退出码。

## 安全 Debug

```bash
gcommit --debug
gcommit --dry-run --debug
```

Debug 仅写标准错误，不自动创建日志文件。普通建议、已过滤覆盖范围、终端交互和恢复提示仍照常显示。`--debug` 本身不调用额外命令、不扩大模型权限，也不改变写操作确认方式。

固定事件字段：

| 事件                      | 字段与含义                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| phase                     | configuration / analysis / codex / interaction / commit / push                                                |
| command                   | 固定 operation（如 git.status、git.commit、git.push、codex.exec）、result、elapsedMs，失败时可含数值 exitCode |
| context                   | promptBytes、files、metadataOnly、mode、redacted；不含文件名或内容                                            |
| failure                   | 当前 phase 与稳定错误 code；未知异常为 UNKNOWN                                                                |
| truncated                 | 普通事件达到 500 条后的截断提示；后续普通事件省略，含保留摘要总计最多 507 行                                  |
| last-write / last-failure | 截断后额外保留最多四种写操作各自的最后结果，以及最后一个流程错误                                              |
| end                       | 总 elapsedMs；即使截断仍输出结束事件，不代表流程成功，结果以 CLI 提示和退出码为准                             |

例如：

```text
[debug] event=command operation=git.status result=ok elapsedMs=12
[debug] event=command operation=codex.exec result=PROCESS_EXIT_FAILED elapsedMs=250 exitCode=7
[debug] event=failure phase=codex code=CODEX_EXEC_FAILED
[debug] event=end elapsedMs=540
```

命令日志不包含可执行文件路径、参数、URL、模型名、环境、stdin、stdout、stderr、错误 message/stack/cause、代码、提交消息或历史。不会为了 Debug 枚举被 Git 忽略的文件；上下文事件只报告实际提供的覆盖数量。Git 可选查询常用退出码 1 表示配置/引用不存在，因此单条 command 非零不等于整个流程失败。

诊断按异步调用隔离，关闭 Debug 不继承外层日志。日志接收器同步抛错不改变返回值或原异常。原始错误内容不提供“解除脱敏”开关；具体网络、认证或 hook 细节需用户在本机自行排查。

## 验收范围

本步使用真实临时 Git 仓库及本地 bare 接收端验证状态、现场与恢复；Codex 使用进程替身，不消耗真实额度或访问真实远程。macOS 的源码与隔离全局安装包使用真实 PTY 验证交互和信号。Linux/Windows 和联网认证仍未验收，既有 Codex 平台/版本限制不变。

具体测试及独立评审结果见 源码仓库的 `docs/plans/08-recovery-debug.md`。

## 模型设置失败

- `gcommit model` 需要交互终端，管道或 TERM=dumb 会在读取 Git/Codex 前拒绝；`gcommit model --help` 可在非交互环境查看。
- `CONFIG_CHANGED`：选择期间配置被另一个终端修改，本次不覆盖；重新运行命令读取最新配置。
- `CONFIG_WRITE_FAILED`：检查 `~/.gcommit` 目录写权限、目标是否为普通文件，以及 `config.json.lock` 是否由另一设置进程持有。进程被强制终止可能留下锁；确认没有其他设置进程后再处理遗留锁，不要删除配置文件。
- 显示“设置已保存，但临时文件或锁清理失败”时，新设置已经生效；按提示检查权限及遗留锁，无需重复选择来猜测结果。
- 配置损坏时先修复 JSON/字段；菜单不自动覆盖损坏配置。模型或档位已从目录消失时可重新选择。
- 目录探测失败或超时：检查 `codex --version`、PATH 和受支持版本；选择操作不需要登录，实际生成阶段才会检查登录和账号权限。
