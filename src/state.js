/**
 * 归约状态与查询视图。
 *
 * 状态完全由事件流回放得到；已批准的事实（基因/同源组/标识链接）带证据与有效区间，
 * 冲突不在归约时消除，只记录专家决定，原始候选事实始终保留。
 */
import { ALL_SPECIES } from './contracts.js';
import { overlaps, contains, toUtcDate } from './time.js';
import { canonicalize, contentHash } from './canonical.js';

export const geneKey = (speciesCode, stableId) => `${speciesCode}::${stableId}`;

export function initialState() {
  return {
    sources: new Map(), // source_id -> {source_id,name,kind,status,reason,registered_at,retracted_at}
    batches: new Map(), // batch_id -> batch 视图
    genes: new Map(), // geneKey -> { facts: [] }
    groups: new Map(), // group_id -> { facts: [] }
    links: [], // [{fact_id, from, to, range, source_id, record_id, revision, evidence, retracted}]
    decisions: new Map(), // conflict_key -> 当前决定（历史在 decisionHistory）
    decisionHistory: [],
    releases: [], // [{version, label, published_at, snapshot, hash}]
    jobs: new Map(), // job_id -> 锁定与产物视图
    retractions: [], // [{source_id, reason, at, fact_ids:[]}]
    impacts: [], // 影响标记（不改动旧产物）
  };
}

function mergeGeneFact(state, fact) {
  const key = geneKey(fact.species_code, fact.stable_id);
  let entry = state.genes.get(key);
  if (!entry) {
    entry = { species_code: fact.species_code, stable_id: fact.stable_id, facts: [] };
    state.genes.set(key, entry);
  }
  entry.facts.push(fact);
}

