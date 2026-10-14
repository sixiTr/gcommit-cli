import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { GcommitError } from './errors.js';
import {
  DEFAULT_CONTEXT_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
} from './budgets.js';

// 配置文件本身的读取上限。
const CONFIG_FILE_LIMIT: number = 64 * 1024;

// 当前配置支持的推理档位，用于菜单与参数共用校验。
export const reasoningEffortSchema = z.enum([
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

// 配置字段与允许的值，类型直接从校验规则派生。
const configSchema = z.strictObject({
  /** 模型名称，null 表示采用受限 Codex 调用的默认模型。 */
  model: z
    .string()
    .regex(/^(?!-)[^\s\p{C}]{1,128}$/u)
    .nullable(),
  /** 推理强度；具体支持情况由模型目录验证。 */
  reasoningEffort: reasoningEffortSchema,
  /** 提交说明语言。 */
  language: z.enum(['auto', 'zh-CN', 'en']),
  /** 提交说明格式。 */
  commitStyle: z.enum(['auto', 'conventional', 'repository']),
  /** 是否询问推送；false 从不表示自动推送。 */
  pushPrompt: z.boolean(),
  /** Codex 执行超时，单位毫秒。 */
  codexTimeoutMs: z.number().int().min(1000).max(600000),
  /** 单次模型请求的最大字节数。 */
  maxContextBytes: z.number().int().min(8192).max(MAX_CONTEXT_BYTES),
  /** 本地单个文件版本的最大读取字节数。 */
  maxFileBytes: z.number().int().min(1024).max(MAX_FILE_BYTES),
  /** 本地 patch、历史和文件版本的总读取字节数。 */
  maxReadBytes: z.number().int().min(1024).max(MAX_READ_BYTES),
});

/** 完整运行配置。 */
export type Config = z.infer<typeof configSchema>;
// 部分配置允许省略字段，完整校验在合并后执行。
const overrideSchema = configSchema.partial();
/** 全局文件或临时参数提供的部分配置。 */
export type ConfigOverrides = z.infer<typeof overrideSchema>;

// 不依赖任何目标仓库的默认配置。
const defaultConfig: Readonly<Config> = Object.freeze({
  model: null,
  reasoningEffort: 'auto',
  language: 'zh-CN',
  commitStyle: 'auto',
  pushPrompt: true,
  codexTimeoutMs: 120000,
  maxContextBytes: DEFAULT_CONTEXT_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  maxReadBytes: MAX_READ_BYTES,
});

/** 校验外部提供的配置字段，不回显字段值。 */
const parseOverrides = (value: unknown): ConfigOverrides => {
  // 已通过字段检查的覆盖项。
  const result = overrideSchema.safeParse(value);
  if (!result.success) {
    throw new GcommitError(
      'CONFIG_INVALID',
      '配置包含未知字段、错误类型或不支持的值。请参考 README 中的配置说明。',
    );
  }
  return result.data;
};

/** 校验合并后的完整字段与上下文预算。 */
const validateConfig = (value: unknown): Config => {
  // 显式 undefined 不能覆盖默认值而绕过完整字段检查。
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new GcommitError('CONFIG_INVALID', '合并后的配置字段缺失或无效。');
  }
  return result.data;
};

/** 有限读取可选的全局配置文件。 */
const readConfigFile = async (
  configPath: string,
): Promise<string | undefined> => {
  try {
    // 先排除目录和管道，避免读取非普通文件时阻塞。
    const metadata = await stat(configPath);
    if (!metadata.isFile()) {
      throw new GcommitError(
        'CONFIG_READ_FAILED',
        '全局配置路径必须指向普通文件。',
      );
    }
    if (metadata.size > CONFIG_FILE_LIMIT) {
      throw new GcommitError('CONFIG_INVALID', '全局配置文件不能超过 64 KiB。');
    }
    // 固定大小缓冲区防止文件在读取期间增长导致无限分配。
    const buffer: Buffer = Buffer.alloc(CONFIG_FILE_LIMIT + 1);
    const handle = await open(configPath, 'r');
    let bytesRead: number = 0;
    try {
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (bytesRead > CONFIG_FILE_LIMIT) {
      throw new GcommitError('CONFIG_INVALID', '全局配置文件不能超过 64 KiB。');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error: unknown) {
    if (error instanceof GcommitError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new GcommitError(
      'CONFIG_READ_FAILED',
      '无法读取全局配置文件，请检查路径与访问权限。',
    );
  }
};

/** 配置选择开始时的有效字段和内容指纹。 */
export interface ConfigSnapshot {
  /** 合并默认值后的配置。 */
  config: Readonly<Config>;
  /** 文件中明确配置的字段。 */
  overrides: Readonly<ConfigOverrides>;
  /** 原始文本指纹；文件不存在时为 null。 */
  fingerprint: string | null;
}
/** 可持久化的模型设置。 */
export type ModelSettings = Pick<Config, 'model' | 'reasoningEffort'>;

/** 读取有效配置及指纹，为保存前复核提供依据。 */
export const readConfigSnapshot = async (
  configPath: string,
): Promise<ConfigSnapshot> => {
  // 配置原文只在解析和计算指纹时保留，不进入日志。
  const content: string | undefined = await readConfigFile(configPath);
  let parsed: unknown = {};
  if (content !== undefined) {
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new GcommitError(
        'CONFIG_INVALID',
        '全局配置不是有效的 JSON 对象。',
      );
    }
  }
  // 显式字段独立保留，保存时不把其他默认值写入文件。
  const overrides: ConfigOverrides = parseOverrides(parsed);
  return {
    config: Object.freeze(validateConfig({ ...defaultConfig, ...overrides })),
    overrides: Object.freeze(overrides),
    fingerprint:
      content === undefined
        ? null
        : createHash('sha256').update(content).digest('hex'),
  };
};

/** 读取全局配置，依次应用默认值、文件内容和 CLI 覆盖。 */
export const loadConfig = async (
  configPath: string,
  overrides: unknown = {},
): Promise<Readonly<Config>> => {
  // 先验证文件，临时参数不能掩盖损坏的全局配置。
  const snapshot: ConfigSnapshot = await readConfigSnapshot(configPath);
  return Object.freeze(
    validateConfig({ ...snapshot.config, ...parseOverrides(overrides) }),
  );
};

/** 在提交文件替换前检查取消。 */
const assertSaveActive = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new GcommitError('PROCESS_CANCELLED', '设置已取消，未保存配置。');
};

/** 拒绝通过符号链接或特殊文件保存设置。 */
const assertWritableConfigTarget = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile())
      throw new GcommitError(
        'CONFIG_WRITE_FAILED',
        '配置保存目标必须是普通文件，不能是符号链接。',
      );
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
};

