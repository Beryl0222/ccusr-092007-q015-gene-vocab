import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, registerCatalog, coreRecords, orthodbRecords, approveAll } from './helpers.js';

const ALL_RECORDS = () => [...coreRecords(), ...orthodbRecords()];

test('分片导入：大批记录按 shard_size 切片并逐片记录状态', () => {
  const service = makeService();
  registerCatalog(service);
  const report = service.importBatch({ source_id: 'src_ensembl', batch_id: 'b1', records: ALL_RECORDS(), shard_size: 3 });
  assert.equal(report.shards.length, 3); // 7 条记录，每片 3 条
  assert.ok(report.shards.every((s) => s.status === 'done'));
  assert.equal(report.totals.created, 7);
  assert.equal(service.listCandidates().length, 7);
});

test('幂等重试：同一批次重放不产生重复候选', () => {
  const service = makeService();
  registerCatalog(service);
  const first = service.importBatch({ source_id: 'src_ensembl', batch_id: 'b1', records: ALL_RECORDS(), shard_size: 3 });
  const second = service.importBatch({ source_id: 'src_ensembl', batch_id: 'b1', records: ALL_RECORDS(), shard_size: 3 });
  assert.equal(second.totals.created, 0);
  assert.equal(service.listCandidates().length, first.totals.created);
  // 显式 retry 入口同样幂等
  const third = service.retryBatch({ batch_id: 'b1' });
  assert.equal(third.totals.created, 0);
  assert.equal(service.listCandidates().length, 7);
});

test('同一 batch_id 提交不同内容视为幂等键误用', () => {
  const service = makeService();
  registerCatalog(service);
  service.importBatch({ source_id: 'src_ensembl', batch_id: 'b1', records: ALL_RECORDS() });
  assert.throws(
    () => service.importBatch({ source_id: 'src_ensembl', batch_id: 'b1', records: [{ kind: 'gene', stable_id: 'X1', species: '9606', symbol: 'x' }] }),
    (err) => err.code === 'batch-mismatch',
  );
});

test('来源未注册时分片失败，注册后重试续跑成功', () => {
  const service = makeService();
  registerCatalog(service);
  const records = [{ kind: 'gene', stable_id: 'NOVEL1', species: '9606', symbol: 'novel1' }];
  const failed = service.importBatch({ source_id: 'src_newdb', batch_id: 'b-new', records });
  assert.equal(failed.totals.failed, 1);
  assert.equal(service.listCandidates().length, 0);

  service.registerSource({ source_id: 'src_newdb', name: 'NewDB', release: '2026-09' });
  const retried = service.retryBatch({ batch_id: 'b-new' });
  assert.equal(retried.totals.done, 1);
  assert.equal(retried.totals.created, 1);
  assert.equal(service.listCandidates({ status: 'validated' }).length, 1);
});

test('规则校验：未注册物种、未知基因引用、非法区间被驳回并给出原因', () => {
  const service = makeService();
  registerCatalog(service);
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-bad',
    records: [
      { kind: 'gene', stable_id: 'BAD1', species: '000000', symbol: 'x' },
      { kind: 'ortholog_member', group_id: 'OGX', stable_id: 'GHOST1' },
      { kind: 'gene', stable_id: 'BAD2', species: '9606', symbol: 'y', aliases: [{ name: 'A', valid_from: '2025-01-01', valid_to: '2020-01-01' }] },
    ],
  });
  const rejected = service.listCandidates({ status: 'rejected' });
  assert.equal(rejected.length, 3);
  assert.ok(rejected[0].errors.some((e) => e.includes('未注册的物种')));
  assert.ok(rejected[1].errors.some((e) => e.includes('未知基因')));
  assert.ok(rejected[2].errors.some((e) => e.includes('有效区间非法')));
  // 被驳回的候选不能进入复核
  assert.throws(
    () => service.reviewCandidate({ candidate_id: rejected[0].candidate_id, decision: 'approve', reviewer: 'r', rationale: 'x' }),
    (err) => err.code === 'candidate-state',
  );
});

test('循环关系检测：替代链成环在校验期被拦截', () => {
  const service = makeService();
  registerCatalog(service);
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-genes',
    records: [
      { kind: 'gene', stable_id: 'G_A', species: '9606', symbol: 'a' },
      { kind: 'gene', stable_id: 'G_B', species: '9606', symbol: 'b' },
      { kind: 'gene', stable_id: 'G_C', species: '9606', symbol: 'c' },
    ],
  });
  approveAll(service);
  // A -> B -> C 批准通过
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-sup1',
    records: [
      { kind: 'supersedes', from_stable_id: 'G_A', to_stable_id: 'G_B' },
      { kind: 'supersedes', from_stable_id: 'G_B', to_stable_id: 'G_C' },
    ],
  });
  approveAll(service);
  // C -> A 与自环 C -> C 都在校验期被驳回
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-sup2',
    records: [
      { kind: 'supersedes', from_stable_id: 'G_C', to_stable_id: 'G_A' },
      { kind: 'supersedes', from_stable_id: 'G_C', to_stable_id: 'G_C' },
    ],
  });
  const rejected = service.listCandidates({ status: 'rejected' });
  assert.equal(rejected.length, 2);
  assert.ok(rejected[0].errors.some((e) => e.includes('成环')));
  assert.ok(rejected[1].errors.some((e) => e.includes('自环')));
});

test('替代链穿过待批准候选同样被检测（staging 内成环）', () => {
  const service = makeService();
  registerCatalog(service);
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-genes',
    records: [
      { kind: 'gene', stable_id: 'G_A', species: '9606', symbol: 'a' },
      { kind: 'gene', stable_id: 'G_B', species: '9606', symbol: 'b' },
    ],
  });
  approveAll(service);
  // 同一批次内 A->B 与 B->A：第二条校验时应看到第一条（已 validated）
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-sup',
    records: [
      { kind: 'supersedes', from_stable_id: 'G_A', to_stable_id: 'G_B' },
      { kind: 'supersedes', from_stable_id: 'G_B', to_stable_id: 'G_A' },
    ],
  });
  const validated = service.listCandidates({ status: 'validated' });
  const rejected = service.listCandidates({ status: 'rejected' });
  assert.equal(validated.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].errors.some((e) => e.includes('成环')));
});
