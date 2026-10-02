/** 测试构造助手：在内存事件存储上搭出跨 12 物种的典型治理场景。 */
import { GeneVocabService } from '../src/service.js';
import { EventStore, setClock } from '../src/events.js';
import { PermissionRegistry } from '../src/permissions.js';
import { canonicalize, sha256Hex } from '../src/canonical.js';

export const SOURCES = {
  ensembl: 'ensembl_112',
  homol: 'ncbi_homologene',
  spongeDb: 'sponge_consortium_private',
  badDb: 'errata_db_2026_09',
};

export function fixedClock(at = '2026-09-20T09:00:00Z') {
  setClock(() => at);
}

export function makeService(permissions = new PermissionRegistry()) {
  fixedClock();
  const store = new EventStore(null);
  return new GeneVocabService({ store, permissions });
}

export function checksumOf(shardRows) {
  // 与服务端 completeImport 的口径一致：逐片 canonical 哈希后有序拼接。
  return sha256Hex(shardRows.map((rows) => sha256Hex(canonicalize(rows))).join(''));
}

/** 注册来源并导入一个单分片批次，返回批次结果（不自动批准、不发布）。 */
export function ingest(service, by, { batch_id, source_id, rows, approve = false, note = '专家复核通过', publish = false }) {
  try {
    service.registerSource({ source_id, name: source_id }, by);
  } catch (err) {
    if (err.code !== 'SOURCE_EXISTS') throw err;
  }
  service.startImport({ batch_id, source_id, total_shards: 1, overall_checksum: checksumOf([rows]), idempotency_key: `idem-${batch_id}` }, by);
  const up = service.uploadShard({ batch_id, index: 0, rows }, by);
  const done = service.completeImport(batch_id, by);
  let approved = null;
  if (approve) {
    const ack = (done.warnings ?? []).map((w) => w.id);
    approved = service.approveBatch({ batch_id, note, acknowledged_warning_ids: ack }, by);
    if (publish) {
      const out = service.publish({ label: batch_id }, by);
      approved = { ...approved, released: out };
    }
  }
  return { upload: up, validation: done, approved };
}

export const geneRow = ({ record_id, species, stable, aliases = [], revision = 1, from = '2020-01-01', to = null, evidence = { confidence: 0.99 } }) => ({
  kind: 'gene',
  record_id,
  species_code: species,
  stable_id: stable,
  revision,
  effective_from: from,
  effective_to: to,
  aliases: aliases.map((name) => ({ name, effective_from: from, effective_to: to })),
  evidence,
});

export const groupRow = ({ record_id, group_id, members, revision = 1, from = '2020-01-01', to = null, evidence = { method: 'treefam' } }) => ({
  kind: 'group',
  record_id,
  group_id,
  revision,
  effective_from: from,
  effective_to: to,
  members: members.map(([species, stable]) => ({ species_code: species, stable_id: stable })),
  evidence,
});

export const linkRow = ({ record_id, from, to, fromDate = '2020-01-01', toDate = null, evidence = { score: 0.9 } }) => ({
  kind: 'link',
  record_id,
  from: { species_code: from[0], stable_id: from[1] },
  to: { species_code: to[0], stable_id: to[1] },
  effective_from: fromDate,
  effective_to: toDate,
  evidence,
});

/** BRCA1 跨物种场景：人/小鼠/斑马鱼 + 受限海绵，一个同源组。 */
export function buildBrcaScenario(service, by = 'curator') {
  // 场景构建人需持有受限物种（海绵）项目授权。
  if (service.permissions) {
    service.permissions.registerSpeciesProject('amphimedon_queenslandica', spongeProject);
    service.permissions.grant(spongeProject, by);
  }
  const genes = [
    geneRow({ record_id: 'hs-brca1', species: 'homo_sapiens', stable: 'ENSG00000012048', aliases: ['BRCA1', 'RNF53'] }),
    geneRow({ record_id: 'mm-brca1', species: 'mus_musculus', stable: 'ENSMUSG00000017146', aliases: ['Brca1'] }),
    geneRow({ record_id: 'dr-brca1', species: 'danio_rerio', stable: 'ENSDARG00000071460', aliases: ['brca1'] }),
    geneRow({ record_id: 'aq-brca1l', species: 'amphimedon_queenslandica', stable: 'AQUQ190001', aliases: ['BRCA1-like'] }),
  ];
  ingest(service, by, { batch_id: 'batch-genes-1', source_id: SOURCES.ensembl, rows: genes, approve: true });

  const group = groupRow({
    record_id: 'og-brca1',
    group_id: 'OG:BRCA1',
    members: [
      ['homo_sapiens', 'ENSG00000012048'],
      ['mus_musculus', 'ENSMUSG00000017146'],
      ['danio_rerio', 'ENSDARG00000071460'],
      ['amphimedon_queenslandica', 'AQUQ190001'],
    ],
  });
  ingest(service, by, { batch_id: 'batch-groups-1', source_id: SOURCES.homol, rows: [group], approve: true, publish: true });
  return service;
}

export const spongeProject = 'proj-sponge-consortium';
