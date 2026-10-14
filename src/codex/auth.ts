import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { GcommitError } from '../errors.js';

/** Codex 持久化登录的存储方式。 */
export type CodexAuthStore = 'file' | 'keyring' | 'auto';

// 只允许持久化登录；ephemeral 凭据无法跨独立 CLI 进程复用。
const authStoreSchema = z.enum(['file', 'keyring', 'auto']);
// 有界解析用户 TOML，不加载其中其他配置或认证文件。
const AUTH_CONFIG_LIMIT: number = 1024 * 1024;

/** 定位原有 Codex 配置，不重设认证目录。 */
export const codexAuthConfigPath = (env: NodeJS.ProcessEnv): string => {
  const directory: string = env.CODEX_HOME ?? join(homedir(), '.codex');
  if (!isAbsolute(directory))
    throw new GcommitError(
      'CODEX_AUTH_CONFIG_INVALID',
      'CODEX_HOME 必须是原有认证目录的绝对路径。',
    );
  return join(directory, 'config.toml');
};

/** 只读取用户配置中的认证存储选项。 */
export const readCodexAuthStore = async (
  path: string,
): Promise<CodexAuthStore> => {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > AUTH_CONFIG_LIMIT)
        throw new Error('unsupported config');
      const buffer: Buffer = Buffer.alloc(AUTH_CONFIG_LIMIT + 1);
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
      if (length > AUTH_CONFIG_LIMIT) throw new Error('config too large');
      const content: string = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      );
      const config = parse(content);
      return authStoreSchema.parse(config.cli_auth_credentials_store ?? 'file');
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return 'file';
    // TOML 错误可能含完整原文，不能向外暴露。
    throw new GcommitError(
      'CODEX_AUTH_CONFIG_INVALID',
      '无法安全读取 Codex 认证存储配置；配置必须是有效、非链接的普通 TOML 文件（最多 1 MiB），存储方式支持 file、keyring 或 auto。',
    );
  }
};

/** 为登录检查显式指定与分析一致的认证存储。 */
export const codexLoginArguments = (store: CodexAuthStore): string[] => [
  'login',
  'status',
  '-c',
  `cli_auth_credentials_store=${JSON.stringify(store)}`,
];