/** 已完成配置替换后的清理结果。 */
export interface ModelSettingsSaveResult {
  /** 配置已保存，但临时文件或锁需要检查。 */
  cleanupWarning: boolean;
}

/** 复核原配置后原子保存两项设置，保留其他显式字段。 */
export const saveModelSettings = async (
  configPath: string,
  snapshot: ConfigSnapshot,
  settings: ModelSettings,
  signal?: AbortSignal,
): Promise<ModelSettingsSaveResult> => {
  assertSaveActive(signal);
  // 所有设置先经过现有配置规则，不允许写入非法值。
  const validated: Config = validateConfig({
    ...snapshot.config,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  });
  // 锁仅覆盖保存阶段，避免菜单等待阻塞其他终端。
  const lockPath: string = configPath + '.lock';
  const temporary: string = configPath + '.' + randomUUID() + '.tmp';
  let locked: boolean = false;
  let temporaryCreated: boolean = false;
  let cleanupWarning: boolean = false;
  try {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const lock = await open(lockPath, 'wx', 0o600);
    locked = true;
    await lock.close();
    await assertWritableConfigTarget(configPath);
    const current: ConfigSnapshot = await readConfigSnapshot(configPath);
    if (current.fingerprint !== snapshot.fingerprint)
      throw new GcommitError(
        'CONFIG_CHANGED',
        '设置期间全局配置已变化，请重新运行 gcommit model；未覆盖其他修改。',
      );
    // 从复核后的文件合并，其他字段不受选择菜单影响。
    const text: string =
      JSON.stringify(
        {
          ...current.overrides,
          model: validated.model,
          reasoningEffort: validated.reasoningEffort,
        },
        null,
        2,
      ) + '\n';
    if (Buffer.byteLength(text) > CONFIG_FILE_LIMIT)
      throw new GcommitError(
        'CONFIG_INVALID',
        '保存后的全局配置不能超过 64 KiB。',
      );
    assertSaveActive(signal);
    const handle = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertWritableConfigTarget(configPath);
    if (
      (await readConfigSnapshot(configPath)).fingerprint !==
      snapshot.fingerprint
    )
      throw new GcommitError(
        'CONFIG_CHANGED',
        '保存前全局配置已变化，请重新运行 gcommit model。',
      );
    assertSaveActive(signal);
    // rename 是保存生效点；完成后不再把取消报告为未保存。
    await rename(temporary, configPath);
    temporaryCreated = false;
  } catch (error: unknown) {
    if (error instanceof GcommitError) throw error;
    throw new GcommitError(
      'CONFIG_WRITE_FAILED',
      '无法保存模型设置。请检查目录写权限或 config.json.lock 是否被其他设置进程占用；原配置未被本次保存替换。',
    );
  } finally {
    // 两项独立清理；清理异常不覆盖主错误，也不能撤销已完成的替换。
    for (const path of [
      temporaryCreated ? temporary : null,
      locked ? lockPath : null,
    ]) {
      if (path === null) continue;
      try {
        await rm(path, { force: true });
      } catch {
        cleanupWarning = true;
      }
    }
  }
  return { cleanupWarning };
};
