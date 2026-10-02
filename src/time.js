/**
 * 有效区间（半开 [effective_from, effective_to)）。
 *
 * 用 UTC 整日表达：日期串 'YYYY-MM-DD' 视为当天 00:00:00Z（含），
 * effective_to 为空表示至今仍有效。半开区间让相邻修订可以在同一天接续而不重叠：
 * 旧映射 [d1, d2) 与新映射 [d2, null) 恰好覆盖、互不重叠。
 */

export const FAR_FUTURE = '9999-12-31';

export function dayStartUtc(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期必须是 YYYY-MM-DD：${date}`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`非法日期：${date}`);
  }
  return ms;
}

/** 是否半开区间（from 含，to 不含；to 为空代表开放）。 */
export function isValidRange({ effective_from, effective_to }) {
  if (!effective_from) return false;
  const from = dayStartUtc(effective_from);
  if (effective_to == null || effective_to === '') return true;
  return dayStartUtc(effective_to) > from;
}

/** 两个半开区间是否有交集（端点相接不算重叠）。 */
export function overlaps(a, b) {
  const aFrom = dayStartUtc(a.effective_from);
  const aTo = a.effective_to ? dayStartUtc(a.effective_to) : Infinity;
  const bFrom = dayStartUtc(b.effective_from);
  const bTo = b.effective_to ? dayStartUtc(b.effective_to) : Infinity;
  return aFrom < bTo && bFrom < aTo;
}

/** 某日（UTC）是否落在区间内。 */
export function contains(range, date) {
  const at = dayStartUtc(date);
  const from = dayStartUtc(range.effective_from);
  if (at < from) return false;
  if (range.effective_to && at >= dayStartUtc(range.effective_to)) return false;
  return true;
}

/** 把时间戳归一到 UTC 日期串，as_of 查询与训练锁定都走同一口径。 */
export function toUtcDate(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}
