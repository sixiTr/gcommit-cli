import { readConfigSnapshot, saveModelSettings } from './config.js';
import type { Config, ConfigSnapshot } from './config.js';
import { readBundledModels } from './codex/catalog.js';
import { modelChoices } from './codex/profile.js';
import type { ModelChoice } from './codex/profile.js';
import type { CodexOptions } from './codex/adapter.js';
import { GcommitError } from './errors.js';
import { quoteTerminalText } from './analysis/security.js';

/** 经过目录校验的终端选项。 */
export interface SettingOption {
  /** 保存前由流程再次校验的选项值。 */
  value: string;
  /** 可安全显示的标签。 */
  label: string;
}
/** 模型设置使用的终端能力。 */
export interface ModelSettingsUI {
  /** 展示设置说明。 */
  showSettings: (text: string) => void;
  /** 选择一个设置值，null 表示取消。 */
  chooseSetting: (
    message: string,
    choices: SettingOption[],
    initial: string,
  ) => Promise<string | null>;
}

/** 展示模型默认档位，未知时不猜测。 */
const automaticLabel = (model: ModelChoice): string =>
  `auto（模型默认${model.defaultEffort === null ? '，具体档位未知' : `：${model.defaultEffort}`}）`;

/** 选择并保存全局模型与档位，不读取 Git 或调用模型生成。 */
export const runModelSettings = async (
  configPath: string,
  ui: ModelSettingsUI,
  options: Pick<CodexOptions, 'executable' | 'signal'> = {},
): Promise<boolean> => {
  // 菜单开始前的快照用于避免覆盖其他终端的配置修改。
  const snapshot: ConfigSnapshot = await readConfigSnapshot(configPath);
  const config: Readonly<Config> = snapshot.config;
  ui.showSettings('正在读取本机模型目录…');
  const choices: ModelChoice[] = modelChoices(
    await readBundledModels(config, options),
  );
  const defaultModel: ModelChoice = choices[0]!;
  // 仅显示已被目录确认的标识，失效配置的原值不回显。
  const current: ModelChoice | undefined =
    config.model === null
      ? defaultModel
      : choices.find((choice) => choice.model === config.model);
  if (
    current === undefined ||
    (config.reasoningEffort !== 'auto' &&
      !current.efforts.includes(config.reasoningEffort))
  ) {
    ui.showSettings('当前配置的模型或推理档位已不可选，请重新选择。');
  } else {
    ui.showSettings(
      `当前模型：${current.model}${config.model === null ? '（跟随 Codex 默认）' : ''}\n当前推理档位：${config.reasoningEffort === 'auto' ? automaticLabel(current) : config.reasoningEffort}`,
    );
  }
  const selected: string | null = await ui.chooseSetting(
    '选择模型',
    [
      { value: '', label: `跟随 Codex 默认（当前：${defaultModel.model}）` },
      ...choices.map((choice) => ({
        value: choice.model,
        label: choice.model,
      })),
    ],
    current === undefined ? '' : (config.model ?? ''),
  );
  if (selected === null || options.signal?.aborted) return false;
  const model: ModelChoice | undefined =
    selected === ''
      ? defaultModel
      : choices.find((choice) => choice.model === selected);
  if (model === undefined)
    throw new GcommitError(
      'CODEX_MODEL_UNSUPPORTED',
      '所选模型不在本次菜单目录中。',
    );
  // 仅在保持模型且原档位仍受支持时沿用；换模型重新跟随默认档位。
  const initial: Config['reasoningEffort'] =
    selected === (config.model ?? '') &&
    model.efforts.includes(config.reasoningEffort)
      ? config.reasoningEffort
      : 'auto';
  const effort: string | null = await ui.chooseSetting(
    '选择推理档位',
    [
      { value: 'auto', label: automaticLabel(model) },
      ...model.efforts.map((level) => ({ value: level, label: level })),
    ],
    initial,
  );
  if (effort === null || options.signal?.aborted) return false;
  // 从已验证的集合取得类型，不把终端任意返回值写入配置。
  const reasoningEffort: Config['reasoningEffort'] | undefined =
    effort === 'auto'
      ? 'auto'
      : model.efforts.find((level) => level === effort);
  if (reasoningEffort === undefined)
    throw new GcommitError(
      'CODEX_MODEL_UNSUPPORTED',
      '所选推理档位不受该模型支持。',
    );
  const saved = await saveModelSettings(
    configPath,
    snapshot,
    { model: selected === '' ? null : selected, reasoningEffort },
    options.signal,
  );
  ui.showSettings(
    `设置已保存\n模型：${model.model}${selected === '' ? '（跟随 Codex 默认）' : ''}\n推理档位：${reasoningEffort === 'auto' ? automaticLabel(model) : reasoningEffort}\n配置文件：${quoteTerminalText(configPath)}\n之后运行 gcommit 或 gcommit -d 即使用此设置；命令行参数可临时覆盖。`,
  );
  if (saved.cleanupWarning)
    ui.showSettings(
      '设置已保存，但临时文件或锁清理失败。请检查 ~/.gcommit 的写权限；确认没有其他设置进程后再处理遗留的 config.json.lock。',
    );
  return true;
};
