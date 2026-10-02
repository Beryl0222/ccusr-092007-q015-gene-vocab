import test from 'node:test';
import assert from 'node:assert/strict';
import { GeneVocabService } from '../src/service.js';
import { makeService, makePublishedService, makeClock, registerCatalog, importCore, approveAll, ADMIN } from './helpers.js';

const PANEL = ['9606', '10090', '400682'];

function lockOn(service, overrides = {}) {
  return service.createTrainingLock({
    experiment_id: 'exp-1',
    version_id: 'v1',
    query: ['OG0001'],
    species_panel: PANEL,
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: ADMIN,
    ...overrides,
  });
}

test('训练锁固定词表与缺失策略，输入可逐 token 复现', () => {
  const { service } = makePublishedService();
  const lock = lockOn(service);
  const first = service.buildInput(lock.lock_id);
  const second = service.buildInput(lock.lock_id);
  assert.deepEqual(second.tokens, first.tokens);
  assert.equal(second.manifest_hash, first.manifest_hash);
  assert.deepEqual(first.tokens, [
    'GV:OG0001:ENSMUSG00000017146',
    'GV:OG0001:AQU_0001',
    'GV:OG0001:ENSG00000012048',
  ]);
  // 清单里冻结了版本、面板、策略与排除集
  assert.equal(lock.manifest.version_id, 'v1');
  assert.deepEqual(lock.manifest.excluded_relation_ids, []);
});

test('缺失处理策略：placeholder 占位 / skip 省略 / error 拒绝', () => {
  const { service } = makePublishedService();
  // 面板加入一个没有成员的公开物种？用查询 SINGLE:DEEP_0001 组（仅深海海绵）代替
  const singleton = service.getVersion('v1', ADMIN).entries['SINGLE:DEEP_0001'];
  assert.ok(singleton);

  const placeholder = lockOn(service, {
    experiment_id: 'exp-ph',
    query: ['SINGLE:DEEP_0001'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
  });
  const built = service.buildInput(placeholder.lock_id);
  assert.deepEqual(built.tokens, [
    'GV:SINGLE:DEEP_0001:MISSING@10090',
    'GV:SINGLE:DEEP_0001:MISSING@400682',
    'GV:SINGLE:DEEP_0001:MISSING@9606',
  ]);

  const skip = lockOn(service, {
    experiment_id: 'exp-skip',
    query: ['SINGLE:DEEP_0001'],
    missing_policy: { on_missing: 'skip', on_conflict: 'error' },
  });
  const skipped = service.buildInput(skip.lock_id);
  assert.deepEqual(skipped.tokens, []);
  assert.equal(skipped.omitted.length, 3);

  assert.throws(
    () => lockOn(service, {
      experiment_id: 'exp-err',
      query: ['SINGLE:DEEP_0001'],
      missing_policy: { on_missing: 'error', on_conflict: 'error' },
    }),
    (err) => err.code === 'missing-slot',
  );
});

test('未决冲突默认阻断锁定；显式 exclude 策略才允许并记录排除集', () => {
  const { service } = makePublishedService();
  // 制造未决成员冲突：AQU_0001 同时进入 OG_ALT
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-conflict',
    records: [{ kind: 'ortholog_member', group_id: 'OG_ALT', stable_id: 'AQU_0001', valid_from: '2021-01-01', valid_to: null }],
  });
  approveAll(service);
  service.publishVersion({ note: 'v2 含未决冲突' });

  // 默认 error：拒绝悄悄选定
  assert.throws(
    () => lockOn(service, { version_id: 'v2', query: ['OG0001', 'OG_ALT'] }),
    (err) => err.code === 'conflict-open',
  );

  // 显式 exclude：争议关系被排除并冻结在清单里
  const lock = lockOn(service, {
    version_id: 'v2',
    query: ['OG0001', 'OG_ALT'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'exclude' },
  });
  assert.ok(lock.manifest.excluded_relation_ids.length > 0);
  const built = service.buildInput(lock.lock_id);
  // AQU_0001 的争议成员关系被排除 → 海绵槽位占位
  assert.ok(built.tokens.includes('GV:OG0001:MISSING@400682'));
  assert.ok(built.tokens.includes('GV:OG_ALT:MISSING@400682'));

  // 冲突之后被裁定，旧锁重建结果不变（冻结的排除集生效）
  const [conflict] = service.listConflicts({ status: 'open' });
  service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [conflict.relation_refs[0]],
    drop: [conflict.relation_refs[1]],
    rationale: '裁定：AQU_0001 归属 OG0001',
    decided_by: 'expert-1',
  });
  const rebuilt = service.buildInput(lock.lock_id);
  assert.equal(rebuilt.manifest_hash, lock.manifest_hash);
});

test('旁系同源多成员：代表选取规则公开记录，可复现', () => {
  const service = makeService();
  registerCatalog(service);
  importCore(service);
  approveAll(service);
  // 人类第二个旁系同源基因进入 OG0001
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-paralog',
    records: [
      { kind: 'gene', stable_id: 'ENSG00000000001', species: '9606', symbol: 'BRCA1P' },
      { kind: 'ortholog_member', group_id: 'OG0001', stable_id: 'ENSG00000000001', valid_from: '2020-01-01', valid_to: null },
    ],
  });
  approveAll(service);
  service.publishVersion({ note: 'v1' });
  const lock = lockOn(service);
  const built = service.buildInput(lock.lock_id);
  const humanSlot = built.slots.find((s) => s.species === '9606');
  assert.equal(humanSlot.stable_id, 'ENSG00000000001'); // min-stable-id 规则
  assert.equal(humanSlot.note, 'representative=min-stable-id');
  assert.deepEqual(humanSlot.alternatives, ['ENSG00000012048']);
});

test('快照恢复后锁定的输入仍可逐 token 复现', () => {
  const { service } = makePublishedService();
  const lock = lockOn(service);
  const before = service.buildInput(lock.lock_id);

  const restored = GeneVocabService.restore(service.snapshot(), { now: makeClock('2027-01-01T00:00:00.000Z') });
  const after = restored.buildInput(lock.lock_id);
  assert.deepEqual(after.tokens, before.tokens);
  assert.equal(after.manifest_hash, before.manifest_hash);
});

test('锁定引用的版本必须存在，未知同源组被拒绝', () => {
  const { service } = makePublishedService();
  assert.throws(() => lockOn(service, { version_id: 'v99' }), (err) => err.code === 'not-found');
  assert.throws(() => lockOn(service, { query: ['OG_NOPE'] }), (err) => err.code === 'unknown-group');
});
