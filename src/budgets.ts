// 本地读取的可配置硬上限，与模型 Prompt 预算相互独立。
export const MAX_FILE_BYTES: number = 10 * 1024 * 1024;
export const MAX_READ_BYTES: number = 20 * 1024 * 1024;

// 默认单次模型输入预算，包含说明、历史及全部文件的变更块。
export const DEFAULT_CONTEXT_BYTES: number = 1024 * 1024;
// CLI 输入字节硬上限，不代表模型的 token 容量。
export const MAX_CONTEXT_BYTES: number = 8 * 1024 * 1024;

/** 同时展示准确字节数和便于阅读的二进制单位。 */
export const formatByteCount = (bytes: number): string =>
  `${bytes} B (${bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(2)} KiB`})`;
