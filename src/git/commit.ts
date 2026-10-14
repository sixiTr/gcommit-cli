import { join } from 'node:path';
import { gitOperation } from '../diagnostics.js';
import { GcommitError } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import { runProcessBytes } from '../process.js';
import {
  createGitEnvironment,
  GIT_ARGUMENTS,
  decodeGit,
  gitLine,
  optionalGit,
  runGit,
} from './command.js';
import { assertGitContextUnchanged, readGitContext } from './context.js';
import { digestBytes, readBoundedRegular } from './files.js';
import { checkRepositoryState } from './status.js';
import type { GitContext, GitContextOptions } from './types.js';

/** 成功创建并核对内容的本地提交。 */
export interface CommitReceipt {
  /** 实际提交标识。 */
  oid: string;
  /** 核实后的提交树。 */
  tree: string;
  /** 提交后是否仍有修改；无法读取时为空。 */
  worktreeChanged: boolean | null;
}
/** 写操作失败后独立读取的现场状态。 */
export interface CommitFailureReport {
  /** 停止的阶段。 */
  phase: 'stage' | 'verify' | 'commit';
  /** 原分支未前移、已创建直接后继提交或无法确定。 */
  outcome: 'unchanged' | 'created' | 'unknown';
  /** 可读取的原分支当前提交。 */
  head: string | null;
  /** index 是否相对操作前改变；无法读取时为空。 */
  indexChanged: boolean | null;
}
/** 保留现场状态的受控提交错误。 */
export class CommitExecutionError extends GcommitError {
  /** 不含原始内容的状态报告。 */
  readonly report: CommitFailureReport;
  /** 保存受控原因和实际写入状态。 */
  constructor(code: ErrorCode, reason: string, report: CommitFailureReport) {
    const outcome =
      report.outcome === 'created'
        ? `已创建本地提交 ${report.head}，请先检查，勿直接重试。`
        : report.outcome === 'unchanged'
          ? '原分支 HEAD 未变化，未检测到新提交。'
          : '无法确认是否已创建提交，请先检查 git log 和 git status，勿直接重试。';
    const index =
      report.indexChanged === true
        ? '暂存区已经变化，已保留现场。'
        : report.indexChanged === false
          ? '暂存区与操作前一致。'
          : '暂存区状态无法确认，已保留现场。';
    super(
      code,
      `${reason}\n${outcome}\n${index}\n请检查 git status 和 git diff --cached；工具未自动回滚、重试或推送。`,
    );
    this.name = 'CommitExecutionError';
    this.report = report;
  }
}
/** 核对 Git 返回的完整对象标识。 */
const objectId = (bytes: Buffer): string => {
  const value = gitLine(bytes);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw new GcommitError('GIT_DATA_INVALID', 'Git 对象标识无效。');
  return value;
};
/** 为已确认操作调用原生 Git，保留用户 hooks 和签名。 */
const writeGit = async (
  root: string,
  args: readonly string[],
  input: string | undefined,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (signal?.aborted)
    throw new GcommitError('PROCESS_CANCELLED', 'Git 写操作已取消。');
  const result = await runProcessBytes(
    'git',
    [...GIT_ARGUMENTS, '-c', 'i18n.commitEncoding=UTF-8', ...args],
    {
      cwd: root,
      operation: gitOperation(args[0]),
      env: createGitEnvironment(),
      maxOutputBytes: 1048576,
      timeoutMs: args[0] === 'commit' ? 300000 : 10000,
      ...(input === undefined ? {} : { input }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return result.stdout;
};
/** 确认暂存的是原始净变化，且 index 已与最终工作树一致。 */
const verifyStaged = (original: GitContext, staged: GitContext): void => {
  if (
    JSON.stringify(staged.repository) !== JSON.stringify(original.repository) ||
    JSON.stringify(staged.netChanges) !== JSON.stringify(original.netChanges) ||
    staged.changes.some(
      (change) => change.indexStatus === '?' || change.worktreeStatus !== '.',
    )
  )
    throw new GcommitError(
      'GIT_CONTEXT_CHANGED',
      '暂存后的内容与确认快照不一致，已停止提交。',
    );
};
/** 根据用户确认的快照暂存并提交，不回滚、不重试、不推送。 */
export const commitSnapshot = async (
  context: GitContext,
  message: string,
  options: GitContextOptions = {},
): Promise<CommitReceipt> => {
  if (
    !message.trim() ||
    message.includes('\0') ||
    Buffer.byteLength(message) > 4096
  )
    throw new GcommitError('ARGUMENT_INVALID', '提交消息无效。');
  if (context.netChanges.length === 0)
    throw new GcommitError('GIT_NOTHING_TO_COMMIT', '没有可提交的净变化。');
  await assertGitContextUnchanged(context, options);
  const root = context.repository.root;
  // verbatim 不补末尾换行，CLI 自己提供标准文本结束符。
  const commitMessage: string = message.endsWith('\n')
    ? message
    : `${message}\n`;
  // 失败后的现场检查不能复用已经取消的信号。
  const recoveryOptions: GitContextOptions = { ...options };
  delete recoveryOptions.signal;
  const signalOptions =
    options.signal === undefined ? {} : { signal: options.signal };
  const ref = gitLine(
    await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], signalOptions),
  );
  if (!ref.startsWith('refs/heads/'))
    throw new GcommitError('GIT_DATA_INVALID', '当前分支引用无效。');
  // 缺少身份时在更改 index 之前失败，不回显身份内容。
  try {
    await runGit(root, ['var', 'GIT_AUTHOR_IDENT'], signalOptions);
    await runGit(root, ['var', 'GIT_COMMITTER_IDENT'], signalOptions);
  } catch (error: unknown) {
    if (error instanceof GcommitError && error.code === 'PROCESS_EXIT_FAILED')
      throw new GcommitError(
        'GIT_IDENTITY_INVALID',
        'Git 作者或提交者身份不可用，尚未开始暂存。',
      );
    throw error;
  }
  const indexModes = await checkRepositoryState(
    context.repository,
    signalOptions,
  );
  const untracked = new Set(context.untracked.map((file) => file.path));
  // 已从 index 删除、工作树也不参与提交的旧路径不再传给 add。
  const paths: string[] = [
    ...new Set(
      context.changes.flatMap((change) =>
        change.oldPath === null ? [change.path] : [change.path, change.oldPath],
      ),
    ),
  ]
    .filter((path) => indexModes.has(path) || untracked.has(path))
    .sort();
  await assertGitContextUnchanged(context, options);
  const indexPath = join(context.repository.gitDir, 'index');
  const indexBefore = digestBytes(
    (await readBoundedRegular(indexPath, 4194304, true)) ?? '',
  );
  let phase: CommitFailureReport['phase'] = 'stage';
  let expectedTree: string | null = null;
  /** 取消后使用新的只读查询，辨别 commit 是否已经更新原分支。 */
  const inspect = async (): Promise<{
    report: CommitFailureReport;
    matches: boolean;
  }> => {
    let indexChanged: boolean | null = null;
    let head: string | null = null;
    let outcome: CommitFailureReport['outcome'] = 'unknown';
    let matches: boolean = false;
    try {
      indexChanged =
        digestBytes(
          (await readBoundedRegular(indexPath, 4194304, true)) ?? '',
        ) !== indexBefore;
    } catch {
      /* 保留未知状态。 */
    }
    try {
      const bytes = await optionalGit(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      ]);
      head = bytes === null ? null : objectId(bytes);
      if (head === context.repository.head) outcome = 'unchanged';
      else if (head !== null) {
        const raw = decodeGit(
          await runGit(root, ['cat-file', 'commit', head], { maxBytes: 65536 }),
        );
        const boundary = raw.indexOf('\n\n');
        const headers = raw.slice(0, boundary).split('\n');
        const parents = headers
          .filter((line) => line.startsWith('parent '))
          .map((line) => line.slice(7));
        if (
          boundary >= 0 &&
          JSON.stringify(parents) ===
            JSON.stringify(
              context.repository.head === null ? [] : [context.repository.head],
            )
        ) {
          outcome = 'created';
          const currentRef = gitLine(
            await runGit(root, ['symbolic-ref', '--quiet', 'HEAD']),
          );
          matches =
            currentRef === ref &&
            headers[0] === `tree ${expectedTree}` &&
            raw.slice(boundary + 2) === commitMessage;
        }
      }
    } catch {
      /* 查询失败不得误称未提交。 */
    }
    return { report: { phase, outcome, head, indexChanged }, matches };
  };
  try {
    if (paths.length > 0)
      await writeGit(
        root,
        ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        `${paths.join('\0')}\0`,
        options.signal,
      );
    phase = 'verify';
    expectedTree = objectId(
      await writeGit(root, ['write-tree'], undefined, options.signal),
    );
    const staged = await readGitContext(root, options);
    verifyStaged(context, staged);
    await assertGitContextUnchanged(staged, options);
    phase = 'commit';
    await writeGit(
      root,
      ['commit', '--quiet', '--file=-', '--cleanup=verbatim'],
      commitMessage,
      options.signal,
    );
    const inspected = await inspect();
    if (!inspected.matches || inspected.report.head === null) {
      throw new CommitExecutionError(
        inspected.report.outcome === 'created'
          ? 'GIT_COMMIT_MISMATCH'
          : 'GIT_COMMIT_UNCERTAIN',
        '提交完成后的分支、内容或消息与确认结果不一致。',
        inspected.report,
      );
    }
    let worktreeChanged: boolean | null = null;
    try {
      worktreeChanged =
        (await readGitContext(root, recoveryOptions)).changes.length > 0;
    } catch {
      /* 新产生的内容可能超限，不能声称干净。 */
    }
    return { oid: inspected.report.head, tree: expectedTree, worktreeChanged };
  } catch (error: unknown) {
    if (error instanceof CommitExecutionError) throw error;
    const inspected = await inspect();
    const code: ErrorCode =
      phase === 'stage'
        ? 'GIT_STAGE_FAILED'
        : phase === 'verify'
          ? 'GIT_COMMIT_ABORTED'
          : 'GIT_COMMIT_FAILED';
    const reason: string =
      error instanceof GcommitError
        ? `${error.code}: ${error.message}`
        : 'Git 写操作未能正常完成。';
    throw new CommitExecutionError(code, reason, inspected.report);
  }
};
