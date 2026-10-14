import { join } from 'node:path';
import { GcommitError } from '../errors.js';
import { MAX_FILE_BYTES, MAX_READ_BYTES } from '../budgets.js';
import { readLimitError } from './read-limit.js';
import { gitLine, nulRecords, optionalGit, runGit } from './command.js';
import type { GitCommandOptions } from './command.js';
import {
  checkRepositoryState,
  locateRepository,
  readHistory,
  readStatus,
} from './status.js';
import {
  digestBytes,
  readBoundedRegular,
  readHeadEntries,
  readHeadFile,
  readWorkingFile,
} from './files.js';
import type { GitWorkingFile } from './files.js';
import type {
  GitContext,
  GitContextOptions,
  GitFileVersion,
  GitNetChange,
  GitUntrackedFile,
} from './types.js';

/** 已验证的读取限额。 */
interface ContextLimits {
  /** 候选路径上限。 */
  maxFiles: number;
  /** 单文件字节上限。 */
  maxFileBytes: number;
  /** 总上下文字节上限。 */
  maxContextBytes: number;
}

/** 验证调用方预算，防止零、负数或无限制读取。 */
const contextLimits = (options: GitContextOptions): ContextLimits => {
  const limits: ContextLimits = {
    maxFiles: options.maxFiles ?? 200,
    maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
    maxContextBytes: options.maxContextBytes ?? MAX_READ_BYTES,
  };
  for (const [value, maximum] of [
    [limits.maxFiles, 200],
    [limits.maxFileBytes, MAX_FILE_BYTES],
    [limits.maxContextBytes, MAX_READ_BYTES],
  ]) {
    if (
      value === undefined ||
      maximum === undefined ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximum
    )
      throw new GcommitError('ARGUMENT_INVALID', 'Git Context 读取预算无效。');
  }
  return limits;
};

