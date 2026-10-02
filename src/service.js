/**
 * 基因词表治理服务：事件流之上的用例编排。
 *
 * 设计原则：
 *  - 所有写操作都追加不可变事件，状态靠归约重建（见 state.js）；
 *  - 冲突只记录与报告，专家决定单独留痕，系统永不静默选择；
 *  - 发布快照不可变；训练任务锁定快照哈希，输入确定性生成；
 *  - 撤回只暂停“新的引用”并沿依赖标记，旧快照与旧产物保留。
 */
import { EventStore, nowIso } from './events.js';
import {
  initialState,
  reducer,
  buildSnapshot,
  diffSnapshots,
  computeConflicts,
  geneKey,
} from './state.js';
import { validateRows } from './validation.js';
import { CURRENT_SCHEMA_VERSION } from './contracts.js';
import { toUtcDate } from './time.js';
import { canonicalize, contentHash, sha256Hex } from './canonical.js';

export const MISSING_POLICIES = Object.freeze(['error', 'skip', 'mask_token']);
export const CONFLICT_POLICIES = Object.freeze(['require_decision', 'keep_all', 'fail_locked']);

function badRequest(message, code = 'BAD_REQUEST', extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export class GeneVocabService {
  constructor({ store = new EventStore(), permissions = null, publishOnApprove = false } = {}) {
    this.store = store;
    this.permissions = permissions;
    this.publishOnApprove = publishOnApprove;
  }

  state() {
    return this.store.reduce(reducer, initialState());
  }

  /* ---------------- 证据来源 ---------------- */

  registerSource({ source_id, name, kind = 'database' }, by) {
    const state = this.state();
    if (state.sources.has(source_id)) throw badRequest(`来源已存在：${source_id}`, 'SOURCE_EXISTS');
    this.store.append('SOURCE_REGISTERED', { source_id, name, kind }, { by, dedupeKey: `source:${source_id}` });
    return { source_id, status: 'active' };
  }

  getSource(source_id) {
    return this.state().sources.get(source_id) ?? null;
  }

  /* ---------------- 分片导入（幂等） ---------------- */

  /**
   * 开始一个导入批次。
   * total_shards 与 overall_checksum（全部行规范化拼接后的 sha256）用于最终核对；
   * idempotency_key 保证调用方网络重试不会产生第二个批次。
   */
  startImport({ batch_id, source_id, total_shards, overall_checksum = null, idempotency_key = null }, by) {
    const state = this.state();
    if (idempotency_key) {
      const existing = [...state.batches.values()].find((b) => b.idempotency_key === idempotency_key);
      if (existing) {
        return { batch_id: existing.batch_id, status: existing.status, idempotent_replay: true };
      }
    }
    if (state.batches.has(batch_id)) throw badRequest(`批次已存在：${batch_id}`, 'BATCH_EXISTS');
    const source = state.sources.get(source_id);
    if (!source) throw badRequest(`证据来源未登记：${source_id}`, 'UNKNOWN_SOURCE');
    if (source.status === 'retracted') throw badRequest('证据来源已撤回，不能导入新引用', 'SOURCE_RETRACTED');
    if (!Number.isInteger(total_shards) || total_shards < 1) throw badRequest('total_shards 必须为正整数');

    this.store.append(
      'IMPORT_STARTED',
      { batch_id, source_id, total_shards, overall_checksum, idempotency_key },
      { by, dedupeKey: `import-start:${idempotency_key ?? batch_id}` },
    );
    return { batch_id, status: 'receiving', received_shards: [] };
  }

  /**
   * 上传一个分片。分片可乱序、可重复：
   *  - 同 (batch_id, index) 重传且 rows_hash 一致 → 幂等成功，不重复入库；
   *  - 同 index 重传但内容不同 → 409，调用方必须显式开新批次。
   * rows_hash = sha256(canonicalize(rows))。
   */
  uploadShard({ batch_id, index, rows }, by) {
    const state = this.state();
    const batch = state.batches.get(batch_id);
    if (!batch) throw badRequest(`批次不存在：${batch_id}`, 'UNKNOWN_BATCH');
    if (!Number.isInteger(index) || index < 0 || index >= batch.total_shards) {
      throw badRequest(`分片序号越界：${index}`, 'SHARD_INDEX_OUT_OF_RANGE');
    }
    const rowsHash = sha256Hex(canonicalize(rows));
    // 触及未公开物种的导入必须具备对应项目授权（服务层强约束，HTTP 层之外调用同样生效）。
    if (this.permissions && by) {
      for (const code of touchedSpecies(rows)) this.permissions.requireSpecies(by, code);
    }
    const prior = batch.shards.get(index);
    if (prior) {
      // 汇总后重传也必须幂等：相同内容永远返回 duplicate，不同内容永远拒绝，绝不覆盖。
      if (prior.rows_hash !== rowsHash) {
        throw badRequest(`分片 ${index} 曾以不同内容上传（${prior.rows_hash}）`, 'SHARD_CONFLICT');
      }
      return { batch_id, index, status: 'duplicate', received: [...batch.shards.keys()].sort() };
    }
    if (batch.status !== 'receiving') {
      throw badRequest(`批次 ${batch_id} 已结束接收（${batch.status}）`, 'BATCH_CLOSED');
    }

    this.store.append(
      'SHARD_RECEIVED',
      { batch_id, index, rows, rows_hash: rowsHash, row_count: rows.length },
      { by, dedupeKey: `shard:${batch_id}:${index}` },
    );
    const after = this.state().batches.get(batch_id);
    return {
      batch_id,
      index,
      status: 'accepted',
      row_count: rows.length,
      rows_hash: rowsHash,
      received: [...after.shards.keys()].sort(),
      remaining: batch.total_shards - after.shards.size,
    };
  }

  /** 全部分片到齐后核对并运行规则校验。可安全重试。 */
  completeImport(batch_id, by) {
    const state = this.state();
    const batch = state.batches.get(batch_id);
    if (!batch) throw badRequest(`批次不存在：${batch_id}`, 'UNKNOWN_BATCH');
    if (batch.status === 'rejected' || batch.status === 'validated' || batch.status === 'approved') {
      return { batch_id, status: batch.status, validation: batch.validation ?? null, idempotent_replay: true };
    }
    if (batch.shards.size !== batch.total_shards) {
      throw badRequest(
        `分片不齐：已收 ${batch.shards.size}/${batch.total_shards}`,
        'SHARDS_INCOMPLETE',
        { missing: shardIndexes(batch) },
      );
    }
    // 最终校验和：按分片序号排序后逐片哈希拼接。
    const ordered = [...batch.shards.values()].sort((a, b) => a.index - b.index);
    const combined = sha256Hex(ordered.map((s) => s.rows_hash).join(''));
    if (batch.overall_checksum && batch.overall_checksum !== combined) {
      throw badRequest('整批校验和不一致，拒绝汇总', 'CHECKSUM_MISMATCH', { expected: batch.overall_checksum, actual: combined });
    }

    this.store.append('IMPORT_COMPLETED', { batch_id, checksum: combined }, { by, dedupeKey: `import-complete:${batch_id}` });

    const fresh = this.state();
    const currentBatch = fresh.batches.get(batch_id);
    const { errors, warnings } = validateRows(currentBatch.rows, {
      sources: new Set([...fresh.sources.values()].filter((s) => s.status === 'active').map((s) => s.source_id)),
      sourceActive: fresh.sources.get(batch.source_id)?.status === 'active',
      sourceId: batch.source_id,
      genes: fresh.genes,
      groups: fresh.groups,
      links: fresh.links.filter((l) => !l.retracted),
      batchGenes: currentBatch.rows.filter((r) => r.kind === 'gene'),
    });
    this.store.append('VALIDATION_RUN', { batch_id, errors, warnings }, { by, dedupeKey: `validation:${batch_id}:${combined}` });
    const done = this.state().batches.get(batch_id);
    return { batch_id, status: done.status, checksum: combined, errors, warnings, total_rows: currentBatch.rows.length };
  }

  getBatch(batch_id) {
    const batch = this.state().batches.get(batch_id);
    if (!batch) return null;
    return {
      batch_id: batch.batch_id,
      source_id: batch.source_id,
      status: batch.status,
      total_shards: batch.total_shards,
      received_shards: [...batch.shards.keys()].sort(),
      total_rows: batch.rows.length,
      validation: batch.validation ?? null,
      reviewed_by: batch.reviewed_by ?? null,
      review_note: batch.review_note ?? null,
      reject_reason: batch.reject_reason ?? null,
    };
  }

  /* ---------------- 专家复核 ---------------- */

  /**
   * 批准批次。有校验错误的批次不可批准；存在警告时必须逐条确认全部警告 ID，
   * 且必须给出理由。批准不会消解任何冲突——冲突在发布快照中并列保留。
   */
  approveBatch({ batch_id, note, acknowledged_warning_ids = [] }, by) {
    const state = this.state();
    const batch = state.batches.get(batch_id);
    if (!batch) throw badRequest(`批次不存在：${batch_id}`, 'UNKNOWN_BATCH');
    if (!['validated', 'rejected'].includes(batch.status) && batch.status !== 'approved') {
      throw badRequest(`批次 ${batch_id} 尚不可批准（${batch.status}）`, 'BATCH_NOT_REVIEWABLE');
    }
    if (batch.status === 'approved') {
      return { batch_id, status: 'approved', idempotent_replay: true };
    }
    if (!note || !note.trim()) throw badRequest('批准必须填写复核理由', 'NOTE_REQUIRED');
    // 复核人必须能看到批次触及的全部未公开物种，否则无权批准。
    this.requireSpeciesForRows(by, batch.rows);
    const errors = batch.validation?.errors ?? [];
    if (errors.length > 0) throw badRequest('存在阻断性校验错误，不能批准', 'ERRORS_PRESENT', { errors });
    const warnings = batch.validation?.warnings ?? [];
    const warningIds = new Set(warnings.map((w) => w.id));
    const ack = new Set(acknowledged_warning_ids);
    const unknown = [...ack].filter((id) => !warningIds.has(id));
    if (unknown.length) throw badRequest(`确认了不存在的警告：${unknown.join(', ')}`, 'UNKNOWN_WARNING');
    const missing = warnings.filter((w) => !ack.has(w.id)).map((w) => w.id);
    if (missing.length) {
      throw badRequest(`必须逐条确认全部警告后才能批准，缺少：${missing.join(', ')}`, 'WARNINGS_UNACKNOWLEDGED', { missing });
    }

    this.store.append(
      'BATCH_APPROVED',
      { batch_id, note, acknowledged_warning_ids: [...ack].sort() },
      { by, dedupeKey: `approve:${batch_id}` },
    );
    let released = null;
    if (this.publishOnApprove) released = this.publish({ label: `auto:${batch_id}` }, by, { dedupe: `auto-release:${batch_id}` });
    return { batch_id, status: 'approved', released };
  }

  rejectBatch({ batch_id, reason }, by) {
    const state = this.state();
    const batch = state.batches.get(batch_id);
    if (!batch) throw badRequest(`批次不存在：${batch_id}`, 'UNKNOWN_BATCH');
    if (batch.status === 'approved') throw badRequest('已批准批次不能驳回，请用新版本修订', 'BATCH_APPROVED');
    if (!reason || !reason.trim()) throw badRequest('驳回必须填写原因', 'NOTE_REQUIRED');
    this.store.append('BATCH_REJECTED', { batch_id, reason }, { by, dedupeKey: `reject:${batch_id}` });
    return { batch_id, status: 'rejected' };
  }

  /** 待专家处理的复核队列与冲突清单；user 给出时按项目授权脱敏未公开物种。 */
  reviewQueue({ user = null } = {}) {
    const state = this.state();
    const pendingBatches = [...state.batches.values()]
      .filter((b) => b.status === 'validated')
      .map((b) => ({
        batch_id: b.batch_id,
        source_id: b.source_id,
        warnings: b.validation.warnings,
        error_count: b.validation.errors.length,
      }));
    const asOf = toUtcDate(nowIso());
    const visible = (key) => !user || !this.permissions || this.permissions.canReadSpecies(user, key.split('::')[0]);
    const redactCandidate = (cand) =>
      visible(cand.gene_key)
        ? cand
        : { ...cand, gene_key: `${cand.gene_key.split('::')[0]}::***`, access: 'restricted_hidden' };
    const conflicts = computeConflicts(state, asOf);
    const decisions = state.decisions;
    return {
      as_of: asOf,
      pending_batches: pendingBatches,
      conflicts: conflicts.map((c) => ({
        ...c,
        candidates: c.candidates.map(redactCandidate),
        decision: decisions.get(c.conflict_key)
          ? {
              ...decisions.get(c.conflict_key),
              chosen_gene_key: visible(decisions.get(c.conflict_key).chosen_gene_key ?? '')
                ? decisions.get(c.conflict_key).chosen_gene_key
                : `${decisions.get(c.conflict_key).chosen_gene_key.split('::')[0]}::***`,
            }
          : null,
      })),
    };
  }

  /**
   * 记录冲突选择决定。冲突候选仍然并存，这里只追加“选择依据”：
   * 同一决定键重复决议会保留完整历史（revision 隐式由事件序给出）。
   */
  resolveConflict({ conflict_key, chosen_fact_id, chosen_gene_key = null, rationale }, by) {
    if (!rationale || !rationale.trim()) throw badRequest('冲突决定必须给出依据', 'NOTE_REQUIRED');
    const state = this.state();
    const conflict = computeConflicts(state, toUtcDate(nowIso())).find((c) => c.conflict_key === conflict_key);
    if (!conflict) throw badRequest(`冲突不存在或当前已不成立：${conflict_key}`, 'UNKNOWN_CONFLICT');
    const candidate = conflict.candidates.find(
      (c) => c.fact_id === chosen_fact_id && (chosen_gene_key == null || c.gene_key === chosen_gene_key),
    );
    if (!candidate) {
      throw badRequest('所选事实/基因不在该冲突候选中', 'CHOSEN_NOT_CANDIDATE');
    }
    // 决定涉及未公开物种时，专家必须持有项目授权（不允许盲选被脱敏的候选）。
    if (this.permissions && by) {
      for (const cand of conflict.candidates) this.permissions.requireSpecies(by, cand.gene_key.split('::')[0]);
    }
    const before = state.decisions.get(conflict_key);
    this.store.append(
      'CONFLICT_RESOLVED',
      {
        conflict_key,
        chosen_fact_id,
        chosen_gene_key: chosen_gene_key ?? candidate.gene_key ?? null,
        rationale,
        supersedes: before?.at ?? null,
      },
      { by },
    );
    return { conflict_key, chosen_fact_id, chosen_gene_key: chosen_gene_key ?? candidate.gene_key ?? null, superseded: before ?? null };
  }

  /* ---------------- 发布 ---------------- */

  listReleases() {
    return this.state().releases.map((r) => ({
      version: r.version,
      label: r.label,
      published_at: r.published_at,
      hash: r.hash,
      unresolved_conflicts: r.snapshot.conflicts.filter((c) => !r.snapshot.decisions.some((d) => d.conflict_key === c.conflict_key)).length,
    }));
  }

  getRelease(version) {
    return this.state().releases.find((r) => String(r.version) === String(version)) ?? null;
  }

  publish({ label = null } = {}, by, { dedupe = null, asOf = toUtcDate(nowIso()) } = {}) {
    const state = this.state();
    const at = new Date(nowIso()).toISOString();
    const { snapshot, hash } = buildSnapshot(state, { at: asOf, publishedAt: at });
    const prior = state.releases[state.releases.length - 1];
    if (prior && prior.hash === hash) {
      return { version: prior.version, hash, unchanged: true };
    }
    const version = (prior?.version ?? 0) + 1;
    this.store.append(
      'RELEASE_PUBLISHED',
      { version, label, at, snapshot, hash },
      { by, dedupeKey: dedupe ?? `release:${hash}` },
    );
    this.flagImpactedJobs(prior, snapshot, version);
    return { version, hash, label };
  }

  diff(fromVersion, toVersion) {
    const state = this.state();
    const a = this.requireRelease(state, fromVersion).snapshot;
    const b = this.requireRelease(state, toVersion).snapshot;
    return diffSnapshots(a, b, { from_version: Number(fromVersion), to_version: Number(toVersion) });
  }

  requireSpeciesForRows(user, rows) {
    if (!this.permissions || !user) return;
    for (const code of touchedSpecies(rows)) this.permissions.requireSpecies(user, code);
  }

  requireRelease(state, version) {
    const release = state.releases.find((r) => String(r.version) === String(version));
    if (!release) throw badRequest(`版本不存在：${version}`, 'UNKNOWN_RELEASE');
    return release;
  }

  /* ---------------- 训练锁定与确定性输入 ---------------- */

  /**
   * 训练作业启动：锁定词表版本（按哈希）、缺失处理与冲突处理策略、as_of 日期。
   * 之后发布新版本不会改变该作业读到的任何字节。
   */
  lockTraining({
    job_id,
    experiment = null,
    version,
    missing_policy = 'error',
    conflict_policy = 'require_decision',
    as_of = null,
  }, by) {
    if (!MISSING_POLICIES.includes(missing_policy)) throw badRequest(`未知缺失策略：${missing_policy}`);
    if (!CONFLICT_POLICIES.includes(conflict_policy)) throw badRequest(`未知冲突策略：${conflict_policy}`);
    const state = this.state();
    if (state.jobs.has(job_id)) throw badRequest(`作业已锁定：${job_id}`, 'JOB_EXISTS');
    const release = this.requireRelease(state, version);
    // 锁定即把词表固化进训练输入：对版本中任何未公开物种都必须有项目授权。
    if (this.permissions && by) {
      for (const species of new Set(release.snapshot.genes.map((g) => g.species_code))) {
        this.permissions.requireSpecies(by, species);
      }
    }
    if (as_of != null && !/^\d{4}-\d{2}-\d{2}$/.test(as_of)) {
      throw badRequest('as_of 必须是 YYYY-MM-DD 日期');
    }
    const effectiveAsOf = as_of ?? release.snapshot.as_of;

    // require_decision：仍有未决冲突时拒绝锁定，强迫先留痕选择；fail_locked 同理但措辞区分。
    const unresolved = release.snapshot.conflicts.filter(
      (c) => !release.snapshot.decisions.some((d) => d.conflict_key === c.conflict_key),
    );
    if (unresolved.length && (conflict_policy === 'require_decision' || conflict_policy === 'fail_locked')) {
      throw badRequest(
        `版本 v${version} 存在 ${unresolved.length} 个未决冲突，需专家决定或改用 keep_all 策略`,
        'UNRESOLVED_CONFLICTS',
        { conflicts: unresolved.map((c) => c.conflict_key) },
      );
    }

    this.store.append(
      'TRAINING_LOCKED',
      {
        job_id,
        experiment,
        version: release.version,
        vocab_hash: release.hash,
        missing_policy,
        conflict_policy,
        as_of: effectiveAsOf,
      },
      { by, dedupeKey: `lock:${job_id}` },
    );
    return this.getJob(job_id);
  }

  /**
   * 在锁定词表上确定性地生成模型输入。
   * slots 按 group_id/key 排序固定；相同锁、相同声明基因集合 → 逐字节一致。
   * declaredGenes: [{species_code, stable_id}] 作业实际需要的位置。
   */
  generateInput(job_id, declaredGenes = []) {
    const state = this.state();
    const job = state.jobs.get(job_id);
    if (!job) throw badRequest(`作业不存在：${job_id}`, 'UNKNOWN_JOB');
    const release = this.requireRelease(state, job.version);
    if (release.hash !== job.vocab_hash) throw badRequest('词表哈希与锁定不一致', 'HASH_DRIFT');
    const snap = release.snapshot;

    const decisions = new Map(snap.decisions.map((d) => [d.conflict_key, d]));
    const geneByKey = new Map();
    for (const gene of snap.genes) geneByKey.set(gene.key, gene);

    const missing = [];
    const positions = declaredGenes.map((g) => {
      const key = geneKey(g.species_code, g.stable_id);
      const gene = geneByKey.get(key);
      if (!gene) {
        missing.push({ position: key, reason: 'not_in_vocab' });
        // skip 与 mask_token 都保留位置（保证槽位对齐），只改变状态与占位值。
        if (job.missing_policy === 'mask_token') return { key, status: 'masked', placeholder: '<mask>' };
        return { key, status: 'missing' };
      }
      // 找到该基因参与的、在 as_of 有效的组。
      const groups = snap.groups
        .filter((grp) => grp.members.includes(key))
        .map((grp) => grp.group_id)
        .sort();
      return { key, status: 'resolved', fact_id: gene.fact_id, groups };
    });

    if (job.missing_policy === 'error' && missing.length) {
      throw badRequest(`有 ${missing.length} 个声明基因不在锁定词表中`, 'MISSING_GENES', { missing });
    }
    // 位置按基因键排序：相同声明集合以不同顺序提交也产出完全一致的字节。
    positions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // 统一槽位：每个同源组一槽；按 group_id 排序。无组基因单独成槽，保证可追踪。
    const groupSlots = [...new Set(snap.groups.map((g) => g.group_id))].sort().map((groupId) => {
      const facts = snap.groups.filter((g) => g.group_id === groupId);
      const members = new Set(facts.flatMap((f) => f.members));
      const perSpecies = {};
      for (const key of [...members].sort()) {
        const species = key.split('::')[0];
        (perSpecies[species] ??= []).push(key);
      }
      const chosen = {};
      const pendingConflicts = [];
      for (const [species, keys] of Object.entries(perSpecies)) {
        if (keys.length === 1) {
          chosen[species] = keys[0];
        } else {
          const conflictKey = `membership:${groupId}:${species}`;
          const decision = decisions.get(conflictKey);
          if (decision?.chosen_gene_key && keys.includes(decision.chosen_gene_key)) {
            chosen[species] = decision.chosen_gene_key;
          } else {
            // 未决冲突：keep_all 下全部并列保留；否则槽位留空并显式列出待决键。
            if (job.conflict_policy === 'keep_all') chosen[species] = keys;
            pendingConflicts.push(conflictKey);
          }
        }
      }
      return { slot: `group:${groupId}`, chosen, pending_conflicts: pendingConflicts };
    });

    // 注意：job_id 不进入哈希内容——同一词表、同一策略下，不同作业的模型输入必须逐字节一致；
    // 作业归属作为外层包封保留，便于审计。
    const document = {
      schema_version: CURRENT_SCHEMA_VERSION,
      vocab_version: release.version,
      vocab_hash: release.hash,
      as_of: job.as_of,
      missing_policy: job.missing_policy,
      conflict_policy: job.conflict_policy,
      species_order: snap.species,
      positions,
      slots: groupSlots,
    };
    const inputText = canonicalize(document);
    const inputHash = sha256Hex(inputText);

    // 记录该输入实际引用了哪些基因键，供新版本到达时精确标出受影响实验。
    const usedKeys = new Set();
    for (const pos of positions) if (pos.status === 'resolved') usedKeys.add(pos.key);
    for (const slot of groupSlots) {
      for (const value of Object.values(slot.chosen)) {
        Array.isArray(value) ? value.forEach((k) => usedKeys.add(k)) : usedKeys.add(value);
      }
    }

    this.store.append(
      'INPUT_REGENERATED',
      { job_id, input_hash: inputHash, used_keys: [...usedKeys].sort() },
      { dedupeKey: `input:${job_id}:${inputHash}` },
    );
    return { input: document, input_text: inputText, input_hash: inputHash, missing };
  }

  getJob(job_id) {
    const state = this.state();
    const job = state.jobs.get(job_id);
    if (!job) return null;
    return {
      job_id: job.job_id,
      experiment: job.experiment,
      version: job.version,
      vocab_hash: job.vocab_hash,
      missing_policy: job.missing_policy,
      conflict_policy: job.conflict_policy,
      as_of: job.as_of,
      input_hash: job.input_hash,
      status: job.status,
      impacts: job.impacts,
    };
  }

  /* ---------------- 谱系溯源 ---------------- */

  /**
   * 从模型中的一个位置（槽或物种基因键）追到各物种原始标识与选择依据。
   */
  trace({ slot = null, gene_key = null }, { user = null } = {}) {
    const state = this.state();
    const release = state.releases[state.releases.length - 1];
    if (!release) throw badRequest('尚无已发布词表', 'NO_RELEASE');
    const snap = release.snapshot;

    const visible = (key) => {
      if (!user || !this.permissions) return true;
      return this.permissions.canReadSpecies(user, key.split('::')[0]);
    };

    if (gene_key) {
      const gene = snap.genes.find((g) => g.key === gene_key);
      if (!gene) throw badRequest(`基因不在当前词表：${gene_key}`, 'UNKNOWN_GENE');
      if (!visible(gene.key)) {
        const err = new Error(`无权访问物种 ${gene.species_code} 的未公开数据`);
        err.code = 'FORBIDDEN_SPECIES';
        err.speciesCode = gene.species_code;
        throw err;
      }
      return this.traceGene(snap, state, gene, visible);
    }
    if (slot) {
      const groupId = slot.startsWith('group:') ? slot.slice('group:'.length) : slot;
      const facts = snap.groups.filter((g) => g.group_id === groupId);
      if (!facts.length) throw badRequest(`槽位不存在：${slot}`, 'UNKNOWN_SLOT');
      const memberKeys = new Set(facts.flatMap((f) => f.members));
      const perSpecies = {};
      const evidence = [];
      for (const key of memberKeys) {
        const gene = snap.genes.find((g) => g.key === key);
        if (!gene) continue;
        if (!visible(key)) {
          (perSpecies[key.split('::')[0]] ??= []).push({
            key: `${key.split('::')[0]}::***`,
            access: 'restricted_hidden',
          });
          continue;
        }
        (perSpecies[key.split('::')[0]] ??= []).push(this.traceGene(snap, state, gene, visible));
        evidence.push(...this.factEvidence(state, gene.fact_id));
      }
      const conflicts = snap.conflicts
        .filter((c) => c.conflict_key.startsWith(`membership:${groupId}:`))
        .map((c) => ({
          ...c,
          // 无权限物种的候选只提示存在，不泄漏稳定标识。
          candidates: c.candidates.map((cand) =>
            visible(cand.gene_key) ? cand : { fact_id: cand.fact_id, gene_key: `${cand.gene_key.split('::')[0]}::***`, source_id: cand.source_id, access: 'restricted_hidden' },
          ),
        }));
      // 组事实自身的证据（同源关系依据哪个来源/批次/记录）。
      const groupEvidence = facts.flatMap((f) => this.factEvidence(state, f.fact_id));
      return {
        slot,
        group_id: groupId,
        vocab_version: release.version,
        by_species: perSpecies,
        group_evidence: dedupeById([...groupEvidence, ...evidence]),
        conflicts,
        decisions: conflicts.map((c) => snap.decisions.find((d) => d.conflict_key === c.conflict_key) ?? null).filter(Boolean),
      };
    }
    throw badRequest('trace 需要 slot 或 gene_key', 'BAD_REQUEST');
  }

  traceGene(snap, state, gene, visible) {
    const groups = snap.groups.filter((g) => g.members.includes(gene.key)).map((g) => g.group_id).sort();
    const source = state.sources.get(gene.source_id);
    return {
      key: gene.key,
      access: 'visible',
      species_code: gene.species_code,
      stable_id: gene.stable_id,
      aliases: gene.aliases,
      groups,
      fact_id: gene.fact_id,
      revision: gene.revision,
      evidence: gene.evidence,
      source: source ? { source_id: source.source_id, name: source.name, status: source.status } : null,
    };
  }

  factEvidence(state, factId) {
    const out = [];
    for (const batch of state.batches.values()) {
      const row = batch.rows.find((r) => `${batch.batch_id}#${r.record_id}` === factId);
      if (row) out.push({ fact_id: factId, source_id: batch.source_id, batch_id: batch.batch_id, record_id: row.record_id, evidence: row.evidence ?? null });
    }
    return out;
  }

  /* ---------------- 来源撤回与级联 ---------------- */

  /**
   * 撤回证据来源：标记其全部事实为不可再引用（从后续发布快照排除），
   * 但旧快照/旧输入/旧产物原样保留；同时沿依赖（组→锁定作业）暂停新引用并标记受影响实验。
   */
  retractSource({ source_id, reason }, by) {
    const state = this.state();
    const source = state.sources.get(source_id);
    if (!source) throw badRequest(`来源不存在：${source_id}`, 'UNKNOWN_SOURCE');
    if (source.status === 'retracted') return { source_id, status: 'retracted', idempotent_replay: true };
    if (!reason || !reason.trim()) throw badRequest('撤回必须填写原因', 'NOTE_REQUIRED');

    const at = new Date(nowIso()).toISOString();
    this.store.append('SOURCE_RETRACTED', { source_id, reason, at }, { by, dedupeKey: `retract:${source_id}:${at}` });

    const after = this.state();
    const factIds = [
      ...[...after.genes.values()].flatMap((e) => e.facts.filter((f) => f.source_id === source_id).map((f) => f.fact_id)),
      ...[...after.groups.values()].flatMap((g) => g.facts.filter((f) => f.source_id === source_id).map((f) => f.fact_id)),
      ...after.links.filter((l) => l.source_id === source_id).map((l) => l.fact_id),
    ];
    this.store.append('RETRACTION_CASCADE', { source_id, reason, at, fact_ids: factIds.sort() }, { by });

    // 立即发布一个不含该来源事实的新版本，使新引用被暂停；旧版本仍可读。
    let released = null;
    try {
      released = this.publish({ label: `retract:${source_id}` }, by, { dedupe: `release-retract:${source_id}:${at}` });
    } catch {
      released = { unchanged: true };
    }
    return { source_id, retracted_facts: factIds.length, fact_ids: factIds, released };
  }

  /* ---------------- 影响标记 ---------------- */

  flagImpactedJobs(priorRelease, newSnapshot, newVersion) {
    if (!priorRelease) return;
    const diff = diffSnapshots(priorRelease.snapshot, newSnapshot, {
      from_version: priorRelease.version,
      to_version: newVersion,
    });
    if (!diff.changed_gene_keys.length) return;
    const state = this.state();
    const changed = new Set(diff.changed_gene_keys);
    const impacted = [...state.jobs.values()]
      .filter((job) => (job.used_keys ?? []).some((key) => changed.has(key)))
      .map((job) => job.job_id);
    // 只标记受影响实验；旧产物不删除、不改动，作业仍锁定在旧版本哈希上。
    if (impacted.length) {
      this.store.append(
        'IMPACT_FLAGS',
        {
          reason: `新版本 v${newVersion} 发布`,
          scope: 'locked_jobs',
          from_version: priorRelease.version,
          to_version: newVersion,
          changed_keys: diff.changed_gene_keys,
          job_ids: impacted,
        },
        {},
      );
    }
  }
}

function shardIndexes(batch) {
  const all = new Set(Array.from({ length: batch.total_shards }, (_, i) => i));
  for (const i of batch.shards.keys()) all.delete(i);
  return [...all].sort();
}

/** 收集分片行触及的全部物种代码（基因、组成员、关系端点）。 */
function touchedSpecies(rows) {
  const codes = new Set();
  for (const row of rows) {
    if (row.species_code) codes.add(row.species_code);
    for (const m of row.members ?? []) if (m?.species_code) codes.add(m.species_code);
    for (const end of [row.from, row.to]) if (end?.species_code) codes.add(end.species_code);
  }
  return codes;
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((x) => (seen.has(x.fact_id) ? false : seen.add(x.fact_id)));
}