export function reducer(state, event) {
  const p = event.payload;
  switch (event.type) {
    case 'SOURCE_REGISTERED':
      state.sources.set(p.source_id, {
        source_id: p.source_id,
        name: p.name,
        kind: p.kind ?? 'database',
        status: 'active',
        registered_at: event.ts,
      });
      break;

    case 'SOURCE_RETRACTED':
      state.sources.get(p.source_id) &&
        Object.assign(state.sources.get(p.source_id), {
          status: 'retracted',
          reason: p.reason,
          retracted_at: p.at,
        });
      break;

    case 'RETRACTION_CASCADE': {
      // 只暂停“新的引用”：事实保留并打标，旧发布快照与旧训练产物不动。
      const mark = (fact) => {
        if (p.fact_ids.includes(fact.fact_id)) fact.retracted = true;
      };
      for (const entry of state.genes.values()) entry.facts.forEach(mark);
      for (const group of state.groups.values()) group.facts.forEach(mark);
      state.links.forEach(mark);
      state.retractions.push({ source_id: p.source_id, reason: p.reason, at: p.at, fact_ids: [...p.fact_ids] });
      break;
    }

    case 'IMPORT_STARTED':
      state.batches.set(p.batch_id, {
        batch_id: p.batch_id,
        source_id: p.source_id,
        status: 'receiving',
        total_shards: p.total_shards,
        overall_checksum: p.overall_checksum ?? null,
        idempotency_key: p.idempotency_key ?? null,
        shards: new Map(),
        rows: [],
        created_by: event.by,
        created_at: event.ts,
      });
      break;

    case 'SHARD_RECEIVED': {
      const batch = state.batches.get(p.batch_id);
      batch.shards.set(p.index, { index: p.index, rows_hash: p.rows_hash, row_count: p.row_count });
      batch.rows.push(...p.rows);
      break;
    }

    case 'IMPORT_COMPLETED': {
      const batch = state.batches.get(p.batch_id);
      batch.status = 'received';
      batch.completed_at = event.ts;
      break;
    }

    case 'VALIDATION_RUN': {
      const batch = state.batches.get(p.batch_id);
      batch.validation = { errors: p.errors, warnings: p.warnings, ran_at: event.ts };
      batch.status = p.errors.length > 0 ? 'rejected' : 'validated';
      break;
    }

    case 'BATCH_APPROVED': {
      const batch = state.batches.get(p.batch_id);
      batch.status = 'approved';
      batch.reviewed_by = event.by;
      batch.review_note = p.note;
      batch.acknowledged = [...p.acknowledged_warning_ids];
      batch.reviewed_at = event.ts;
      for (const row of batch.rows) {
        const fact = {
          ...row,
          fact_id: `${batch.batch_id}#${row.record_id}`,
          batch_id: batch.batch_id,
          source_id: batch.source_id,
          record_id: row.record_id,
          revision: row.revision ?? 1,
          retracted: false,
        };
        if (row.kind === 'gene') mergeGeneFact(state, stripKind(fact));
        else if (row.kind === 'group') {
          const groupFact = toGroupFact(stripKind(fact));
          let group = state.groups.get(groupFact.group_id);
          if (!group) {
            group = { group_id: groupFact.group_id, facts: [] };
            state.groups.set(groupFact.group_id, group);
          }
          group.facts.push(groupFact);
        } else if (row.kind === 'link') {
          state.links.push(stripKind(fact));
        }
      }
      break;
    }

    case 'BATCH_REJECTED': {
      const batch = state.batches.get(p.batch_id);
      batch.status = 'rejected';
      batch.reviewed_by = event.by;
      batch.reject_reason = p.reason;
      batch.reviewed_at = event.ts;
      break;
    }

    case 'CONFLICT_RESOLVED':
      state.decisionHistory.push({ ...p, by: event.by, at: event.ts });
      state.decisions.set(p.conflict_key, {
        conflict_key: p.conflict_key,
        chosen_fact_id: p.chosen_fact_id,
        chosen_gene_key: p.chosen_gene_key ?? null,
        rationale: p.rationale,
        by: event.by,
        at: event.ts,
      });
      break;

    case 'RELEASE_PUBLISHED':
      state.releases.push({
        version: p.version,
        label: p.label ?? null,
        published_at: p.at,
        snapshot: p.snapshot,
        hash: p.hash,
      });
      break;

    case 'TRAINING_LOCKED':
      state.jobs.set(p.job_id, {
        job_id: p.job_id,
        experiment: p.experiment ?? null,
        version: p.version,
        vocab_hash: p.vocab_hash,
        missing_policy: p.missing_policy,
        conflict_policy: p.conflict_policy,
        as_of: p.as_of,
        locked_by: event.by,
        locked_at: event.ts,
        input_hash: null,
        impacts: [],
        status: 'locked',
      });
      break;

    case 'INPUT_REGENERATED': {
      const job = state.jobs.get(p.job_id);
      job.input_hash = p.input_hash;
      job.used_keys = [...new Set([...(job.used_keys ?? []), ...p.used_keys])].sort();
      job.generated_at = event.ts;
      job.status = 'ready';
      break;
    }

    case 'IMPACT_FLAGS':
      for (const jobId of p.job_ids) {
        const job = state.jobs.get(jobId);
        if (job) {
          job.impacts.push({
            reason: p.reason,
            scope: p.scope,
            changed_keys: [...p.changed_keys],
            flagged_at: event.ts,
          });
        }
      }
      state.impacts.push({ ...p, flagged_at: event.ts });
      break;

    default:
      break;
  }
  return state;
}

function stripKind(fact) {
  const { kind, ...rest } = fact;
  return rest;
}

function toGroupFact(fact) {
  return {
    ...fact,
    range: { effective_from: fact.effective_from, effective_to: fact.effective_to ?? null },
    members: fact.members.map((m) => geneKey(m.species_code, m.stable_id)),
  };
}

const activeAt = (range, date) => contains({ effective_from: range.effective_from, effective_to: range.effective_to }, date);

/* ---------------- 冲突计算（只报告、不选择） ---------------- */

/**
 * 计算某日仍在有效区间内的冲突：
 *  - alias 冲突：同一物种同一别名在区间重叠时指向不同稳定标识；
 *  - 成员冲突：同一同源组在同一物种有两个不同成员且区间重叠（一对多）。
 * 撤回来源的事实不参与当前冲突集，但历史里仍可追溯。
 */
