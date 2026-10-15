import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { reportProgress } from '../progress.js';
import type { AnalysisProgressReporter } from '../progress.js';
import type { ProcessOperation } from '../diagnostics.js';
import type { Config } from '../config.js';
import { GcommitError } from '../errors.js';
import { runProcessBytes } from '../process.js';
import {
  codexAuthConfigPath,
  codexLoginArguments,
  readCodexAuthStore,
} from './auth.js';
import type { CodexAuthStore } from './auth.js';
import {
  assertCodexRuntime,
  codexExecArguments,
  createCodexEnvironment,
  bundledModelArguments,
  restrictModelCatalog,
} from './profile.js';
import {
  decodeCodexText,
  describeResponseIssue,
  readCodexResult,
  validateCodexEvents,
} from './response.js';

/** 本机 Codex 调用选项。 */
export interface CodexOptions {
  /** 接收不含模型内容的真实进度事件。 */
  onProgress?: AnalysisProgressReporter;
  /** 可信 Codex 可执行文件，默认从 PATH 查找。 */
  executable?: string;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
}

/** 将已过滤的上下文交给无工具 Codex，并校验结构化响应。 */
export const runCodex = async <Schema extends z.ZodType>(
  prompt: string,
  schema: Schema,
  config: Readonly<Config>,
  options: CodexOptions = {},
): Promise<z.output<Schema>> => {
  reportProgress(options.onProgress, { type: 'stage', stage: 'codex-check' });
  if (options.signal?.aborted)
    throw new GcommitError('CODEX_CANCELLED', 'Codex 分析已取消。');
  const executable: string = options.executable ?? 'codex';
  if (
    (executable !== 'codex' && !isAbsolute(executable)) ||
    !prompt.trim() ||
    Buffer.byteLength(prompt) > config.maxContextBytes
  )
    throw new GcommitError(
      'CODEX_REQUEST_INVALID',
      'Codex 输入为空、超过预算或可执行文件路径无效。',
    );
  let schemaText: string;
  try {
    schemaText = JSON.stringify(z.toJSONSchema(schema));
  } catch {
    throw new GcommitError(
      'CODEX_REQUEST_INVALID',
      '响应规则无法转换为 JSON Schema。',
    );
  }
  if (Buffer.byteLength(schemaText) > 65536)
    throw new GcommitError('CODEX_REQUEST_INVALID', '响应规则超过大小限制。');
  // 所有探测与模型调用共享一个期限，不在每个阶段重新计时。
  const deadline: AbortSignal = AbortSignal.timeout(config.codexTimeoutMs);
  const signal: AbortSignal =
    options.signal === undefined
      ? deadline
      : AbortSignal.any([deadline, options.signal]);
  const env: NodeJS.ProcessEnv = createCodexEnvironment(process.env);
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'gcommit-codex-'));
    await chmod(directory, 0o700);
    const cwd: string = directory;
    /** 在同一私有目录、环境和期限内执行 Codex。 */
    const invoke = async (
      operation: ProcessOperation,
      args: readonly string[],
      input?: string,
      maxOutputBytes: number = 262144,
    ): Promise<{ stdout: Buffer; stderr: Buffer }> => {
      if (signal.aborted)
        throw new GcommitError('PROCESS_CANCELLED', '已取消。');
      return runProcessBytes(executable, args, {
        cwd,
        operation,
        env,
        signal,
        timeoutMs: config.codexTimeoutMs,
        maxOutputBytes,
        ...(input === undefined ? {} : { input }),
      });
    };
    const version = await invoke(
      'codex.version',
      ['--version'],
      undefined,
      4096,
    );
    assertCodexRuntime(decodeCodexText(version.stdout));
    const authStore: CodexAuthStore = await readCodexAuthStore(
      codexAuthConfigPath(env),
    );
    try {
      await invoke(
        'codex.login',
        codexLoginArguments(authStore),
        undefined,
        8192,
      );
    } catch (error: unknown) {
      if (error instanceof GcommitError && error.code === 'PROCESS_EXIT_FAILED')
        throw new GcommitError(
          'CODEX_NOT_AUTHENTICATED',
          'Codex 尚未登录，请先运行 codex login。',
        );
      throw error;
    }
    const bundled = await invoke(
      'codex.models',
      bundledModelArguments(cwd),
      undefined,
      4 * 1024 * 1024,
    );
    const { catalog, selection } = restrictModelCatalog(
      decodeCodexText(bundled.stdout),
      config,
    );
    await writeFile(join(cwd, 'models.json'), catalog, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(join(cwd, 'schema.json'), schemaText, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(join(cwd, 'result.json'), '', { mode: 0o600, flag: 'wx' });
    reportProgress(options.onProgress, { type: 'model', selection });
    reportProgress(options.onProgress, {
      type: 'stage',
      stage: 'codex-generate',
    });
    const result = await invoke(
      'codex.exec',
      codexExecArguments(cwd, config, authStore),
      prompt,
    );
    reportProgress(options.onProgress, { type: 'stage', stage: 'validate' });
    const output: string = await readCodexResult(join(cwd, 'result.json'));
    validateCodexEvents(decodeCodexText(result.stdout), output);
    if (signal.aborted) throw new GcommitError('PROCESS_CANCELLED', '已取消。');
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new GcommitError(
        'CODEX_RESPONSE_INVALID',
        'Codex 没有返回有效 JSON。',
      );
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success)
      throw new GcommitError(
        'CODEX_RESPONSE_INVALID',
        `Codex 返回的结果不符合响应规则：${describeResponseIssue(validated.error.issues[0])}，已丢弃结果。`,
      );
    return validated.data;
  } catch (error: unknown) {
    if (options.signal?.aborted)
      throw new GcommitError('CODEX_CANCELLED', 'Codex 分析已取消。');
    if (
      deadline.aborted ||
      (error instanceof GcommitError && error.code === 'PROCESS_TIMEOUT')
    )
      throw new GcommitError(
        'CODEX_TIMEOUT',
        'Codex 分析超时，请稍后重试或调整超时配置。',
      );
    if (error instanceof GcommitError) {
      if (error.code === 'PROCESS_OUTPUT_LIMIT')
        throw new GcommitError('CODEX_OUTPUT_LIMIT', 'Codex 输出超过限制。');
      if (error.code === 'PROCESS_SPAWN_FAILED')
        throw new GcommitError(
          'CODEX_UNAVAILABLE',
          '无法启动本机 Codex，请检查安装与 PATH。',
        );
      if (error.code === 'PROCESS_EXIT_FAILED')
        throw new GcommitError(
          'CODEX_EXEC_FAILED',
          `Codex 进程异常退出${error.exitCode === undefined ? '' : `（退出码 ${error.exitCode}）`}，未完成本次分析。`,
          error.exitCode,
        );
      if (error.code === 'PROCESS_CANCELLED')
        throw new GcommitError('CODEX_CANCELLED', 'Codex 分析已取消。');
      throw error;
    }
    throw new GcommitError(
      'CODEX_TEMP_FAILED',
      '无法准备或读取 Codex 私有临时文件。',
    );
  } finally {
    if (directory !== undefined) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // 清理失败不覆盖业务错误；--force 已是幂等操作，临时目录由系统定期回收。
      }
    }
  }
};
