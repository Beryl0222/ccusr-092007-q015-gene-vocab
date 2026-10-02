import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import { GeneVocabService } from '../src/service.js';
import { EventStore, setClock } from '../src/events.js';
import { PermissionRegistry } from '../src/permissions.js';
import {
  SOURCES,
  makeService,
  ingest,
  geneRow,
  groupRow,
  linkRow,
  checksumOf,
  buildBrcaScenario,
  spongeProject,
} from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const CURATOR = 'curator@example.org';

function assertCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `应抛出 ${code}`);
}

test('v1 业务样例仍可被旧合同读取器读取（向后兼容）', async () => {
  const record = await loadRecord(join(here, '..', 'fixtures', 'gene_mapping.json'));
  assert.equal(record.domain, 'gene_vocab');
  assert.ok(record.revision > 0);
});

test('分片导入：乱序上传、缺片拒绝汇总、校验和不一致拒绝、重试幂等', () => {
  const service = makeService();
  service.registerSource({ source_id: SOURCES.ensembl, name: 'Ensembl' }, CURATOR);
  const shard0 = [geneRow({ record_id: 'g1', species: 'homo_sapiens', stable: 'G1' })];
  const shard1 = [geneRow({ record_id: 'g2', species: 'mus_musculus', stable: 'G2' })];
  const wrongChecksum = 'deadbeef';

  service.startImport({ batch_id: 'b1', source_id: SOURCES.ensembl, total_shards: 2, overall_checksum: wrongChecksum }, CURATOR);
  // 乱序：先传 1 再传 0。
  const up1 = service.uploadShard({ batch_id: 'b1', index: 1, rows: shard1 }, CURATOR);
  assert.deepEqual(up1.received, [1]);
  service.uploadShard({ batch_id: 'b1', index: 0, rows: shard0 }, CURATOR);

  assertCode(() => service.completeImport('b1', CURATOR), 'CHECKSUM_MISMATCH');

  // 正确校验和的新批次。
  const checksum = checksumOf([shard0, shard1]);
  service.startImport({ batch_id: 'b2', source_id: SOURCES.ensembl, total_shards: 2, overall_checksum: checksum }, CURATOR);
  service.uploadShard({ batch_id: 'b2', index: 0, rows: shard0 }, CURATOR);
  service.uploadShard({ batch_id: 'b2', index: 1, rows: shard1 }, CURATOR);
  const done = service.completeImport('b2', CURATOR);
  assert.equal(done.status, 'validated');
  assert.equal(done.total_rows, 2);

  // 幂等重试：重复上传分片返回 duplicate；重复完成返回同一状态。
  const replay = service.uploadShard({ batch_id: 'b2', index: 0, rows: shard0 }, CURATOR);
  assert.equal(replay.status, 'duplicate');
  const again = service.completeImport('b2', CURATOR);
  assert.equal(again.idempotent_replay, true);

  // 同分片不同内容必须冲突，不能悄悄覆盖。
  assertCode(
    () => service.uploadShard({ batch_id: 'b2', index: 0, rows: [geneRow({ record_id: 'gX', species: 'homo_sapiens', stable: 'GX' })] }, CURATOR),
    'SHARD_CONFLICT',
  );

  // 幂等键：startImport 网络重试不会开第二个批次。
  const replayStart = service.startImport(
    { batch_id: 'b3', source_id: SOURCES.ensembl, total_shards: 1, idempotency_key: 'client-retry-7' },
    CURATOR,
  );
  const replayStart2 = service.startImport(
    { batch_id: 'b3-different-id', source_id: SOURCES.ensembl, total_shards: 1, idempotency_key: 'client-retry-7' },
    CURATOR,
  );
  assert.equal(replayStart2.idempotent_replay, true);
  assert.equal(replayStart2.batch_id, replayStart.batch_id);
});

