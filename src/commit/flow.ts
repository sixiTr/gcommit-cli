import { GcommitError } from '../errors.js';
import type { AnalysisSession } from '../analysis/session.js';
import type { SecretFilter } from '../analysis/security.js';
import { displayPath } from '../analysis/security.js';
import type { GitContext, GitContextOptions } from '../git/types.js';
import { assertGitContextUnchanged } from '../git/context.js';
import { commitSnapshot } from '../git/commit.js';
import type { CommitReceipt } from '../git/commit.js';

/** 不含原始秘密的最终确认界面数据。 */
export interface CommitPreview {
  /** 已过滤、转义的分支名。 */
  branch: string;
  /** 候选文件及净变化说明。 */
  files: Array<{ path: string; description: string }>;
  /** 已验证的完整提交消息。 */
  message: string;
  /** 是否存在 staged 与 unstaged 同时发生的路径。 */
  partialStaging: boolean;
  /** 实际净变化文件数。 */
  netFiles: number;
}
/** 一次性最终确认计划。 */
export interface CommitPlan {
  /** 可展示的副本，修改它不会更改实际操作。 */
  preview: CommitPreview;
  /** 仅在用户确认后调用，执行前仍复核快照。 */
  execute: () => Promise<CommitReceipt>;
}
/** 最终确认终端边界。 */
export interface CommitUI {
  /** 明确选择确认才返回 true，取消/关闭返回 false。 */
  confirmCommit: (preview: CommitPreview) => Promise<boolean>;
}
/** 从会话快照创建一次性写入计划，本函数不执行 Git 写入。 */
export const prepareCommitPlan = async (
  context: GitContext,
  message: string,
  filter: SecretFilter,
  options: GitContextOptions,
): Promise<CommitPlan> => {
  await assertGitContextUnchanged(context, options);
  const paths = [
    ...new Set(
      context.changes.flatMap((change) =>
        change.oldPath === null ? [change.path] : [change.path, change.oldPath],
      ),
    ),
  ].sort();
  const labels = {
    added: '新增',
    modified: '修改',
    deleted: '删除',
    'type-changed': '类型变化',
  };
  const preview: CommitPreview = {
    branch: displayPath(context.repository.branch, filter),
    message,
    netFiles: context.netChanges.length,
    partialStaging: context.changes.some(
      (change) =>
        !['.', '?'].includes(change.indexStatus) &&
        !['.', '?'].includes(change.worktreeStatus),
    ),
    files: paths.map((path) => {
      const change = context.netChanges.find((file) => file.path === path);
      return {
        path: displayPath(path, filter),
        description:
          change === undefined ? '仅整理暂存区，无净变化' : labels[change.kind],
      };
    }),
  };
  let used: boolean = false;
  return {
    preview,
    execute: async (): Promise<CommitReceipt> => {
      if (used)
        throw new GcommitError(
          'GIT_COMMIT_PLAN_USED',
          '该确认计划已执行，请重新分析，不自动重试。',
        );
      used = true;
      return commitSnapshot(context, message, options);
    },
  };
};
/** 请求最终确认，只有明确同意后才执行写操作。 */
export const confirmAndCommit = async (
  session: AnalysisSession,
  ui: CommitUI,
  signal?: AbortSignal,
): Promise<CommitReceipt | null> => {
  const plan = await session.prepareCommit();
  const confirmed = await ui.confirmCommit(plan.preview);
  if (signal?.aborted)
    throw new GcommitError('PROCESS_CANCELLED', '最终确认已取消，未开始暂存。');
  if (confirmed !== true) return null;
  return plan.execute();
};
