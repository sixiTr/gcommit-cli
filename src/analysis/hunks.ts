import { structuredPatch } from 'diff';
import type { StructuredPatchHunk } from 'diff';

/** 已脱敏的完整变更块及省略情况。 */
export interface DiffHunks {
  /** 标准 unified diff 的行号、行数与带前缀文本。 */
  hunks: StructuredPatchHunk[];
  /** 两侧共同省略的未变化行数。 */
  omittedUnchangedLines: number;
}
// 限制高复杂度差异计算的同步耗时；超时保留完整前后文本。
const DIFF_TIMEOUT_MS: number = 1000;
// 标准补丁的末尾缺少换行标记。
const NO_NEWLINE: string = '\\ No newline at end of file';

/** 按 LF 分行并保留 CR 字符，不把末尾换行计作额外空行。 */
const textLines = (text: string): string[] => {
  // 原始行序列。
  const lines: string[] = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** 差异计算超时时使用完整增删块，避免省略任何修改。 */
const fullHunk = (before: string, after: string): StructuredPatchHunk[] => {
  // 脱敏后的两侧行序列。
  const left: string[] = textLines(before);
  const right: string[] = textLines(after);
  if (left.length === 0 && right.length === 0) return [];
  // 完整前后版本及各自的行尾状态。
  const lines: string[] = left.map((line) => '-' + line);
  if (before !== '' && !before.endsWith('\n')) lines.push(NO_NEWLINE);
  for (const line of right) lines.push('+' + line);
  if (after !== '' && !after.endsWith('\n')) lines.push(NO_NEWLINE);
  return [
    {
      oldStart: left.length === 0 ? 0 : 1,
      oldLines: left.length,
      newStart: right.length === 0 ? 0 : 1,
      newLines: right.length,
      lines,
    },
  ];
};

/** 按原文确定变更位置，再从整文件脱敏结果取行，保留凭据值修改的事实。 */
export const createDiffHunks = (
  originalBefore: string,
  originalAfter: string,
  before: string,
  after: string,
): DiffHunks => {
  // 原文只用于行匹配，不返回库中保存的原始行或文件头。
  const patch = structuredPatch(
    'before',
    'after',
    originalBefore,
    originalAfter,
    undefined,
    undefined,
    {
      context: 3,
      ignoreWhitespace: false,
      stripTrailingCr: false,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (patch === undefined)
    return { hunks: fullHunk(before, after), omittedUnchangedLines: 0 };
  // 整文件过滤保留行结构，局部片段不再独立识别跨行秘密。
  const left: string[] = textLines(before);
  const right: string[] = textLines(after);
  // 用已过滤的文本覆盖每一条差异内容。
  const hunks: StructuredPatchHunk[] = patch.hunks.map((hunk) => {
    // 两侧当前行的零基索引。
    let oldIndex: number = hunk.oldStart - 1;
    let newIndex: number = hunk.newStart - 1;
    // 补丁控制前缀来自差异库，内容全部来自完整脱敏版本。
    const lines: string[] = hunk.lines.map((line) => {
      if (line === NO_NEWLINE) return NO_NEWLINE;
      if (line.startsWith('-')) return '-' + left[oldIndex++]!;
      if (line.startsWith('+')) return '+' + right[newIndex++]!;
      newIndex++;
      return ' ' + left[oldIndex++]!;
    });
    return {
      // jsdiff 内部采用一基起点，标准补丁的空区间需改为前一行位置。
      oldStart: hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0),
      oldLines: hunk.oldLines,
      newStart: hunk.newStart - (hunk.newLines === 0 ? 1 : 0),
      newLines: hunk.newLines,
      lines,
    };
  });
  return {
    hunks,
    omittedUnchangedLines:
      left.length - hunks.reduce((total, hunk) => total + hunk.oldLines, 0),
  };
};
