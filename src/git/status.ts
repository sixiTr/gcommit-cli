import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { GitStateError } from './state-error.js';
import type { GitStateReason } from './state-error.js';
import { GcommitError } from '../errors.js';
import {
  runGit,
  optionalGit,
  gitLine,
  nulRecords,
  validateGitPath,
} from './command.js';
import type { GitCommandOptions } from './command.js';
import type { GitRepository, GitChange, GitHistoryEntry } from './types.js';

/** 确认工作树及分支位置，不假定 .git 是目录。 */
export const locateRepository = async (
  cwd: string,
  options: GitCommandOptions,
): Promise<GitRepository> => {
  try {
    if (
      gitLine(
        await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], options),
      ) !== 'true'
    )
      throw new GcommitError('GIT_NOT_REPOSITORY', '当前目录不是 Git 工作树。');
  } catch (error: unknown) {
    if (error instanceof GcommitError && error.code === 'PROCESS_EXIT_FAILED')
      throw new GcommitError(
        'GIT_NOT_REPOSITORY',
        '无法在当前目录读取 Git 工作树。',
      );
    throw error;
  }
  const root: string = await realpath(
    gitLine(await runGit(cwd, ['rev-parse', '--show-toplevel'], options)),
  );
  const gitDir: string = await realpath(
    gitLine(await runGit(root, ['rev-parse', '--absolute-git-dir'], options)),
  );
  await assertGitIdle(gitDir);
  const branch: Buffer | null = await optionalGit(
    root,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    options,
  );
  if (branch === null)
    throw new GcommitError(
      'GIT_DETACHED_HEAD',
      '当前处于 Detached HEAD，请先切换到分支。',
    );
  const head: Buffer | null = await optionalGit(
    root,
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    options,
  );
  return {
    root,
    gitDir,
    branch: gitLine(branch),
    head: head === null ? null : gitLine(head),
  };
};

/** 只检查操作标记是否存在，不读取其内容或跟随链接。 */
const markerExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return false;
    throw error;
  }
};

/** 检查 Git 锁与进行中的操作，避免被 Detached HEAD 提示遮蔽。 */
const assertGitIdle = async (gitDir: string): Promise<void> => {
  if (await markerExists(join(gitDir, 'index.lock')))
    throw new GitStateError('index-lock');
  // 上层 rebase/am 优先于可能同时出现的 cherry-pick 标记。
  const markers: readonly (readonly [string, GitStateReason])[] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['sequencer', 'sequencer'],
    ['BISECT_START', 'bisect'],
  ];
  for (const [marker, reason] of markers) {
    if (await markerExists(join(gitDir, marker)))
      throw new GitStateError(
        marker === 'rebase-apply' &&
          (await markerExists(join(gitDir, marker, 'applying')))
          ? 'am'
          : reason,
      );
  }
};

