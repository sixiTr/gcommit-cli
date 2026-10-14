import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { CodexOptions } from './adapter.js';
import { GcommitError } from '../errors.js';
import { runProcessBytes } from '../process.js';
import {
  assertCodexRuntime,
  bundledModelArguments,
  createCodexEnvironment,
  parseModelCatalog,
} from './profile.js';
import { decodeCodexText } from './response.js';

/** 在私有目录读取本机模型能力，不检查登录或发起模型生成。 */
export const readBundledModels = async (
  config: Readonly<Config>,
  options: Pick<CodexOptions, 'executable' | 'signal'> = {},
): Promise<string> => {
  // 两次本地探测共享期限，不占用菜单选择时间。
  const deadline: AbortSignal = AbortSignal.timeout(
    Math.min(config.codexTimeoutMs, 10000),
  );
  const signal: AbortSignal =
    options.signal === undefined
      ? deadline
      : AbortSignal.any([deadline, options.signal]);
  const env: NodeJS.ProcessEnv = createCodexEnvironment(process.env);
  let directory: string | undefined;
  try {
    if (signal.aborted)
      throw new GcommitError('PROCESS_CANCELLED', '模型目录读取已取消。');
    directory = await mkdtemp(join(tmpdir(), 'gcommit-models-'));
    await chmod(directory, 0o700);
    // 不继承目标项目目录或自动加载项目能力。
    const cwd: string = directory;
    const executable: string = options.executable ?? 'codex';
    const version = await runProcessBytes(executable, ['--version'], {
      cwd,
      env,
      signal,
      timeoutMs: 10000,
      maxOutputBytes: 4096,
      operation: 'codex.version',
    });
    assertCodexRuntime(decodeCodexText(version.stdout));
    const result = await runProcessBytes(
      executable,
      bundledModelArguments(cwd),
      {
        cwd,
        env,
        signal,
        timeoutMs: 10000,
        maxOutputBytes: 4 * 1024 * 1024,
        operation: 'codex.models',
      },
    );
    const text: string = decodeCodexText(result.stdout);
    parseModelCatalog(text);
    return text;
  } catch (error: unknown) {
    if (options.signal?.aborted)
      throw new GcommitError('CODEX_CANCELLED', '模型目录读取已取消。');
    if (
      deadline.aborted ||
      (error instanceof GcommitError && error.code === 'PROCESS_TIMEOUT')
    )
      throw new GcommitError(
        'CODEX_TIMEOUT',
        '本机模型目录读取超时，请检查 Codex 后重试。',
      );
    if (error instanceof GcommitError) {
      if (error.code === 'PROCESS_SPAWN_FAILED')
        throw new GcommitError(
          'CODEX_UNAVAILABLE',
          '无法启动本机 Codex，请检查安装与 PATH。',
        );
      if (error.code === 'PROCESS_EXIT_FAILED')
        throw new GcommitError(
          'CODEX_EXEC_FAILED',
          '本机模型目录读取失败，请检查 Codex 安装。',
        );
      if (error.code === 'PROCESS_OUTPUT_LIMIT')
        throw new GcommitError(
          'CODEX_OUTPUT_LIMIT',
          '本机模型目录输出超过限制。',
        );
      throw error;
    }
    throw new GcommitError(
      'CODEX_TEMP_FAILED',
      '无法准备模型目录读取所需的私有目录。',
    );
  } finally {
    if (directory !== undefined) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        /* 清理失败不覆盖原错误，临时目录不含业务代码或认证副本。 */
      }
    }
  }
};
