import { GcommitError } from './errors.js';
import { GitStateError } from './git/state-error.js';

/** 按稳定错误类别给出静态恢复建议，不执行恢复操作。 */
export const recoveryAdvice = (error: unknown): readonly string[] => {
  if (error instanceof GitStateError && error.reason !== 'index-lock') {
    if (error.reason === 'conflict')
      return [
        '先运行 git status 查看冲突；按原 Git 操作解决冲突后，再重新运行 gcommit。',
      ];
    return [
      '先运行 git status 查看当前 Git 操作；按原操作的提示自行选择继续或放弃，处理完成后再运行 gcommit。工具不会替你结束该操作。',
    ];
  }
  if (!(error instanceof GcommitError))
    return ['检查 gcommit 安装与工作目录权限；可使用 --debug 查看受控诊断。'];
  switch (error.code) {
    case 'ARGUMENT_INVALID':
      return ['运行 gcommit --help 查看支持的参数；修正参数后重新运行。'];
    case 'CONFIG_INVALID':
    case 'CONFIG_READ_FAILED':
      return [
        '检查 ~/.gcommit/config.json 的格式、字段与读取权限；CLI 参数不会覆盖损坏的配置文件。',
      ];
    case 'CONFIG_CHANGED':
      return [
        '全局配置已被其他操作修改，请重新运行 gcommit model 读取最新设置。',
      ];
    case 'CONFIG_WRITE_FAILED':
      return [
        '检查 ~/.gcommit 目录写权限；若存在 config.json.lock，先确认没有其他设置进程，再检查是否为异常退出留下的锁。',
      ];
    case 'INTERACTION_TTY_REQUIRED':
      return ['在交互终端运行 gcommit；只需建议时使用 gcommit --dry-run。'];
    case 'GIT_UNAVAILABLE':
      return ['运行 git --version 检查 Git 安装及 PATH，再重新运行 gcommit。'];
    case 'GIT_NOT_REPOSITORY':
      return ['进入已有 Git 工作树后重新运行；工具不会自动初始化仓库。'];
    case 'GIT_DETACHED_HEAD':
      return [
        '先检查 git status 和 git log -1，保护需要保留的提交，再自行选择分支；工具不会切换分支。',
      ];
    case 'GIT_INDEX_LOCKED':
      return [
        '先运行 git status 并确认是否仍有 Git 进程在工作；只有确认是遗留锁后才按 Git 指引手工处理。工具不会删除 index.lock。',
      ];
    case 'GIT_IDENTITY_INVALID':
      return [
        '检查 Git user.name、user.email 及身份配置；修正后重新运行。工具不会代填身份。',
      ];
    case 'GIT_STATE_BLOCKED':
      return ['先运行 git status，处理未完成的 Git 操作或冲突，再重新运行。'];
    case 'GIT_CONTEXT_CHANGED':
    case 'GIT_COMMIT_PLAN_USED':
      return [
        '先检查 git status 和 git log -1；旧快照或确认已失效，请重新分析并确认，不要继续使用旧计划。',
      ];
    case 'GIT_STAGE_FAILED':
    case 'GIT_COMMIT_ABORTED':
    case 'GIT_COMMIT_FAILED':
    case 'GIT_COMMIT_MISMATCH':
    case 'GIT_COMMIT_UNCERTAIN':
      return [
        '先检查 git status、git diff --cached 和 git log -1，确认暂存区与提交结果，不要直接重试。',
        '检查仓库 hooks、签名和权限；保留现有现场，工具不会绕过检查或自动回滚。',
      ];
    case 'GIT_PUSH_CHANGED':
    case 'GIT_PUSH_PLAN_USED':
      return [
        '先检查 git status、git log -1 和推送配置；本地提交已保留，旧推送确认不可复用。确认目标后可自行手工推送，无需重新生成提交。',
      ];
    case 'GIT_PUSH_FAILED':
      return [
        '先检查 git log -1，并自行核对远端目标分支；远端结果未确认时不要直接重试。',
        '检查网络、认证、pre-push/远端 hooks 与分支保护；本地提交保留，不自动同步或强推。',
      ];
    case 'GIT_PUSH_UNSUPPORTED':
      return [
        '检查 remote/upstream 与 push URL 配置；复杂推送配置需自行使用 Git 推送，本地提交已保留。',
      ];
    case 'GIT_NOTHING_TO_COMMIT':
      return ['运行 git status 确认是否有净变化；无需创建空提交。'];
    case 'GIT_CONTEXT_LIMIT':
      return [
        '按提示检查文件或读取阶段；maxFileBytes 控制本地单文件（最高 10 MiB），maxReadBytes 控制本地总量（最高 20 MiB）。',
        '达到硬上限、候选文件或固定元数据限制时，请拆分变更或用 Git 手工处理；提高模型预算 maxContextBytes 不会提高读取上限。',
      ];
    case 'ANALYSIS_CONTEXT_LIMIT':
      return [
        '缩小本次变更范围；若提示为 AI 字节预算不足，可调整 maxContextBytes（最高 8 MiB；字节预算不等于模型 token 容量）。本地读取预算不影响模型发送预算，工具保持单次完整分析，不自动分批或丢弃修改内容。',
      ];
    case 'ANALYSIS_SENSITIVE_FILE':
    case 'ANALYSIS_SENSITIVE_CONTENT':
      return [
        '在本机检查敏感文件或内容，明确本次提交范围后再运行；AI 过滤不会把秘密自动排除出 Git 提交。',
      ];
    case 'GIT_UNSUPPORTED_STATE':
    case 'GIT_PATH_UNSUPPORTED':
    case 'GIT_FILE_UNSUPPORTED':
      return [
        '检查仓库配置、文件类型和 index 状态；当前不支持的场景需使用 Git 手工处理。',
      ];
    case 'GIT_COMMAND_FAILED':
    case 'GIT_DATA_INVALID':
    case 'PROCESS_EXIT_FAILED':
      return [
        '在本机检查 git status、仓库访问权限和配置；可用 --debug 查看失败阶段与命令类别。',
      ];
    case 'CODEX_UNAVAILABLE':
      return ['运行 codex --version 检查本机安装及 PATH；安装可用后重新运行。'];
    case 'CODEX_NOT_AUTHENTICATED':
      return ['先运行 codex login 完成本机登录，再重新运行 gcommit。'];
    case 'CODEX_UNSUPPORTED':
    case 'CODEX_ISOLATION_FAILED':
      return [
        '核对 docs/CODEX_ISOLATION.md 中已验收的平台与版本；不能通过放宽模型权限继续。',
      ];
    case 'CODEX_AUTH_CONFIG_INVALID':
      return [
        '检查本机 Codex 认证存储配置与权限；不要将认证文件复制到项目或日志中。',
      ];
    case 'CODEX_MODEL_UNSUPPORTED':
      return ['检查模型及推理强度组合，或移除覆盖值后使用受限调用的默认设置。'];
    case 'CODEX_TIMEOUT':
    case 'PROCESS_TIMEOUT':
      return [
        '检查网络和服务可用性；需要时调整允许范围内的超时设置，再由你决定是否重试。',
      ];
    case 'CODEX_EXEC_FAILED':
      return [
        '检查本机 Codex 登录、网络、服务与模型配置后自行重新生成；gcommit 不会额外发起分析请求。',
      ];
    case 'CODEX_RESPONSE_INVALID':
    case 'ANALYSIS_RESPONSE_INVALID':
    case 'CODEX_OUTPUT_LIMIT':
    case 'PROCESS_OUTPUT_LIMIT':
      return [
        '可自行选择重新生成；若重复失败，请检查 Codex 版本与模型兼容性。工具不会执行或展示原始响应。',
      ];
    case 'CODEX_TEMP_FAILED':
      return [
        '检查系统临时目录权限与可用空间；若提示清理失败，请在本机处理残留私有目录。',
      ];
    case 'CODEX_REQUEST_INVALID':
      return ['检查上下文预算与调用配置，再重新运行；不要扩大 Codex 权限。'];
    case 'INTERACTION_EDIT_INVALID':
      return [
        '修正标题与正文的格式、长度或敏感内容，也可放弃编辑，继续使用上一版建议。',
      ];
    case 'CODEX_CANCELLED':
    case 'PROCESS_CANCELLED':
      return [
        '本次操作已取消；再次操作前检查 git status 和 git log -1，以现场报告为准。',
      ];
    case 'PROCESS_SPAWN_FAILED':
      return ['检查本机可执行程序、PATH 与工作目录访问权限。'];
    case 'FEATURE_UNAVAILABLE':
      return ['运行 gcommit --help 确认当前版本已支持的功能。'];
  }
};
