import { execa, ExecaError } from 'execa';
import { GcommitError } from './errors.js';
import { performance } from 'node:perf_hooks';
import { diagnosticCommand } from './diagnostics.js';
import type { ProcessOperation } from './diagnostics.js';

/** 子进程启动约束。 */
export interface ProcessOptions {
  /** 仅用于安全诊断的固定命令类别。 */
  operation?: ProcessOperation;
  /** 固定工作目录。 */
  cwd: string;
  /** 标准输入内容。 */
  input?: string | Uint8Array;
  /** 执行超时毫秒数。 */
  timeoutMs?: number;
  /** 单个输出流的字节上限。 */
  maxOutputBytes?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 显式提供时替换继承环境。 */
  env?: NodeJS.ProcessEnv;
}

/** 成功完成的进程输出。 */
export interface ProcessResult {
  /** 标准输出，保留换行与 NUL。 */
  stdout: string;
  /** 标准错误输出。 */
  stderr: string;
}

/** 无损进程输出。 */
export interface ProcessBytesResult {
  /** 标准输出字节。 */
  stdout: Buffer;
  /** 标准错误字节。 */
  stderr: Buffer;
}

/** 通过参数数组启动受限子进程。 */
export const runProcessBytes = async (
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessBytesResult> => {
  const started: number = performance.now();
  try {
    // 命令和输入都不经过 shell，也不优先查找业务项目中的二进制。
    const result = await execa(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      preferLocal: false,
      extendEnv: false,
      env: options.env ?? process.env,
      // 先按原始字节限制输出，再统一解码，避免中文绕过字节预算。
      encoding: 'buffer',
      stripFinalNewline: false,
      timeout: options.timeoutMs ?? 10000,
      maxBuffer: options.maxOutputBytes ?? 1048576,
      forceKillAfterDelay: 1000,
      cleanup: true,
      killDescendants: true,
      ...(options.input === undefined
        ? { stdin: 'ignore' }
        : { input: options.input }),
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    });
    diagnosticCommand(options.operation, started);
    return {
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
    };
  } catch (error: unknown) {
    const failure: GcommitError = (() => {
      if (error instanceof ExecaError) {
        if (error.isCanceled)
          return new GcommitError('PROCESS_CANCELLED', '子进程已取消。');
        if (error.timedOut)
          return new GcommitError('PROCESS_TIMEOUT', '子进程执行超时。');
        if (error.isMaxBuffer)
          return new GcommitError(
            'PROCESS_OUTPUT_LIMIT',
            '子进程输出超过限制。',
          );
        if (error.exitCode !== undefined) {
          return new GcommitError(
            'PROCESS_EXIT_FAILED',
            `子进程执行失败，退出码 ${error.exitCode}。`,
            error.exitCode,
          );
        }
      }
      // Execa 的原始错误包含完整命令及输出，不能直接交给终端或 debug。
      return new GcommitError(
        'PROCESS_SPAWN_FAILED',
        '无法启动或完成子进程，请检查可执行程序及运行环境。',
      );
    })();
    diagnosticCommand(options.operation, started, failure);
    throw failure;
  }
};

/** 将受限子进程输出解码为 UTF-8 文本。 */
export const runProcess = async (
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> => {
  const result: ProcessBytesResult = await runProcessBytes(
    executable,
    args,
    options,
  );
  return {
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};