test('规则校验：修订号不前进、自指关系、重复成员为阻断错误', () => {
  const service = makeService();
  ingest(service, CURATOR, {
    batch_id: 'base',
    source_id: SOURCES.ensembl,
    rows: [geneRow({ record_id: 'g1', species: 'homo_sapiens', stable: 'G1', revision: 2 })],
    approve: true,
  });

  service.registerSource({ source_id: SOURCES.homol, name: 'HomoloGene' }, CURATOR);
  const rows = [
    geneRow({ record_id: 'g1-old', species: 'homo_sapiens', stable: 'G1', revision: 1 }), // 修订倒退
    linkRow({ record_id: 'self', from: ['homo_sapiens', 'G1'], to: ['homo_sapiens', 'G1'] }),
    groupRow({ record_id: 'grp-dup', group_id: 'OG:DUP', members: [['homo_sapiens', 'G1'], ['homo_sapiens', 'G1']] }),
  ];
  service.startImport({ batch_id: 'bad', source_id: SOURCES.homol, total_shards: 1, overall_checksum: checksumOf([rows]) }, CURATOR);
  service.uploadShard({ batch_id: 'bad', index: 0, rows }, CURATOR);
  const result = service.completeImport('bad', CURATOR);
  assert.equal(result.status, 'rejected');
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('revision_not_advancing'));
  assert.ok(codes.includes('self_link'));
  assert.ok(codes.includes('duplicate_member'));
  assertCode(() => service.approveBatch({ batch_id: 'bad', note: 'x' }, CURATOR), 'ERRORS_PRESENT');
});

test('警告必须逐条显式确认，批准必须留理由', () => {
  const service = makeService();
  // 先种一个已批准基因，第二批次引入同别名不同稳定标识 → 冲突警告。
  ingest(service, CURATOR, {
    batch_id: 'first',
    source_id: SOURCES.ensembl,
    rows: [geneRow({ record_id: 'a1', species: 'homo_sapiens', stable: 'STABLE_A', aliases: ['P53'] })],
    approve: true,
  });
  const rows = [geneRow({ record_id: 'a2', species: 'homo_sapiens', stable: 'STABLE_B', aliases: ['P53'], revision: 1 })];
  ingest(service, CURATOR, { batch_id: 'second-start', source_id: SOURCES.ensembl, rows, approve: false });
  // 上面 ingest 的批次 id 不重复：改用直接流程。
  assertCode(() => service.approveBatch({ batch_id: 'second-start', note: '', acknowledged_warning_ids: [] }, CURATOR), 'NOTE_REQUIRED');
  assertCode(
    () => service.approveBatch({ batch_id: 'second-start', note: '核对数据库原函', acknowledged_warning_ids: [] }, CURATOR),
    'WARNINGS_UNACKNOWLEDGED',
  );
  const batch = service.getBatch('second-start');
  const warnIds = batch.validation.warnings.map((w) => w.id);
  assert.ok(warnIds.length >= 1);
  assertCode(
    () => service.approveBatch({ batch_id: 'second-start', note: '核对', acknowledged_warning_ids: ['W999'] }, CURATOR),
    'UNKNOWN_WARNING',
  );
  const approved = service.approveBatch({ batch_id: 'second-start', note: '两库对 P53 归属不同，并存待专家决定', acknowledged_warning_ids: warnIds }, CURATOR);
  assert.equal(approved.status, 'approved');
});

