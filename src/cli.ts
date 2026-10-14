#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAnalysisProgress } from './progress.js';
import { loadConfig } from './config.js';
import { runModelSettings } from './model-settings.js';
import {
  withDiagnostics,
  diagnosticPhase,
  diagnosticFailure,
  diagnosticCoverage,
} from './diagnostics.js';
import { recoveryAdvice } from './recovery.js';
import { GcommitError } from './errors.js';
import { runDryRun } from './analysis/dry-run.js';
import { createAnalysisSession } from './analysis/session.js';
import { confirmAndCommit } from './commit/flow.js';
import { offerPush } from './push/flow.js';
import { PushExecutionError } from './git/push.js';
import { CommitExecutionError } from './git/commit.js';
import { runInteraction } from './interaction/flow.js';
import { createTerminalUI } from './interaction/terminal.js';
import { createSecretFilter, displayPath } from './analysis/security.js';
import type { AnalysisCoverage } from './analysis/prompt.js';

// 当前阶段真实可用的入口与后续流程参数。
const HELP: string = `gcommit — 独立的 AI Git 提交助手

用法：gcommit [options]
      gcommit model           交互选择并保存全局模型与推理档位

  -h, --help             显示帮助
  -v, --version          显示安装包版本
      --model <name>     临时指定模型
      --reasoning <level> 推理强度，auto 表示不覆盖 Codex
      --language <value> zh-CN（默认）| en | auto
      --style <value>    auto | conventional | repository
  -d, --dry-run          只分析，不暂存、提交或推送
      --no-push          提交后不询问推送，从不表示自动推送
      --debug            显示不含原始内容的诊断信息

配置：~/.gcommit/config.json
优先级：CLI 参数 > 全局配置 > 默认值

快捷预览：gcommit -d（默认中文，显式语言配置或参数优先）。
生成时默认显示模型、推理档位、阶段、已用时间和耗时汇总；Ctrl+C 可取消。
直接运行进入使用、修改、重新生成、查看 Diff、取消菜单，需要交互终端。
使用建议后还需最终确认提交，推送需单独确认。
--dry-run 读取当前仓库，过滤上下文并调用本机已登录 Codex；不暂存、提交或推送。
分析可能访问网络并消耗 Codex 额度；敏感文件变更或上下文超限会停止。
`;

// 模型设置命令不读取 Git，不发起建议生成。
const MODEL_HELP: string = `用法：gcommit model

通过方向键和回车选择模型，再选择推理档位；完成后保存到 ~/.gcommit/config.json。
模型与档位从本机 Codex 目录读取，不需要 Git 仓库，不发起模型生成。
选择“跟随 Codex 默认”和 auto 可恢复默认；Esc 或 Ctrl+C 取消且不保存。
其他配置保持不变；--model / --reasoning 仍可临时覆盖已保存的设置。

  -h, --help             显示本帮助
`;

/** 运行独立设置命令并管理终端取消。 */
const configureModel = async (): Promise<void> => {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env.TERM === 'dumb'
  )
    throw new GcommitError(
      'INTERACTION_TTY_REQUIRED',
      'gcommit model 需要可交互终端；本次未读取 Git、调用 Codex 或修改配置。',
    );
  const controller: AbortController = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  /** 记录取消来源并结束菜单或目录探测。 */
  const interrupt = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    controller.abort();
  };
  const onInterrupt = (): void => interrupt('SIGINT');
  const onTerminate = (): void => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const saved: boolean = await runModelSettings(
      join(homedir(), '.gcommit', 'config.json'),
      createTerminalUI({ signal: controller.signal, onInterrupt }),
      { signal: controller.signal },
    );
    if (!saved) {
      process.stdout.write('设置已取消，未保存配置。\n');
      if (interrupted !== null)
        process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    }
  } catch (error: unknown) {
    if (
      interrupted === null ||
      !(error instanceof GcommitError) ||
      (error.code !== 'PROCESS_CANCELLED' && error.code !== 'CODEX_CANCELLED')
    )
      throw error;
    process.stdout.write('设置已取消，未保存配置。\n');
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
};

