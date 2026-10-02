import { GovernanceError, CODES } from './errors.js';
import { deepFreeze, hashOf, sortedUnique } from './util.js';
import { isMembershipSuspended } from './suspension.js';
import { partitionMembers, canViewSpecies } from './access.js';

/**
 * 词表版本发布与差异查询。
 *
 * - 发布把“当前已批准、未被裁定丢弃、未被撤回暂停”的关系固化为不可变版本；
 *   旧版本永远可原样重放，数据库修订只产生新版本，不回写旧版本；
 * - 发布后自动对照每个训练锁所在版本做差异分析，给受影响实验打标记
 *   （只标记，不改动任何已锁定的输入）；
 * - diffVersions 支持任意两个版本的差异查询，供研究者审查修订。
 */
export function publishVersion(store, clock, { note = '', actor = 'release' } = {}) {
  const seq = store.nextSeq('version');
  const versionId = `v${seq}`;
  const parent = seq > 1 ? `v${seq - 1}` : null;

  // 基因目录：排除被裁定丢弃与被撤回暂停的。
  const genes = {};
  for (const gene of store.genes.values()) {
    if (gene.dropped_at || gene.suspended_at) continue;
    genes[gene.stable_id] = {
      stable_id: gene.stable_id,
      species: gene.species,
      symbol: gene.symbol,
      aliases: gene.aliases.map((a) => ({ name: a.name, valid_from: a.valid_from, valid_to: a.valid_to })),
      original_ids: gene.original_ids.map((ref) => ({ ...ref })),
      source_id: gene.source_id,
      conflict_ids: sortedUnique(gene.conflict_ids),
      open_conflict_ids: openConflictIds(store, gene.conflict_ids),
    };
  }

  // 同源组条目：成员关系未被丢弃/暂停，且基因本体可用。
  const grouped = new Map();
  for (const membership of store.memberships.values()) {
    if (membership.dropped_at || isMembershipSuspended(store, membership)) continue;
    if (!genes[membership.stable_id]) continue;
    if (!grouped.has(membership.group_id)) grouped.set(membership.group_id, []);
    grouped.get(membership.group_id).push(membership);
  }

  const entries = {};
  const sourceIds = new Set();
  for (const groupId of [...grouped.keys()].sort()) {
    const memberships = grouped.get(groupId);
    const members = memberships
      .map((m) => memberView(genes[m.stable_id], m))
      .sort((a, b) => a.stable_id.localeCompare(b.stable_id));
    for (const member of members) member.source_ids.forEach((id) => sourceIds.add(id));
    const conflictIds = sortedUnique(memberships.flatMap((m) => m.conflict_ids));
    entries[groupId] = {
      token: `GV:${groupId}`,
      group_id: groupId,
      members,
      conflict_ids: conflictIds,
      open_conflict_ids: conflictIds.filter((id) => store.conflicts.get(id)?.status === 'open'),
      valid_from: minIso(memberships.map((m) => m.valid_from)),
      valid_to: maxIso(memberships.map((m) => m.valid_to)),
    };
  }

  // 未入组的已批准基因以单例条目进入词表，物种特有基因也有稳定词位。
  const groupedGenes = new Set([...grouped.values()].flat().map((m) => m.stable_id));
  for (const gene of Object.values(genes)) {
    if (groupedGenes.has(gene.stable_id)) continue;
    const groupId = `SINGLE:${gene.stable_id}`;
    sourceIds.add(gene.source_id);
    entries[groupId] = {
      token: `GV:${groupId}`,
      group_id: groupId,
      members: [memberView(gene, null)],
      conflict_ids: gene.conflict_ids,
      open_conflict_ids: gene.open_conflict_ids,
      valid_from: null,
      valid_to: null,
    };
  }
  for (const gene of Object.values(genes)) sourceIds.add(gene.source_id);

  const version = {
    version_id: versionId,
    seq,
    parent,
    note,
    created_at: clock(),
    entries,
    genes,
    species_catalog: [...store.species.keys()].sort(),
    source_releases: Object.fromEntries(
      [...sourceIds].sort().map((id) => [id, store.sources.get(id)?.release ?? null]),
    ),
  };
  version.hash = hashOf(version);
  deepFreeze(version);
  store.versions.set(versionId, version);

  const marks = markImpactedExperiments(store, clock, version);
  store.log({
    at: clock(),
    actor,
    action: 'publish',
    details: { version_id: versionId, parent, note, entries: Object.keys(entries).length, impacted: marks.map((m) => m.experiment_id) },
  });
  return version;
}

