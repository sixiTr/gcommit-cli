import { z } from 'zod';
import type { Config } from '../config.js';
import { GcommitError } from '../errors.js';
import type { SecretFilter } from './security.js';
// 提交响应结构。
export const commitSchema = z.strictObject({
  format: z.enum(['conventional', 'repository']),
  type: z
    .enum([
      'feat',
      'fix',
      'update',
      'refactor',
      'perf',
      'style',
      'docs',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ])
    .nullable(),
  scope: z.string().min(1).max(40).nullable(),
  subject: z.string().min(1).max(120),
  body: z.array(z.string().min(1).max(500)).max(8),
});
/** 已验证的提交建议。 */
export type CommitSuggestion = z.infer<typeof commitSchema> & {
  message: string;
};
/** 校验语义并组合提交消息。 */
export const validateSuggestion = (
  response: unknown,
  config: Readonly<Config>,
  filter: SecretFilter,
): CommitSuggestion => {
  /** 统一拒绝无效结果，不将响应放进错误信息。 */
  const invalid = (): never => {
    throw new GcommitError(
      'ANALYSIS_RESPONSE_INVALID',
      'Codex 建议含无效字段、格式或敏感内容，已丢弃结果。',
    );
  };
  const parsed = commitSchema.safeParse(response);
  if (!parsed.success) return invalid();
  const value = parsed.data;
  if (
    (config.commitStyle !== 'auto' && config.commitStyle !== value.format) ||
    (value.format === 'conventional' && value.type === null) ||
    (value.format === 'repository' &&
      (value.type !== null || value.scope !== null))
  )
    return invalid();
  if (
    value.scope !== null &&
    !/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,39}$/u.test(value.scope)
  )
    return invalid();
  if (
    [
      value.subject,
      ...value.body,
      ...(value.scope === null ? [] : [value.scope]),
    ].some(
      (text) =>
        text.trim() !== text ||
        /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text) ||
        filter.isUnsafe(text) ||
        text.includes('[REDACTED]'),
    )
  )
    return invalid();
  if (
    value.format === 'conventional' &&
    /^(?:feat|fix|update|refactor|perf|style|docs|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s/u.test(
      value.subject,
    )
  )
    return invalid();
  const title: string =
    value.format === 'conventional'
      ? `${value.type}${value.scope === null ? '' : `(${value.scope})`}: ${value.subject}`
      : value.subject;
  const message: string =
    title +
    (value.body.length === 0
      ? ''
      : `\n\n${value.body.map((line) => `- ${line}`).join('\n')}`);
  if (Buffer.byteLength(message) > 4096 || filter.isUnsafe(message))
    return invalid();
  return { ...value, message };
};