/** 展示已过滤的实际发送范围，不输出代码、历史或原始路径。 */
const showCoverage = (
  coverage: AnalysisCoverage,
  write: (text: string) => void,
): void => {
  const metadataCount: number = coverage.files.filter(
    (file) => file.coverage === 'metadata',
  ).length;
  const filter = createSecretFilter([]);
  write(
    `分析范围：${coverage.files.length} 个净变更文件，${coverage.files.length - metadataCount} 个提供文本，${metadataCount} 个仅元数据；${coverage.mode === 'full' ? '全部文本已覆盖' : '已省略未变内容，保留全部修改行'}；上下文 ${(coverage.promptBytes / 1024).toFixed(1)} KB。\n`,
  );
  for (const file of coverage.files)
    write(
      `  ${file.coverage === 'content' ? '文本' : file.reason === 'sensitive-deletion' ? '仅元数据（敏感文件删除）' : '仅元数据（二进制/符号链接）'} ${displayPath(file.path, filter)}\n`,
    );
  if (coverage.redacted)
    write(
      '已遮蔽识别到的敏感内容；过滤仅影响 AI 上下文，不代表从 Git 提交中排除。\n',
    );
  diagnosticCoverage(coverage);
  diagnosticPhase('codex');
};

/** 输出只含静态指引的下一步，不自动恢复仓库。 */
const showRecovery = (error: unknown): void => {
  process.stderr.write(`下一步：${recoveryAdvice(error).join(' ')}\n`);
};

/** 从安装包读取版本，不依赖目标项目的文件。 */
const readVersion = async (): Promise<string> => {
  // 编译后入口位于安装包的 dist 目录。
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('安装包缺少版本信息');
  }
  return manifest.version;
};

