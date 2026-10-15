import { z } from 'zod';
import type { Config } from '../config.js';
import { GcommitError } from '../errors.js';
import { describeResponseIssue } from '../codex/response.js';
/** 仅去掉两端空格，不吞掉换行、制表符或不可见控制字符。 */
const normalizeSpaces = (text: string): string =>
  text.replace(/^\p{Zs}+|\p{Zs}+$/gu, '');
// 提交响应结构；overwrite 保持 JSON Schema 的字段类型和原有限制。
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
  scope: z.string().overwrite(normalizeSpaces).min(1).max(40).nullable(),
  subject: z.string().overwrite(normalizeSpaces).min(1).max(120),
  body: z.array(z.string().overwrite(normalizeSpaces).min(1).max(500)).max(8),
});
/** 已验证的提交建议。 */
export type CommitSuggestion = z.infer<typeof commitSchema> & {
  message: string;
};
/** 校验消息结构与终端字符，保留正文内容供人工审核。 */
export const validateSuggestion = (
  response: unknown,
  config: Readonly<Config>,
): CommitSuggestion => {
  /** 统一拒绝无效结果，不将响应放进错误信息。 */
  const invalid = (reason: string): never => {
    throw new GcommitError(
      'ANALYSIS_RESPONSE_INVALID',
      `Codex 建议校验失败：${reason}，已丢弃结果。`,
    );
  };
  const parsed = commitSchema.safeParse(response);
  if (!parsed.success)
    return invalid(describeResponseIssue(parsed.error.issues[0]));
  // 已通过结构校验并规范化空格的字段。
  const value = parsed.data;
  if (config.commitStyle !== 'auto' && config.commitStyle !== value.format)
    return invalid('format 与当前提交格式配置不一致');
  if (value.format === 'conventional' && value.type === null)
    return invalid('conventional 格式的 type 不能为空');
  if (
    value.format === 'repository' &&
    (value.type !== null || value.scope !== null)
  )
    return invalid('repository 格式的 type 和 scope 必须为 null');
  /** 检查终端控制字符，不根据敏感值或脱敏标记拒绝建议。 */
  const validateText = (text: string, label: string): void => {
    if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text))
      invalid(`${label}含换行或控制字符`);
  };
  validateText(value.subject, '标题（subject）');
  for (const [index, line] of value.body.entries())
    validateText(line, `正文第 ${index + 1} 条`);
  if (value.scope !== null) {
    validateText(value.scope, 'scope');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,39}$/u.test(value.scope))
      return invalid('scope 含不允许的字符');
  }
  if (
    value.format === 'conventional' &&
    /^(?:feat|fix|update|refactor|perf|style|docs|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s/u.test(
      value.subject,
    )
  )
    return invalid('标题重复包含提交类型或 scope 前缀');
  const title: string =
    value.format === 'conventional'
      ? `${value.type}${value.scope === null ? '' : `(${value.scope})`}: ${value.subject}`
      : value.subject;
  const message: string =
    title +
    (value.body.length === 0
      ? ''
      : `\n\n${value.body.map((line) => `- ${line}`).join('\n')}`);
  if (Buffer.byteLength(message) > 4096)
    return invalid('完整提交消息超过 4096 字节上限');
  return { ...value, message };
};
