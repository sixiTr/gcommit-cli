import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GcommitError } from '../errors.js';
import { readLimitError } from './read-limit.js';
import type { FileReadBudget } from './read-limit.js';
import { runGit, gitLine, nulRecords, validateGitPath } from './command.js';
import type { GitCommandOptions } from './command.js';
import type { GitFileVersion, GitRepository } from './types.js';

/** HEAD 树中的文件条目。 */
export interface GitTreeEntry {
  /** Git 文件模式。 */
  mode: string;
  /** Blob 标识。 */
  oid: string;
}

/** 读取期间使用的工作树版本及原始字节。 */
export interface GitWorkingFile {
  /** 可返回给内部调用方的版本信息。 */
  file: GitFileVersion;
  /** 仅用于当前收集过程，不作为上下文文本返回。 */
  bytes: Buffer;
}

/** 计算原始字节的摘要。 */
export const digestBytes = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** 判定文件系统路径不存在。 */
const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** 有界读取普通文件，拒绝符号链接和特殊设备。 */
export const readBoundedRegular = async (
  path: string,
  maxBytes: number,
  allowMissing: boolean,
  budget: FileReadBudget = { source: 'Git index' },
): Promise<Buffer | null> => {
  try {
    const initial = await lstat(path);
    if (!initial.isFile())
      throw new GcommitError(
        'GIT_FILE_UNSUPPORTED',
        '无法安全读取非普通文件。',
      );
    if (initial.size > maxBytes)
      throw readLimitError(
        budget.source === 'Git index' ? 'index' : 'file',
        budget.source,
        initial.size,
        maxBytes,
        budget.candidateNumber,
      );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        initial.ino !== before.ino ||
        initial.dev !== before.dev
      )
        throw new GcommitError(
          'GIT_CONTEXT_CHANGED',
          '读取期间文件已变化，请重试。',
        );
      if (before.size > maxBytes)
        throw readLimitError(
          budget.source === 'Git index' ? 'index' : 'file',
          budget.source,
          before.size,
          maxBytes,
          budget.candidateNumber,
        );
      budget.reserve?.(before.size);
      // 按已核实的文件大小分配，额外一个字节用于检测并发增长。
      const buffer: Buffer = Buffer.alloc(before.size + 1);
      let length: number = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes)
        throw readLimitError(
          budget.source === 'Git index' ? 'index' : 'file',
          budget.source,
          length,
          maxBytes,
          budget.candidateNumber,
        );
      const after = await handle.stat();
      if (
        length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new GcommitError(
          'GIT_CONTEXT_CHANGED',
          '读取期间文件已变化，请重试。',
        );
      return Buffer.from(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (allowMissing && isMissing(error)) return null;
    if (error instanceof GcommitError) throw error;
    throw new GcommitError('GIT_FILE_UNSUPPORTED', '无法安全读取仓库文件。');
  }
};

/** 将原始文件分为文本、二进制或符号链接元数据。 */
const fileVersion = (
  bytes: Buffer,
  mode: string,
  oid: string | null,
): GitFileVersion => {
  const kind: GitFileVersion['kind'] =
    mode === '120000'
      ? 'symlink'
      : bytes.includes(0) || !isUtf8(bytes)
        ? 'binary'
        : 'text';
  return {
    kind,
    mode,
    oid,
    bytes: bytes.length,
    digest: digestBytes(bytes),
    content: kind === 'text' ? bytes.toString('utf8') : null,
  };
};