test('冲突并存不被静默选定：复核队列列出双方，决定需理由且可追溯', () => {
  const service = makeService();
  ingest(service, CURATOR, {
    batch_id: 'first',
    source_id: SOURCES.ensembl,
    rows: [geneRow({ record_id: 'a1', species: 'homo_sapiens', stable: 'STABLE_A', aliases: ['P53'] })],
    approve: true,
  });
  const rows = [geneRow({ record_id: 'a2', species: 'homo_sapiens', stable: 'STABLE_B', aliases: ['P53'], revision: 1 })];
  ingest(service, CURATOR, { batch_id: 'second', source_id: SOURCES.ensembl, rows, approve: true, note: '并存' });
  const queue = service.reviewQueue();
  const conflict = queue.conflicts.find((c) => c.type === 'alias_overlap' && c.conflict_key.includes('p53'));
  assert.ok(conflict, '别名冲突必须出现在复核队列');
  assert.equal(conflict.candidates.length, 2);
  assert.equal(conflict.decision, null);

  assertCode(() => service.resolveConflict({ conflict_key: conflict.conflict_key, chosen_fact_id: 'x', rationale: 'r' }, CURATOR), 'CHOSEN_NOT_CANDIDATE');
  assertCode(() => service.resolveConflict({ conflict_key: conflict.conflict_key, chosen_fact_id: conflict.candidates[0].fact_id, rationale: '' }, CURATOR), 'NOTE_REQUIRED');
  const decision = service.resolveConflict({
    conflict_key: conflict.conflict_key,
    chosen_fact_id: conflict.candidates[0].fact_id,
    chosen_gene_key: conflict.candidates[0].gene_key,
    rationale: '依据 Ensembl 112 主记录，旧库符号为历史误并',
  }, CURATOR);
  assert.ok(decision.chosen_gene_key.endsWith('STABLE_A'));

  // 发布快照仍保留两个候选事实 + 决定。
  const release = service.publish({ label: 'v1' }, CURATOR);
  const snap = service.getRelease(release.version).snapshot;
  assert.equal(snap.genes.length, 2);
  const snapConflict = snap.conflicts.find((c) => c.conflict_key === conflict.conflict_key);
  assert.equal(snapConflict.candidates.length, 2);
  assert.equal(snap.decisions[0].chosen_gene_key, 'homo_sapiens::STABLE_A');
});

test('循环关系检测：成环产生带路径的复核警告', () => {
  const service = makeService();
  const rows = [
    geneRow({ record_id: 'ga', species: 'homo_sapiens', stable: 'GA' }),
    geneRow({ record_id: 'gb', species: 'mus_musculus', stable: 'GB' }),
    geneRow({ record_id: 'gc', species: 'danio_rerio', stable: 'GC' }),
    linkRow({ record_id: 'l1', from: ['homo_sapiens', 'GA'], to: ['mus_musculus', 'GB'] }),
    linkRow({ record_id: 'l2', from: ['mus_musculus', 'GB'], to: ['danio_rerio', 'GC'] }),
    linkRow({ record_id: 'l3', from: ['danio_rerio', 'GC'], to: ['homo_sapiens', 'GA'] }),
  ];
  const result = ingest(service, CURATOR, { batch_id: 'cyc', source_id: SOURCES.homol, rows });
  const cycleWarning = result.validation.warnings.find((w) => w.code === 'relation_cycle');
  assert.ok(cycleWarning);
  assert.ok(cycleWarning.path.length >= 4);
});

test('发布不可变、版本差异可查；新库到达只标出受影响实验', () => {
  const service = makeService();
  buildBrcaScenario(service, CURATOR);
  const v1 = service.listReleases().at(-1);
  assert.equal(v1.version, 1);

  // 训练作业锁定 v1 并生成输入。
  service.lockTraining({ job_id: 'job-1', experiment: 'exp-sponge-embedding', version: 1 }, CURATOR);
  const input1 = service.generateInput('job-1', [
    { species_code: 'homo_sapiens', stable_id: 'ENSG00000012048' },
    { species_code: 'mus_musculus', stable_id: 'ENSMUSG00000017146' },
  ]);

  // 新数据库发布：给人基因加别名。
  const rows = [
    geneRow({
      record_id: 'hs-brca1-r2',
      species: 'homo_sapiens',
      stable: 'ENSG00000012048',
      revision: 2,
      aliases: ['BRCA1', 'RNF53', 'BRCC1'],
      from: '2026-01-01',
    }),
  ];
  ingest(service, CURATOR, { batch_id: 'batch-genes-2', source_id: SOURCES.ensembl, rows, approve: true, publish: true });
  const releases = service.listReleases();
  assert.equal(releases.length, 2);

  const diff = service.diff(1, 2);
  assert.ok(diff.changed_aliases.some((c) => c.added.some((a) => a.startsWith('BRCC1'))));
  assert.ok(diff.changed_gene_keys.includes('homo_sapiens::ENSG00000012048'));

  // v1 快照仍在且哈希未变；作业锁定与输入哈希不变，但被标出受影响。
  const stillV1 = service.getRelease(1);
  assert.equal(stillV1.hash, input1.input.vocab_hash);
  const job = service.getJob('job-1');
  assert.equal(job.impacts.length, 1);
  assert.ok(job.impacts[0].changed_keys.includes('homo_sapiens::ENSG00000012048'));
});

