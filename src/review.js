import { GovernanceError, CODES } from './errors.js';
import { intervalsOverlap } from './util.js';

/**
 * 专家复核与冲突治理。
 *
 * - 只有通过规则校验（validated）的候选才能复核；复核必须留下复核人与理由；
 * - 批准时与既有已批准关系做冲突检测：别名撞车、同一基因在重叠区间进入
 *   不同同源组、同一标识有多个替代目标；
 * - 冲突双方保持 approved 并存，挂上同一 conflict_id，任何流程不得悄悄选定；
 *   只有 resolveConflict 显式裁定（keep/drop + 理由）才会让被丢弃的关系
 *   退出后续发布。
 */
export function reviewCandidate(store, clock, { candidate_id, decision, reviewer, rationale }) {
  const candidate = store.candidates.get(candidate_id);
  if (!candidate) throw new GovernanceError(CODES.NOT_FOUND, `未知候选: ${candidate_id}`);
  if (candidate.status !== 'validated') {
    throw new GovernanceError(CODES.CANDIDATE_STATE, `候选状态不允许复核: ${candidate.status}`, { candidate_id, status: candidate.status });
  }
  if (!reviewer || !rationale) {
    throw new GovernanceError(CODES.VALIDATION, '复核必须提供复核人与理由');
  }
  if (!['approve', 'decline'].includes(decision)) {
    throw new GovernanceError(CODES.VALIDATION, `未知复核决定: ${decision}`);
  }
  candidate.reviewed_at = clock();
  candidate.reviewer = reviewer;
  candidate.rationale = rationale;

  if (decision === 'decline') {
    candidate.status = 'declined';
    store.log({ at: clock(), actor: reviewer, action: 'review-decline', details: { candidate_id, rationale } });
    return { candidate_id, status: 'declined', relation_ids: [], conflict_ids: [] };
  }

  candidate.status = 'approved';
  const review = { by: reviewer, rationale, at: clock() };
  const applied = applyCandidate(store, clock, candidate, review);
  store.log({ at: clock(), actor: reviewer, action: 'review-approve', details: { candidate_id, rationale, relation_ids: applied.relation_ids, conflict_ids: applied.conflict_ids } });
  return { candidate_id, status: 'approved', ...applied };
}

function applyCandidate(store, clock, candidate, review) {
  if (candidate.kind === 'gene') return applyGene(store, clock, candidate, review);
  if (candidate.kind === 'ortholog_member') return applyMembership(store, clock, candidate, review);
  if (candidate.kind === 'supersedes') return applySupersedes(store, clock, candidate, review);
  throw new GovernanceError(CODES.VALIDATION, `未知候选类型: ${candidate.kind}`);
}

function nextRelationId(store) {
  return `rel_${store.nextSeq('relation')}`;
}

function applyGene(store, clock, candidate, review) {
  const payload = candidate.payload;
  const relationId = nextRelationId(store);
  const conflictIds = [];
  const incomingAliases = (payload.aliases ?? []).map((alias) => ({
    name: alias.name,
    valid_from: alias.valid_from ?? null,
    valid_to: alias.valid_to ?? null,
    relation_id: relationId,
    source_id: candidate.source_id,
  }));
  const incomingOriginalIds = (payload.original_ids ?? []).map((ref) => ({ ...ref }));

  let gene = store.genes.get(payload.stable_id);
  if (!gene) {
    gene = {
      stable_id: payload.stable_id,
      species: payload.species,
      symbol: payload.symbol,
      aliases: [],
      original_ids: [],
      relation_ids: [],
      source_id: candidate.source_id,
      status: 'approved',
      reviews: [],
      conflict_ids: [],
      dropped_at: null,
      suspended_at: null,
    };
    store.genes.set(gene.stable_id, gene);
  }
  gene.relation_ids.push(relationId);
  gene.reviews.push(review);

  // 别名冲突：同物种、同名（忽略大小写）、有效区间重叠的不同基因并存撞车。
  for (const alias of incomingAliases) {
    for (const other of store.genes.values()) {
      if (other.stable_id === gene.stable_id || other.dropped_at) continue;
      if (other.species !== gene.species) continue;
      for (const existing of other.aliases) {
        if (existing.name.toLowerCase() === alias.name.toLowerCase() && intervalsOverlap(existing, alias)) {
          const conflict = ensureConflict(store, clock, 'alias', [existing.relation_id, relationId], {
            alias: alias.name,
            species: gene.species,
            genes: [other.stable_id, gene.stable_id].sort(),
          });
          conflictIds.push(conflict.conflict_id);
        }
      }
    }
  }

  mergeAliases(gene, incomingAliases);
  mergeOriginalIds(gene, incomingOriginalIds);
  return { relation_ids: [relationId], conflict_ids: [...new Set(conflictIds)] };
}

