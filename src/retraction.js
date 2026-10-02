import { GovernanceError, CODES } from './errors.js';
import { isEntryMemberSuspended } from './suspension.js';

/**
 * 证据来源撤回。
 *
 * 撤回只改治理状态，不删除任何旧产物：
 * - 来源标记 retracted，其直接产生的基因/成员/替代关系进入暂停态，
 *   并沿依赖链传递（基因暂停则其成员关系视同暂停，见 suspension.js）；
 * - 暂停的条目不再进入后续发布，也不允许新的训练锁引用（新引用被暂停）；
 * - 已发布版本与已锁定输入原样保留、仍可复现；
 * - 仍在复核队列中的该来源候选直接驳回；
 * - 引用到受影响条目的旧实验被打上 retraction-impact 标记，便于研究者评估。
 */
export function retractSource(store, clock, { source_id, reason, by }) {
  const source = store.sources.get(source_id);
  if (!source) throw new GovernanceError(CODES.NOT_FOUND, `未知证据来源: ${source_id}`);
  if (source.status === 'retracted') {
    throw new GovernanceError(CODES.SOURCE_STATE, `来源已撤回: ${source_id}`);
  }
  if (!reason || !by) throw new GovernanceError(CODES.VALIDATION, '撤回必须提供理由与操作人');

  source.status = 'retracted';
  source.retracted_at = clock();
  source.retraction_reason = reason;
  source.retracted_by = by;

  const suspended = { genes: [], memberships: [], supersedes: [] };
  for (const gene of store.genes.values()) {
    if (gene.source_id === source_id && !gene.suspended_at) {
      gene.suspended_at = clock();
      suspended.genes.push(gene.stable_id);
    }
  }
  for (const membership of store.memberships.values()) {
    if (membership.source_id === source_id && !membership.suspended_at) {
      membership.suspended_at = clock();
      suspended.memberships.push(membership.relation_id);
    }
  }
  for (const relation of store.supersedes.values()) {
    if (relation.source_id === source_id && !relation.suspended_at) {
      relation.suspended_at = clock();
      suspended.supersedes.push(relation.relation_id);
    }
  }

  // 队列中尚未复核的该来源候选直接驳回，不再进入批准流程。
  let rejectedCandidates = 0;
  for (const candidate of store.candidates.values()) {
    if (candidate.source_id === source_id && candidate.status === 'validated') {
      candidate.status = 'rejected';
      candidate.errors = [...candidate.errors, 'source-retracted'];
      rejectedCandidates += 1;
    }
  }

  // 影响标记：旧锁的清单槽位若落在被暂停的条目上，标记对应实验。
  const affected = [];
  for (const lock of store.locks.values()) {
    const version = store.versions.get(lock.version_id);
    if (!version) continue;
    const hitTokens = [];
    for (const slot of lock.manifest.slots) {
      if (slot.status !== 'present') continue;
      const entry = version.entries[slot.group_id];
      const member = entry?.members.find((m) => m.stable_id === slot.stable_id);
      if (member && isEntryMemberSuspended(store, member)) hitTokens.push(slot.token);
    }
    if (hitTokens.length === 0) continue;
    const mark = {
      mark_id: `mark_${store.nextSeq('mark')}`,
      kind: 'retraction-impact',
      experiment_id: lock.experiment_id,
      source_id,
      tokens: hitTokens.sort(),
      created_at: clock(),
    };
    store.ensureExperiment(lock.experiment_id).marks.push(mark);
    affected.push(mark);
  }

  store.log({
    at: clock(),
    actor: by,
    action: 'source-retract',
    details: { source_id, reason, suspended, rejected_candidates: rejectedCandidates, affected_experiments: affected.map((m) => m.experiment_id) },
  });
  return { source_id, suspended, rejected_candidates: rejectedCandidates, affected_marks: affected };
}
