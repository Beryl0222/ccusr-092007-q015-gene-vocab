import { GovernanceError, CODES } from './errors.js';
import { hashOf, sortedUnique } from './util.js';
import { requireSpeciesAccess } from './access.js';
import { isEntryMemberSuspended } from './suspension.js';

/**
 * 训练任务锁定与输入重建。
 *
 * - 锁定时固定：词表版本、物种面板、查询的同源组、缺失处理策略，
 *   以及锁定时点的冲突排除集（之后冲突被裁定也不影响已锁定的输入）；
 * - 清单哈希在锁定与重建时各算一次，不一致即报 manifest-diverged，
 *   保证“相同词表重新生成完全一致的输入”是可验证的；
 * - 未决冲突默认报错（on_conflict: 'error'），选择 'exclude' 会把被争议
 *   的关系显式排除并记录在清单里——任何情况下都不悄悄选定；
 * - 被撤回来源沿依赖链暂停的条目，禁止被新锁引用（旧锁不受限）。
 */
export const MISSING_POLICIES = Object.freeze(['skip', 'placeholder', 'error']);
export const CONFLICT_POLICIES = Object.freeze(['error', 'exclude']);

export function createTrainingLock(store, clock, {
  experiment_id,
  version_id,
  query,
  species_panel = null,
  missing_policy = {},
  principal,
  actor = 'training',
}) {
  const version = store.versions.get(version_id);
  if (!version) throw new GovernanceError(CODES.NOT_FOUND, `未知词表版本: ${version_id}`);
  if (!experiment_id) throw new GovernanceError(CODES.VALIDATION, '缺少 experiment_id');

  const policy = {
    on_missing: missing_policy.on_missing ?? 'placeholder',
    on_conflict: missing_policy.on_conflict ?? 'error',
  };
  if (!MISSING_POLICIES.includes(policy.on_missing)) {
    throw new GovernanceError(CODES.VALIDATION, `未知缺失策略: ${policy.on_missing}`);
  }
  if (!CONFLICT_POLICIES.includes(policy.on_conflict)) {
    throw new GovernanceError(CODES.VALIDATION, `未知冲突策略: ${policy.on_conflict}`);
  }

  const panel = sortedUnique(species_panel ?? version.species_catalog);
  const groups = query === 'ALL' ? Object.keys(version.entries).sort() : sortedUnique(query ?? []);
  if (groups.length === 0) throw new GovernanceError(CODES.VALIDATION, '查询的同源组不能为空');

  // 面板物种必须已注册（拼写错误不应被静默当作缺失），且新引用需有权限。
  const unknownTaxa = panel.filter((taxon) => !store.species.has(taxon));
  if (unknownTaxa.length > 0) {
    throw new GovernanceError(CODES.VALIDATION, '面板中存在未注册的物种', { unknown: unknownTaxa });
  }
  requireSpeciesAccess(store, principal, panel);

  // 锁定时点的治理状态：裁定丢弃的关系/基因、未决冲突、撤回暂停。
  const excludedRelations = new Set();
  const excludedGenes = new Set();
  const suspendedHits = [];
  const openConflicts = new Set();
  for (const groupId of groups) {
    const entry = version.entries[groupId];
    if (!entry) throw new GovernanceError(CODES.UNKNOWN_GROUP, `版本 ${version_id} 中不存在同源组: ${groupId}`, { group_id: groupId });
    // 冲突检查用“当前治理状态”：版本快照之后新开的冲突同样阻断或显式排除。
    const conflictIds = new Set(entry.conflict_ids);
    for (const member of entry.members) {
      const relation = member.relation_id ? store.memberships.get(member.relation_id) : null;
      for (const id of relation?.conflict_ids ?? []) conflictIds.add(id);
    }
    for (const conflictId of conflictIds) {
      if (store.conflicts.get(conflictId)?.status === 'open') openConflicts.add(conflictId);
    }
    for (const member of entry.members) {
      if (isEntryMemberSuspended(store, member)) {
        suspendedHits.push({ group_id: groupId, stable_id: member.stable_id });
      }
      const membership = member.relation_id ? store.memberships.get(member.relation_id) : null;
      if (membership?.dropped_at) excludedRelations.add(member.relation_id);
      if (store.genes.get(member.stable_id)?.dropped_at) excludedGenes.add(member.stable_id);
    }
  }
  if (suspendedHits.length > 0) {
    throw new GovernanceError(CODES.SUSPENDED, '所引用的词表条目已被撤回来源暂停', { hits: suspendedHits });
  }
  if (openConflicts.size > 0 && policy.on_conflict === 'error') {
    throw new GovernanceError(CODES.CONFLICT_OPEN, '存在未裁定的冲突，拒绝悄悄选定', { conflict_ids: [...openConflicts].sort() });
  }
  if (policy.on_conflict === 'exclude') {
    for (const conflictId of openConflicts) {
      for (const ref of store.conflicts.get(conflictId).relation_refs) {
        const found = store.findRelation(ref);
        if (found?.type === 'membership') excludedRelations.add(ref);
        if (found?.type === 'gene') excludedGenes.add(found.relation.stable_id);
      }
    }
  }

  const manifest = {
    version_id,
    species_panel: panel,
    query: groups,
    missing_policy: policy,
    ...computeSlots(version, { groups, panel, policy, excludedRelations, excludedGenes }),
    excluded_relation_ids: [...excludedRelations].sort(),
    excluded_gene_ids: [...excludedGenes].sort(),
    frozen_at: clock(),
  };
  const manifestHash = manifestHashOf(manifest);

  const lock = {
    lock_id: `lock_${store.nextSeq('lock')}`,
    experiment_id,
    version_id,
    species_panel: panel,
    query: groups,
    missing_policy: policy,
    manifest,
    manifest_hash: manifestHash,
    status: 'active',
    created_at: clock(),
    created_by: actor,
  };
  store.locks.set(lock.lock_id, lock);
  const experiment = store.ensureExperiment(experiment_id);
  experiment.lock_ids.push(lock.lock_id);
  store.log({ at: clock(), actor, action: 'lock', details: { lock_id: lock.lock_id, experiment_id, version_id, manifest_hash: manifestHash } });
  return lock;
}

