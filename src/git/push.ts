import { resolve } from 'node:path';
import { GcommitError } from '../errors.js';
import { runProcessBytes } from '../process.js';
import {
  createGitEnvironment,
  GIT_ARGUMENTS,
  runGit,
  optionalGit,
  gitLine,
  nulRecords,
  decodeGit,
} from './command.js';
import type { GitCommandOptions } from './command.js';
import { digestBytes } from './files.js';
import { locateRepository, checkRepositoryState } from './status.js';

/** 推送执行约束。 */
export interface PushOptions {
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 实际传输的超时毫秒数，默认两分钟。 */
  timeoutMs?: number;
}
/** 仅在本机保存的推送发现结果，不直接展示原始名称。 */
export interface PushState {
  /** 工作树根目录。 */
  root: string;
  /** 本地完整分支引用。 */
  ref: string;
  /** 本次明确确认的提交。 */
  oid: string;
  /** 已配置的 remote 名称。 */
  remotes: string[];
  /** 根据配置或唯一 remote 确定的默认目标。 */
  preferred: string | null;
  /** 已配置的 upstream；不要求 tracking ref 已下载。 */
  upstream: { remote: string; ref: string } | null;
  /** 分支、HEAD 与有效配置的摘要。 */
  fingerprint: string;
}
/** 绑定本地状态与唯一有效地址的推送目标。 */
export interface PushTarget extends PushState {
  /** 所选 remote 别名。 */
  remote: string;
  /** 已展开且不会再次重写的地址，不直接展示。 */
  url: string;
  /** 远端完整分支引用。 */
  targetRef: string;
}
/** Git 已确认成功更新的唯一目标。 */
export interface PushReceipt {
  /** 推送的提交。 */
  oid: string;
  /** 远端分支。 */
  targetRef: string;
}
/** 传输开始后的错误，不能据退出码断言远端没有更新。 */
export class PushExecutionError extends GcommitError {
  /** 保存受控原因，不附带 URL、hook 日志或原始异常。 */
  constructor(reason: string) {
    super(
      'GIT_PUSH_FAILED',
      `${reason}\n本地提交已保留；远端可能已更新，请检查远端分支后再操作。工具未自动重试、拉取、回滚或强推。`,
    );
    this.name = 'PushExecutionError';
  }
}
/** 拒绝首版不能准确解释的推送配置。 */
const unsupported = (): never => {
  throw new GcommitError(
    'GIT_PUSH_UNSUPPORTED',
    '推送配置不受支持：请检查 remote、upstream、mirror、多 URL、自定义推送映射或传输配置。本地提交已保留。',
  );
};
/** 拒绝失效的确认状态。 */
const changed = (): never => {
  throw new GcommitError(
    'GIT_PUSH_CHANGED',
    '分支、HEAD 或 Git 配置已变化，原推送确认失效；尚未开始推送。',
  );
};
/** 把取消约束交给既有只读 Git 命令。 */
const readOptions = (options: PushOptions): GitCommandOptions =>
  options.signal === undefined ? {} : { signal: options.signal };