function memberView(gene, membership) {
  const sourceIds = new Set([gene.source_id]);
  if (membership) sourceIds.add(membership.source_id);
  return {
    stable_id: gene.stable_id,
    species: gene.species,
    symbol: gene.symbol,
    aliases: gene.aliases.map((a) => ({ ...a })),
    original_ids: gene.original_ids.map((ref) => ({ ...ref })),
    relation_id: membership ? membership.relation_id : null,
    source_ids: [...sourceIds].sort(),
  };
}

function openConflictIds(store, conflictIds) {
  return sortedUnique(conflictIds).filter((id) => store.conflicts.get(id)?.status === 'open');
}

function minIso(values) {
  const present = values.filter((v) => v != null).sort();
  return present.length > 0 ? present[0] : null;
}

function maxIso(values) {
  const present = values.filter((v) => v != null).sort();
  return present.length > 0 ? present[present.length - 1] : null;
}

/** 两个版本条目集的结构差异：新增组、移除组、成员与冲突标记变化。 */
export function diffEntries(aEntries, bEntries) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const groupId of Object.keys(bEntries)) {
    if (!(groupId in aEntries)) added.push(groupId);
  }
  for (const groupId of Object.keys(aEntries)) {
    if (!(groupId in bEntries)) {
      removed.push(groupId);
      continue;
    }
    const aMembers = new Set(aEntries[groupId].members.map((m) => m.stable_id));
    const bMembers = new Set(bEntries[groupId].members.map((m) => m.stable_id));
    const aConflicts = new Set(aEntries[groupId].open_conflict_ids ?? aEntries[groupId].conflict_ids);
    const bConflicts = new Set(bEntries[groupId].open_conflict_ids ?? bEntries[groupId].conflict_ids);
    const change = {
      group_id: groupId,
      token: bEntries[groupId].token,
      added_members: [...bMembers].filter((id) => !aMembers.has(id)).sort(),
      removed_members: [...aMembers].filter((id) => !bMembers.has(id)).sort(),
      conflicts_opened: [...bConflicts].filter((id) => !aConflicts.has(id)).sort(),
      conflicts_closed: [...aConflicts].filter((id) => !bConflicts.has(id)).sort(),
    };
    if (change.added_members.length || change.removed_members.length || change.conflicts_opened.length || change.conflicts_closed.length) {
      changed.push(change);
    }
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => a.group_id.localeCompare(b.group_id)),
  };
}

/**
 * 差异查询：added / removed / changed 三类，附基因目录变化与汇总。
 * 传入 principal 时按项目权限过滤：成员全部受限的条目只计入数，
 * 不泄露组名（单例条目的组名本身含稳定标识）。
 */
