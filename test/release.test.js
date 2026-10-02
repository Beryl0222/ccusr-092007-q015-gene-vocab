import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, registerCatalog, importCore, approveAll, makePublishedService, ADMIN } from './helpers.js';

test('发布生成不可变版本：条目、基因目录、来源快照齐全且冻结', () => {
  const { service, version } = makePublishedService();
  assert.equal(version.version_id, 'v1');
  assert.equal(version.parent, null);
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.entries.OG0001));
  // OG0001 三个公开成员 + 深海海绵单例条目
  assert.equal(version.entries.OG0001.members.length, 3);
  assert.ok(version.entries['SINGLE:DEEP_0001']);
  assert.equal(version.source_releases.src_ensembl, '112');
  assert.deepEqual(version.species_catalog, ['10090', '400682', '9606', '999001']);
  // 冻结对象不可改写（ESM 严格模式下赋值抛 TypeError）
  assert.throws(() => { version.entries.OG0001.members = []; }, TypeError);
  // 服务内版本与返回值一致，可重复读取
  assert.equal(service.getVersion('v1', ADMIN).hash, version.hash);
});

test('差异查询：数据库修订产生新版本，diff 给出增删改', () => {
  const { service } = makePublishedService();
  // 新数据库发布：小鼠基因改入 OG0002，新增一个海绵基因
  service.registerSource({ source_id: 'src_ensembl2', name: 'Ensembl', release: '113' });
  service.importBatch({
    source_id: 'src_ensembl2',
    batch_id: 'b-rev',
    records: [
      { kind: 'gene', stable_id: 'AQU_0002', species: '400682', symbol: 'brca2-like' },
      { kind: 'ortholog_member', group_id: 'OG0002', stable_id: 'ENSMUSG00000017146', valid_from: '2026-01-01', valid_to: null },
      { kind: 'ortholog_member', group_id: 'OG0001', stable_id: 'AQU_0002', valid_from: '2026-01-01', valid_to: null },
    ],
  });
  approveAll(service);
  // 小鼠基因的第二次成员关系与 OG0001 冲突 → 裁定保留新组
  const [conflict] = service.listConflicts({ status: 'open' });
  service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG0002')],
    drop: [conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG0001')],
    rationale: 'Ensembl 113 修订：小鼠 Brca1 归入 OG0002',
    decided_by: 'expert-1',
  });
  const v2 = service.publishVersion({ note: 'Ensembl 113 修订' });
  assert.equal(v2.parent, 'v1');

  const diff = service.diffVersions('v1', 'v2', ADMIN);
  assert.deepEqual(diff.added, ['OG0002']);
  assert.equal(diff.removed.length, 0);
  const og1 = diff.changed.find((c) => c.group_id === 'OG0001');
  assert.deepEqual(og1.removed_members, ['ENSMUSG00000017146']);
  assert.deepEqual(og1.added_members, ['AQU_0002']);
  assert.ok(diff.genes_added.includes('AQU_0002'));
  assert.equal(diff.summary.entries_changed, 1);

  // 反向 diff 同样可查
  const back = service.diffVersions('v2', 'v1', ADMIN);
  assert.deepEqual(back.removed, ['OG0002']);
});

test('旧版本不受新版本影响：v1 内容逐字节不变', () => {
  const { service, version: v1 } = makePublishedService();
  const hashBefore = v1.hash;
  service.registerSource({ source_id: 'src_new', name: 'NewDB', release: '1' });
  service.importBatch({
    source_id: 'src_new',
    batch_id: 'b-more',
    records: [{ kind: 'gene', stable_id: 'EXTRA1', species: '9606', symbol: 'extra1' }],
  });
  approveAll(service);
  service.publishVersion({ note: 'v2' });
  const v1After = service.getVersion('v1', ADMIN);
  assert.equal(v1After.hash, hashBefore);
  assert.ok(!('SINGLE:EXTRA1' in v1After.entries));
});

test('未决冲突在版本中保留标记，不被悄悄消解', () => {
  const service = makeService();
  registerCatalog(service);
  importCore(service);
  approveAll(service);
  // 制造成员冲突但不裁定
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-conflict',
    records: [{ kind: 'ortholog_member', group_id: 'OG_ALT', stable_id: 'AQU_0001', valid_from: '2021-01-01', valid_to: null }],
  });
  approveAll(service);
  const version = service.publishVersion({ note: '含未决冲突的版本' });
  const [conflict] = service.listConflicts({ status: 'open' });
  // 两个组的条目都挂上同一冲突标记，双方都还在词表里（并存）
  assert.ok(version.entries.OG0001.conflict_ids.includes(conflict.conflict_id));
  assert.ok(version.entries.OG_ALT.conflict_ids.includes(conflict.conflict_id));
  assert.ok(version.entries.OG0001.members.some((m) => m.stable_id === 'AQU_0001'));
  assert.ok(version.entries.OG_ALT.members.some((m) => m.stable_id === 'AQU_0001'));
});

test('新数据库到达只标记受影响实验，不改动其锁定输入', () => {
  const { service } = makePublishedService();
  const lock = service.createTrainingLock({
    experiment_id: 'exp-sponge-brca1',
    version_id: 'v1',
    query: ['OG0001'],
    species_panel: ['9606', '10090', '400682'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: ADMIN,
  });
  const inputBefore = service.buildInput(lock.lock_id);

  // 新数据库修订：小鼠基因移出 OG0001
  service.registerSource({ source_id: 'src_ensembl2', name: 'Ensembl', release: '113' });
  service.importBatch({
    source_id: 'src_ensembl2',
    batch_id: 'b-rev',
    records: [{ kind: 'ortholog_member', group_id: 'OG0002', stable_id: 'ENSMUSG00000017146', valid_from: '2026-01-01', valid_to: null }],
  });
  approveAll(service);
  const [conflict] = service.listConflicts({ status: 'open' });
  service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG0002')],
    drop: [conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG0001')],
    rationale: '修订：小鼠基因移入 OG0002',
    decided_by: 'expert-1',
  });
  service.publishVersion({ note: 'v2' });

  // 实验被标记受影响，但锁定输入逐 token 一致
  const marks = service.experimentMarks('exp-sponge-brca1');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'vocab-impact');
  assert.equal(marks[0].from_version, 'v1');
  assert.equal(marks[0].to_version, 'v2');
  assert.deepEqual(marks[0].groups, ['OG0001']);
  const inputAfter = service.buildInput(lock.lock_id);
  assert.deepEqual(inputAfter.tokens, inputBefore.tokens);
  assert.equal(inputAfter.manifest_hash, inputBefore.manifest_hash);
});