/** 解析命令行并验证当前阶段的配置。 */
const main = async (): Promise<void> => {
  // 独立子命令只接受帮助，生成参数仍属于默认入口。
  const args: string[] = process.argv.slice(2);
  const modelCommand: boolean = args[0] === 'model';
  // Node 内置解析器拒绝未知参数与额外位置参数。
  const { values } = (() => {
    try {
      return parseArgs({
        args: modelCommand ? args.slice(1) : args,
        strict: true,
        allowPositionals: false,
        options: modelCommand
          ? { help: { type: 'boolean', short: 'h' } }
          : {
              help: { type: 'boolean', short: 'h' },
              version: { type: 'boolean', short: 'v' },
              model: { type: 'string' },
              reasoning: { type: 'string' },
              language: { type: 'string' },
              style: { type: 'string' },
              'dry-run': { type: 'boolean', short: 'd' },
              'no-push': { type: 'boolean' },
              debug: { type: 'boolean' },
            },
      });
    } catch {
      throw new GcommitError(
        'ARGUMENT_INVALID',
        '参数无效。请运行 gcommit --help 查看支持的选项。',
      );
    }
  })();

  if (values.help) {
    process.stdout.write(modelCommand ? MODEL_HELP : HELP);
    return;
  }
  if (modelCommand) {
    await configureModel();
    return;
  }
  if (values.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  // 动画仅用于足够宽的交互提示流；结果 stdout 和 debug 日志保持普通文本。
  const progress = createAnalysisProgress({
    output: process.stderr,
    animated:
      process.stderr.isTTY === true &&
      process.env.TERM !== 'dumb' &&
      (process.stderr.columns ?? 0) >= 80 &&
      values.debug !== true,
  });
  try {
    await withDiagnostics(
      values.debug === true,
      progress.write,
      async (): Promise<void> => {
        diagnosticPhase('configuration');
        // 仅显式提供的参数覆盖文件配置，不注入 undefined。
        const overrides: Record<string, unknown> = {};
        if (values.model !== undefined) overrides.model = values.model;
        if (values.reasoning !== undefined)
          overrides.reasoningEffort = values.reasoning;
        if (values.language !== undefined) overrides.language = values.language;
        if (values.style !== undefined) overrides.commitStyle = values.style;
        if (values['no-push']) overrides.pushPrompt = false;

        const config = await loadConfig(
          join(homedir(), '.gcommit', 'config.json'),
          overrides,
        );
        if (
          !values['dry-run'] &&
          (!process.stdin.isTTY ||
            !process.stdout.isTTY ||
            process.env.TERM === 'dumb')
        )
          throw new GcommitError(
            'INTERACTION_TTY_REQUIRED',
            '交互模式需要支持编辑的终端输入和输出（TERM 不能为 dumb）。请在终端运行 gcommit，或使用 gcommit --dry-run。本次未执行 Git 或 Codex。',
          );
        const controller: AbortController = new AbortController();
        let interrupted: NodeJS.Signals | null = null;
        // 本地提交完成后，取消与推送失败不能再声称未提交。
        let committedOid: string | null = null;
        /** 取消分析并记录终端退出原因。 */
        const interrupt = (signal: NodeJS.Signals): void => {
          interrupted = signal;
          controller.abort();
        };
        /** 响应 Ctrl-C。 */
        const onInterrupt = (): void => interrupt('SIGINT');
        /** 响应进程终止请求。 */
        const onTerminate = (): void => interrupt('SIGTERM');
        process.on('SIGINT', onInterrupt);
        process.on('SIGTERM', onTerminate);
        try {
          const analysisOptions = {
            signal: controller.signal,
            onProgress: progress.onProgress,
            onPrepared: (coverage: AnalysisCoverage): void =>
              showCoverage(coverage, progress.write),
          };
          diagnosticPhase('analysis');
          if (values['dry-run']) {
            const result = await runDryRun(
              process.cwd(),
              config,
              analysisOptions,
            );
            if (result === null)
              process.stdout.write('没有可分析的净变化，未调用 Codex。\n');
            else
              process.stdout.write(
                `提交建议（dry-run）：\n\n${result.suggestion.message}\n\n未暂存、提交或推送。\n`,
              );
          } else {
            const session = await createAnalysisSession(
              process.cwd(),
              config,
              analysisOptions,
            );
            if (session === null) {
              process.stdout.write('没有可分析的净变化，未调用 Codex。\n');
              return;
            }
            const terminal = createTerminalUI({
              signal: controller.signal,
              onInterrupt,
            });
            diagnosticPhase('interaction');
            const result = await runInteraction(
              session,
              terminal,
              controller.signal,
            );
            if (result === null)
              process.stdout.write('已取消，未暂存、提交或推送。\n');
            else {
              diagnosticPhase('commit');
              const receipt = await confirmAndCommit(
                session,
                terminal,
                controller.signal,
              );
              if (receipt === null)
                process.stdout.write('已取消最终确认，未暂存、提交或推送。\n');
              else {
                committedOid = receipt.oid;
                process.stdout.write(`本地提交成功：${receipt.oid}\n`);
                if (receipt.worktreeChanged === true)
                  process.stdout.write(
                    '提交后仍有未提交变化，请检查 git status。\n',
                  );
                if (receipt.worktreeChanged === null)
                  process.stdout.write(
                    '提交已核实，但未能确认工作树状态，请检查 git status。\n',
                  );
                if (interrupted !== null) {
                  process.stdout.write(
                    '已取消后续操作，未开始推送。本地提交已保留。\n',
                  );
                  process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
                } else {
                  diagnosticPhase('push');
                  const pushed = await offerPush(
                    session,
                    receipt,
                    terminal,
                    config.pushPrompt,
                    controller.signal,
                  );
                  if (pushed.status === 'pushed')
                    process.stdout.write(
                      `推送成功：${pushed.receipt.oid}（已确认的单一目标分支）。\n`,
                    );
                  else if (pushed.status === 'no-remote')
                    process.stdout.write(
                      '没有配置 remote，本地提交已保留，未推送。\n',
                    );
                  else process.stdout.write('未推送，本地提交已保留。\n');
                  if (controller.signal.aborted)
                    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
                }
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof CommitExecutionError) {
            diagnosticFailure(error);
            process.stderr.write(`${error.code}: ${error.message}\n`);
            showRecovery(error);
            process.exitCode =
              interrupted === null ? 2 : interrupted === 'SIGINT' ? 130 : 143;
            return;
          }
          if (committedOid !== null) {
            diagnosticFailure(error);
            const reason =
              error instanceof GcommitError
                ? `${error.code}: ${error.message}`
                : '推送流程未能完成。';
            process.stderr.write(
              `${reason}\n本地提交已保留：${committedOid}\n`,
            );
            if (!(error instanceof PushExecutionError))
              process.stderr.write('尚未开始推送。\n');
            showRecovery(error);
            process.exitCode =
              interrupted === null ? 2 : interrupted === 'SIGINT' ? 130 : 143;
            return;
          }
          if (interrupted !== null) {
            diagnosticFailure(error);
            process.stderr.write('分析已取消，未暂存、提交或推送。\n');
            process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
            return;
          }
          throw error;
        } finally {
          process.removeListener('SIGINT', onInterrupt);
          process.removeListener('SIGTERM', onTerminate);
        }
      },
    );
  } finally {
    progress.dispose();
  }
};

// 只展示受控错误消息，未知异常不回显参数、配置或调用栈。
main().catch((error: unknown): void => {
  if (error instanceof GcommitError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write('运行失败，请检查安装是否完整。\n');
  }
  showRecovery(error);
  process.exitCode = 2;
});
