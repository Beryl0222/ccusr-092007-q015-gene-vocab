import test from 'node:test';
import assert from 'node:assert/strict';
import { makePublishedService, ADMIN, PUBLIC_USER, DEEPSEA_USER } from './helpers.js';

test('版本视图按项目权限过滤未公开物种成员', () => {
  const { service } = makePublishedService();
  const adminView = service.getVersion('v1', ADMIN);
  assert.equal(adminView.entries['SINGLE:DEEP_0001'].members.length, 1);
  assert.equal(adminView.redacted_member_count, 0);

  const publicView = service.getVersion('v1', PUBLIC_USER);
  assert.equal(publicView.entries['SINGLE:DEEP_0001'].members.length, 0);
  assert.equal(publicView.redacted_member_count, 1);
  // 公开物种成员不受影响
  assert.equal(publicView.entries.OG0001.members.length, 3);

  const deepView = service.getVersion('v1', DEEPSEA_USER);
  assert.equal(deepView.entries['SINGLE:DEEP_0001'].members.length, 1);
});

test('训练锁定：面板包含未授权物种时被拒绝，授权项目可锁定', () => {
  const { service } = makePublishedService();
  assert.throws(
    () => service.createTrainingLock({
      experiment_id: 'exp-x',
      version_id: 'v1',
      query: ['SINGLE:DEEP_0001'],
      species_panel: ['999001'],
      missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
      principal: PUBLIC_USER,
    }),
    (err) => {
      assert.equal(err.code, 'forbidden');
      assert.deepEqual(err.details.denied, ['999001']);
      return true;
    },
  );
  // 公开面板不受限
  const ok = service.createTrainingLock({
    experiment_id: 'exp-public',
    version_id: 'v1',
    query: ['OG0001'],
    species_panel: ['9606', '10090', '400682'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: PUBLIC_USER,
  });
  assert.ok(ok.lock_id);
  // 默认面板为版本全目录（含未公开物种），无权者需显式收窄
  assert.throws(
    () => service.createTrainingLock({
      experiment_id: 'exp-default-panel',
      version_id: 'v1',
      query: ['OG0001'],
      missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
      principal: PUBLIC_USER,
    }),
    (err) => err.code === 'forbidden',
  );
  const deep = service.createTrainingLock({
    experiment_id: 'exp-deep',
    version_id: 'v1',
    query: ['OG0001'],
    missing_policy: { on_missing: 'placeholder', on_conflict: 'error' },
    principal: DEEPSEA_USER,
  });
  assert.ok(deep.lock_id);
});

test('差异查询按权限隐藏受限物种的成员明细', () => {
  const { service } = makePublishedService();
  // 新版本：深海海绵增加一个基因
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-deep2',
    records: [{ kind: 'gene', stable_id: 'DEEP_0002', species: '999001', symbol: 'deep2' }],
  });
  service.reviewCandidate({
    candidate_id: service.listCandidates({ status: 'validated' })[0].candidate_id,
    decision: 'approve',
    reviewer: 'curator-1',
    rationale: '复核通过',
  });
  service.publishVersion({ note: 'v2' });

  const adminDiff = service.diffVersions('v1', 'v2', ADMIN);
  assert.ok(adminDiff.added.includes('SINGLE:DEEP_0002'));
  assert.ok(adminDiff.genes_added.includes('DEEP_0002'));

  const publicDiff = service.diffVersions('v1', 'v2', PUBLIC_USER);
  // 未公开物种的新增条目与基因不向无权者泄露，只计入数
  assert.ok(!publicDiff.added.includes('SINGLE:DEEP_0002'));
  assert.ok(!publicDiff.genes_added.includes('DEEP_0002'));
  assert.ok(publicDiff.redacted_member_count >= 2);
});