/** 获取候选路径在 HEAD 中的文件标识，不读取工作树。 */
export const readHeadEntries = async (
  repository: GitRepository,
  paths: string[],
  options: GitCommandOptions,
): Promise<Map<string, GitTreeEntry>> => {
  const entries: Map<string, GitTreeEntry> = new Map();
  if (repository.head === null || paths.length === 0) return entries;
  for (const record of nulRecords(
    await runGit(
      repository.root,
      ['ls-tree', '-z', '--full-tree', repository.head, '--', ...paths],
      options,
    ),
  )) {
    const match: RegExpExecArray | null =
      /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (match === null)
      throw new GcommitError('GIT_DATA_INVALID', '无法解析 HEAD 文件树。');
    if (match[2] === 'tree') continue;
    if (match[2] !== 'blob')
      throw new GcommitError(
        'GIT_UNSUPPORTED_STATE',
        '当前不支持 submodule 变更。',
      );
    entries.set(validateGitPath(match[4]!), {
      mode: match[1]!,
      oid: match[3]!,
    });
  }
  return entries;
};

/** 有界读取 HEAD 中的单个 blob。 */
export const readHeadFile = async (
  root: string,
  entry: GitTreeEntry,
  maxBytes: number,
  options: GitCommandOptions,
  budget: FileReadBudget,
): Promise<GitFileVersion> => {
  const size: number = Number(
    gitLine(await runGit(root, ['cat-file', '-s', entry.oid], options)),
  );
  if (!Number.isSafeInteger(size) || size < 0)
    throw new GcommitError('GIT_DATA_INVALID', 'Git blob 大小无效。');
  if (size > maxBytes)
    throw readLimitError(
      'file',
      budget.source,
      size,
      maxBytes,
      budget.candidateNumber,
    );
  budget.reserve?.(size);
  const bytes: Buffer = await runGit(root, ['cat-file', 'blob', entry.oid], {
    ...options,
    maxBytes: Math.max(maxBytes, 1),
  });
  return fileVersion(bytes, entry.mode, entry.oid);
};

/** 读取工作树最终版本，不跟随文件或父目录中的符号链接。 */
export const readWorkingFile = async (
  root: string,
  path: string,
  indexMode: string | undefined,
  fileMode: boolean,
  symlinks: boolean,
  maxBytes: number,
  budget: FileReadBudget,
): Promise<GitWorkingFile | null> => {
  validateGitPath(path);
  try {
    const segments: string[] = path.split('/');
    let parent: string = root;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent);
      // Git 不会沿替换父目录的符号链接收集子文件。
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    }
    const absolute: string = join(root, path);
    const canonicalParent: string = await realpath(dirname(absolute));
    if (canonicalParent !== dirname(absolute))
      throw new GcommitError('GIT_CONTEXT_CHANGED', '读取期间目录已变化。');
    const info = await lstat(absolute);
    if (info.isDirectory()) return null;
    if (info.isSymbolicLink()) {
      const bytes: Buffer = await readlink(absolute, { encoding: 'buffer' });
      if (bytes.length > maxBytes)
        throw readLimitError(
          'file',
          budget.source,
          bytes.length,
          maxBytes,
          budget.candidateNumber,
        );
      budget.reserve?.(bytes.length);
      return { file: fileVersion(bytes, '120000', null), bytes };
    }
    const bytes: Buffer | null = await readBoundedRegular(
      absolute,
      maxBytes,
      false,
      budget,
    );
    if (bytes === null)
      throw new GcommitError('GIT_CONTEXT_CHANGED', '读取期间文件已消失。');
    if ((await realpath(dirname(absolute))) !== canonicalParent)
      throw new GcommitError('GIT_CONTEXT_CHANGED', '读取期间目录已变化。');
    const mode: string =
      !symlinks && indexMode === '120000'
        ? '120000'
        : fileMode
          ? (info.mode & 0o100) !== 0
            ? '100755'
            : '100644'
          : indexMode === '100755'
            ? '100755'
            : '100644';
    // 工作树没有已写入的 blob；不能把 hash-object 的推测当成最终 index OID。
    return { file: fileVersion(bytes, mode, null), bytes };
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    if (error instanceof GcommitError) throw error;
    throw new GcommitError('GIT_FILE_UNSUPPORTED', '无法安全读取工作树文件。');
  }
};