export function computeConflicts(state, date = toUtcDate(new Date())) {
  const conflicts = [];

  const aliasOwners = new Map(); // species::alias(lower) -> [{key, fact}]
  for (const [key, entry] of state.genes) {
    for (const fact of entry.facts) {
      if (fact.retracted) continue;
      for (const alias of fact.aliases ?? []) {
        if (!activeAt(alias, date)) continue;
        const mapKey = `${fact.species_code}::${alias.name.toLowerCase()}`;
        const owners = aliasOwners.get(mapKey) ?? [];
        owners.push({ key, fact, alias });
        aliasOwners.set(mapKey, owners);
      }
    }
  }
  for (const [mapKey, owners] of aliasOwners) {
    const distinct = new Set(owners.map((o) => o.key));
    if (distinct.size > 1) {
      conflicts.push({
        conflict_key: `alias:${mapKey}`,
        type: 'alias_overlap',
        date,
        candidates: owners
          .map((o) => ({ fact_id: o.fact.fact_id, gene_key: o.key, range: o.alias, source_id: o.fact.source_id }))
          .sort(compareBy('fact_id')),
      });
    }
  }

  for (const [groupId, group] of state.groups) {
    const bySpecies = new Map();
    for (const fact of group.facts) {
      if (fact.retracted || !activeAt(fact.range, date)) continue;
      for (const member of fact.members) {
        const species = member.split('::')[0];
        const list = bySpecies.get(species) ?? [];
        list.push({ member, fact });
        bySpecies.set(species, list);
      }
    }
    for (const [species, list] of bySpecies) {
      const distinct = new Set(list.map((x) => x.member));
      if (distinct.size > 1) {
        conflicts.push({
          conflict_key: `membership:${groupId}:${species}`,
          type: 'one_to_many',
          date,
          candidates: list
            .map((x) => ({ fact_id: x.fact.fact_id, gene_key: x.member, range: x.fact.range, source_id: x.fact.source_id }))
            .sort(compareBy('fact_id')),
        });
      }
    }
  }

  return conflicts.sort(compareBy('conflict_key'));
}

function compareBy(key) {
  return (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}

/* ---------------- 发布快照 ---------------- */

/** 构造不可变发布快照；撤回事实被排除在“新引用”之外，但仍留在历史事件里。 */
export function buildSnapshot(state, { at = toUtcDate(new Date()), publishedAt = new Date().toISOString() } = {}) {
  const genes = [];
  for (const [key, entry] of state.genes) {
    for (const fact of entry.facts) {
      if (fact.retracted) continue;
      genes.push({
        key,
        species_code: fact.species_code,
        stable_id: fact.stable_id,
        aliases: (fact.aliases ?? []).map((a) => ({ ...a })).sort(compareBy('name')),
        evidence: fact.evidence ?? null,
        source_id: fact.source_id,
        fact_id: fact.fact_id,
        revision: fact.revision,
      });
    }
  }
  genes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.fact_id < b.fact_id ? -1 : 1));

  const groups = [];
  for (const [groupId, group] of state.groups) {
    for (const fact of group.facts) {
      if (fact.retracted) continue;
      groups.push({
        group_id: groupId,
        fact_id: fact.fact_id,
        members: [...fact.members].sort(),
        range: { ...fact.range },
        evidence: fact.evidence ?? null,
        source_id: fact.source_id,
        revision: fact.revision,
      });
    }
  }
  groups.sort((a, b) => (a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : a.fact_id < b.fact_id ? -1 : 1));

  const links = state.links
    .filter((l) => !l.retracted)
    .map((l) => ({
      fact_id: l.fact_id,
      from: geneKey(l.from.species_code, l.from.stable_id),
      to: geneKey(l.to.species_code, l.to.stable_id),
      range: { effective_from: l.effective_from, effective_to: l.effective_to ?? null },
      evidence: l.evidence ?? null,
      source_id: l.source_id,
      revision: l.revision,
    }))
    .sort((a, b) => (a.fact_id < b.fact_id ? -1 : 1));

  const conflicts = computeConflicts(state, at);
  const decisions = [...state.decisions.values()]
    .filter((d) => conflicts.some((c) => c.conflict_key === d.conflict_key))
    .sort(compareBy('conflict_key'));

  const snapshot = {
    schema_version: 2,
    published_at: publishedAt,
    as_of: at,
    species: ALL_SPECIES.map((s) => s.code),
    genes,
    groups,
    links,
    conflicts,
    decisions,
  };
  return { snapshot, hash: contentHash(snapshot) };
}

