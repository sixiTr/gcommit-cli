import { GcommitError } from '../errors.js';

/** 判断路径是否包含凭据文件、证书或秘密目录。 */
export const isSensitivePath = (path: string): boolean =>
  path
    .split('/')
    .some(
      (part: string): boolean =>
        /^(?:\.env(?:[.-].*)?|\.envrc|\.npmrc|\.pypirc|\.?netrc|\.aws|\.ssh|\.gnupg|\.docker|\.kube|auth\.json|service[-_]account|secrets?|credentials?)(?:[._-].*)?$/iu.test(
          part,
        ) ||
        /^(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:\..*)?$/iu.test(part) ||
        /\.(?:key|pem|p12|pfx|jks|keystore|crt|cer|der)$/iu.test(part),
    );

// 常见密钥、授权头与带密码 URL；不以熵猜测任意业务内容。
const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|$)/gu,
  /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(?:Bearer|Basic)\s+([^\s"'`,;<>]+)/giu,
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:([^\s/@]+)@/giu,
];

// 键名匹配有长度边界，避免长标识符上的重复回溯。
const ASSIGNMENT: RegExp = /\b([a-z_][\w-]{0,127})["']?[ \t]*[:=][ \t]*/giu;
// 常见凭据字段后缀，兼容环境变量前缀和 camelCase。
const SECRET_KEY: RegExp =
  /(?:password|passwd|pwd|(?:api|access|refresh|auth|client|private|secret)[_-]?(?:key|token|secret)|token|secret|authorization)$/iu;

/** 识别带 HTTP 方法和 Api 前缀的接口响应模式映射，不按凭据字段推断其模式值。 */
const isOperationMode = (
  text: string,
  key: string,
  keyStart: number,
  valueStart: number,
): boolean =>
  // 仅豁免双引号属性的固定模式值；普通 password、赋值表达式和其他值仍检查。
  text[keyStart - 1] === '"' &&
  /^"[ \t]*:[ \t\r\n]*$/u.test(text.slice(keyStart + key.length, valueStart)) &&
  /^(?:get|post|put|patch|delete|head|options)Api[A-Z0-9_][A-Za-z0-9_]*$/u.test(
    key,
  ) &&
  /^"(?:data|raw|response|empty)"[ \t]*(?=[,}\r\n]|$)/u.test(
    text.slice(valueStart),
  );

/** 无法确定凭据边界时停止发送。 */
const ambiguousSecret = (): never => {
  throw new GcommitError(
    'ANALYSIS_SENSITIVE_CONTENT',
    '无法安全解析凭据声明，已停止分析。请检查变更中的敏感内容。',
  );
};

/** 保存字面值及多行中的各行，供历史和输出交叉检测。 */
const addValue = (values: string[], value: string): void => {
  if (!value.trim() || value === '[REDACTED]') return;
  values.push(value);
  if (value.includes('\n'))
    for (const line of value.split(/\r?\n/u))
      if (line.trim()) values.push(line.trim());
};

/** 读取带缩进的 YAML 块值，保留完整内容及各行秘密。 */
const readBlockValue = (
  text: string,
  keyStart: number,
  start: number,
): string => {
  const lineStart: number = text.lastIndexOf('\n', keyStart) + 1;
  const indent: number =
    /^[ \t]*/u.exec(text.slice(lineStart, keyStart))?.[0].length ?? 0;
  const headerEnd: number = text.indexOf('\n', start);
  if (
    headerEnd < 0 ||
    !/^[|>][1-9+-]*[ \t]*(?:#[^\n]*)?\r?$/u.test(text.slice(start, headerEnd))
  )
    return ambiguousSecret();
  let end: number = headerEnd + 1;
  while (end < text.length) {
    const newline: number = text.indexOf('\n', end);
    const next: number = newline < 0 ? text.length : newline + 1;
    const line: string = text.slice(end, next);
    const padding: number = /^[ \t]*/u.exec(line)?.[0].length ?? 0;
    if (line.trim() && padding <= indent) break;
    end = next;
  }
  const value: string = text.slice(headerEnd + 1, end);
  if (!value.trim()) return ambiguousSecret();
  return value;
};

/** 收集可识别的秘密值，供跨位置遮蔽使用。 */
const secretValues = (text: string, fragment: boolean = false): string[] => {
  const values: string[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern))
      addValue(values, match[1] ?? match[0]);
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    // 正则捕获的候选凭据字段名。
    const key: string = match[1] ?? '';
    if (!SECRET_KEY.test(key)) continue;
    let start: number = match.index + match[0].length;
    while (start < text.length && /\s/u.test(text[start] ?? '')) start++;
    // TypeScript/Kotlin 的简单类型注解不属于凭据值。
    const annotation: string | undefined =
      /^[a-z_$][\w$<>\[\]|?. \t]{0,128}=[ \t]*/iu.exec(
        text.slice(start, start + 256),
      )?.[0];
    if (annotation !== undefined) start += annotation.length;
    while (start < text.length && /\s/u.test(text[start] ?? '')) start++;
    if (isOperationMode(text, key, match.index, start)) continue;
    const quote: string = text[start] ?? '';
    if (quote === '|' || quote === '>') {
      try {
        addValue(values, readBlockValue(text, match.index, start));
      } catch (error: unknown) {
        if (!fragment) throw error;
      }
    } else if (quote === '"' || quote === "'" || quote === '`') {
      const delimiter: string = text.startsWith(quote.repeat(3), start)
        ? quote.repeat(3)
        : quote;
      let end: number = start + delimiter.length;
      while (end < text.length && !text.startsWith(delimiter, end))
        end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) {
        if (fragment) continue;
        return ambiguousSecret();
      }
      const value: string = text.slice(start + delimiter.length, end);
      addValue(values, value);
      if (quote === '"' && delimiter.length === 1) {
        try {
          const decoded: unknown = JSON.parse(`"${value}"`);
          if (typeof decoded === 'string') addValue(values, decoded);
        } catch {
          // 非 JSON 源码字符串仍按原始字面值遮蔽。
        }
      }
    } else {
      addValue(values, /^[^\s,;#}\]]+/u.exec(text.slice(start))?.[0] ?? '');
    }
  }
  return values;
};

/** 在原文上合并秘密覆盖区间，只生成一次标记并保留换行。 */
const redactValues = (text: string, values: readonly string[]): string => {
  const mask: Uint8Array = new Uint8Array(text.length);
  for (const value of values) {
    let start: number = text.indexOf(value);
    let previousEnd: number = 0;
    while (start >= 0) {
      const end: number = start + value.length;
      mask.fill(1, Math.max(start, previousEnd), end);
      previousEnd = end;
      start = text.indexOf(value, start + 1);
    }
  }
  // 输入中已有的标记保持稳定，不将其字符再当作短秘密重写。
  for (const marker of text.matchAll(/\[REDACTED\]/gu))
    mask.fill(0, marker.index, marker.index + marker[0].length);
  const chunks: string[] = [];
  let start: number = 0;
  while (start < text.length) {
    let end: number = start + 1;
    while (end < text.length && mask[end] === mask[start]) end++;
    const part: string = text.slice(start, end);
    chunks.push(
      mask[start] === 1 ? part.replace(/[^\r\n]+/gu, '[REDACTED]') : part,
    );
    start = end;
  }
  return chunks.join('');
};

/** 文本过滤能力。 */
export interface SecretFilter {
  /** 是否发现过需要遮蔽的内容。 */
  readonly changed: boolean;
  /** 替换已识别的秘密。 */
  redact: (text: string) => string;
  /** 检测文本是否包含已知或新出现的凭据，不用于拦截提交建议。 */
  isUnsafe: (text: string) => boolean;
}

/** 收集本次分析的秘密并创建过滤器。 */
export const createSecretFilter = (
  texts: readonly string[],
  fragments: readonly string[] = [],
): SecretFilter => {
  // patch 只是片段，不能将其中被 Git 截断的语法当作完整文件解析失败。
  const known: string[] = [
    ...new Set([
      ...texts.flatMap((text) => secretValues(text)),
      ...fragments.flatMap((text) => secretValues(text, true)),
    ]),
  ].sort((a, b) => b.length - a.length);
  if (known.length > 512)
    throw new GcommitError(
      'ANALYSIS_CONTEXT_LIMIT',
      '敏感内容数量超过安全处理上限，请缩小变更范围。',
    );
  /** 先识别当前文本，再一次性遮蔽全部秘密区间。 */
  const redact = (text: string): string =>
    redactValues(text, [...new Set([...secretValues(text), ...known])]);
  return {
    changed: known.length > 0,
    redact,
    isUnsafe: (text: string): boolean => {
      try {
        return (
          secretValues(text).length > 0 ||
          known.some((value) => text.includes(value))
        );
      } catch {
        return true;
      }
    },
  };
};

/** 将已过滤文本转义为终端可安全展示的字符串；不重新解析片段。 */
export const quoteTerminalText = (text: string): string =>
  JSON.stringify(text).replace(
    /[\u007f-\u009f\p{Cf}\u2028\u2029]/gu,
    (character: string): string =>
      `\\u{${character.codePointAt(0)?.toString(16)}}`,
  );

/** 转换为可安全展示的路径。 */
export const displayPath = (path: string, filter: SecretFilter): string =>
  quoteTerminalText(filter.redact(path));
