import { GovernanceError, CODES } from './errors.js';
import { hashOf } from './util.js';
import { validateCandidateRecord } from './validation.js';

/**
 * 分片幂等导入。
 *
 * - 大批映射按 shard_size 切片，逐片处理、逐片记录状态；
 * - candidate_id 由 (batch_id, 分片序号, 片内序号, 记录内容) 哈希派生，
 *   同一批次重放不会产生重复候选（幂等重试）；
 * - 已完成的分片跳过，失败的分片（如来源未注册）可在修复后通过
 *   相同 batch_id 重新导入或 retryBatch 续跑；
 * - 同一 batch_id 提交不同内容视为幂等键误用，直接报错。
 */
export function importBatch(store, clock, { source_id, batch_id, records, shard_size = 100, actor = 'import' }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new GovernanceError(CODES.VALIDATION, '导入记录不能为空');
  }
  const recordsHash = hashOf(records);
  let batch = store.batches.get(batch_id);
  if (batch) {
    if (batch.records_hash !== recordsHash || batch.source_id !== source_id) {
      throw new GovernanceError(CODES.BATCH_MISMATCH, '同一 batch_id 提交了不同的记录内容', { batch_id });
    }
  } else {
    batch = {
      batch_id,
      source_id,
      shard_size,
      records,
      records_hash: recordsHash,
      created_at: clock(),
      shards: [],
    };
    for (let index = 0; index < Math.ceil(records.length / shard_size); index += 1) {
      batch.shards.push({
        shard_id: `${batch_id}/shard-${index}`,
        index,
        status: 'pending',
        error: null,
        candidate_ids: [],
        created: 0,
        duplicates: 0,
        rejected: 0,
      });
    }
    store.batches.set(batch_id, batch);
  }

  const processed = [];
  for (const shard of batch.shards) {
    if (shard.status === 'done') continue;
    processShard(store, clock, batch, shard, actor);
    processed.push(shard);
  }
  store.log({ at: clock(), actor, action: 'import', details: { batch_id, source_id } });
  return reportOf(batch, processed);
}

/** 失败批次的显式重试入口（与重复调用 importBatch 等价，语义更清晰）。 */
export function retryBatch(store, clock, { batch_id, actor = 'import-retry' }) {
  const batch = store.batches.get(batch_id);
  if (!batch) throw new GovernanceError(CODES.NOT_FOUND, `未知批次: ${batch_id}`);
  return importBatch(store, clock, {
    source_id: batch.source_id,
    batch_id: batch.batch_id,
    records: batch.records,
    shard_size: batch.shard_size,
    actor,
  });
}

function processShard(store, clock, batch, shard, actor) {
  // 来源未注册属于可修复的分片级失败：记录错误、保留现场，等待重试。
  if (!store.sources.has(batch.source_id)) {
    shard.status = 'failed';
    shard.error = `未注册的证据来源: ${batch.source_id}`;
    return;
  }
  const start = shard.index * batch.shard_size;
  const slice = batch.records.slice(start, start + batch.shard_size);
  shard.candidate_ids = [];
  shard.created = 0;
  shard.duplicates = 0;
  shard.rejected = 0;
  slice.forEach((record, offset) => {
    const candidateId = `cand_${hashOf({ batch: batch.batch_id, shard: shard.index, offset, record }).slice(0, 24)}`;
    if (store.candidates.has(candidateId)) {
      shard.duplicates += 1;
      return;
    }
    const errors = validateCandidateRecord(store, record);
    const candidate = {
      candidate_id: candidateId,
      batch_id: batch.batch_id,
      shard_id: shard.shard_id,
      source_id: batch.source_id,
      kind: record.kind,
      payload: record.payload ?? record,
      occurred_at: record.occurred_at ?? null,
      status: errors.length > 0 ? 'rejected' : 'validated',
      errors,
      imported_at: clock(),
      reviewed_at: null,
      reviewer: null,
      rationale: null,
    };
    store.candidates.set(candidateId, candidate);
    shard.candidate_ids.push(candidateId);
    shard.created += 1;
    if (errors.length > 0) shard.rejected += 1;
  });
  shard.status = 'done';
  shard.error = null;
  store.log({ at: clock(), actor, action: 'import-shard', details: { shard_id: shard.shard_id, created: shard.created, rejected: shard.rejected } });
}

function reportOf(batch, processed) {
  const sum = (list, key) => list.reduce((n, s) => n + s[key], 0);
  const shardView = (shard) => ({
    shard_id: shard.shard_id,
    status: shard.status,
    error: shard.error,
    created: shard.created,
    duplicates: shard.duplicates,
    rejected: shard.rejected,
  });
  return {
    batch_id: batch.batch_id,
    source_id: batch.source_id,
    shards: batch.shards.map(shardView),
    // 本次调用的处理结果（幂等重放时全为 0）
    totals: {
      processed_shards: processed.length,
      done: processed.filter((s) => s.status === 'done').length,
      failed: processed.filter((s) => s.status === 'failed').length,
      created: sum(processed, 'created'),
      duplicates: sum(processed, 'duplicates'),
      rejected: sum(processed, 'rejected'),
    },
    // 批次累计状态
    batch_totals: {
      shards: batch.shards.length,
      done: batch.shards.filter((s) => s.status === 'done').length,
      failed: batch.shards.filter((s) => s.status === 'failed').length,
      created: sum(batch.shards, 'created'),
      duplicates: sum(batch.shards, 'duplicates'),
      rejected: sum(batch.shards, 'rejected'),
    },
  };
}
