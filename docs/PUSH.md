# 单独确认与单分支推送

本地提交成功后，`gcommit` 根据 Git 配置准备推送目标，再询问“确认推送？”。默认“稍后处理”；只有明确选择推送才联系远端。`gcommit --no-push` 或全局配置 `pushPrompt: false` 跳过整个推送发现与交互。dry-run 不进入此流程。

确认界面显示 remote、实际 push URL、完整本地/目标分支和固定提交 OID。URL 的 userinfo、查询参数和片段会遮蔽；名称与 URL 继续使用本次分析的秘密过滤器，并转义终端控制字符。脱敏影响展示，不改变真实目标。

## 目标选择

依次使用当前分支的 `branch.<name>.pushRemote`、`remote.pushDefault`、`branch.<name>.remote`。都未设置时，只有一个 remote 就使用它；多个 remote 让用户选择，菜单默认稍后处理，不自动假定 origin。没有 remote 时保留本地提交并结束。

选中的 remote 与 upstream remote 相同时使用 `branch.<name>.merge` 指向的分支，支持异名 upstream。三角工作流中选择了另一 remote，或没有 upstream 时，推送到与当前分支同名的 `refs/heads/...`。界面展示完整目标；不依赖 push.default 的隐式选择。

使用 Git 自身的 `remote get-url --push --all` 解析 pushurl、insteadOf 与 pushInsteadOf。首版拒绝 mirror、多有效 push URL、自定义 remote.push/receivepack/vcs、多 merge ref、无效引用和扩展 remote helper。已展开地址如果还会被 insteadOf 再次重写，或仍匹配任意 pushInsteadOf 前缀，也会停止；即使某条规则的重写结果相同，首版仍保守拒绝，以避免确认地址与实际地址不同。支持 file、本地路径、SSH/scp、HTTP(S) 和 Git 协议；这些协议的认证和可用性由本机 Git 配置决定，联网认证尚未作为本步跨平台验收内容。

## 执行边界

- 推送前再次核对 HEAD、当前分支及完整有效 Git 配置。等待选择或确认期间发生变化，原计划失效。
- 用冻结的有效 URL 和 `<确认的 OID>:<完整目标分支>` 调用原生 Git。即使 pre-push hook 改动本地分支，发送的仍是确认的提交及远端缺少的祖先对象。
- 只更新一个分支，显式关闭 followTags、submodule 递归、mirror 和强推，不执行自动 pull/rebase/retry。push.default/matching 与 push.autoSetupRemote 不扩大行为。
- 保留 pre-push hook 和 push 签名要求。直接 URL/OID 的调用意味着 hook 的 remote 参数是 URL，源 ref 字段是 OID；依赖 remote 别名或分支名参数的 hook 可能拒绝，不绕过它。
- 不自动修改 upstream，也不更新 named remote 的 tracking ref。首次推送及依赖 tracking 状态的工作流，需要用户在本机自行设置或 fetch；这样不会在推送后附带配置写入。
- 工作树新增的未提交变化不会被推送；确认界面绑定的是已经成功创建的提交。工具不替用户撤销 hook 修改。

传输默认上限 120 秒，标准输入关闭，`GIT_TERMINAL_PROMPT=0`，不在 gcommit 中收集密码。沿用本机可用的认证代理、credential helper 与 SSH 配置。传输超时、输出超限或 Ctrl-C/SIGTERM 会终止受控子进程及后代。

## 失败与退出

| 情况                                           | 结果                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| --no-push / 关闭 pushPrompt                    | 不发现目标、不询问、不推送，本地提交保留                                |
| 没有 remote / 选择稍后 / 确认取消              | 正常结束，本地提交保留，未推送                                          |
| 不支持配置 / 快照变化                          | 不开始传输；本地提交保留，退出码 2                                      |
| 非快进 / 权限认证 / 网络 / hook / 签名失败     | 受控错误，保留本地提交，不强推、不重试，退出码 2                        |
| Ctrl-C / SIGTERM                               | 退出码 130 / 143；区分传输开始前取消和开始后的不确定结果                |
| Git 成功且 porcelain 唯一结果匹配确认 OID/分支 | 报告推送成功；这代表此次 Git 操作确认成功，不保证远端之后不会被他人修改 |

传输开始后的失败都保守报告“远端可能已更新”。例如远端已更新分支，post-receive hook 卡住后被取消；此时不能简单声称推送没有发生。工具不会为判断结果自动再次联网，需检查远端分支后再决定后续操作。原始 URL、hook 日志及 Git 错误输出不会直接展示。

本工具不是 Git/hooks 的系统隔离环境；本机 Git、认证工具、原生 hooks 与远端服务属于用户信任边界。普通配置变化和分支变化有复核，恶意并发配置替换等不承诺事务隔离。

## 验收

普通测试使用真实临时 Git 仓库、本地 bare 接收端、真实 pre-push/pre-receive/post-receive hooks；不向真实远程推送。另以 macOS PTY 和临时全局安装包验证实际 CLI。结果见 源码仓库的 `docs/plans/07-push.md`。

命令与配置语义参考 [git push](https://git-scm.com/docs/git-push)、[git remote](https://git-scm.com/docs/git-remote) 和 [git config](https://git-scm.com/docs/git-config)；实际验收 Git 2.43.0。