function mergeAliases(gene, incoming) {
  const seen = new Set(gene.aliases.map((a) => `${a.name.toLowerCase()}|${a.valid_from}|${a.valid_to}`));
  for (const alias of incoming) {
    const key = `${alias.name.toLowerCase()}|${alias.valid_from}|${alias.valid_to}`;
    if (!seen.has(key)) {
      gene.aliases.push(alias);
      seen.add(key);
    }
  }
}

function mergeOriginalIds(gene, incoming) {
  const seen = new Set(gene.original_ids.map((ref) => `${ref.source_id ?? ''}|${ref.id}`));
  for (const ref of incoming) {
    const key = `${ref.source_id ?? ''}|${ref.id}`;
    if (!seen.has(key)) {
      gene.original_ids.push(ref);
      seen.add(key);
    }
  }
}

function applyMembership(store, clock, candidate, review) {
  const payload = candidate.payload;
  const relationId = nextRelationId(store);
  const membership = {
    relation_id: relationId,
    kind: 'ortholog_member',
    group_id: payload.group_id,
    stable_id: payload.stable_id,
    valid_from: payload.valid_from ?? null,
    valid_to: payload.valid_to ?? null,
    source_id: candidate.source_id,
    reviews: [review],
    conflict_ids: [],
    dropped_at: null,
    suspended_at: null,
  };
  store.memberships.set(relationId, membership);

  // 成员冲突：同一基因在重叠区间被分进不同同源组。
  const conflictIds = [];
  for (const other of store.memberships.values()) {
    if (other.relation_id === relationId || other.dropped_at) continue;
    if (other.stable_id !== membership.stable_id || other.group_id === membership.group_id) continue;
    if (!intervalsOverlap(other, membership)) continue;
    const conflict = ensureConflict(store, clock, 'membership', [other.relation_id, relationId], {
      stable_id: membership.stable_id,
      groups: [other.group_id, membership.group_id].sort(),
    });
    conflictIds.push(conflict.conflict_id);
  }
  return { relation_ids: [relationId], conflict_ids: [...new Set(conflictIds)] };
}

function applySupersedes(store, clock, candidate, review) {
  const payload = candidate.payload;
  const relationId = nextRelationId(store);
  const relation = {
    relation_id: relationId,
    kind: 'supersedes',
    from_stable_id: payload.from_stable_id,
    to_stable_id: payload.to_stable_id,
    valid_from: payload.valid_from ?? null,
    source_id: candidate.source_id,
    reviews: [review],
    conflict_ids: [],
    dropped_at: null,
    suspended_at: null,
  };
  store.supersedes.set(relationId, relation);

  // 替代冲突：同一标识被裁定替代到多个不同目标。
  const conflictIds = [];
  for (const other of store.supersedes.values()) {
    if (other.relation_id === relationId || other.dropped_at) continue;
    if (other.from_stable_id !== relation.from_stable_id || other.to_stable_id === relation.to_stable_id) continue;
    const conflict = ensureConflict(store, clock, 'supersedes', [other.relation_id, relationId], {
      from_stable_id: relation.from_stable_id,
      targets: [other.to_stable_id, relation.to_stable_id].sort(),
    });
    conflictIds.push(conflict.conflict_id);
  }
  return { relation_ids: [relationId], conflict_ids: [...new Set(conflictIds)] };
}

