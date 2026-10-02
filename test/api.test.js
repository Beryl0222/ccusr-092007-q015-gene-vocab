import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { PermissionRegistry } from '../src/permissions.js';
import { checksumOf, geneRow, groupRow, spongeProject } from './helpers.js';

let base;
let app;

test.before(async () => {
  const perms = new PermissionRegistry();
  app = await createApp({ permissions: perms });
  await new Promise((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
});

const H = (user, roles = []) => {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-user'] = user;
  if (roles.length) headers['x-roles'] = roles.join(',');
  return headers;
};

async function call(method, path, { user, roles, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: H(user, roles),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('HTTP：角色强制、受限物种脱敏、完整治理链路、差异与锁定', async () => {
  // 无身份 → 403。
  assert.equal((await call('GET', '/species')).status, 403);
  // 有身份但角色不足 → 403。
  assert.equal((await call('POST', '/sources', { user: 'u', roles: ['researcher'], body: { source_id: 'x' } })).status, 403);

  // 管理员登记海绵项目并授权导入专家。
  const r1 = await call('POST', '/species/amphimedon_queenslandica/project', {
    user: 'admin', roles: ['admin'], body: { project_id: spongeProject },
  });
  assert.equal(r1.status, 201);
  assert.equal((await call('POST', '/projects/grants', { user: 'admin', roles: ['admin'], body: { project_id: spongeProject, user: 'curator' } })).status, 201);
  // 复核专家也要能看到受限数据，否则无权批准触及海绵的批次。
  assert.equal((await call('POST', '/projects/grants', { user: 'admin', roles: ['admin'], body: { project_id: spongeProject, user: 'expert' } })).status, 201);

  // 物种目录：外人对海绵 accessible=false。
  const species = await call('GET', '/species', { user: 'outsider', roles: ['researcher'] });
  const sponge = species.json.species.find((s) => s.code === 'amphimedon_queenslandica');
  assert.equal(sponge.visibility, 'restricted');
  assert.equal(sponge.accessible, false);

  // 导入：来源 + 两分片批次（基因 / 同源组各一片）。
  assert.equal((await call('POST', '/sources', { user: 'curator', roles: ['importer'], body: { source_id: 'ensembl', name: 'Ensembl 112' } })).status, 201);
  assert.equal((await call('POST', '/sources', { user: 'curator', roles: ['importer'], body: { source_id: 'homol', name: 'HomoloGene' } })).status, 201);

  const shard0 = [
    geneRow({ record_id: 'hs', species: 'homo_sapiens', stable: 'ENSG1', aliases: ['BRCA1'] }),
    geneRow({ record_id: 'aq', species: 'amphimedon_queenslandica', stable: 'AQ1', aliases: ['BRCA1-like'] }),
  ];
  const shard1 = [
    groupRow({ record_id: 'og', group_id: 'OG:BRCA1', members: [['homo_sapiens', 'ENSG1'], ['amphimedon_queenslandica', 'AQ1']] }),
  ];
  const checksum = checksumOf([shard0]);
  const started = await call('POST', '/imports', {
    user: 'curator', roles: ['importer'],
    body: { batch_id: 'http-b1', source_id: 'ensembl', total_shards: 1, overall_checksum: checksum },
  });
  assert.equal(started.status, 201);

  // 无海绵项目授权的导入者上传受限分片 → 403。
  const denied = await call('PUT', '/imports/http-b1/shards/0', { user: 'other-importer', roles: ['importer'], body: { rows: shard0 } });
  assert.equal(denied.status, 403);

  const s0 = await call('PUT', '/imports/http-b1/shards/0', { user: 'curator', roles: ['importer'], body: { rows: shard0 } });
  assert.equal(s0.status, 200);
  // 幂等重试。
  const s0again = await call('PUT', '/imports/http-b1/shards/0', { user: 'curator', roles: ['importer'], body: { rows: shard0 } });
  assert.equal(s0again.json.status, 'duplicate');
  // 组事实来源是 homol，但批次来源为 ensembl —— 这里改用第二个批次承载组，避免来源语义混乱。
  const started2 = await call('POST', '/imports', {
    user: 'curator', roles: ['importer'],
    body: { batch_id: 'http-b2', source_id: 'homol', total_shards: 1, overall_checksum: checksumOf([shard1]) },
  });
  assert.equal(started2.status, 201);
  const s1 = await call('PUT', '/imports/http-b2/shards/0', { user: 'curator', roles: ['importer'], body: { rows: shard1 } });
  assert.equal(s1.status, 200);

  const done1 = await call('POST', '/imports/http-b1/complete', { user: 'curator', roles: ['importer'] });
  assert.equal(done1.status, 200);
  assert.equal(done1.json.status, 'validated');
  const done2 = await call('POST', '/imports/http-b2/complete', { user: 'curator', roles: ['importer'] });
  assert.equal(done2.json.status, 'validated');

  // 复核：专家必须逐条确认警告（若有）并给出理由。
  for (const [bid, done] of [['http-b1', done1], ['http-b2', done2]]) {
    const ack = done.json.warnings.map((w) => w.id);
    const approved = await call('POST', `/imports/${bid}/approve`, {
      user: 'expert', roles: ['reviewer'],
      body: { note: '核对原始记录与证据，批准并存', acknowledged_warning_ids: ack },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
  }

  // 发布 v1。
  const pub1 = await call('POST', '/releases', { user: 'expert', roles: ['reviewer'], body: { label: 'sept' } });
  assert.equal(pub1.status, 201);
  assert.equal(pub1.json.version, 1);

  // 外部研究者看 v1：海绵稳定标识被脱敏。
  const redacted = await call('GET', '/releases/1', { user: 'outsider', roles: ['researcher'] });
  assert.equal(redacted.status, 200);
  assert.ok(!JSON.stringify(redacted.json.snapshot).includes('AQ1'));
  assert.ok(!redacted.json.snapshot.genes.some((g) => g.species_code === 'amphimedon_queenslandica'));

  // 溯源：外人看到 restricted_hidden；授权后看到原值。
  const traceHidden = await call('GET', '/trace?slot=group:OG:BRCA1', { user: 'outsider', roles: ['researcher'] });
  assert.equal(traceHidden.json.by_species.amphimedon_queenslandica[0].access, 'restricted_hidden');
  assert.ok(!JSON.stringify(traceHidden.json).includes('AQ1'));

  await call('POST', '/projects/grants', { user: 'admin', roles: ['admin'], body: { project_id: spongeProject, user: 'insider' } });
  const traceOk = await call('GET', '/trace?slot=group:OG:BRCA1', { user: 'insider', roles: ['researcher'] });
  assert.equal(traceOk.json.by_species.amphimedon_queenslandica[0].stable_id, 'AQ1');
  assert.ok(traceOk.json.group_evidence.some((e) => e.source_id === 'homol'));

  // 研究者锁定并生成确定性输入。
  const locked = await call('POST', '/jobs', {
    user: 'insider', roles: ['researcher'],
    body: { job_id: 'job-a', version: 1, missing_policy: 'mask_token' },
  });
  assert.equal(locked.status, 201);
  const input = await call('POST', '/jobs/job-a/input', {
    user: 'insider', roles: ['researcher'],
    body: { declared_genes: [{ species_code: 'homo_sapiens', stable_id: 'ENSG1' }] },
  });
  assert.equal(input.status, 200);
  assert.equal(input.json.input.vocab_hash, locked.json.vocab_hash);

  // 第二版：人基因修订加别名；差异端点报告变更。
  const shard2 = [geneRow({ record_id: 'hs-r2', species: 'homo_sapiens', stable: 'ENSG1', revision: 2, aliases: ['BRCA1', 'RNF53'], from: '2026-01-01' })];
  await call('POST', '/imports', { user: 'curator', roles: ['importer'], body: { batch_id: 'http-b3', source_id: 'ensembl', total_shards: 1, overall_checksum: checksumOf([shard2]) } });
  await call('PUT', '/imports/http-b3/shards/0', { user: 'curator', roles: ['importer'], body: { rows: shard2 } });
  const done3 = await call('POST', '/imports/http-b3/complete', { user: 'curator', roles: ['importer'] });
  await call('POST', '/imports/http-b3/approve', {
    user: 'expert', roles: ['reviewer'],
    body: { note: '新库修订', acknowledged_warning_ids: done3.json.warnings.map((w) => w.id) },
  });
  const pub2 = await call('POST', '/releases', { user: 'expert', roles: ['reviewer'], body: {} });
  assert.equal(pub2.json.version, 2);
  const diff = await call('GET', '/releases/1/diff/2', { user: 'insider', roles: ['researcher'] });
  assert.ok(diff.json.changed_aliases.some((c) => c.added.some((a) => a.startsWith('RNF53'))));

  // 旧作业锁定不动，但被标记受影响。
  const job = await call('GET', '/jobs/job-a', { user: 'insider', roles: ['researcher'] });
  assert.equal(job.json.version, 1);
  assert.ok(job.json.impacts.length >= 1);

  // 撤回 homol 来源：需要 reviewer 角色；新版本不再含其组事实。
  const retract = await call('POST', '/sources/homol/retract', {
    user: 'expert', roles: ['reviewer'], body: { reason: '错误合并，暂停引用' },
  });
  assert.equal(retract.status, 200);
  const releases = await call('GET', '/releases', { user: 'insider', roles: ['researcher'] });
  const latest = releases.json.releases.at(-1).version;
  const newSnap = await call('GET', `/releases/${latest}`, { user: 'insider', roles: ['researcher'] });
  assert.equal(newSnap.json.snapshot.groups.some((g) => g.source_id === 'homol'), false);
});