/**
 * 按锁重建输入：用冻结在清单里的排除集与策略重算，校验哈希一致后返回。
 * 同一锁定无论重建多少次、何时重建，结果必须完全一致。
 */
export function buildInput(store, lockId) {
  const lock = store.locks.get(lockId);
  if (!lock) throw new GovernanceError(CODES.NOT_FOUND, `未知训练锁: ${lockId}`);
  const version = store.versions.get(lock.version_id);
  if (!version) throw new GovernanceError(CODES.NOT_FOUND, `锁定的词表版本缺失: ${lock.version_id}`);

  const recomputed = computeSlots(version, {
    groups: lock.query,
    panel: lock.species_panel,
    policy: lock.missing_policy,
    excludedRelations: new Set(lock.manifest.excluded_relation_ids),
    excludedGenes: new Set(lock.manifest.excluded_gene_ids),
  });
  const recomputedHash = manifestHashOf({ ...lock.manifest, ...recomputed });
  if (recomputedHash !== lock.manifest_hash) {
    throw new GovernanceError(CODES.MANIFEST_DIVERGED, '重建结果与锁定清单不一致', {
      lock_id: lockId,
      expected: lock.manifest_hash,
      actual: recomputedHash,
    });
  }
  return {
    lock_id: lock.lock_id,
    version_id: lock.version_id,
    tokens: recomputed.slots.map((slot) => slot.token),
    slots: recomputed.slots,
    omitted: recomputed.omitted,
    manifest_hash: lock.manifest_hash,
  };
}

function manifestHashOf(manifest) {
  return hashOf({
    version_id: manifest.version_id,
    species_panel: manifest.species_panel,
    query: manifest.query,
    missing_policy: manifest.missing_policy,
    slots: manifest.slots,
    omitted: manifest.omitted,
    excluded_relation_ids: manifest.excluded_relation_ids,
    excluded_gene_ids: manifest.excluded_gene_ids,
  });
}

/**
 * 由版本条目生成输入槽位。同一物种在同一组内有多名成员（旁系同源）时，
 * 按“稳定标识最小者”确定代表并显式记录备选——规则公开，不是悄悄选定。
 */
function computeSlots(version, { groups, panel, policy, excludedRelations, excludedGenes }) {
  const slots = [];
  const omitted = [];
  for (const groupId of groups) {
    const entry = version.entries[groupId];
    if (!entry) throw new GovernanceError(CODES.UNKNOWN_GROUP, `版本中不存在同源组: ${groupId}`, { group_id: groupId });
    const members = entry.members.filter(
      (m) => !excludedRelations.has(m.relation_id) && !excludedGenes.has(m.stable_id),
    );
    for (const taxon of panel) {
      const candidates = members
        .filter((m) => m.species === taxon)
        .sort((a, b) => a.stable_id.localeCompare(b.stable_id));
      if (candidates.length === 0) {
        if (policy.on_missing === 'error') {
          throw new GovernanceError(CODES.MISSING_SLOT, `同源组 ${groupId} 缺少物种 ${taxon} 的成员`, { group_id: groupId, species: taxon });
        }
        if (policy.on_missing === 'skip') {
          omitted.push({ group_id: groupId, species: taxon });
          continue;
        }
        slots.push({
          group_id: groupId,
          species: taxon,
          stable_id: null,
          status: 'missing',
          token: `GV:${groupId}:MISSING@${taxon}`,
        });
        continue;
      }
      const representative = candidates[0];
      slots.push({
        group_id: groupId,
        species: taxon,
        stable_id: representative.stable_id,
        status: 'present',
        token: `GV:${groupId}:${representative.stable_id}`,
        original_ids: representative.original_ids,
        ...(candidates.length > 1
          ? { note: 'representative=min-stable-id', alternatives: candidates.slice(1).map((c) => c.stable_id) }
          : {}),
      });
    }
  }
  return { slots, omitted };
}
