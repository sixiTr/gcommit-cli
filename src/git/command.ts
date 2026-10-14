import { isUtf8 } from 'node:buffer';
import { gitOperation } from '../diagnostics.js';
import { GcommitError } from '../errors.js';
import { formatByteCount } from '../budgets.js';
import type { ErrorCode } from '../errors.js';
import { runProcessBytes } from '../process.js';

/** Git 读取命令的受限选项。 */
export interface GitCommandOptions {
  /** 标准输入字节。 */
  input?: string | Uint8Array;
  /** 单流输出上限。 */
  maxBytes?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 清除父进程的 Git 位置、index、配置注入和 trace 覆盖。 */
export const createGitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  );
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_PAGER: 'cat',
  };
};
// 读取和写入共用的路径与辅助执行约束；不覆盖 hooksPath 或签名配置。
export const GIT_ARGUMENTS: readonly string[] = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotePath=true',
  '-c',
  'submodule.recurse=false',
];

/** 只调用显式命令，关闭可导致写入或外部执行的读命令扩展。 */
export const runGit = async (
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer> => {
  try {
    const result = await runProcessBytes('git', [...GIT_ARGUMENTS, ...args], {
      cwd,
      operation: gitOperation(args[0]),
      env: createGitEnvironment(),
      maxOutputBytes: options.maxBytes ?? 4 * 1024 * 1024,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return result.stdout;
  } catch (error: unknown) {
    if (error instanceof GcommitError) {
      if (
        error.code === 'PROCESS_EXIT_FAILED' ||
        error.code === 'PROCESS_CANCELLED' ||
        error.code === 'PROCESS_TIMEOUT'
      )
        throw error;
      if (error.code === 'PROCESS_OUTPUT_LIMIT')
        throw new GcommitError(
          'GIT_CONTEXT_LIMIT',
          `Git 输出（${gitOperation(args[0])}）超过本次输出上限 ${formatByteCount(options.maxBytes ?? 4 * 1024 * 1024)}；已提前停止，完整大小未知。`,
        );
      if (error.code === 'PROCESS_SPAWN_FAILED')
        throw new GcommitError(
          'GIT_UNAVAILABLE',
          '无法启动 Git，请检查本机 Git 安装及工作目录。',
        );
    }
    throw new GcommitError('GIT_COMMAND_FAILED', 'Git 读取失败。');
  }
};

/** 执行允许退出码 1 表示不存在的查询。 */
export const optionalGit = async (
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer | null> => {
  try {
    return await runGit(cwd, args, options);
  } catch (error: unknown) {
    if (
      error instanceof GcommitError &&
      error.code === 'PROCESS_EXIT_FAILED' &&
      error.exitCode === 1
    )
      return null;
    throw error;
  }
};

/** 无损解码文本；拒绝会被替换字符改变含义的输入。 */
export const decodeGit = (
  bytes: Buffer,
  code: ErrorCode = 'GIT_DATA_INVALID',
): string => {
  if (!isUtf8(bytes))
    throw new GcommitError(code, 'Git 数据包含不支持的编码。');
  return bytes.toString('utf8');
};

/** 移除命令约定的一个末尾换行，保留路径本身的空白。 */
export const gitLine = (bytes: Buffer): string =>
  decodeGit(bytes, 'GIT_PATH_UNSUPPORTED').replace(/\n$/, '');

/** 解析以 NUL 结束的记录。 */
export const nulRecords = (bytes: Buffer): string[] => {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0)
    throw new GcommitError('GIT_DATA_INVALID', 'Git 记录缺少结束分隔符。');
  return decodeGit(bytes, 'GIT_PATH_UNSUPPORTED').slice(0, -1).split('\0');
};

/** 检查仓库相对路径，拒绝越界和当前平台无法准确解释的形式。 */
export const validateGitPath = (path: string): string => {
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git',
      ) ||
    (process.platform === 'win32' && /[\\:]/.test(path))
  ) {
    throw new GcommitError(
      'GIT_PATH_UNSUPPORTED',
      '仓库包含当前不支持的路径。',
    );
  }
  return path;
};
