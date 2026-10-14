import { reportProgress } from '../progress.js';
import { preparePushSelection } from '../push/flow.js';
import type { PushSelection } from '../push/flow.js';
import { prepareCommitPlan } from '../commit/flow.js';
import type { CommitPlan } from '../commit/flow.js';
import type { Config } from '../config.js';
import { GcommitError } from '../errors.js';
import { runCodex } from '../codex/adapter.js';
import type { CodexOptions } from '../codex/adapter.js';
import { readGitContext, assertGitContextUnchanged } from '../git/context.js';
import type { GitContext, GitContextOptions } from '../git/types.js';
import { prepareAnalysis } from './prompt.js';
import type { AnalysisCoverage, PreparedAnalysis } from './prompt.js';
import { commitSchema, validateSuggestion } from './schema.js';
import type { CommitSuggestion } from './schema.js';

/** 分析流程选项。 */
export interface AnalysisOptions extends CodexOptions {
  /** 在调用 Codex 前通知实际发送范围。 */
  onPrepared?: (coverage: AnalysisCoverage) => void;
}
/** 只读分析结果。 */
export interface AnalysisResult {
  /** 通过校验的提交建议。 */
  suggestion: CommitSuggestion;
  /** 实际上下文范围。 */
  coverage: AnalysisCoverage;
}
/** 绑定一次 Git 快照的建议会话。 */
export interface AnalysisSession {
  /** 为刚完成的提交解析推送目标，不访问远端。 */
  preparePush: (oid: string) => Promise<PushSelection>;
  /** 复核并准备一次性最终确认计划，不执行写入。 */
  prepareCommit: () => Promise<CommitPlan>;
  /** 读取当前有效建议。 */
  current: () => AnalysisResult;
  /** 复核原始快照。 */
  assertUnchanged: () => Promise<void>;
  /** 使用上一版生成替代建议。 */
  regenerate: () => Promise<void>;
  /** 在内存中更新标题和逐行正文。 */
  edit: (title: string, body: string) => Promise<void>;
  /** 校验编辑内容，不改变当前建议。 */
  validateEdit: (title: string, body: string) => CommitSuggestion;
  /** 复核后读取脱敏净变化。 */
  diff: () => Promise<string>;
}

/** 创建只读分析会话，净变化为空时返回 null。 */
export const createAnalysisSession = async (
  cwd: string,
  config: Readonly<Config>,
  options: AnalysisOptions = {},
): Promise<AnalysisSession | null> => {
  // 原始读取与模型预算各自受限。
  const gitOptions: GitContextOptions = {
    maxContextBytes: config.maxReadBytes,
    maxFileBytes: config.maxFileBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  /** 结束失败或取消的生成，不携带异常原文。 */
  const reportFailure = (error: unknown): void => {
    const cancelled: boolean =
      options.signal?.aborted === true ||
      (error instanceof GcommitError &&
        ['CODEX_CANCELLED', 'PROCESS_CANCELLED'].includes(error.code));
    reportProgress(options.onProgress, {
      type: 'finished',
      outcome: cancelled ? 'cancelled' : 'failed',
    });
  };
  // 初次生成计时包含 Git 读取；重新生成从快照复核开始。
  reportProgress(options.onProgress, { type: 'stage', stage: 'git' });
  let context: GitContext;
  try {
    context = await readGitContext(cwd, gitOptions);
  } catch (error: unknown) {
    reportFailure(error);
    throw error;
  }
  if (context.netChanges.length === 0) {
    reportProgress(options.onProgress, { type: 'finished', outcome: 'empty' });
    return null;
  }
  /** 在交互、模型调用和退出前复核快照。 */
  const assertUnchanged = async (): Promise<void> => {
    await assertGitContextUnchanged(context, gitOptions);
  };
  /** 过滤并生成有效建议，不提前改变当前会话。 */
  const generate = async (
    previous?: CommitSuggestion,
  ): Promise<{ result: AnalysisResult; prepared: PreparedAnalysis }> => {
    if (previous !== undefined)
      reportProgress(options.onProgress, { type: 'stage', stage: 'git' });
    try {
      await assertUnchanged();
      reportProgress(options.onProgress, { type: 'stage', stage: 'context' });
      const prepared = await prepareAnalysis(
        context,
        config,
        options.signal,
        previous,
      );
      options.onPrepared?.(prepared.coverage);
      const response = await runCodex(
        prepared.prompt,
        commitSchema,
        config,
        options,
      );
      const suggestion = validateSuggestion(response, config, prepared.filter);
      await assertUnchanged();
      reportProgress(options.onProgress, {
        type: 'finished',
        outcome: 'success',
      });
      return { result: { suggestion, coverage: prepared.coverage }, prepared };
    } catch (error: unknown) {
      reportFailure(error);
      throw error;
    }
  };
  // 仅成功生成或成功编辑后替换该状态。
  let state = await generate();
  /** 把用户输入转换为当前格式并复用安全校验。 */
  const validateEdit = (title: string, body: string): CommitSuggestion => {
    try {
      const current = state.result.suggestion;
      const match = /^([a-z]+)(?:\(([^)]+)\))?: (.+)$/u.exec(title);
      return validateSuggestion(
        {
          format: current.format,
          type: current.format === 'conventional' ? (match?.[1] ?? null) : null,
          scope:
            current.format === 'conventional' ? (match?.[2] ?? null) : null,
          subject:
            current.format === 'conventional' ? (match?.[3] ?? '') : title,
          body:
            body === ''
              ? []
              : body
                  .replaceAll('\r\n', '\n')
                  .split('\n')
                  .filter((line) => line.trim() !== ''),
        },
        config,
        state.prepared.filter,
      );
    } catch {
      throw new GcommitError(
        'INTERACTION_EDIT_INVALID',
        '标题或正文无效：请检查提交格式、长度、空行、控制字符及敏感内容。原建议已保留。',
      );
    }
  };
  return {
    preparePush: async (oid): Promise<PushSelection> =>
      preparePushSelection(
        context.repository.root,
        oid,
        state.prepared.filter,
        gitOptions,
      ),
    prepareCommit: async (): Promise<CommitPlan> =>
      prepareCommitPlan(
        context,
        state.result.suggestion.message,
        state.prepared.filter,
        gitOptions,
      ),
    current: (): AnalysisResult => structuredClone(state.result),
    assertUnchanged,
    validateEdit,
    regenerate: async (): Promise<void> => {
      state = await generate(state.result.suggestion);
    },
    edit: async (title: string, body: string): Promise<void> => {
      await assertUnchanged();
      const suggestion = validateEdit(title, body);
      state.result = { ...state.result, suggestion };
    },
    diff: async (): Promise<string> => {
      await assertUnchanged();
      return state.prepared.diff;
    },
  };
};
