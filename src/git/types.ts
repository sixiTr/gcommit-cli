/** 仓库定位结果。 */
export interface GitRepository {
  /** 工作树根目录。 */
  root: string;
  /** 本工作树的 Git 管理目录。 */
  gitDir: string;
  /** 当前分支。 */
  branch: string;
  /** 当前提交，首次提交前为空。 */
  head: string | null;
}

/** porcelain v2 中的一项变更。 */
export interface GitChange {
  /** 仓库相对路径。 */
  path: string;
  /** 重命名之前的路径。 */
  oldPath: string | null;
  /** HEAD 到 index 的状态。 */
  indexStatus: string;
  /** index 到工作树的状态。 */
  worktreeStatus: string;
}

/** 有界文件版本，二进制及符号链接不返回内容。 */
export interface GitFileVersion {
  /** 文件类别。 */
  kind: 'text' | 'binary' | 'symlink';
  /** Git 文件模式。 */
  mode: string;
  /** 原始字节长度。 */
  bytes: number;
  /** HEAD 中的真实 blob 标识；未暂存的工作树版本为空。 */
  oid: string | null;
  /** 原始字节摘要，用于工作区快照。 */
  digest: string;
  /** 文本内容，其他类型为空。 */
  content: string | null;
}

/** 未跟踪文件。 */
export interface GitUntrackedFile {
  /** 仓库相对路径。 */
  path: string;
  /** 最终工作树版本。 */
  file: GitFileVersion;
}

/** HEAD 与工作树最终版本的净变化。 */
export interface GitNetChange {
  /** 仓库相对路径。 */
  path: string;
  /** 净变化类别。 */
  kind: 'added' | 'modified' | 'deleted' | 'type-changed';
  /** HEAD 中的版本。 */
  before: GitFileVersion | null;
  /** 工作树最终版本。 */
  after: GitFileVersion | null;
}

/** 最近提交的标题。 */
export interface GitHistoryEntry {
  /** 完整提交标识。 */
  oid: string;
  /** 提交标题，尚未脱敏。 */
  subject: string;
}

/** Git Context 读取约束。 */
export interface GitContextOptions {
  /** 最大候选路径数量。 */
  maxFiles?: number;
  /** 单个文件的最大字节数。 */
  maxFileBytes?: number;
  /** 本地 patch、历史和文件版本的总字节上限；由配置 maxReadBytes 提供，不是模型预算。 */
  maxContextBytes?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 内部原始 Git 上下文，不能直接输出或发送给模型。 */
export interface GitContext {
  /** 仓库位置及当前版本。 */
  repository: GitRepository;
  /** staged、unstaged 和 untracked 状态。 */
  changes: GitChange[];
  /** HEAD 到 index 的原始 patch 字节，不能假定文件内容是 UTF-8。 */
  stagedDiff: Buffer;
  /** index 到工作树的原始 patch 字节。 */
  unstagedDiff: Buffer;
  /** 未被忽略的未跟踪文件。 */
  untracked: GitUntrackedFile[];
  /** 最终净变化，不能与上述两种 patch 相加。 */
  netChanges: GitNetChange[];
  /** 最近最多十条提交标题。 */
  history: GitHistoryEntry[];
  /** 用于复核的内容快照摘要。 */
  snapshot: string;
}
