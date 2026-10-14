import type { Config } from '../config.js';
import { createAnalysisSession } from './session.js';
import type { AnalysisOptions, AnalysisResult } from './session.js';
/** dry-run 与交互复用同一分析边界。 */
export type DryRunOptions = AnalysisOptions;
/** 只读分析结果。 */
export type DryRunResult = AnalysisResult;
/** 只读分析仓库，净变化为空时返回 null。 */
export const runDryRun = async (
  cwd: string,
  config: Readonly<Config>,
  options: DryRunOptions = {},
): Promise<DryRunResult | null> => {
  const session = await createAnalysisSession(cwd, config, options);
  return session?.current() ?? null;
};
