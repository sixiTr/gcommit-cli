import { recoveryAdvice } from '../recovery.js';
import { diagnosticFailure, diagnosticPhase } from '../diagnostics.js';
import { GcommitError } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import type { AnalysisResult, AnalysisSession } from '../analysis/session.js';
import type { CommitSuggestion } from '../analysis/schema.js';

/** 建议菜单动作。 */
export type MenuAction = 'use' | 'edit' | 'regenerate' | 'diff' | 'cancel';
/** 用户输入的完整标题和逐行正文。 */
export interface EditedMessage {
  /** 提交标题。 */
  title: string;
  /** 每行一条正文，空字符串表示清空。 */
  body: string;
}
/** 终端展示与状态转换的边界。 */
export interface InteractionUI {
  /** 展示建议并选择动作。 */
  choose: (suggestion: CommitSuggestion) => Promise<MenuAction>;
  /** 修改标题和正文；null 表示放弃本次编辑。 */
  edit: (
    suggestion: CommitSuggestion,
    validate: (title: string, body: string) => void,
  ) => Promise<EditedMessage | null>;
  /** 展示已经过滤的净变化。 */
  showDiff: (diff: string) => void;
  /** 展示经过整理的失败原因。 */
  showError: (message: string) => void;
}
// 这些失败允许继续选择旧建议；隔离失败、取消和 Git 状态错误直接结束。
const RECOVERABLE: ReadonlySet<ErrorCode> = new Set([
  'CODEX_TIMEOUT',
  'CODEX_EXEC_FAILED',
  'CODEX_RESPONSE_INVALID',
  'CODEX_OUTPUT_LIMIT',
  'ANALYSIS_RESPONSE_INVALID',
  'ANALYSIS_CONTEXT_LIMIT',
  'INTERACTION_EDIT_INVALID',
]);
/** 运行只读建议菜单，使用返回最终建议，取消返回 null。 */
export const runInteraction = async (
  session: AnalysisSession,
  ui: InteractionUI,
  signal?: AbortSignal,
): Promise<AnalysisResult | null> => {
  /** 避免取消后继续展示或采用建议。 */
  const checkCancelled = (): void => {
    if (signal?.aborted)
      throw new GcommitError('PROCESS_CANCELLED', '交互已取消。');
  };
  while (true) {
    checkCancelled();
    await session.assertUnchanged();
    diagnosticPhase('interaction');
    const action = await ui.choose(session.current().suggestion);
    checkCancelled();
    if (action === 'cancel') return null;
    try {
      if (action === 'use') {
        await session.assertUnchanged();
        return session.current();
      }
      if (action === 'diff') ui.showDiff(await session.diff());
      if (action === 'regenerate') {
        diagnosticPhase('analysis');
        await session.regenerate();
      }
      if (action === 'edit') {
        const edited = await ui.edit(
          session.current().suggestion,
          (title, body): void => {
            session.validateEdit(title, body);
          },
        );
        checkCancelled();
        if (edited !== null) await session.edit(edited.title, edited.body);
      }
    } catch (error: unknown) {
      checkCancelled();
      if (!(error instanceof GcommitError) || !RECOVERABLE.has(error.code))
        throw error;
      // 模型失败期间也可能有人修改仓库，此时不能恢复旧建议。
      await session.assertUnchanged();
      diagnosticFailure(error);
      ui.showError(
        `${error.code}: ${error.message}\n已保留上一版建议。\n下一步：${recoveryAdvice(error).join(' ')}`,
      );
    }
  }
};