/** 收集一次有界的仓库状态及文件版本。 */
const collectContext = async (
  cwd: string,
  limits: ContextLimits,
  commandOptions: GitCommandOptions,
): Promise<GitContext> => {
  const repository = await locateRepository(cwd, commandOptions);
  const indexModes: Map<string, string> = await checkRepositoryState(
    repository,
    commandOptions,
  );
  const indexBefore: Buffer | null = await readBoundedRegular(
    join(repository.gitDir, 'index'),
    4 * 1024 * 1024,
    true,
  );
  const changes = await readStatus(repository.root, commandOptions);
  const paths: string[] = [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath === null ? [change.path] : [change.path, change.oldPath],
      ),
    ),
  ].sort();
  if (paths.length > limits.maxFiles)
    throw new GcommitError(
      'GIT_CONTEXT_LIMIT',
      `候选文件数量超过读取上限：实际 ${paths.length} 个，上限 ${limits.maxFiles} 个。`,
    );
  // patch、历史和每个文件版本共享本次读取预算；读内容前先计入已知大小。
  let consumed: number = 0;
  /** 在读取下一个文件前验证累计字节数。 */
  const consume = (
    bytes: number,
    source: string,
    candidateNumber?: number,
  ): void => {
    const required: number = consumed + bytes;
    if (required > limits.maxContextBytes)
      throw readLimitError(
        'total',
        source,
        required,
        limits.maxContextBytes,
        candidateNumber,
      );
    consumed = required;
  };
  const history = await readHistory(repository, {
    ...commandOptions,
    maxBytes: limits.maxContextBytes,
  });
  consume(Buffer.byteLength(JSON.stringify(history)), '提交历史');
  const diffArgs: string[] = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-renames',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--unified=3',
    '--ignore-submodules=none',
  ];
  const stagedDiff: Buffer = await runGit(
    repository.root,
    [...diffArgs, '--cached', '--'],
    {
      ...commandOptions,
      maxBytes: Math.max(1, limits.maxContextBytes - consumed),
    },
  );
  consume(stagedDiff.length, 'staged patch');
  const unstagedDiff: Buffer = await runGit(
    repository.root,
    [...diffArgs, '--'],
    {
      ...commandOptions,
      maxBytes: Math.max(1, limits.maxContextBytes - consumed),
    },
  );
  consume(unstagedDiff.length, 'unstaged patch');
  // Git diff 使用真实 index 决定 CRLF 转换，避免自行重现暂存语义。
  const trackedNetPaths: Set<string> = new Set(
    repository.head === null
      ? []
      : nulRecords(
          await runGit(
            repository.root,
            [...diffArgs, '--name-only', '-z', repository.head, '--'],
            commandOptions,
          ),
        ),
  );
  const entries = await readHeadEntries(repository, paths, commandOptions);
  const modeConfig: Buffer | null = await optionalGit(
    repository.root,
    ['config', '--type=bool', '--get', 'core.fileMode'],
    commandOptions,
  );
  const fileMode: boolean =
    modeConfig === null || gitLine(modeConfig) !== 'false';
  const symlinkConfig: Buffer | null = await optionalGit(
    repository.root,
    ['config', '--type=bool', '--get', 'core.symlinks'],
    commandOptions,
  );
  const symlinks: boolean =
    symlinkConfig === null || gitLine(symlinkConfig) !== 'false';
  const untrackedPaths: Set<string> = new Set(
    changes
      .filter((change) => change.indexStatus === '?')
      .map((change) => change.path),
  );
  const untracked: GitUntrackedFile[] = [];
  const netChanges: GitNetChange[] = [];
  const workingVersions: Array<{ path: string; file: GitFileVersion | null }> =
    [];
  for (const [index, path] of paths.entries()) {
    commandOptions.signal?.throwIfAborted();
    const entry = entries.get(path);
    const before: GitFileVersion | null =
      entry === undefined
        ? null
        : await readHeadFile(
            repository.root,
            entry,
            limits.maxFileBytes,
            commandOptions,
            {
              candidateNumber: index + 1,
              source: 'HEAD 文件',
              reserve: (bytes): void => consume(bytes, 'HEAD 文件', index + 1),
            },
          );
    // 已从 index 删除且被忽略的同名文件不会被 git add -A 重新加入。
    const working: GitWorkingFile | null =
      indexModes.has(path) || untrackedPaths.has(path)
        ? await readWorkingFile(
            repository.root,
            path,
            indexModes.get(path),
            fileMode,
            symlinks,
            limits.maxFileBytes,
            {
              candidateNumber: index + 1,
              source: '工作树文件',
              reserve: (bytes): void => consume(bytes, '工作树文件', index + 1),
            },
          )
        : null;
    const after: GitFileVersion | null = working?.file ?? null;
    workingVersions.push({ path, file: after });
    if (untrackedPaths.has(path)) {
      if (after === null)
        throw new GcommitError(
          'GIT_CONTEXT_CHANGED',
          '未跟踪文件在读取期间已变化。',
        );
      untracked.push({ path, file: after });
    }
    if (before === null && after === null) continue;
    if (before !== null && after !== null && working !== null) {
      if (indexModes.has(path)) {
        if (!trackedNetPaths.has(path)) continue;
      } else {
        // 同名文件已从 index 删除，重新加入时不存在 index 中的 CRLF 特例。
        const oid: string = gitLine(
          await runGit(
            repository.root,
            [
              'hash-object',
              '--stdin',
              after.mode === '120000' ? '--no-filters' : `--path=${path}`,
            ],
            { ...commandOptions, input: working.bytes },
          ),
        );
        if (oid === before.oid && before.mode === after.mode) continue;
      }
    }
    const kind: GitNetChange['kind'] =
      before === null
        ? 'added'
        : after === null
          ? 'deleted'
          : before.mode.slice(0, 3) !== after.mode.slice(0, 3)
            ? 'type-changed'
            : 'modified';
    netChanges.push({ path, kind, before, after });
  }
  const indexAfter: Buffer | null = await readBoundedRegular(
    join(repository.gitDir, 'index'),
    4 * 1024 * 1024,
    true,
  );
  if (digestBytes(indexBefore ?? '') !== digestBytes(indexAfter ?? ''))
    throw new GcommitError(
      'GIT_CONTEXT_CHANGED',
      '读取期间暂存区已变化，请重新分析。',
    );
  const snapshot: string = digestBytes(
    JSON.stringify({
      repository,
      index: digestBytes(indexAfter ?? ''),
      changes,
      history,
      stagedDiff: digestBytes(stagedDiff),
      unstagedDiff: digestBytes(unstagedDiff),
      workingVersions,
    }),
  );
  return {
    repository,
    changes,
    stagedDiff,
    unstagedDiff,
    untracked,
    netChanges,
    history,
    snapshot,
  };
};

/** 收集只读上下文，并重复核对以拒绝读取期间的仓库变化。 */
export const readGitContext = async (
  cwd: string,
  options: GitContextOptions = {},
): Promise<GitContext> => {
  const limits: ContextLimits = contextLimits(options);
  const commandOptions: GitCommandOptions =
    options.signal === undefined ? {} : { signal: options.signal };
  try {
    const first: GitContext = await collectContext(cwd, limits, commandOptions);
    const second: GitContext = await collectContext(
      cwd,
      limits,
      commandOptions,
    );
    if (first.snapshot !== second.snapshot)
      throw new GcommitError(
        'GIT_CONTEXT_CHANGED',
        '读取期间仓库内容已变化，请重新分析。',
      );
    return first;
  } catch (error: unknown) {
    if (options.signal?.aborted)
      throw new GcommitError('PROCESS_CANCELLED', 'Git Context 读取已取消。');
    if (error instanceof GcommitError) {
      if (error.code === 'PROCESS_EXIT_FAILED')
        throw new GcommitError(
          'GIT_COMMAND_FAILED',
          'Git 读取失败，请检查仓库状态。',
        );
      throw error;
    }
    throw new GcommitError('GIT_COMMAND_FAILED', '无法完成 Git Context 读取。');
  }
};

/** 拒绝使用分析之后已变化的内容快照。 */
export const assertGitContextUnchanged = async (
  context: GitContext,
  options: GitContextOptions = {},
): Promise<void> => {
  const current: GitContext = await readGitContext(
    context.repository.root,
    options,
  );
  if (current.snapshot !== context.snapshot)
    throw new GcommitError(
      'GIT_CONTEXT_CHANGED',
      '仓库已发生变化，原有建议或确认已失效。',
    );
};