/** 阻止 Git 操作进行中或当前未支持的 index/属性设置。 */
export const checkRepositoryState = async (
  repository: GitRepository,
  options: GitCommandOptions,
): Promise<Map<string, string>> => {
  await assertGitIdle(repository.gitDir);
  const partial: Buffer | null = await optionalGit(
    repository.root,
    ['config', '--get', 'extensions.partialClone'],
    options,
  );
  const promisors: Buffer | null = await optionalGit(
    repository.root,
    ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'],
    options,
  );
  if (
    partial !== null ||
    (promisors !== null && / true$/m.test(gitLine(promisors)))
  )
    throw new GcommitError(
      'GIT_UNSUPPORTED_STATE',
      '当前不支持可能隐式拉取对象的部分克隆。',
    );
  const sparse: Buffer | null = await optionalGit(
    repository.root,
    ['config', '--type=bool', '--get', 'core.sparseCheckout'],
    options,
  );
  if (sparse !== null && gitLine(sparse) === 'true')
    throw new GcommitError(
      'GIT_UNSUPPORTED_STATE',
      '当前不支持 sparse checkout。',
    );
  const tracked: Map<string, string> = new Map();
  const index: string[] = nulRecords(
    await runGit(repository.root, ['ls-files', '--stage', '-v', '-z'], options),
  );
  for (const record of index) {
    const match: RegExpExecArray | null =
      /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (match === null)
      throw new GcommitError('GIT_DATA_INVALID', '无法解析 Git index。');
    if (match[4] !== '0') throw new GitStateError('conflict');
    if (match[1] !== 'H' || match[2] === '160000')
      throw new GcommitError(
        'GIT_UNSUPPORTED_STATE',
        '当前不支持特殊 index 标记或 submodule。',
      );
    tracked.set(validateGitPath(match[5]!), match[2]!);
  }
  const untracked: string[] = nulRecords(
    await runGit(
      repository.root,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      options,
    ),
  );
  for (const path of untracked) validateGitPath(path);
  const paths: string[] = [...new Set([...tracked.keys(), ...untracked])];
  if (paths.length > 0) {
    // check-attr 只查询规则，在 status 触发 clean filter 之前阻断自定义转换。
    const attributes: string[] = nulRecords(
      await runGit(
        repository.root,
        ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'],
        { ...options, input: `${paths.join('\0')}\0` },
      ),
    );
    if (attributes.length % 3 !== 0)
      throw new GcommitError('GIT_DATA_INVALID', '无法解析 Git 属性。');
    for (let index = 2; index < attributes.length; index += 3) {
      if (attributes[index] !== 'unspecified' && attributes[index] !== 'unset')
        throw new GcommitError(
          'GIT_UNSUPPORTED_STATE',
          '当前不支持自定义文件转换规则。',
        );
    }
  }
  return tracked;
};

/** 按 porcelain v2 的固定字段及 NUL 路径解析变更。 */
export const readStatus = async (
  root: string,
  options: GitCommandOptions,
): Promise<GitChange[]> => {
  const records: string[] = nulRecords(
    await runGit(
      root,
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--renames',
      ],
      options,
    ),
  );
  const changes: GitChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record: string = records[index]!;
    if (record.startsWith('? ')) {
      changes.push({
        path: validateGitPath(record.slice(2)),
        oldPath: null,
        indexStatus: '?',
        worktreeStatus: '?',
      });
      continue;
    }
    if (record.startsWith('u ')) throw new GitStateError('conflict');
    const renamed: boolean = record.startsWith('2 ');
    const fields: number = renamed ? 9 : 8;
    let boundary: number = -1;
    for (let field = 0; field < fields; field++) {
      boundary = record.indexOf(' ', boundary + 1);
      if (boundary === -1)
        throw new GcommitError('GIT_DATA_INVALID', '无法解析 Git 状态。');
    }
    if (
      (!record.startsWith('1 ') && !renamed) ||
      !/^[12] [MADRCUT.]{2} N\.\.\./.test(record)
    )
      throw new GcommitError(
        'GIT_UNSUPPORTED_STATE',
        '当前 Git 状态不受支持。',
      );
    const oldPath: string | null = renamed ? (records[++index] ?? null) : null;
    if (renamed && oldPath === null)
      throw new GcommitError('GIT_DATA_INVALID', 'Git 重命名记录不完整。');
    changes.push({
      path: validateGitPath(record.slice(boundary + 1)),
      oldPath: oldPath === null ? null : validateGitPath(oldPath),
      indexStatus: record[2]!,
      worktreeStatus: record[3]!,
    });
  }
  return changes;
};

/** 读取当前提交链上最近十条标题。 */
export const readHistory = async (
  repository: GitRepository,
  options: GitCommandOptions,
): Promise<GitHistoryEntry[]> => {
  if (repository.head === null) return [];
  const records: string[] = nulRecords(
    await runGit(
      repository.root,
      [
        'log',
        '-10',
        '--no-show-signature',
        '--no-notes',
        '--no-patch',
        '--encoding=UTF-8',
        '--format=%H%x00%s',
        '-z',
        repository.head,
        '--',
      ],
      options,
    ),
  );
  if (records.length % 2 !== 0)
    throw new GcommitError('GIT_DATA_INVALID', '无法解析 Git 提交历史。');
  const history: GitHistoryEntry[] = [];
  for (let index = 0; index < records.length; index += 2) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(records[index]!))
      throw new GcommitError('GIT_DATA_INVALID', 'Git 提交标识无效。');
    history.push({ oid: records[index]!, subject: records[index + 1]! });
  }
  return history;
};
