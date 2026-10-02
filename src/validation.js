import { STABLE_ID_RE, intervalValid } from './util.js';

/**
 * 候选关系的规则校验。自动导入的记录必须先过校验（status = validated），
 * 再进入专家复核；校验失败直接置为 rejected 并记录全部错误。
 *
 * 支持的候选类型：
 * - gene             基因登记：稳定标识、物种、符号、别名（含有效区间）、原始标识
 * - ortholog_member  同源组成员关系：group_id + stable_id + 有效区间
 * - supersedes       标识替代：from_stable_id -> to_stable_id（有向，参与循环检测）
 */

export const CANDIDATE_KINDS = Object.freeze(['gene', 'ortholog_member', 'supersedes']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 基因是否“已知”：已批准，或存在已通过校验的 gene 候选（同批先导入基因再导入成员关系）。 */
export function geneKnown(store, stableId) {
  if (store.genes.has(stableId)) return true;
  for (const candidate of store.candidates.values()) {
    if (candidate.kind === 'gene' && candidate.status === 'validated' && candidate.payload.stable_id === stableId) {
      return true;
    }
  }
  return false;
}

function validateGene(store, payload, errors) {
  if (!STABLE_ID_RE.test(payload.stable_id ?? '')) errors.push('stable_id 格式非法');
  if (!store.species.has(payload.species)) errors.push(`未注册的物种: ${payload.species}`);
  if (!isNonEmptyString(payload.symbol)) errors.push('symbol 不能为空');
  const aliases = payload.aliases ?? [];
  if (!Array.isArray(aliases)) {
    errors.push('aliases 必须是数组');
  } else {
    aliases.forEach((alias, index) => {
      if (!isNonEmptyString(alias.name)) errors.push(`aliases[${index}].name 不能为空`);
      if (!intervalValid(alias)) errors.push(`aliases[${index}] 有效区间非法`);
    });
  }
  const originalIds = payload.original_ids ?? [];
  if (!Array.isArray(originalIds)) {
    errors.push('original_ids 必须是数组');
  } else {
    originalIds.forEach((ref, index) => {
      if (!isNonEmptyString(ref.id)) errors.push(`original_ids[${index}].id 不能为空`);
    });
  }
}

function validateOrthologMember(store, payload, errors) {
  if (!isNonEmptyString(payload.group_id)) errors.push('group_id 不能为空');
  if (!STABLE_ID_RE.test(payload.stable_id ?? '')) {
    errors.push('stable_id 格式非法');
  } else if (!geneKnown(store, payload.stable_id)) {
    errors.push(`未知基因: ${payload.stable_id}`);
  }
  if (!intervalValid(payload)) errors.push('有效区间非法');
}

function validateSupersedes(store, payload, errors) {
  const { from_stable_id: from, to_stable_id: to } = payload;
  if (!STABLE_ID_RE.test(from ?? '')) errors.push('from_stable_id 格式非法');
  if (!STABLE_ID_RE.test(to ?? '')) errors.push('to_stable_id 格式非法');
  if (errors.length > 0) return;
  if (from === to) {
    errors.push('不允许自我替代（自环）');
    return;
  }
  for (const id of [from, to]) {
    if (!geneKnown(store, id)) errors.push(`未知基因: ${id}`);
  }
  const cycle = detectSupersedesCycle(store, from, to);
  if (cycle) errors.push(`替代关系成环: ${cycle.join(' -> ')}`);
}

/**
 * 循环检测：在“已批准且未丢弃/未暂停的替代边”与“已通过校验的候选替代边”
 * 组成的图上，若加入 from -> to 后 to 能回到 from，则成环。
 * 返回成环路径（数组），不成环返回 null。
 */
export function detectSupersedesCycle(store, from, to) {
  const edges = [];
  for (const rel of store.supersedes.values()) {
    if (!rel.dropped_at && !rel.suspended_at) edges.push([rel.from_stable_id, rel.to_stable_id]);
  }
  for (const candidate of store.candidates.values()) {
    if (candidate.kind === 'supersedes' && candidate.status === 'validated') {
      edges.push([candidate.payload.from_stable_id, candidate.payload.to_stable_id]);
    }
  }
  edges.push([from, to]);

  const adjacency = new Map();
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push(b);
  }
  // 从 to 出发沿有向边搜索，能回到 from 即成环。
  const stack = [[to, [to]]];
  const visited = new Set();
  while (stack.length > 0) {
    const [node, path] = stack.pop();
    if (node === from) return [...path, from];
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push([next, [...path, next]]);
  }
  return null;
}

/** 校验一条候选记录，返回错误列表（空数组表示通过）。 */
export function validateCandidateRecord(store, record) {
  const errors = [];
  const payload = record.payload ?? record;
  if (!CANDIDATE_KINDS.includes(record.kind)) {
    return [`未知候选类型: ${record.kind}`];
  }
  if (record.kind === 'gene') validateGene(store, payload, errors);
  if (record.kind === 'ortholog_member') validateOrthologMember(store, payload, errors);
  if (record.kind === 'supersedes') validateSupersedes(store, payload, errors);
  return errors;
}
