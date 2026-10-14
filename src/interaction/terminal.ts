import { addAbortListener } from 'node:events';
import type { Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { confirm, isCancel, multiline, select, text } from '@clack/prompts';
import type { PushUI, PushPreview, PushRemoteChoice } from '../push/flow.js';
import { GcommitError } from '../errors.js';
import type { InteractionUI, MenuAction, EditedMessage } from './flow.js';
import type { CommitUI } from '../commit/flow.js';
import type { ModelSettingsUI } from '../model-settings.js';
import type { CommitSuggestion } from '../analysis/schema.js';

/** 终端输入输出和生命周期。 */
interface TerminalOptions {
  /** 输入流，默认为标准输入。 */
  input?: Readable;
  /** 输出流，默认为标准输出。 */
  output?: Writable;
  /** 整个分析交互的取消信号。 */
  signal?: AbortSignal;
  /** 通知 CLI 记录 Ctrl-C 退出码。 */
  onInterrupt?: () => void;
}
/** 创建 Clack 终端交互，所有仓库文字由调用方先验证。 */
export const createTerminalUI = (
  options: TerminalOptions = {},
): InteractionUI & CommitUI & PushUI & ModelSettingsUI => {
  const input: Readable = options.input ?? process.stdin;
  const output: Writable = options.output ?? process.stdout;
  // EOF 或 Ctrl-D 结束整个交互，不能回到已关闭输入的菜单。
  let closed: boolean = false;
  /** 为每次提示建立独立取消边界，清理父信号与流监听。 */
  const prompt = async <T>(
    run: (signal: AbortSignal) => Promise<T | symbol>,
  ): Promise<T | null> => {
    if (
      closed ||
      input.readableEnded ||
      input.destroyed ||
      options.signal?.aborted
    )
      return null;
    const controller = new AbortController();
    const subscription =
      options.signal === undefined
        ? undefined
        : addAbortListener(options.signal, (): void => controller.abort());
    /** 在输入结束时解除提示等待。 */
    const end = (): void => {
      closed = true;
      controller.abort();
    };
    /** 在原始模式中识别终止键，保留 Escape 放弃编辑的语义。 */
    const keypress = (_text: string, key: Key): void => {
      if (key.ctrl && key.name === 'c') {
        closed = true;
        options.onInterrupt?.();
        controller.abort();
      } else if (key.ctrl && key.name === 'd') end();
    };
    input.once('end', end);
    input.once('close', end);
    input.once('error', end);
    input.on('keypress', keypress);
    try {
      const result = await run(controller.signal);
      return isCancel(result) || typeof result === 'symbol' ? null : result;
    } finally {
      subscription?.[Symbol.dispose]();
      input.off('end', end);
      input.off('close', end);
      input.off('error', end);
      input.off('keypress', keypress);
    }
  };
  return {
    showSettings: (message: string): void => {
      output.write(message + '\n');
    },
    chooseSetting: (message, choices, initial): Promise<string | null> =>
      prompt<string>((signal) =>
        select<string>({
          input,
          output,
          signal,
          message,
          options: choices,
          initialValue: initial,
          maxItems: 12,
        }),
      ),
    chooseRemote: async (choices: PushRemoteChoice[]): Promise<string | null> =>
      prompt<string>((signal) =>
        select<string>({
          input,
          output,
          signal,
          message: '选择推送 remote',
          initialValue: 'cancel',
          options: [
            ...choices.map((choice) => ({
              value: choice.id,
              label: choice.label,
            })),
            { value: 'cancel', label: '稍后处理' },
          ],
        }),
      ).then((value) => (value === 'cancel' ? null : value)),
    confirmPush: async (preview: PushPreview): Promise<boolean> => {
      output.write(
        `\n推送确认\nRemote：${preview.remote}\nPush URL：${preview.url}\n本地分支：${preview.sourceRef}\n目标分支：${preview.targetRef}\n提交：${preview.oid}\n`,
      );
      output.write(
        '将发送此提交及远端缺少的祖先提交；只更新以上分支，不推送 tags 或 submodules。保留 pre-push hook 和签名，不自动修改 upstream。\n',
      );
      if (!preview.hasUpstream)
        output.write('当前未配置 upstream，本次按上述明确目标推送。\n');
      return (
        (await prompt<boolean>((signal) =>
          confirm({
            input,
            output,
            signal,
            message: '确认推送？',
            initialValue: false,
            active: '推送',
            inactive: '稍后处理',
            vertical: true,
          }),
        )) ?? false
      );
    },
    confirmCommit: async (preview): Promise<boolean> => {
      output.write(
        `\n最终提交确认\n分支：${preview.branch}\n文件：${preview.netFiles} 个净变化，${preview.files.length} 个候选路径\n`,
      );
      for (const file of preview.files)
        output.write(`  ${file.description} ${file.path}\n`);
      output.write(
        `\n提交消息：\n${preview.message}\n\n将提交全部工作树最终版本，包含 staged、unstaged 和 untracked；这会覆盖原有部分暂存边界。\n`,
      );
      if (preview.partialStaging)
        output.write('当前存在部分暂存，同一文件尚未暂存的修改也会纳入。\n');
      output.write(
        '确认后执行 git add 和 git commit，保留仓库 hooks 与签名；hooks 可能修改文件。不会推送。\n',
      );
      return (
        (await prompt<boolean>((signal) =>
          confirm({
            input,
            output,
            signal,
            message: '确认暂存并提交？',
            initialValue: false,
            active: '确认提交',
            inactive: '取消',
            vertical: true,
          }),
        )) ?? false
      );
    },
    choose: async (suggestion: CommitSuggestion): Promise<MenuAction> => {
      output.write(`\n提交建议：\n\n${suggestion.message}\n\n`);
      return (
        (await prompt<MenuAction>((signal) =>
          select<MenuAction>({
            input,
            output,
            signal,
            message: '请选择下一步',
            initialValue: 'cancel',
            options: [
              {
                value: 'use',
                label: '使用此 Commit',
                hint: '继续最终确认',
              },
              { value: 'edit', label: '修改标题和正文' },
              {
                value: 'regenerate',
                label: '重新生成',
                hint: '会再次调用 Codex',
              },
              { value: 'diff', label: '查看 Diff', hint: '脱敏后的净变化' },
              { value: 'cancel', label: '取消' },
            ],
          }),
        )) ?? 'cancel'
      );
    },
    edit: async (suggestion, validate): Promise<EditedMessage | null> => {
      const originalBody: string = suggestion.body.join('\n');
      /** 只返回受控校验错误，Clack 在用户输入期间正常显示本地编辑内容。 */
      const check = (title: string, body: string): string | undefined => {
        try {
          validate(title, body);
          return undefined;
        } catch (error: unknown) {
          return error instanceof GcommitError
            ? error.message
            : '编辑内容无效，请检查后重试。';
        }
      };
      const title = await prompt<string>((signal) =>
        text({
          input,
          output,
          signal,
          message: '修改标题（Esc 放弃编辑）',
          initialValue: suggestion.message.split('\n')[0] ?? '',
          validate: (value) => check(value ?? '', originalBody),
        }),
      );
      if (title === null) return null;
      const body = await prompt<string>((signal) =>
        multiline({
          input,
          output,
          signal,
          message:
            '修改正文（每行一条，无需 -；清空可删除正文；Tab 后 Enter 保存；Esc 放弃）',
          initialValue: originalBody,
          showSubmit: true,
          validate: (value) => check(title, value ?? ''),
        }),
      );
      return body === null ? null : { title, body };
    },
    showDiff: (diff: string): void => {
      output.write(`\n${diff}\n`);
    },
    showError: (message: string): void => {
      output.write(`\n${message}\n`);
    },
  };
};