test('相同词表+相同策略再生成输入逐字节一致，与声明顺序无关', () => {
  const service = makeService();
  buildBrcaScenario(service, CURATOR);
  service.lockTraining({ job_id: 'j-a', version: 1 }, CURATOR);
  service.lockTraining({ job_id: 'j-b', version: 1 }, CURATOR);
  const declA = [
    { species_code: 'homo_sapiens', stable_id: 'ENSG00000012048' },
    { species_code: 'mus_musculus', stable_id: 'ENSMUSG00000017146' },
  ];
  const declB = [...declA].reverse();
  const a = service.generateInput('j-a', declA);
  const b = service.generateInput('j-b', declB);
  // positions 保留调用顺序（模型位置语义），槽位与词表部分按规范排序；槽位内容一致。
  assert.equal(a.input_hash, b.input_hash);
  // 同作业重复生成得到同一哈希，事件不重复追加。
  const again = service.generateInput('j-a', declA);
  assert.equal(again.input_hash, a.input_hash);
});

test('缺失策略：error 拒绝、skip 保留缺失位、mask_token 占位', () => {
  const service = makeService();
  buildBrcaScenario(service, CURATOR);
  const missingGene = [{ species_code: 'homo_sapiens', stable_id: 'NO_SUCH_GENE' }];

  service.lockTraining({ job_id: 'strict', version: 1, missing_policy: 'error' }, CURATOR);
  assertCode(() => service.generateInput('strict', missingGene), 'MISSING_GENES');

  service.lockTraining({ job_id: 'lenient', version: 1, missing_policy: 'skip' }, CURATOR);
  const skipped = service.generateInput('lenient', missingGene);
  assert.equal(skipped.input.positions[0].status, 'missing');

  service.lockTraining({ job_id: 'masked', version: 1, missing_policy: 'mask_token' }, CURATOR);
  const masked = service.generateInput('masked', missingGene);
  assert.equal(masked.input.positions[0].status, 'masked');
  assert.equal(masked.input.positions[0].placeholder, '<mask>');
});

test('未决冲突阻止默认锁定；keep_all 下候选全部进入输入且显式标注', () => {
  const service = makeService();
  // 同一同源组在人里放两个成员 → 一对多冲突。
  const rows = [
    geneRow({ record_id: 'h1', species: 'homo_sapiens', stable: 'H1' }),
    geneRow({ record_id: 'h2', species: 'homo_sapiens', stable: 'H2' }),
    geneRow({ record_id: 'm1', species: 'mus_musculus', stable: 'M1' }),
    groupRow({ record_id: 'og1', group_id: 'OG:X', members: [['homo_sapiens', 'H1'], ['homo_sapiens', 'H2'], ['mus_musculus', 'M1']] }),
  ];
  ingest(service, CURATOR, { batch_id: 'one-to-many', source_id: SOURCES.homol, rows, approve: true, publish: true });
  const release = service.listReleases().at(-1);
  assert.ok(release.unresolved_conflicts >= 1);

  assertCode(() => service.lockTraining({ job_id: 'blocked', version: release.version }, CURATOR), 'UNRESOLVED_CONFLICTS');

  service.lockTraining({ job_id: 'all', version: release.version, conflict_policy: 'keep_all' }, CURATOR);
  const out = service.generateInput('all', []);
  const slot = out.input.slots.find((s) => s.slot === 'group:OG:X');
  assert.deepEqual(slot.chosen.homo_sapiens.sort(), ['homo_sapiens::H1', 'homo_sapiens::H2']);
  assert.ok(slot.pending_conflicts.includes('membership:OG:X:homo_sapiens'));
});

