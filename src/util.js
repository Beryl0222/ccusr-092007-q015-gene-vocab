import { createHash } from 'node:crypto';

/** 稳定标识允许的形态：字母开头，可含数字、点、冒号、下划线、连字符。 */
export const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]{2,63}$/;

/**
 * 确定性序列化：对象键排序、忽略 undefined。
 * 词表版本哈希、训练输入清单哈希都依赖它，任何字段顺序变化不得影响结果。
 */
export function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item) ?? 'null').join(',')}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashOf(value) {
  return sha256(canonical(value));
}

/** 深冻结：发布后的词表版本不可再被任何流程改写。 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function parseBound(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** 有效区间是否为合法的非空区间（起止均存在时 from < to）。 */
export function intervalValid(interval) {
  const from = parseBound(interval.valid_from, null);
  const to = parseBound(interval.valid_to, null);
  if (interval.valid_from !== null && interval.valid_from !== undefined && from === null) return false;
  if (interval.valid_to !== null && interval.valid_to !== undefined && to === null) return false;
  if (from !== null && to !== null) return from < to;
  return true;
}

/** 两个有效区间是否重叠；null 端点视为开放区间。 */
export function intervalsOverlap(a, b) {
  const aFrom = parseBound(a.valid_from, -Infinity);
  const aTo = parseBound(a.valid_to, Infinity);
  const bFrom = parseBound(b.valid_from, -Infinity);
  const bTo = parseBound(b.valid_to, Infinity);
  return aFrom < bTo && bFrom < aTo;
}

export function sortedUnique(values) {
  return [...new Set(values)].sort();
}
