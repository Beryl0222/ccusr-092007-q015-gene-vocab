import test from 'node:test';
import assert from 'node:assert/strict';
import { makePublishedService, makeService, registerCatalog, importCore, approveAll, ADMIN, PUBLIC_USER, DEEPSEA_USER } from './helpers.js';

function lockFull(service, experimentId = 'exp-trace') {
  return service.createTrainingLock({
    experiment_id: experimentId,
    version_id: 'v1',
    query: ['OG0001'],
    species_panel: ['9606', '10090', '400682'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: ADMIN,
  });
}

test('从模型位置追溯到各物种原始标识与选择依据', () => {
  const { service } = makePublishedService();
  const lock = lockFull(service);
  const built = service.buildInput(lock.lock_id);
  const position = built.tokens.indexOf('GV:OG0001:AQU_0001');
  assert.ok(position >= 0);

  const trace = service.tracePosition(lock.lock_id, position, ADMIN);
  assert.equal(trace.token, 'GV:OG0001:AQU_0001');
  assert.equal(trace.group_id, 'OG0001');
  // 三个物种成员的稳定标识与原始标识
  const bySpecies = Object.fromEntries(trace.members.map((m) => [m.species, m]));
  assert.equal(bySpecies['9606'].stable_id, 'ENSG00000012048');
  assert.deepEqual(bySpecies['9606'].original_ids, [{ source_id: 'src_ensembl', id: 'ENSG00000012048' }]);
  assert.equal(bySpecies['400682'].stable_id, 'AQU_0001');
  assert.deepEqual(bySpecies['400682'].original_ids, [{ source_id: 'src_orthodb', id: 'AQU1.0001' }]);
  // 选择依据：专家复核理由 + 证据来源状态
  const reviews = trace.members.flatMap((m) => m.reviews);
  assert.ok(reviews.length > 0);
  assert.ok(reviews.every((r) => r.rationale && r.by === 'curator-1'));
  const sources = trace.members.flatMap((m) => m.sources);
  assert.ok(sources.some((s) => s.source_id === 'src_ensembl' && s.release === '112'));
});

test('追溯包含冲突裁定依据', () => {
  const service = makeService();
  registerCatalog(service);
  importCore(service);
  approveAll(service);
  // 制造冲突并裁定：AQU_0001 从 OG_ALT 移除
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-conflict',
    records: [{ kind: 'ortholog_member', group_id: 'OG_ALT', stable_id: 'AQU_0001', valid_from: '2021-01-01', valid_to: null }],
  });
  approveAll(service);
  const [conflict] = service.listConflicts({ status: 'open' });
  const keepRef = conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG0001');
  const dropRef = conflict.relation_refs.find((id) => service.store.memberships.get(id).group_id === 'OG_ALT');
  service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [keepRef],
    drop: [dropRef],
    rationale: 'OrthoDB 修订确认 AQU_0001 仅属 OG0001',
    decided_by: 'expert-9',
  });
  service.publishVersion({ note: 'v1' });
  const lock = lockFull(service);
  const built = service.buildInput(lock.lock_id);
  const position = built.tokens.indexOf('GV:OG0001:AQU_0001');
  const trace = service.tracePosition(lock.lock_id, position, ADMIN);
  const resolution = trace.rationale.find((r) => r.type === 'resolution');
  assert.ok(resolution);
  assert.equal(resolution.rationale, 'OrthoDB 修订确认 AQU_0001 仅属 OG0001');
  assert.equal(resolution.decided_by, 'expert-9');
  assert.deepEqual(resolution.drop, [dropRef]);
});

test('位置越界被拒绝', () => {
  const { service } = makePublishedService();
  const lock = lockFull(service);
  assert.throws(() => service.tracePosition(lock.lock_id, 99, ADMIN), (err) => err.code === 'validation-failed');
});

test('未公开物种：无权者只看到计数，有权者看到完整标识', () => {
  const { service } = makePublishedService();
  const lock = service.createTrainingLock({
    experiment_id: 'exp-deep',
    version_id: 'v1',
    query: ['SINGLE:DEEP_0001'],
    species_panel: ['999001'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: DEEPSEA_USER,
  });
  const tracePublic = service.tracePosition(lock.lock_id, 0, PUBLIC_USER);
  assert.equal(tracePublic.members.length, 0);
  assert.equal(tracePublic.redacted_member_count, 1);

  const traceDeep = service.tracePosition(lock.lock_id, 0, DEEPSEA_USER);
  assert.equal(traceDeep.members.length, 1);
  assert.equal(traceDeep.members[0].stable_id, 'DEEP_0001');
  assert.deepEqual(traceDeep.members[0].original_ids, [{ source_id: 'src_orthodb', id: 'DEEP1.0001' }]);
});