/** 读取单值配置，遵守 Git 自身的配置覆盖顺序。 */
const configValue = async (
  root: string,
  key: string,
  options: GitCommandOptions,
): Promise<string | null> => {
  const value = await optionalGit(
    root,
    ['config', '--null', '--get', key],
    options,
  );
  if (value === null) return null;
  const values = nulRecords(value);
  if (values.length !== 1) return unsupported();
  return values[0]!;
};
/** 验证完整分支引用，避免 refspec 歧义。 */
const checkBranch = async (
  root: string,
  ref: string,
  options: GitCommandOptions,
): Promise<void> => {
  if (!ref.startsWith('refs/heads/')) return unsupported();
  try {
    await runGit(root, ['check-ref-format', ref], options);
  } catch (error: unknown) {
    if (error instanceof GcommitError && error.code === 'PROCESS_CANCELLED')
      throw error;
    return unsupported();
  }
};
/** 只读本地配置解析 remote 优先级，不访问网络或修改 tracking。 */
export const readPushState = async (
  cwd: string,
  expectedOid: string,
  options: PushOptions = {},
): Promise<PushState> => {
  if (options.signal?.aborted)
    throw new GcommitError('PROCESS_CANCELLED', '推送已取消，尚未开始传输。');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedOid)) return changed();
  const commandOptions = readOptions(options);
  const repository = await locateRepository(cwd, commandOptions);
  if (repository.head !== expectedOid) return changed();
  const root = repository.root;
  const config = await runGit(
    root,
    ['config', '--null', '--list'],
    commandOptions,
  );
  const ref = gitLine(
    await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], commandOptions),
  );
  await checkBranch(root, ref, commandOptions);
  await checkRepositoryState(repository, commandOptions);
  const branch = ref.slice('refs/heads/'.length);
  const rawRemotes = gitLine(await runGit(root, ['remote'], commandOptions));
  const remotes = rawRemotes === '' ? [] : rawRemotes.split('\n').sort();
  for (const remote of remotes) {
    if (
      !remote ||
      remote.startsWith('-') ||
      /[\s\u0000-\u001f\u007f]/u.test(remote)
    )
      return unsupported();
    try {
      await runGit(
        root,
        ['check-ref-format', `refs/remotes/${remote}/gcommit-check`],
        commandOptions,
      );
    } catch {
      return unsupported();
    }
  }
  const upstreamRemote = await configValue(
    root,
    `branch.${branch}.remote`,
    commandOptions,
  );
  const mergeBytes = await optionalGit(
    root,
    ['config', '--null', '--get-all', `branch.${branch}.merge`],
    commandOptions,
  );
  const merges = mergeBytes === null ? [] : nulRecords(mergeBytes);
  if (merges.length > 1 || (merges.length > 0 && upstreamRemote === null))
    return unsupported();
  const upstream =
    merges.length === 0 ? null : { remote: upstreamRemote!, ref: merges[0]! };
  if (upstream !== null) await checkBranch(root, upstream.ref, commandOptions);
  const preferred =
    (await configValue(root, `branch.${branch}.pushRemote`, commandOptions)) ??
    (await configValue(root, 'remote.pushDefault', commandOptions)) ??
    upstreamRemote ??
    (remotes.length === 1 ? remotes[0]! : null);
  if (preferred !== null && !remotes.includes(preferred)) return unsupported();
  const after = await locateRepository(root, commandOptions);
  if (
    after.head !== expectedOid ||
    after.branch !== repository.branch ||
    !config.equals(
      await runGit(root, ['config', '--null', '--list'], commandOptions),
    )
  )
    return changed();
  const fingerprint = digestBytes(
    JSON.stringify({
      root,
      gitDir: repository.gitDir,
      ref,
      oid: expectedOid,
      config: digestBytes(config),
    }),
  );
  return {
    root,
    ref,
    oid: expectedOid,
    remotes,
    preferred,
    upstream,
    fingerprint,
  };
};
/** 将本地路径固定为绝对路径，并排除任意 remote helper。 */
const transportUrl = (root: string, url: string): string => {
  if (
    !url ||
    url.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(url) ||
    url.startsWith('-') ||
    /^[a-z][a-z0-9+.-]*::/iu.test(url)
  )
    return unsupported();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!['file', 'ssh', 'http', 'https', 'git'].includes(scheme))
      return unsupported();
    return url;
  }
  if (
    !url.startsWith('/') &&
    !url.startsWith('./') &&
    !url.startsWith('../') &&
    /^[^/:]+:.+/u.test(url)
  )
    return url;
  if (url.startsWith('~')) return unsupported();
  return resolve(root, url);
};
/** 复核目标发现阶段的本地状态。 */
const assertState = async (
  state: PushState,
  options: PushOptions,
): Promise<void> => {
  const current = await readPushState(state.root, state.oid, options);
  if (current.fingerprint !== state.fingerprint) return changed();
};
/** 解析唯一 push URL 和目标分支，仍不联系远端。 */
export const resolvePushTarget = async (
  state: PushState,
  remote: string,
  options: PushOptions = {},
): Promise<PushTarget> => {
  await assertState(state, options);
  if (!state.remotes.includes(remote)) return unsupported();
  const opts = readOptions(options);
  const mirror = await optionalGit(
    state.root,
    ['config', '--type=bool', '--get', `remote.${remote}.mirror`],
    opts,
  );
  if (mirror !== null && gitLine(mirror) === 'true') return unsupported();
  for (const suffix of ['push', 'receivepack', 'vcs'])
    if (
      (await configValue(state.root, `remote.${remote}.${suffix}`, opts)) !==
      null
    )
      return unsupported();
  const urls = gitLine(
    await runGit(
      state.root,
      ['remote', 'get-url', '--push', '--all', remote],
      opts,
    ),
  ).split('\n');
  if (urls.length !== 1) return unsupported();
  const url = transportUrl(state.root, urls[0]!);
  // 读取形式能排除 insteadOf；直接推送还会应用 pushInsteadOf，匹配时保守拒绝。
  const rewritten = gitLine(
    await runGit(state.root, ['ls-remote', '--get-url', url], opts),
  );
  if (rewritten !== url) return unsupported();
  const pushRules = await optionalGit(
    state.root,
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^url\\..*\\.pushinsteadof$',
    ],
    opts,
  );
  if (pushRules !== null) {
    for (const key of new Set(nulRecords(pushRules))) {
      const prefixes = nulRecords(
        await runGit(state.root, ['config', '--null', '--get-all', key], opts),
      );
      if (prefixes.some((prefix) => url.startsWith(prefix)))
        return unsupported();
    }
  }
  const targetRef =
    state.upstream?.remote === remote ? state.upstream.ref : state.ref;
  await checkBranch(state.root, targetRef, opts);
  await assertState(state, options);
  return { ...state, remote, url, targetRef };
};
/** 仅推送确认的 OID 到一个 heads 引用，失败不推测远端状态。 */
export const pushTarget = async (
  target: PushTarget,
  options: PushOptions = {},
): Promise<PushReceipt> => {
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new GcommitError(
      'ARGUMENT_INVALID',
      '推送超时必须是 1 到 600000 毫秒的整数。',
    );
  const fresh = await resolvePushTarget(target, target.remote, options);
  if (fresh.url !== target.url || fresh.targetRef !== target.targetRef)
    return changed();
  if (options.signal?.aborted)
    throw new GcommitError('PROCESS_CANCELLED', '推送已取消，尚未开始传输。');
  try {
    const result = await runProcessBytes(
      'git',
      [
        ...GIT_ARGUMENTS,
        '-c',
        'push.followTags=false',
        '-c',
        'push.autoSetupRemote=false',
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--recurse-submodules=no',
        '--no-force',
        '--no-force-with-lease',
        '--no-force-if-includes',
        '--no-mirror',
        '--',
        target.url,
        `${target.oid}:${target.targetRef}`,
      ],
      {
        cwd: target.root,
        operation: 'git.push',
        env: {
          ...createGitEnvironment(),
          GIT_ALLOW_PROTOCOL: 'file:ssh:http:https:git',
        },
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    const statuses = decodeGit(result.stdout)
      .split('\n')
      .filter((line) => /^.\t/u.test(line));
    if (statuses.length !== 1)
      throw new PushExecutionError('Git 未返回唯一目标的成功确认。');
    const fields = statuses[0]!.split('\t');
    if (
      ![' ', '*', '='].includes(fields[0]!) ||
      fields[1] !== `${target.oid}:${target.targetRef}`
    )
      throw new PushExecutionError('Git 返回的推送目标或结果与确认不一致。');
    return { oid: target.oid, targetRef: target.targetRef };
  } catch (error: unknown) {
    if (error instanceof PushExecutionError) throw error;
    throw new PushExecutionError(
      error instanceof GcommitError
        ? `${error.code}: ${error.message}`
        : '推送未能正常完成。',
    );
  }
};