/* ---------------- 版本差异 ---------------- */

export function diffSnapshots(fromSnapshot, toSnapshot, { from_version = null, to_version = null } = {}) {
  // 基因按“物种::稳定标识”聚合各修订事实的别名集合：同键新修订带来的别名变化应被识别为变更，
  // 而不是淹没在事实新增里。
  const aliasIndex = (snap) => {
    const byKey = new Map();
    for (const g of snap.genes) {
      const set = byKey.get(g.key) ?? new Set();
      for (const a of g.aliases) set.add(`${a.name}[${a.effective_from},${a.effective_to ?? ''})`);
      byKey.set(g.key, set);
    }
    return byKey;
  };
  const oldAliases = aliasIndex(fromSnapshot);
  const newAliases = aliasIndex(toSnapshot);
  const addedGeneKeys = [];
  const removedGeneKeys = [];
  const changedAliases = [];
  const changedKeys = new Set();

  for (const [key, set] of newAliases) {
    if (!oldAliases.has(key)) {
      addedGeneKeys.push(key);
      changedKeys.add(key);
    } else {
      const added = [...set].filter((x) => !oldAliases.get(key).has(x));
      const removed = [...oldAliases.get(key)].filter((x) => !set.has(x));
      if (added.length || removed.length) {
        changedAliases.push({ gene_key: key, added: added.sort(), removed: removed.sort() });
        changedKeys.add(key);
      }
    }
  }
  for (const key of oldAliases.keys()) {
    if (!newAliases.has(key)) {
      removedGeneKeys.push(key);
      changedKeys.add(key);
    }
  }

  const groupIndex = (snap) => new Map(snap.groups.map((g) => [g.fact_id, g]));
  const ga = groupIndex(fromSnapshot);
  const gb = groupIndex(toSnapshot);
  const addedGroups = [];
  const removedGroups = [];
  const membershipChanged = [];
  for (const [id, g] of gb) {
    if (!ga.has(id)) {
      addedGroups.push(id);
      g.members.forEach((m) => changedKeys.add(m));
    } else {
      const old = ga.get(id);
      const add = g.members.filter((m) => !old.members.includes(m));
      const rem = old.members.filter((m) => !g.members.includes(m));
      if (add.length || rem.length || canonicalize(old.range) !== canonicalize(g.range)) {
        membershipChanged.push({ fact_id: id, group_id: g.group_id, added: add, removed: rem });
        [...add, ...rem].forEach((m) => changedKeys.add(m));
      }
    }
  }
  for (const [id, g] of ga) {
    if (!gb.has(id)) {
      removedGroups.push(id);
      g.members.forEach((m) => changedKeys.add(m));
    }
  }

  const la = new Set(fromSnapshot.links.map((l) => l.fact_id));
  const lb = new Set(toSnapshot.links.map((l) => l.fact_id));
  const addedLinks = [...lb].filter((x) => !la.has(x)).sort();
  const removedLinks = [...la].filter((x) => !lb.has(x)).sort();

  return {
    from_version,
    to_version,
    added_genes: addedGeneKeys.sort(),
    removed_genes: removedGeneKeys.sort(),
    changed_aliases: changedAliases.sort(compareBy('gene_key')),
    added_groups: addedGroups.sort(),
    removed_groups: removedGroups.sort(),
    membership_changed: membershipChanged.sort(compareBy('fact_id')),
    added_links: addedLinks,
    removed_links: removedLinks,
    conflict_keys_added: toSnapshot.conflicts
      .map((c) => c.conflict_key)
      .filter((k) => !fromSnapshot.conflicts.some((c) => c.conflict_key === k))
      .sort(),
    conflict_keys_resolved: toSnapshot.decisions
      .map((d) => d.conflict_key)
      .filter((k) => !fromSnapshot.decisions.some((d) => d.conflict_key === k))
      .sort(),
    changed_gene_keys: [...changedKeys].sort(),
  };
}
