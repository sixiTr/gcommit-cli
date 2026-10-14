import { GcommitError } from '../errors.js';

/** 阻断自动流程的仓库状态。 */
export type GitStateReason =
  | 'merge'
  | 'rebase'
  | 'am'
  | 'cherry-pick'
  | 'revert'
  | 'sequencer'
  | 'bisect'
  | 'conflict'
  | 'index-lock';
// 固定状态名称，不引用仓库内容或路径。
const STATE_MESSAGES: Record<GitStateReason, string> = {
  merge: 'Git merge 尚未完成。',
  rebase: 'Git rebase 尚未完成。',
  am: 'Git am 尚未完成。',
  'cherry-pick': 'Git cherry-pick 尚未完成。',
  revert: 'Git revert 尚未完成。',
  sequencer: 'Git 序列操作尚未完成。',
  bisect: 'Git bisect 尚未完成。',
  conflict: '仓库存在未解决的冲突。',
  'index-lock': 'Git index.lock 存在，已停止自动流程。',
};
/** 提供不含原始数据的机器可读状态与提示。 */
export class GitStateError extends GcommitError {
  /** 已检测到的阻断原因。 */
  readonly reason: GitStateReason;
  /** 记录状态原因，不修改仓库现场。 */
  constructor(reason: GitStateReason) {
    super(
      reason === 'index-lock' ? 'GIT_INDEX_LOCKED' : 'GIT_STATE_BLOCKED',
      STATE_MESSAGES[reason],
    );
    this.name = 'GitStateError';
    this.reason = reason;
  }
}
