/**
 * 数据合同与迁移。
 *
 * v1（最小样例）：schema_version / record_id / domain / occurred_at / revision / source
 * v2（词表治理）：在 v1 基础上规定物种、基因稳定标识、别名、同源组与证据的最小含义，
 *                但治理状态机（候选/有效/撤回等）由服务层以事件流实现，不写进合同字段，
 *                这样旧版读取器不会因新增状态而失效（向后兼容）。
 */
import { readFile } from 'node:fs/promises';

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const CURRENT_SCHEMA_VERSION = 2;

/** 合同要求的全部 12 个物种，按合同顺序；其中未公开物种标记为 restricted。 */
export const ALL_SPECIES = Object.freeze([
  { code: 'homo_sapiens', taxon_id: 9606, label: '人', visibility: 'public' },
  { code: 'mus_musculus', taxon_id: 10090, label: '小鼠', visibility: 'public' },
  { code: 'danio_rerio', taxon_id: 7955, label: '斑马鱼', visibility: 'public' },
  { code: 'drosophila_melanogaster', taxon_id: 7227, label: '果蝇', visibility: 'public' },
  { code: 'caenorhabditis_elegans', taxon_id: 6239, label: '线虫', visibility: 'public' },
  { code: 'xenopus_laevis', taxon_id: 8355, label: '非洲爪蟾', visibility: 'public' },
  {
    code: 'amphimedon_queenslandica',
    taxon_id: 400682,
    label: '昆士兰海绵',
    visibility: 'restricted',
  },
  { code: 'saccharomyces_cerevisiae', taxon_id: 559292, label: '酿酒酵母', visibility: 'public' },
  { code: 'schizosaccharomyces_pombe', taxon_id: 1037659, label: '裂殖酵母', visibility: 'public' },
  { code: 'arabidopsis_thaliana', taxon_id: 3702, label: '拟南芥', visibility: 'public' },
  { code: 'obelia_latcarina', taxon_id: 503151, label: '水母', visibility: 'restricted' },
  { code: 'diploblasteplokemia_sp', taxon_id: 1742001, label: '扁盘动物', visibility: 'restricted' },
]);

export const SPECIES_BY_CODE = Object.freeze(
  new Map(ALL_SPECIES.map((entry) => [entry.code, entry])),
);

export function isRestrictedSpecies(code) {
  const entry = SPECIES_BY_CODE.get(code);
  return Boolean(entry && entry.visibility === 'restricted');
}

/**
 * 合同 v2 对包封记录的字段约定。事件流中的业务载荷都要先经此校验。
 * 与 loadRecord 的最小校验保持兼容（v1 样例仍可读取）。
 */
export function validateContract(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return ['载荷必须是对象'];
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(payload.schema_version)) {
    errors.push(
      `schema_version 必须是 ${SUPPORTED_SCHEMA_VERSIONS.join('/')}，得到 ${payload.schema_version}`,
    );
  }
  if (!payload.record_id || typeof payload.record_id !== 'string') {
    errors.push('缺少必要标识 record_id');
  }
  if (payload.domain !== 'gene_vocab') {
    errors.push("domain 必须为 'gene_vocab'");
  }
  if (!payload.occurred_at || Number.isNaN(Date.parse(payload.occurred_at))) {
    errors.push('occurred_at 必须是合法时间戳');
  }
  if (!Number.isInteger(payload.revision) || payload.revision < 1) {
    errors.push('revision 必须为 >=1 的整数');
  }
  return errors;
}

/**
 * 把外部记录迁移到当前合同。v1 包封仍是合法的：
 * 业务数据由治理事件承载，旧包封字段不被覆盖、不丢时间语义。
 */
export function migrateEnvelope(input) {
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(input.schema_version)) {
    throw new Error(`不支持的 schema_version: ${input.schema_version}`);
  }
  return { ...input, schema_version: CURRENT_SCHEMA_VERSION };
}

/**
 * 读取项目已经确认的最小数据合同，不包含业务流程实现。
 * v1 与 v2 均可读取；治理所需的严格校验见 validateContract。
 */
export async function loadRecord(path) {
  const raw = await readFile(path, 'utf8');
  const payload = JSON.parse(raw);
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  return Object.freeze(payload);
}