/**
 * 归并冲突：若涉及的关系已在某个未决冲突中，则并入该冲突（冲突链不断裂）；
 * 否则新建冲突记录。冲突双方保持 approved 并存。
 */
function ensureConflict(store, clock, kind, relationRefs, context) {
  for (const conflict of store.conflicts.values()) {
    if (conflict.kind !== kind || conflict.status !== 'open') continue;
    if (conflict.relation_refs.some((ref) => relationRefs.includes(ref))) {
      conflict.relation_refs = [...new Set([...conflict.relation_refs, ...relationRefs])];
      attachConflict(store, conflict.conflict_id, relationRefs);
      return conflict;
    }
  }
  const conflict = {
    conflict_id: `cfl_${store.nextSeq('conflict')}`,
    kind,
    relation_refs: [...new Set(relationRefs)],
    context,
    status: 'open',
    resolution: null,
    created_at: clock(),
  };
  store.conflicts.set(conflict.conflict_id, conflict);
  attachConflict(store, conflict.conflict_id, conflict.relation_refs);
  store.log({ at: clock(), actor: 'system', action: 'conflict-open', details: { conflict_id: conflict.conflict_id, kind, context } });
  return conflict;
}

function attachConflict(store, conflictId, relationRefs) {
  for (const ref of relationRefs) {
    const found = store.findRelation(ref);
    if (found && !found.relation.conflict_ids.includes(conflictId)) {
      found.relation.conflict_ids.push(conflictId);
    }
  }
}

/**
 * 显式裁定：keep 保留、drop 丢弃（退出后续发布），必须完整覆盖冲突涉及的关系，
 * 并记录裁定人与理由。旧版本不受影响（版本不可变），新版本按裁定结果生成。
 */
export function resolveConflict(store, clock, { conflict_id, keep = [], drop = [], rationale, decided_by }) {
  const conflict = store.conflicts.get(conflict_id);
  if (!conflict) throw new GovernanceError(CODES.NOT_FOUND, `未知冲突: ${conflict_id}`);
  if (conflict.status !== 'open') {
    throw new GovernanceError(CODES.CONFLICT_STATE, `冲突已裁定: ${conflict_id}`);
  }
  if (!decided_by || !rationale) {
    throw new GovernanceError(CODES.VALIDATION, '裁定必须提供裁定人与理由');
  }
  const refs = new Set(conflict.relation_refs);
  const keepSet = new Set(keep);
  const dropSet = new Set(drop);
  const covered = new Set([...keepSet, ...dropSet]);
  const overlap = [...keepSet].filter((id) => dropSet.has(id));
  const missing = [...refs].filter((id) => !covered.has(id));
  const extra = [...covered].filter((id) => !refs.has(id));
  if (overlap.length > 0 || missing.length > 0 || extra.length > 0) {
    throw new GovernanceError(CODES.VALIDATION, 'keep/drop 必须完整且不重叠地覆盖冲突关系', { overlap, missing, extra });
  }
  for (const relationId of drop) {
    const found = store.findRelation(relationId);
    if (found) found.relation.dropped_at = clock();
  }
  conflict.status = 'resolved';
  conflict.resolution = { keep, drop, rationale, decided_by, decided_at: clock() };
  store.log({ at: clock(), actor: decided_by, action: 'conflict-resolve', details: { conflict_id, keep, drop, rationale } });
  return conflict;
}

export function listConflicts(store, { status } = {}) {
  const all = [...store.conflicts.values()];
  return status ? all.filter((c) => c.status === status) : all;
}
