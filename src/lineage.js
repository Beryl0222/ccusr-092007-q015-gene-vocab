import { GovernanceError, CODES } from './errors.js';
import { partitionMembers } from './access.js';

/**
 * 谱系追溯：从训练输入中的一个位置（token 序号）出发，
 * 还原该位置对应的同源组、各物种成员的稳定标识与原始标识，
 * 以及每一项选择留下的依据（复核理由、冲突裁定、代表选取规则、排除记录）。
 * 受限物种的成员对未授权 principal 只计数、不泄露标识。
 */
export function tracePosition(store, lockId, position, principal) {
  const lock = store.locks.get(lockId);
  if (!lock) throw new GovernanceError(CODES.NOT_FOUND, `未知训练锁: ${lockId}`);
  const version = store.versions.get(lock.version_id);
  if (!version) throw new GovernanceError(CODES.NOT_FOUND, `锁定的词表版本缺失: ${lock.version_id}`);
  const slots = lock.manifest.slots;
  if (!Number.isInteger(position) || position < 0 || position >= slots.length) {
    throw new GovernanceError(CODES.VALIDATION, `位置超出输入范围: ${position}`, { length: slots.length });
  }
  const slot = slots[position];
  const entry = version.entries[slot.group_id];
  if (!entry) throw new GovernanceError(CODES.NOT_FOUND, `版本中不存在同源组: ${slot.group_id}`);

  const { visible, redacted } = partitionMembers(store, principal, entry.members);
  const members = visible.map((member) => ({
    stable_id: member.stable_id,
    species: member.species,
    symbol: member.symbol,
    aliases: member.aliases,
    original_ids: member.original_ids,
    sources: member.source_ids.map((sourceId) => sourceView(store, sourceId)),
    reviews: reviewsOf(store, member),
  }));

  return {
    lock_id: lock.lock_id,
    version_id: lock.version_id,
    position,
    token: slot.token,
    group_id: slot.group_id,
    slot,
    members,
    redacted_member_count: redacted.length,
    rationale: rationaleOf(store, lock, entry, slot),
  };
}

function sourceView(store, sourceId) {
  const source = store.sources.get(sourceId);
  return {
    source_id: sourceId,
    name: source?.name ?? null,
    release: source?.release ?? null,
    status: source?.status ?? 'unknown',
  };
}

function reviewsOf(store, member) {
  const reviews = [];
  const gene = store.genes.get(member.stable_id);
  for (const review of gene?.reviews ?? []) reviews.push({ ...review, on: 'gene' });
  if (member.relation_id) {
    const membership = store.memberships.get(member.relation_id);
    for (const review of membership?.reviews ?? []) reviews.push({ ...review, on: 'membership' });
  }
  return reviews;
}

function rationaleOf(store, lock, entry, slot) {
  const rationale = [];
  // 代表选取规则（旁系同源多成员时）。
  if (slot.note) {
    rationale.push({ type: 'rule', note: slot.note, alternatives: slot.alternatives ?? [] });
  }
  // 缺失占位策略。
  if (slot.status === 'missing') {
    rationale.push({ type: 'policy', note: `on_missing=${lock.missing_policy.on_missing}` });
  }
  // 该组冲突的裁定记录（含被丢弃关系的去向）。
  for (const conflictId of entry.conflict_ids) {
    const conflict = store.conflicts.get(conflictId);
    if (conflict?.resolution) {
      rationale.push({
        type: 'resolution',
        conflict_id: conflictId,
        keep: conflict.resolution.keep,
        drop: conflict.resolution.drop,
        rationale: conflict.resolution.rationale,
        decided_by: conflict.resolution.decided_by,
        decided_at: conflict.resolution.decided_at,
      });
    } else if (conflict) {
      rationale.push({ type: 'conflict-open', conflict_id: conflictId, note: '冲突未裁定，按锁定策略显式排除或阻断' });
    }
  }
  // 锁定时被显式排除的关系（未决冲突的保守排除）。
  const excluded = (lock.manifest.excluded_relation_ids ?? []).filter((relationId) => {
    const membership = store.memberships.get(relationId);
    return membership?.group_id === slot.group_id;
  });
  if (excluded.length > 0) {
    rationale.push({ type: 'excluded', relation_ids: excluded.sort(), note: `on_conflict=${lock.missing_policy.on_conflict}` });
  }
  return rationale;
}
