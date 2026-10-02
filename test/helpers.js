import { GeneVocabService } from '../src/service.js';

/** 递增时钟：每次调用前进一秒，保证审计与版本时间确定且有序。 */
export function makeClock(start = '2026-10-01T00:00:00.000Z') {
  let tick = Date.parse(start);
  return () => new Date((tick += 1000)).toISOString();
}

export const ADMIN = { name: 'admin', projects: ['*'] };
export const PUBLIC_USER = { name: 'public-researcher', projects: [] };
export const DEEPSEA_USER = { name: 'deepsea-researcher', projects: ['proj-deepsea'] };

export function makeService() {
  return new GeneVocabService({ now: makeClock() });
}

/**
 * 标准环境：四个物种（含一个未公开的深海海绵）、两个证据来源。
 * - 9606 人 / 10090 小鼠 / 400682 海绵（公开）
 * - 999001 深海海绵（未公开，仅 proj-deepsea 可见）
 */
export function registerCatalog(service) {
  service.registerSpecies({ taxon_id: '9606', name: 'Homo sapiens' });
  service.registerSpecies({ taxon_id: '10090', name: 'Mus musculus' });
  service.registerSpecies({ taxon_id: '400682', name: 'Amphimedon queenslandica' });
  service.registerSpecies({ taxon_id: '999001', name: 'Deepsea sponge (unpublished)', visibility: 'restricted', projects: ['proj-deepsea'] });
  service.registerSource({ source_id: 'src_ensembl', name: 'Ensembl', release: '112' });
  service.registerSource({ source_id: 'src_orthodb', name: 'OrthoDB', release: 'v11' });
}

/** 标准基因与同源组记录：BRCA1 跨物种组 OG0001 + 深海海绵单例。 */
export function coreRecords() {
  return [
    {
      kind: 'gene',
      stable_id: 'ENSG00000012048',
      species: '9606',
      symbol: 'BRCA1',
      aliases: [
        { name: 'BRCC1', valid_from: '2000-01-01', valid_to: null },
        { name: 'RNF53', valid_from: '2001-01-01', valid_to: '2015-01-01' },
      ],
      original_ids: [{ source_id: 'src_ensembl', id: 'ENSG00000012048' }],
    },
    {
      kind: 'gene',
      stable_id: 'ENSMUSG00000017146',
      species: '10090',
      symbol: 'Brca1',
      aliases: [{ name: 'Brca1', valid_from: null, valid_to: null }],
      original_ids: [{ source_id: 'src_ensembl', id: 'ENSMUSG00000017146' }],
    },
  ];
}

/** 海绵与深海海绵基因、以及 OG0001 成员关系（证据来自 OrthoDB）。 */
export function orthodbRecords() {
  return [
    {
      kind: 'gene',
      stable_id: 'AQU_0001',
      species: '400682',
      symbol: 'brca1-like',
      aliases: [{ name: 'BRCA1L', valid_from: null, valid_to: null }],
      original_ids: [{ source_id: 'src_orthodb', id: 'AQU1.0001' }],
    },
    {
      kind: 'gene',
      stable_id: 'DEEP_0001',
      species: '999001',
      symbol: 'deep1',
      aliases: [],
      original_ids: [{ source_id: 'src_orthodb', id: 'DEEP1.0001' }],
    },
    { kind: 'ortholog_member', group_id: 'OG0001', stable_id: 'ENSG00000012048', valid_from: '2020-01-01', valid_to: null },
    { kind: 'ortholog_member', group_id: 'OG0001', stable_id: 'ENSMUSG00000017146', valid_from: '2020-01-01', valid_to: null },
    { kind: 'ortholog_member', group_id: 'OG0001', stable_id: 'AQU_0001', valid_from: '2020-01-01', valid_to: null },
  ];
}

export function importCore(service) {
  const ensembl = service.importBatch({ source_id: 'src_ensembl', batch_id: 'batch-ensembl', records: coreRecords(), shard_size: 3 });
  const orthodb = service.importBatch({ source_id: 'src_orthodb', batch_id: 'batch-orthodb', records: orthodbRecords(), shard_size: 3 });
  return { ensembl, orthodb };
}

/** 批准所有通过校验的候选（模拟专家复核完成）。 */
export function approveAll(service, reviewer = 'curator-1') {
  const approved = [];
  for (const candidate of service.listCandidates({ status: 'validated' })) {
    approved.push(service.reviewCandidate({
      candidate_id: candidate.candidate_id,
      decision: 'approve',
      reviewer,
      rationale: `复核通过: ${candidate.kind}`,
    }));
  }
  return approved;
}

/** 一步搭好“已发布 v1”的标准环境。 */
export function makePublishedService() {
  const service = makeService();
  registerCatalog(service);
  importCore(service);
  approveAll(service);
  const version = service.publishVersion({ note: 'v1 基线词表' });
  return { service, version };
}
