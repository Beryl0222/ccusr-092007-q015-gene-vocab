import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService, registerCatalog, approveAll } from './helpers.js';

function setupGenes(service) {
  registerCatalog(service);
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-genes',
    records: [
      { kind: 'gene', stable_id: 'GENE1', species: '9606', symbol: 'g1', aliases: [{ name: 'ACT1', valid_from: '2020-01-01', valid_to: null }] },
      { kind: 'gene', stable_id: 'GENE2', species: '9606', symbol: 'g2' },
      { kind: 'gene', stable_id: 'GENE3', species: '10090', symbol: 'g3' },
    ],
  });
  approveAll(service);
}

test('复核必须留下复核人与理由；decline 后不可再批准', () => {
  const service = makeService();
  registerCatalog(service);
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b1',
    records: [{ kind: 'gene', stable_id: 'GENE1', species: '9606', symbol: 'g1' }],
  });
  const [candidate] = service.listCandidates({ status: 'validated' });
  assert.throws(
    () => service.reviewCandidate({ candidate_id: candidate.candidate_id, decision: 'approve', reviewer: 'curator' }),
    (err) => err.code === 'validation-failed',
  );
  const declined = service.reviewCandidate({ candidate_id: candidate.candidate_id, decision: 'decline', reviewer: 'curator', rationale: '证据不足' });
  assert.equal(declined.status, 'declined');
  assert.throws(
    () => service.reviewCandidate({ candidate_id: candidate.candidate_id, decision: 'approve', reviewer: 'curator', rationale: '再议' }),
    (err) => err.code === 'candidate-state',
  );
});

test('别名冲突并存：两个基因保留同名别名，冲突挂到双方，不悄悄选定', () => {
  const service = makeService();
  setupGenes(service);
  // G2 也声明别名 ACT1（区间重叠）→ 与 G1 冲突
  service.importBatch({
    source_id: 'src_ensembl',
    batch_id: 'b-alias',
    records: [{ kind: 'gene', stable_id: 'GENE2', species: '9606', symbol: 'g2', aliases: [{ name: 'ACT1', valid_from: '2021-01-01', valid_to: null }] }],
  });
  const [result] = approveAll(service);
  assert.equal(result.conflict_ids.length, 1);
  const [conflict] = service.listConflicts({ status: 'open' });
  assert.equal(conflict.kind, 'alias');
  assert.equal(conflict.context.alias, 'ACT1');
  // 双方并存：两个基因都仍是 approved，别名都保留
  const g1 = service.store.genes.get('GENE1');
  const g2 = service.store.genes.get('GENE2');
  assert.equal(g1.status, 'approved');
  assert.equal(g2.status, 'approved');
  assert.ok(g1.aliases.some((a) => a.name === 'ACT1'));
  assert.ok(g2.aliases.some((a) => a.name === 'ACT1'));
  assert.ok(g1.conflict_ids.includes(conflict.conflict_id));
  assert.ok(g2.conflict_ids.includes(conflict.conflict_id));
});

test('成员冲突并存：同一基因重叠区间进入两个同源组', () => {
  const service = makeService();
  setupGenes(service);
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-mem',
    records: [
      { kind: 'ortholog_member', group_id: 'OG_A', stable_id: 'GENE1', valid_from: '2020-01-01', valid_to: null },
      { kind: 'ortholog_member', group_id: 'OG_B', stable_id: 'GENE1', valid_from: '2022-01-01', valid_to: null },
    ],
  });
  const results = approveAll(service);
  const conflicted = results.filter((r) => r.conflict_ids.length > 0);
  assert.equal(conflicted.length, 1);
  const [conflict] = service.listConflicts({ status: 'open' });
  assert.equal(conflict.kind, 'membership');
  assert.deepEqual(conflict.context.groups, ['OG_A', 'OG_B']);
  // 两条成员关系并存，均未被丢弃
  const memberships = [...service.store.memberships.values()].filter((m) => m.stable_id === 'GENE1');
  assert.equal(memberships.length, 2);
  assert.ok(memberships.every((m) => !m.dropped_at));
});

test('显式裁定：keep/drop 必须完整覆盖，裁定后不可重复裁定', () => {
  const service = makeService();
  setupGenes(service);
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-mem',
    records: [
      { kind: 'ortholog_member', group_id: 'OG_A', stable_id: 'GENE1', valid_from: '2020-01-01', valid_to: null },
      { kind: 'ortholog_member', group_id: 'OG_B', stable_id: 'GENE1', valid_from: '2022-01-01', valid_to: null },
    ],
  });
  approveAll(service);
  const [conflict] = service.listConflicts({ status: 'open' });
  const [keepRef, dropRef] = conflict.relation_refs;

  // 不完整覆盖被拒绝
  assert.throws(
    () => service.resolveConflict({ conflict_id: conflict.conflict_id, keep: [keepRef], drop: [], rationale: 'x', decided_by: 'expert' }),
    (err) => err.code === 'validation-failed',
  );

  const resolved = service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [keepRef],
    drop: [dropRef],
    rationale: 'OrthoDB v11 修订：G1 仅属 OG_A',
    decided_by: 'expert-1',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution.rationale, 'OrthoDB v11 修订：G1 仅属 OG_A');
  // 被丢弃的关系退出后续发布，但记录保留（可追溯）
  const dropped = service.store.findRelation(dropRef).relation;
  assert.ok(dropped.dropped_at);
  assert.throws(
    () => service.resolveConflict({ conflict_id: conflict.conflict_id, keep: [keepRef], drop: [dropRef], rationale: 'again', decided_by: 'expert' }),
    (err) => err.code === 'conflict-state',
  );
});

test('裁定理由进入审计日志，支撑后续追溯', () => {
  const service = makeService();
  setupGenes(service);
  service.importBatch({
    source_id: 'src_orthodb',
    batch_id: 'b-mem',
    records: [
      { kind: 'ortholog_member', group_id: 'OG_A', stable_id: 'GENE1', valid_from: '2020-01-01', valid_to: null },
      { kind: 'ortholog_member', group_id: 'OG_B', stable_id: 'GENE1', valid_from: '2022-01-01', valid_to: null },
    ],
  });
  approveAll(service);
  const [conflict] = service.listConflicts({ status: 'open' });
  service.resolveConflict({
    conflict_id: conflict.conflict_id,
    keep: [conflict.relation_refs[0]],
    drop: [conflict.relation_refs[1]],
    rationale: '依据最新实验数据',
    decided_by: 'expert-2',
  });
  const resolveLog = service.auditLog().find((e) => e.action === 'conflict-resolve');
  assert.equal(resolveLog.actor, 'expert-2');
  assert.equal(resolveLog.details.rationale, '依据最新实验数据');
});