test('溯源：从模型槽位追到 12 物种中的原始标识、别名、证据与来源', () => {
  const service = makeService();
  buildBrcaScenario(service, CURATOR);
  const trace = service.trace({ slot: 'group:OG:BRCA1' }, { user: 'anyone' });
  const species = Object.keys(trace.by_species);
  assert.ok(species.includes('homo_sapiens'));
  assert.ok(species.includes('amphimedon_queenslandica'));
  const human = trace.by_species.homo_sapiens[0];
  assert.equal(human.stable_id, 'ENSG00000012048');
  assert.ok(human.aliases.some((a) => a.name === 'RNF53'));
  assert.equal(human.source.source_id, SOURCES.ensembl);
  assert.ok(human.evidence);
  assert.ok(trace.group_evidence.some((e) => e.source_id === SOURCES.homol));
});

test('来源撤回：暂停新引用、旧发布与旧产物保留、沿依赖标记实验', () => {
  const service = makeService();
  buildBrcaScenario(service, CURATOR);
  service.lockTraining({ job_id: 'legacy', experiment: 'exp-old', version: 1, missing_policy: 'mask_token' }, CURATOR);
  const before = service.generateInput('legacy', [{ species_code: 'danio_rerio', stable_id: 'ENSDARG00000071460' }]);

  // 撤回 HomoloGene（组事实来源）。
  const retraction = service.retractSource({ source_id: SOURCES.homol, reason: '2026-09 批次发现错误合并' }, CURATOR);
  assert.ok(retraction.retracted_facts >= 1);

  const releases = service.listReleases();
  assert.ok(releases.length >= 2);
  // 新快照不再可引用该组事实。
  const newSnap = service.getRelease(releases.at(-1).version).snapshot;
  assert.equal(newSnap.groups.some((g) => g.source_id === SOURCES.homol), false);
  // 旧快照原样保留。
  const oldSnap = service.getRelease(1).snapshot;
  assert.ok(oldSnap.groups.some((g) => g.source_id === SOURCES.homol));

  // 旧作业仍锁在旧哈希、旧输入仍可逐字节复现，并被标记受影响。
  const job = service.getJob('legacy');
  assert.equal(job.version, 1);
  assert.equal(job.vocab_hash, before.input.vocab_hash);
  assert.ok(job.impacts.length >= 1);
  const regenerated = service.generateInput('legacy', [{ species_code: 'danio_rerio', stable_id: 'ENSDARG00000071460' }]);
  assert.equal(regenerated.input_hash, before.input_hash);

  // 撤回来源不能再导入新引用。
  const rows = [geneRow({ record_id: 'z1', species: 'homo_sapiens', stable: 'Z1' })];
  assertCode(() => service.startImport({ batch_id: 'from-retracted', source_id: SOURCES.homol, total_shards: 1 }, CURATOR), 'SOURCE_RETRACTED');
});