export function diffVersions(store, fromId, toId, principal = null) {
  const a = mustGetVersion(store, fromId);
  const b = mustGetVersion(store, toId);
  const diff = diffEntries(a.entries, b.entries);
  let redacted = 0;
  let genesAdded = [...Object.keys(b.genes)].filter((id) => !(id in a.genes)).sort();
  let genesRemoved = [...Object.keys(a.genes)].filter((id) => !(id in b.genes)).sort();
  if (principal) {
    const fullyRedacted = (entry) => {
      if (!entry || entry.members.length === 0) return false;
      return partitionMembers(store, principal, entry.members).visible.length === 0;
    };
    const hiddenAdded = diff.added.filter((g) => fullyRedacted(b.entries[g]));
    const hiddenRemoved = diff.removed.filter((g) => fullyRedacted(a.entries[g]));
    redacted += hiddenAdded.length + hiddenRemoved.length;
    diff.added = diff.added.filter((g) => !hiddenAdded.includes(g));
    diff.removed = diff.removed.filter((g) => !hiddenRemoved.includes(g));
    for (const change of diff.changed) {
      // added_members 按新版本可见集过滤；removed_members 按旧版本可见集过滤
      // （被移除的成员只存在于旧版本中）。
      const visibleIn = (entry) => new Set(partitionMembers(store, principal, entry?.members ?? []).visible.map((m) => m.stable_id));
      const visibleB = visibleIn(b.entries[change.group_id]);
      const visibleA = visibleIn(a.entries[change.group_id]);
      redacted += (b.entries[change.group_id]?.members.length ?? 0) - visibleB.size;
      change.added_members = change.added_members.filter((id) => visibleB.has(id));
      change.removed_members = change.removed_members.filter((id) => visibleA.has(id));
    }
    const visibleGene = (id, genes) => {
      const species = store.species.get(genes[id]?.species);
      return species ? canViewSpecies(principal, species) : false;
    };
    const hiddenGenesAdded = genesAdded.filter((id) => !visibleGene(id, b.genes));
    const hiddenGenesRemoved = genesRemoved.filter((id) => !visibleGene(id, a.genes));
    redacted += hiddenGenesAdded.length + hiddenGenesRemoved.length;
    genesAdded = genesAdded.filter((id) => !hiddenGenesAdded.includes(id));
    genesRemoved = genesRemoved.filter((id) => !hiddenGenesRemoved.includes(id));
  }
  return {
    from: fromId,
    to: toId,
    ...diff,
    genes_added: genesAdded,
    genes_removed: genesRemoved,
    redacted_member_count: redacted,
    summary: {
      entries_added: diff.added.length,
      entries_removed: diff.removed.length,
      entries_changed: diff.changed.length,
    },
  };
}

/** 版本读取视图：受限物种成员对未授权 principal 隐藏，仅保留计数。 */
export function getVersionView(store, versionId, principal) {
  const version = mustGetVersion(store, versionId);
  const entries = {};
  let redacted = 0;
  for (const [groupId, entry] of Object.entries(version.entries)) {
    const { visible, redacted: hidden } = partitionMembers(store, principal, entry.members);
    redacted += hidden.length;
    entries[groupId] = { ...entry, members: visible };
  }
  return { ...version, entries, redacted_member_count: redacted };
}

function mustGetVersion(store, versionId) {
  const version = store.versions.get(versionId);
  if (!version) throw new GovernanceError(CODES.NOT_FOUND, `未知词表版本: ${versionId}`);
  return version;
}

/**
 * 影响标记：新版本发布后，对锁定在旧版本上的实验，
 * 若其清单用到的同源组在新版本中被修改或移除，则打 vocab-impact 标记。
 * 只标记，不改动任何已锁定的输入。
 */
function markImpactedExperiments(store, clock, newVersion) {
  const marks = [];
  for (const lock of store.locks.values()) {
    if (lock.version_id === newVersion.version_id) continue;
    const oldVersion = store.versions.get(lock.version_id);
    if (!oldVersion) continue;
    const diff = diffEntries(oldVersion.entries, newVersion.entries);
    const touched = new Set([...diff.removed, ...diff.changed.map((c) => c.group_id)]);
    const usedGroups = new Set(lock.manifest.slots.map((slot) => slot.group_id));
    const hitGroups = [...touched].filter((g) => usedGroups.has(g)).sort();
    if (hitGroups.length === 0) continue;
    const hitTokens = lock.manifest.slots.filter((s) => hitGroups.includes(s.group_id)).map((s) => s.token).sort();
    const mark = {
      mark_id: `mark_${store.nextSeq('mark')}`,
      kind: 'vocab-impact',
      experiment_id: lock.experiment_id,
      from_version: lock.version_id,
      to_version: newVersion.version_id,
      groups: hitGroups,
      tokens: hitTokens,
      created_at: clock(),
    };
    store.ensureExperiment(lock.experiment_id).marks.push(mark);
    marks.push(mark);
  }
  return marks;
}
