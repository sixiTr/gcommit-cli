import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import type { CodexModelSelection } from './codex/profile.js';

// 生成流程的固定阶段；只展示程序确认到达的边界。
const STAGES = [
  { id: 'git', label: '读取并复核 Git 变更' },
  { id: 'context', label: '过滤并准备上下文' },
  { id: 'codex-check', label: '检查 Codex 环境' },
  { id: 'codex-generate', label: '等待 Codex 生成建议' },
  { id: 'validate', label: '校验建议与仓库状态' },
] as const;
/** 可观察的生成阶段。 */
export type AnalysisStage = (typeof STAGES)[number]['id'];
/** 一次生成的结束状态。 */
export type AnalysisOutcome = 'success' | 'empty' | 'failed' | 'cancelled';
/** 不携带代码、模型输出或错误原文的进度事件。 */
export type AnalysisProgressEvent =
  | { type: 'stage'; stage: AnalysisStage }
  | { type: 'model'; selection: CodexModelSelection }
  | { type: 'finished'; outcome: AnalysisOutcome };
/** 生成进度接收器。 */
export type AnalysisProgressReporter = (event: AnalysisProgressEvent) => void;

/** 通知观察器，显示故障不能中断分析或改变安全校验。 */
export const reportProgress = (
  reporter: AnalysisProgressReporter | undefined,
  event: AnalysisProgressEvent,
): void => {
  try {
    reporter?.(event);
  } catch {
    /* 进度观察不参与业务结果。 */
  }
};

/** 终端进度输出选项。 */
interface ProgressOptions {
  /** 提示输出流，默认使用 stderr。 */
  output?: Writable;
  /** 支持单行重绘的终端才启用动画。 */
  animated?: boolean;
}
/** 进度展示与输出协调入口。 */
export interface AnalysisProgress {
  /** 消费真实阶段和结束事件。 */
  onProgress: AnalysisProgressReporter;
  /** 输出覆盖信息或诊断，不打断当前进度行。 */
  write: (text: string) => void;
  /** 释放刷新定时器与进度行。 */
  dispose: () => void;
}

/** 展示真实阶段、单调计时与汇总，不估算模型完成百分比。 */
export const createAnalysisProgress = (
  options: ProgressOptions = {},
): AnalysisProgress => {
  // 提示流与重绘能力；CLI 会为窄终端、重定向和 debug 关闭动画。
  const output: Writable = options.output ?? process.stderr;
  const animated: boolean = options.animated ?? false;
  // 当前阶段及本次生成的计时状态。
  let current: AnalysisStage | null = null;
  let started: number = 0;
  let entered: number = 0;
  let lastHeartbeat: number = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible: boolean = false;
  let frame: number = 0;
  const durations: Map<AnalysisStage, number> = new Map();

  /** 格式化单调时钟的秒数。 */
  const seconds = (milliseconds: number): string =>
    `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
  /** 停止刷新，不改变业务进程的信号处理。 */
  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  /** 输出提示，终端关闭时停止刷新。 */
  const write = (text: string): void => {
    try {
      output.write(text);
    } catch {
      stopTimer();
    }
  };
  /** 擦除本模块绘制的单行，不隐藏光标或接管输入。 */
  const clear = (): void => {
    if (visible) write('\r\u001b[2K');
    visible = false;
  };
  /** 返回当前阶段的固定标题。 */
  const title = (stage: AnalysisStage): string => {
    const index: number = STAGES.findIndex((entry) => entry.id === stage);
    return `[${index + 1}/5] ${STAGES[index]?.label ?? ''}`;
  };
  /** 刷新当前等待时间；普通文本只每十秒输出一次。 */
  const render = (initial: boolean = false): void => {
    if (current === null) return;
    const now: number = performance.now();
    if (!animated && !initial && now - lastHeartbeat < 10000) return;
    const elapsed: number = now - entered;
    const label: string =
      current === 'codex-generate' && elapsed >= 30000
        ? '[4/5] 仍在等待 Codex 返回'
        : title(current);
    const indicator: string = animated
      ? (['◐', '◓', '◑', '◒'][frame++ % 4] ?? '…')
      : '…';
    clear();
    write(
      `${indicator} ${label} · ${current === 'codex-generate' ? '已等待' : '已用'} ${seconds(elapsed)}${animated ? '' : '\n'}`,
    );
    visible = animated;
    lastHeartbeat = now;
  };
  /** 记录结束阶段的耗时和实际结果。 */
  const endStage = (now: number, marker: string): void => {
    if (current === null) return;
    clear();
    const elapsed: number = Math.max(0, now - entered);
    durations.set(current, elapsed);
    write(`${marker} ${title(current)} · ${seconds(elapsed)}\n`);
  };
  /** 清理计时器和当前行，允许后续菜单正常使用终端。 */
  const dispose = (): void => {
    stopTimer();
    clear();
    current = null;
  };

  return {
    onProgress: (event): void => {
      const now: number = performance.now();
      if (event.type === 'model') {
        // 设置提示单独成行，不重置阶段耗时；只有已校验的目录值会到达这里。
        const selection: CodexModelSelection = event.selection;
        const effort: string =
          selection.reasoningEffort === null
            ? 'auto（由 Codex 决定，具体档位未知）'
            : `${selection.reasoningEffort}${selection.reasoningDefault ? '（模型默认）' : ''}`;
        clear();
        write(
          `模型：${selection.model}${selection.modelDefault ? '（默认）' : ''} · 推理档位：${effort}\n`,
        );
        if (animated) render(true);
        return;
      }
      if (event.type === 'stage') {
        if (current === event.stage) return;
        if (current === null) {
          durations.clear();
          started = now;
          frame = 0;
          write('生成提交建议 · Ctrl+C 可取消\n');
          timer = setInterval((): void => render(), 1000);
          timer.unref?.();
        } else endStage(now, '✓');
        current = event.stage;
        entered = now;
        lastHeartbeat = now;
        render(true);
        return;
      }
      if (current === null) return;
      stopTimer();
      endStage(
        now,
        event.outcome === 'success' || event.outcome === 'empty' ? '✓' : '×',
      );
      const label: string = {
        success: '生成完成',
        empty: '无需生成',
        failed: '生成失败',
        cancelled: '生成已取消',
      }[event.outcome];
      // 汇总只包含已进入的阶段，菜单等待和下一次生成不计入。
      const parts: string[] = [];
      if (durations.has('git') || durations.has('context'))
        parts.push(
          `本地准备 ${seconds((durations.get('git') ?? 0) + (durations.get('context') ?? 0))}`,
        );
      for (const [stage, name] of [
        ['codex-check', 'Codex 检查'],
        ['codex-generate', 'Codex 生成'],
        ['validate', '校验'],
      ] as const) {
        const elapsed: number | undefined = durations.get(stage);
        if (elapsed !== undefined) parts.push(`${name} ${seconds(elapsed)}`);
      }
      write(`${label}，用时 ${seconds(now - started)}\n${parts.join(' · ')}\n`);
      current = null;
    },
    write: (text): void => {
      clear();
      write(text);
      if (animated) render(true);
    },
    dispose,
  };
};
