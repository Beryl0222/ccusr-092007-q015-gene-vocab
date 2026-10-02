import test from 'node:test';
import assert from 'node:assert/strict';
import { makePublishedService, ADMIN } from './helpers.js';

const PANEL = ['9606', '10090', '400682'];

function lockExp(service, experimentId) {
  return service.createTrainingLock({
    experiment_id: experimentId,
    version_id: 'v1',
    query: ['OG0001'],
    species_panel: PANEL,
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: ADMIN,
  });
}

test('撤回来源：沿依赖链暂停新引用，旧产物不删除且可复现', () => {
  const { service } = makePublishedService();
  const lock = lockExp(service, 'exp-old');
  const before = service.buildInput(lock.lock_id);

  const result = service.retractSource({ source_id: 'src_ensembl', reason: '该批次注释证据被上游撤回', by: 'governance-board' });
  // 人/鼠基因被直接暂停；其成员关系（来自 src_orthodb）沿依赖链视同暂停
  assert.deepEqual(result.suspended.genes.sort(), ['ENSG00000012048', 'ENSMUSG00000017146']);
  assert.equal(result.suspended.memberships.length, 0);
  // 旧实验被标记，旧锁输入不变
  assert.deepEqual(result.affected_marks.map((m) => m.experiment_id), ['exp-old']);
  const after = service.buildInput(lock.lock_id);
  assert.deepEqual(after.tokens, before.tokens);
  assert.equal(after.manifest_hash, before.manifest_hash);

  // 新引用被暂停：同一版本同一查询的新锁被拒绝
  assert.throws(
    () => lockExp(service, 'exp-new'),
    (err) => {
      assert.equal(err.code, 'suspended-reference');
      assert.ok(err.details.hits.length >= 2);
      return true;
    },
  );
});

test('撤回后来源记录保留、待复核候选被驳回、重复撤回被拒绝', () => {
  const { service } = makePublishedService();
  // 留一个待复核候选
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-pending',
    records: [{ kind: 'gene', stable_id: 'PEND1', species: '9606', symbol: 'pend1' }],
  });
  service.retractSource({ source_id: 'src_ensembl', reason: '证据撤回', by: 'board' });
  const source = service.store.sources.get('src_ensembl');
  assert.equal(source.status, 'retracted');
  assert.equal(source.retraction_reason, '证据撤回');
  const [pending] = service.listCandidates({ kind: 'gene' }).filter((c) => c.payload.stable_id === 'PEND1');
  assert.equal(pending.status, 'rejected');
  assert.ok(pending.errors.includes('source-retracted'));
  assert.throws(
    () => service.retractSource({ source_id: 'src_ensembl', reason: 'again', by: 'board' }),
    (err) => err.code === 'source-state',
  );
});

test('撤回后的新版本沿依赖排除被暂停条目，旧版本保持原样', () => {
  const { service, version: v1 } = makePublishedService();
  service.retractSource({ source_id: 'src_ensembl', reason: '证据撤回', by: 'board' });
  const v2 = service.publishVersion({ note: '撤回后重建' });
  // OG0001 只剩海绵成员；人/鼠基因从目录消失
  assert.deepEqual(v2.entries.OG0001.members.map((m) => m.stable_id), ['AQU_0001']);
  assert.ok(!('ENSG00000012048' in v2.genes));
  // 旧版本不变
  assert.equal(v1.entries.OG0001.members.length, 3);
  const diff = service.diffVersions('v1', 'v2', ADMIN);
  const og1 = diff.changed.find((c) => c.group_id === 'OG0001');
  assert.deepEqual(og1.removed_members.sort(), ['ENSG00000012048', 'ENSMUSG00000017146']);
});

test('撤回影响标记与词表影响标记分别归档到实验', () => {
  const { service } = makePublishedService();
  lockExp(service, 'exp-marks');
  service.retractSource({ source_id: 'src_ensembl', reason: '证据撤回', by: 'board' });
  service.publishVersion({ note: 'v2' });
  const marks = service.experimentMarks('exp-marks');
  const kinds = marks.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['retraction-impact', 'vocab-impact']);
  const retraction = marks.find((m) => m.kind === 'retraction-impact');
  assert.ok(retraction.tokens.includes('GV:OG0001:ENSG00000012048'));
});
