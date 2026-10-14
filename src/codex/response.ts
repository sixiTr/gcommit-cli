import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { GcommitError } from '../errors.js';

// 结果大小独立于上下文预算，避免响应占用无限内存。
export const CODEX_RESULT_LIMIT: number = 16 * 1024;

/** 严格解码 UTF-8，拒绝替换字符掩盖损坏输出。 */
export const decodeCodexText = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GcommitError(
      'CODEX_RESPONSE_INVALID',
      'Codex 返回了无法识别的文本。',
    );
  }
};

/** 有界读取 Codex 最后响应，不跟随符号链接或打开特殊文件。 */
export const readCodexResult = async (path: string): Promise<string> => {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new GcommitError(
          'CODEX_RESPONSE_INVALID',
          'Codex 结果必须是普通文件。',
        );
      if (stat.size > CODEX_RESULT_LIMIT)
        throw new GcommitError(
          'CODEX_OUTPUT_LIMIT',
          'Codex 结果超过 16 KiB 限制。',
        );
      const buffer: Buffer = Buffer.alloc(CODEX_RESULT_LIMIT + 1);
      let length: number = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > CODEX_RESULT_LIMIT)
        throw new GcommitError(
          'CODEX_OUTPUT_LIMIT',
          'Codex 结果超过 16 KiB 限制。',
        );
      return decodeCodexText(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (error instanceof GcommitError) throw error;
    throw new GcommitError(
      'CODEX_RESPONSE_INVALID',
      '无法读取 Codex 的完整结果。',
    );
  }
};

// 只读取协议中本模块需要的字段，未知事件类型仍拒绝。
const eventSchema = z.object({
  type: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});

/** 核实一次完整的无工具响应；事件检查不能代替调用前的工具隔离。 */
export const validateCodexEvents = (text: string, output: string): void => {
  let started: boolean = false;
  let completed: boolean = false;
  let message: string | undefined;
  try {
    for (const line of text.trim().split('\n')) {
      const event = eventSchema.parse(JSON.parse(line));
      if (completed)
        throw new GcommitError(
          'CODEX_ISOLATION_FAILED',
          'Codex 完成后仍返回了额外事件。',
        );
      if (event.type === 'thread.started' && !started) continue;
      if (event.type === 'turn.started' && !started) {
        started = true;
        continue;
      }
      if (
        event.type === 'turn.failed' ||
        event.type === 'error' ||
        event.item?.type === 'error'
      )
        throw new GcommitError(
          'CODEX_EXEC_FAILED',
          'Codex 未能完成本次分析，请检查登录、网络与模型配置。',
        );
      if (started && event.type === 'turn.completed') {
        completed = true;
        continue;
      }
      if (
        started &&
        ['item.started', 'item.updated', 'item.completed'].includes(event.type)
      ) {
        if (event.item?.type === 'reasoning') continue;
        if (
          event.item?.type === 'agent_message' &&
          event.type === 'item.completed' &&
          event.item.text !== undefined &&
          message === undefined
        ) {
          message = event.item.text;
          continue;
        }
      }
      throw new GcommitError(
        'CODEX_ISOLATION_FAILED',
        'Codex 返回了未允许的工具或事件，本次结果已拒绝。',
      );
    }
  } catch (error: unknown) {
    if (error instanceof GcommitError) throw error;
    throw new GcommitError('CODEX_RESPONSE_INVALID', 'Codex 事件流格式无效。');
  }
  if (
    !started ||
    !completed ||
    message === undefined ||
    message.trimEnd() !== output.trimEnd()
  )
    throw new GcommitError(
      'CODEX_RESPONSE_INVALID',
      'Codex 返回了不完整或不一致的结果。',
    );
};
