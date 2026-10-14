import { GcommitError } from '../errors.js';
import { formatByteCount } from '../budgets.js';

/** 文件读取时的总预算检查与安全定位信息。 */
export interface FileReadBudget {
  /** 排序去重后的候选序号，从 1 开始；index 不提供。 */
  candidateNumber?: number;
  /** 文件版本来源。 */
  source: 'HEAD 文件' | '工作树文件' | 'Git index';
  /** 在读取内容前计入总预算。 */
  reserve?: (bytes: number) => void;
}

/** 构造只含大小、预算和候选编号的本地超限错误。 */
export const readLimitError = (
  kind: 'file' | 'total' | 'index',
  source: string,
  actual: number,
  limit: number,
  candidateNumber?: number,
): GcommitError => {
  // 跨文件秘密扫描尚未完成，不能只凭路径自身的形式认定其可展示。
  const location: string =
    candidateNumber === undefined
      ? ''
      : `（候选文件 #${candidateNumber}，路径尚未完成脱敏，已隐藏）`;
  const label: string =
    kind === 'total'
      ? '本地总读取预算'
      : kind === 'index'
        ? 'Git index 读取预算'
        : '本地单文件读取预算';
  const setting: string =
    kind === 'total'
      ? 'maxReadBytes'
      : kind === 'index'
        ? '固定 index 上限'
        : 'maxFileBytes';
  return new GcommitError(
    'GIT_CONTEXT_LIMIT',
    `${label}超限：${source}${location}；${kind === 'total' ? '累计需要' : '大小'} ${formatByteCount(actual)}，上限 ${formatByteCount(limit)}（${setting}）。已停止读取。`,
  );
};
