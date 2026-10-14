import { GcommitError } from '../errors.js';
import type { AnalysisSession } from '../analysis/session.js';
import { displayPath } from '../analysis/security.js';
import type { SecretFilter } from '../analysis/security.js';
import type { CommitReceipt } from '../git/commit.js';
import { readPushState, resolvePushTarget, pushTarget } from '../git/push.js';
import type { PushOptions, PushReceipt } from '../git/push.js';

/** 已过滤的 remote 选择项。 */
export interface PushRemoteChoice {
  /** 仅用于选择的会话标识，不包含原始名称。 */
  id: string;
  /** 已过滤和转义的 remote 名称。 */
  label: string;
}
/** 推送前可展示的确认信息。 */
export interface PushPreview {
  /** 已过滤的 remote 名称。 */
  remote: string;
  /** 已遮蔽凭据的实际 push URL。 */
  url: string;
  /** 本地分支完整名称。 */
  sourceRef: string;
  /** 明确的远端分支完整名称。 */
  targetRef: string;
  /** 固定的提交标识。 */
  oid: string;
  /** 是否已经配置 upstream。 */
  hasUpstream: boolean;
}
/** 单次确认对应的固定推送操作。 */
export interface PushPlan {
  /** 可展示的副本，不控制真实操作。 */
  preview: PushPreview;
  /** 仅在用户确认后调用。 */
  execute: () => Promise<PushReceipt>;
}
/** 本地发现结果；选择本身不访问远端。 */
export interface PushSelection {
  /** 可选择的 remote。 */
  choices: PushRemoteChoice[];
  /** 配置已明确的选择，没有则询问用户。 */
  preferred: string | null;
  /** 根据会话标识准备最终确认。 */
  select: (id: string) => Promise<PushPlan>;
}
/** 推送交互边界。 */
export interface PushUI {
  /** 多目标时明确选择 remote，取消返回 null。 */
  chooseRemote: (choices: PushRemoteChoice[]) => Promise<string | null>;
  /** 默认拒绝，只有明确选择才返回 true。 */
  confirmPush: (preview: PushPreview) => Promise<boolean>;
}
/** 推送流程的明确结束状态。 */
export type PushResult =
  | { status: 'skipped' | 'no-remote' | 'cancelled' }
  | { status: 'pushed'; receipt: PushReceipt };

/** 在显示地址前遮蔽全部 URL 凭据、查询和片段。 */
const visibleUrl = (url: string): string => {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GcommitError(
        'GIT_PUSH_UNSUPPORTED',
        '无法安全展示推送地址，未开始推送。',
      );
    }
    const userinfo = parsed.username || parsed.password ? '[REDACTED]@' : '';
    const suffix = /[?#]/u.test(url) ? '?[REDACTED]' : '';
    return `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname}${suffix}`;
  }
  // 本地路径与 scp 形式不能用 URL 解析；按明确分隔位置截取，不依赖点号匹配换行。
  const boundary = url.search(/[?#]/u);
  const base = boundary < 0 ? url : url.slice(0, boundary);
  const colon = base.indexOf(':');
  const at = colon < 0 ? -1 : base.slice(0, colon).lastIndexOf('@');
  const address = at < 0 ? base : `[REDACTED]@${base.slice(at + 1)}`;
  return `${address}${boundary < 0 ? '' : '?[REDACTED]'}`;
};
/** 为已经完成的本地提交准备安全选项，始终复核有效配置。 */
export const preparePushSelection = async (
  cwd: string,
  oid: string,
  filter: SecretFilter,
  options: PushOptions = {},
): Promise<PushSelection> => {
  const capturedOptions: PushOptions = { ...options };
  const state = await readPushState(cwd, oid, capturedOptions);
  const choices = state.remotes.map((remote, index) => ({
    id: String(index),
    label: displayPath(remote, filter),
  }));
  return {
    choices,
    preferred:
      state.preferred === null
        ? null
        : String(state.remotes.indexOf(state.preferred)),
    select: async (id): Promise<PushPlan> => {
      const remote = state.remotes.find((_name, index) => String(index) === id);
      if (remote === undefined)
        throw new GcommitError(
          'ARGUMENT_INVALID',
          '无效的 remote 选择，未推送。',
        );
      const target = await resolvePushTarget(state, remote, capturedOptions);
      const preview: PushPreview = {
        remote: displayPath(remote, filter),
        url: displayPath(visibleUrl(target.url), filter),
        sourceRef: displayPath(target.ref, filter),
        targetRef: displayPath(target.targetRef, filter),
        oid: target.oid,
        hasUpstream: state.upstream !== null,
      };
      let used = false;
      return {
        preview,
        execute: async (): Promise<PushReceipt> => {
          if (used)
            throw new GcommitError(
              'GIT_PUSH_PLAN_USED',
              '该推送计划已使用，不能自动重试。',
            );
          used = true;
          return pushTarget(target, capturedOptions);
        },
      };
    },
  };
};
/** 取消时停止后续发现、选择和写入。 */
const checkCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new GcommitError(
      'PROCESS_CANCELLED',
      '推送流程已取消，本地提交已保留。',
    );
};
/** 在本地提交成功后单独确认推送；禁用时不进行目标发现。 */
export const offerPush = async (
  session: Pick<AnalysisSession, 'preparePush'>,
  commit: CommitReceipt,
  ui: PushUI,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<PushResult> => {
  if (!enabled) return { status: 'skipped' };
  checkCancelled(signal);
  const selection = await session.preparePush(commit.oid);
  if (selection.choices.length === 0) return { status: 'no-remote' };
  const id = selection.preferred ?? (await ui.chooseRemote(selection.choices));
  checkCancelled(signal);
  if (id === null) return { status: 'cancelled' };
  const plan = await selection.select(id);
  const confirmed = await ui.confirmPush(plan.preview);
  checkCancelled(signal);
  if (confirmed !== true) return { status: 'cancelled' };
  return { status: 'pushed', receipt: await plan.execute() };
};