test('权限：未公开海绵数据无项目授权时脱敏，授权后可见，导入同样受限', () => {
  const perms = new PermissionRegistry();
  const service = makeService(perms);
  buildBrcaScenario(service, CURATOR);

  // 无授权研究者：看不到海绵稳定标识。
  const outsider = 'researcher@example.org';
  const trace = service.trace({ slot: 'group:OG:BRCA1' }, { user: outsider });
  const sponge = trace.by_species.amphimedon_queenslandica[0];
  assert.equal(sponge.access, 'restricted_hidden');
  assert.ok(!JSON.stringify(trace).includes('AQUQ190001'));

  // 授权后可见原始标识。
  perms.registerSpeciesProject('amphimedon_queenslandica', spongeProject);
  perms.grant(spongeProject, outsider);
  const trace2 = service.trace({ slot: 'group:OG:BRCA1' }, { user: outsider });
  assert.equal(trace2.by_species.amphimedon_queenslandica[0].stable_id, 'AQUQ190001');

  // 未授权导入触及海绵物种被拒（另一名完全无项目授权的用户）。
  const outsider2 = 'importer2@example.org';
  const rows = [geneRow({ record_id: 's1', species: 'amphimedon_queenslandica', stable: 'SECRET' })];
  service.registerSource({ source_id: 'sponge2', name: 'sponge2' }, CURATOR);
  service.startImport({ batch_id: 'sponge-import', source_id: 'sponge2', total_shards: 1 }, outsider2);
  assertCode(() => service.uploadShard({ batch_id: 'sponge-import', index: 0, rows }, outsider2), 'FORBIDDEN_SPECIES');

  // 授权后同分片可以导入。
  perms.grant(spongeProject, outsider2);
  const accepted = service.uploadShard({ batch_id: 'sponge-import', index: 0, rows }, outsider2);
  assert.equal(accepted.status, 'accepted');
});

test('权限：无项目授权的专家不能批准受限批次或锁定含受限物种的版本', () => {
  const perms = new PermissionRegistry();
  const service = makeService(perms);
  buildBrcaScenario(service, CURATOR); // 已发布 v1，含海绵基因

  const blindExpert = 'blind-expert@example.org';
  // 构造一个触及海绵的待批批次。
  const rows = [geneRow({ record_id: 'aq-r2', species: 'amphimedon_queenslandica', stable: 'AQUQ190001', revision: 2, aliases: ['BRCA1-like', 'NEW-ALIAS'], from: '2026-01-01' })];
  ingest(service, CURATOR, { batch_id: 'restricted-batch', source_id: SOURCES.ensembl, rows, approve: false });
  const queue = service.getBatch('restricted-batch');
  const ack = queue.validation.warnings.map((w) => w.id);
  assertCode(
    () => service.approveBatch({ batch_id: 'restricted-batch', note: '我看不到海绵数据却想批准', acknowledged_warning_ids: ack }, blindExpert),
    'FORBIDDEN_SPECIES',
  );

  // 锁定含受限物种版本：无授权研究者被拒。
  assertCode(
    () => service.lockTraining({ job_id: 'blind-job', version: 1, missing_policy: 'mask_token' }, blindExpert),
    'FORBIDDEN_SPECIES',
  );

  // 授权后两者均放行。
  perms.grant(spongeProject, blindExpert);
  assert.equal(service.approveBatch({ batch_id: 'restricted-batch', note: '核对后批准', acknowledged_warning_ids: ack }, blindExpert).status, 'approved');
  assert.ok(service.lockTraining({ job_id: 'blind-job', version: 1, missing_policy: 'mask_token' }, blindExpert));
});

test('事件日志可持久化并重建成同一状态（哈希一致）', async () => {
  const tmp = join(here, '..', '.tmp-test-events.json');
  setClock(() => '2026-09-20T09:00:00Z');
  const store1 = await EventStore.open(tmp);
  const svc1 = new GeneVocabService({ store: store1 });
  buildBrcaScenario(svc1, CURATOR);
  await store1.persist();
  const chain1 = store1.chainHash();

  const store2 = await EventStore.open(tmp);
  assert.equal(store2.chainHash(), chain1);
  const svc2 = new GeneVocabService({ store: store2 });
  const rel = svc2.listReleases();
  assert.ok(rel.length >= 1);
  const { rm } = await import('node:fs/promises');
  await rm(tmp, { force: true });
});
