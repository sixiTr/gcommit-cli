import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { ERROR_CODES, GcommitError } from './errors.js';
import type { AnalysisCoverage } from './analysis/prompt.js';

// 允许输出的命令类别；不从完整参数或可执行路径生成日志。
const OPERATIONS = [
  'process.other',
  'git.rev-parse',
  'git.symbolic-ref',
  'git.config',
  'git.ls-files',
  'git.check-attr',
  'git.status',
  'git.log',
  'git.diff',
  'git.ls-tree',
  'git.cat-file',
  'git.hash-object',
  'git.remote',
  'git.ls-remote',
  'git.check-ref-format',
  'git.var',
  'git.add',
  'git.write-tree',
  'git.commit',
  'git.push',
  'git.other',
  'codex.version',
  'codex.login',
  'codex.models',
  'codex.exec',
] as const;
/** 受控子进程类别。 */
export type ProcessOperation = (typeof OPERATIONS)[number];
// 允许输出的 CLI 阶段。
const PHASES = [
  'configuration',
  'analysis',
  'codex',
  'interaction',
  'commit',
  'push',
] as const;
/** 当前流程阶段。 */
export type DiagnosticPhase = (typeof PHASES)[number];
/** 单次调用的隔离日志状态。 */
interface DiagnosticScope {
  /** 安全文本接收器。 */
  write: (line: string) => void;
  /** 已记录事件数。 */
  count: number;
  /** 当前流程阶段。 */
  phase: DiagnosticPhase;
  /** 四种写命令各自的最后一次受控结果。 */
  writes: Map<ProcessOperation, string>;
  /** 最后一个受控失败事件。 */
  failure: string | null;
}
// 禁用日志时使用空作用域，避免继承外层诊断。
const scope: AsyncLocalStorage<DiagnosticScope | null> =
  new AsyncLocalStorage();

/** 写入有界事件，日志失败不能改变业务行为。 */
const emit = (text: string, final: boolean = false): void => {
  const current = scope.getStore();
  if (!current) return;
  let message: string = text;
  if (!final) {
    if (current.count > 500) return;
    if (current.count === 500) message = 'event=truncated limit=500';
    current.count++;
  }
  try {
    current.write(`[debug] ${message}\n`);
  } catch {
    /* 诊断接收器不参与业务结果。 */
  }
};

/** 返回非负整数指标，拒绝非有限或非整数输入。 */
const metric = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** 从受控异常提取白名单错误码，不读取 message/stack/cause。 */
const errorCode = (error: unknown): string =>
  error instanceof GcommitError &&
  ERROR_CODES.some((code) => code === error.code)
    ? error.code
    : 'UNKNOWN';
/** 记录当前流程阶段。 */
export const diagnosticPhase = (phase: DiagnosticPhase): void => {
  const current = scope.getStore();
  if (!current || !PHASES.some((value) => value === phase)) return;
  current.phase = phase;
  emit(`event=phase phase=${phase}`);
};
/** 记录最终或已处理错误的类别，不输出异常内容。 */
export const diagnosticFailure = (error: unknown): void => {
  const current = scope.getStore();
  if (current) {
    current.failure = `phase=${current.phase} code=${errorCode(error)}`;
    emit(`event=failure ${current.failure}`);
  }
};
/** 记录上下文大小与覆盖数量，不输出任何路径。 */
export const diagnosticCoverage = (coverage: AnalysisCoverage): void => {
  emit(
    `event=context promptBytes=${metric(coverage.promptBytes)} files=${coverage.files.length} metadataOnly=${coverage.files.filter((file) => file.coverage === 'metadata').length} mode=${coverage.mode === 'full' ? 'full' : 'trimmed'} redacted=${coverage.redacted === true}`,
  );
};
/** 记录真实进程的受控结果与耗时，非零结果不等于整个流程失败。 */
export const diagnosticCommand = (
  operation: ProcessOperation | undefined,
  started: number,
  error?: GcommitError,
): void => {
  const label: ProcessOperation =
    OPERATIONS.find((value) => value === operation) ?? 'process.other';
  const exit: string =
    error?.exitCode !== undefined &&
    Number.isSafeInteger(error.exitCode) &&
    error.exitCode >= 0
      ? ` exitCode=${error.exitCode}`
      : '';
  const details: string = `operation=${label} result=${error === undefined ? 'ok' : errorCode(error)} elapsedMs=${metric(Math.round(performance.now() - started))}${exit}`;
  if (
    label === 'git.add' ||
    label === 'git.write-tree' ||
    label === 'git.commit' ||
    label === 'git.push'
  )
    scope.getStore()?.writes.set(label, details);
  emit(`event=command ${details}`);
};
/** 将固定 Git 子命令映射到白名单，未知文本永不回显。 */
export const gitOperation = (command: string | undefined): ProcessOperation =>
  OPERATIONS.find((value) => value === `git.${command}`) ?? 'git.other';
/** 在单次异步调用内启用诊断，结束后恢复上层作用域。 */
export const withDiagnostics = async <T>(
  enabled: boolean,
  write: (line: string) => void,
  run: () => Promise<T>,
): Promise<T> =>
  scope.run(
    enabled
      ? {
          write,
          count: 0,
          phase: 'configuration',
          writes: new Map(),
          failure: null,
        }
      : null,
    async () => {
      const started: number = performance.now();
      try {
        return await run();
      } catch (error: unknown) {
        diagnosticFailure(error);
        throw error;
      } finally {
        const current = scope.getStore();
        if (current && current.count > 500) {
          for (const details of current.writes.values())
            emit(`event=last-write ${details}`, true);
          if (current.failure !== null)
            emit(`event=last-failure ${current.failure}`, true);
        }
        emit(
          `event=end elapsedMs=${metric(Math.round(performance.now() - started))}`,
          true,
        );
      }
    },
  );
