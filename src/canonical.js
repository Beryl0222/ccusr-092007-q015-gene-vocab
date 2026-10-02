/**
 * 规范化序列化与内容哈希。
 *
 * 快照、导入分片校验和、确定性输入都依赖同一套规则：
 * 对象键按 UTF-16 码点排序后递归输出，数组保持顺序，不输出空白。
 * 因此同一逻辑内容在任何机器、任何进程里产生完全一致的字节。
 */
import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',');
  return `{${body}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 任意可序列化值的内容哈希。 */
export function contentHash(value) {
  return sha256Hex(canonicalize(value));
}
