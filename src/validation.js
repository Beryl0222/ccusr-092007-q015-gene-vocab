/**
 * 候选关系规则校验。
 *
 * 错误（error）：阻断导入，必须修正后重传；
 * 警告（warning）：不阻断，但进入待复核清单，专家批准时必须逐条显式确认。
 * 系统不会替专家在冲突候选中做选择——只把它们算清楚、摆出来。
 */
import { SPECIES_BY_CODE } from './contracts.js';
import { isValidRange, overlaps, dayStartUtc } from './time.js';
import { buildAdjacency, findCycle } from './graph.js';
import { geneKey } from './state.js';

function validDate(d) {
  if (d == null || d === '') return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(dayStartUtc(d));
}

function commonChecks(row, ctx, errors) {
  if (!row || typeof row !== 'object') {
    errors.push({ code: 'row_not_object', message: '分片行必须是对象' });
    return false;
  }
  if (!row.record_id || typeof row.record_id !== 'string') {
    errors.push({ code: 'missing_record_id', message: '缺少 record_id' });
  }
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    errors.push({ code: 'bad_revision', message: `${row.record_id ?? '?'}: revision 必须为 >=1 整数`, record_id: row.record_id });
  }
  if (!ctx.sourceActive) {
    errors.push({
      code: 'source_not_citable',
      message: `批次证据来源 ${ctx.sourceId} 未登记或已撤回，不能导入新引用`,
    });
  }
  if (!row.effective_from || !isValidRange(row)) {
    errors.push({
      code: 'bad_range',
      message: `${row.record_id ?? '?'}: 有效区间非法（需要 YYYY-MM-DD，且 to>from）`,
      record_id: row.record_id,
    });
  } else if (!validDate(row.effective_to)) {
    errors.push({ code: 'bad_range', message: `${row.record_id}: effective_to 日期非法`, record_id: row.record_id });
  }
  if (row.species_code && !SPECIES_BY_CODE.has(row.species_code)) {
    errors.push({ code: 'unknown_species', message: `${row.record_id}: 未知物种 ${row.species_code}`, record_id: row.record_id });
  }
  return true;
}

/**
 * 校验整个批次的候选行。
 * ctx: { sources: Set<active_source_id>, genes, groups, links }（归约状态，已排除撤回事实由调用方过滤）
 */
export function validateRows(rows, ctx) {
  const errors = [];
  const warnings = [];
  const seenRecords = new Set();

  const warn = (w) => warnings.push(w);

  rows.forEach((row, i) => {
    if (!commonChecks(row, ctx, errors)) return;
    if (seenRecords.has(row.record_id)) {
      errors.push({ code: 'duplicate_record', message: `批次内 record_id 重复：${row.record_id}`, record_id: row.record_id });
    }
    seenRecords.add(row.record_id);

    if (row.kind === 'gene') validateGene(row, ctx, errors, warnings);
    else if (row.kind === 'group') validateGroup(row, ctx, errors, warnings);
    else if (row.kind === 'link') validateLink(row, ctx, errors, warnings);
    else errors.push({ code: 'unknown_kind', message: `${row.record_id}: kind 必须是 gene/group/link`, record_id: row.record_id });
  });

  // 跨整批的关系成环检测：把候选边与既有边一起构图。
  const edges = [];
  for (const link of ctx.links) {
    edges.push({
      from: geneKey(link.from.species_code, link.from.stable_id),
      to: geneKey(link.to.species_code, link.to.stable_id),
    });
  }
  for (const candidate of rows.filter((r) => r.kind === 'link' && r.from && r.to)) {
    edges.push({
      from: geneKey(candidate.from.species_code, candidate.from.stable_id),
      to: geneKey(candidate.to.species_code, candidate.to.stable_id),
    });
  }
  const cycle = findCycle(buildAdjacency(edges));
  if (cycle) {
    warn({
      code: 'relation_cycle',
      message: `候选关系成环：${cycle.join(' -> ')}，需专家确认是否为错误合并`,
      path: cycle,
    });
  }

  // 警告按 (record_id, code) 排序后赋稳定编号，供复核逐条确认。
  const sorted = warnings
    .map((w) => ({ ...w, record_id: w.record_id ?? '_batch' }))
    .sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const numbered = sorted.map((w, i) => ({ id: `W${String(i + 1).padStart(3, '0')}`, ...w }));
  errors.sort((a, b) => (a.code < b.code ? -1 : 1));
  return { errors, warnings: numbered };
}

function validateGene(row, ctx, errors, warnings) {
  if (!row.stable_id || typeof row.stable_id !== 'string') {
    errors.push({ code: 'missing_stable_id', message: `${row.record_id}: 缺少 stable_id`, record_id: row.record_id });
    return;
  }
  const key = geneKey(row.species_code, row.stable_id);
  const entry = ctx.genes.get(key);

  if (entry) {
    const latest = entry.facts
      .filter((f) => !f.retracted)
      .sort((a, b) => b.revision - a.revision)[0];
    if (latest && row.revision <= latest.revision) {
      errors.push({
        code: 'revision_not_advancing',
        message: `${row.record_id}: ${key} 最新修订为 r${latest.revision}，新候选必须使用更大 revision`,
        record_id: row.record_id,
      });
    }
    if (latest && isValidRange(row) && overlaps(row, latest)) {
      warnings.push({
        code: 'fact_range_overlap',
        message: `${row.record_id}: 与既有事实 ${latest.fact_id} 的有效区间重叠`,
        record_id: row.record_id,
      });
    }
  }

  const aliasNames = new Set();
  for (const alias of row.aliases ?? []) {
    if (!alias?.name || typeof alias.name !== 'string') {
      errors.push({ code: 'bad_alias', message: `${row.record_id}: 别名缺少 name`, record_id: row.record_id });
      continue;
    }
    if (aliasNames.has(alias.name.toLowerCase())) {
      errors.push({ code: 'duplicate_alias', message: `${row.record_id}: 同批内别名重复 ${alias.name}`, record_id: row.record_id });
    }
    aliasNames.add(alias.name.toLowerCase());
    if (!isValidRange(alias)) {
      errors.push({ code: 'bad_alias_range', message: `${row.record_id}: 别名 ${alias.name} 区间非法`, record_id: row.record_id });
    }
  }

  // 与既有（含本批其他基因）别名归属冲突：同一物种别名重叠指向不同稳定标识。
  const batchGenes = ctx.batchGenes ?? [];
  const candidateOwners = batchGenes.filter(
    (g) => g.species_code === row.species_code && geneKey(g.species_code, g.stable_id) !== key,
  );
  for (const alias of row.aliases ?? []) {
    if (!isValidRange(alias)) continue;
    for (const other of candidateOwners) {
      for (const otherAlias of other.aliases ?? []) {
        if (otherAlias.name.toLowerCase() === alias.name.toLowerCase() && overlaps(alias, otherAlias)) {
          warnings.push({
            code: 'alias_conflict_pending',
            message: `${row.record_id}: 别名 ${alias.name} 同时指向 ${row.stable_id} 与 ${other.stable_id}`,
            record_id: row.record_id,
          });
        }
      }
    }
    for (const [otherKey, otherEntry] of ctx.genes) {
      if (otherKey === key || !otherKey.startsWith(`${row.species_code}::`)) continue;
      for (const fact of otherEntry.facts) {
        if (fact.retracted) continue;
        for (const otherAlias of fact.aliases ?? []) {
          if (otherAlias.name.toLowerCase() === alias.name.toLowerCase() && overlaps(alias, otherAlias)) {
            warnings.push({
              code: 'alias_conflict_pending',
              message: `${row.record_id}: 别名 ${alias.name} 与已批准事实 ${fact.fact_id} 指向不同稳定标识`,
              record_id: row.record_id,
            });
          }
        }
      }
    }
  }
}

function validateGroup(row, ctx, errors, warnings) {
  if (!row.group_id) {
    errors.push({ code: 'missing_group_id', message: `${row.record_id}: 缺少 group_id`, record_id: row.record_id });
  }
  if (!Array.isArray(row.members) || row.members.length === 0) {
    errors.push({ code: 'empty_members', message: `${row.record_id}: 同源组必须至少含一个成员`, record_id: row.record_id });
    return;
  }
  if (row.members.length > 12) {
    errors.push({ code: 'too_many_members', message: `${row.record_id}: 成员数超过物种总数 12`, record_id: row.record_id });
  }
  const memberKeys = new Set();
  for (const member of row.members) {
    if (!member?.species_code || !member?.stable_id) {
      errors.push({ code: 'bad_member', message: `${row.record_id}: 成员缺少 species_code/stable_id`, record_id: row.record_id });
      continue;
    }
    if (!SPECIES_BY_CODE.has(member.species_code)) {
      errors.push({ code: 'unknown_species', message: `${row.record_id}: 成员物种未知 ${member.species_code}`, record_id: row.record_id });
    }
    const mk = geneKey(member.species_code, member.stable_id);
    if (memberKeys.has(mk)) {
      errors.push({ code: 'duplicate_member', message: `${row.record_id}: 组成员重复 ${mk}`, record_id: row.record_id });
    }
    memberKeys.add(mk);
    if (!ctx.genes.has(mk)) {
      warnings.push({
        code: 'member_unknown',
        message: `${row.record_id}: 成员 ${mk} 尚无已批准基因事实，发布前需确认`,
        record_id: row.record_id,
      });
    }
  }
  // 同物种多成员（一对多）在批准后会成为显式冲突；导入期先警告。
  const bySpecies = new Map();
  for (const member of row.members) {
    const list = bySpecies.get(member.species_code) ?? [];
    list.push(member.stable_id);
    bySpecies.set(member.species_code, list);
  }
  for (const [species, ids] of bySpecies) {
    if (new Set(ids).size > 1) {
      warnings.push({
        code: 'one_to_many_pending',
        message: `${row.record_id}: 同源组 ${row.group_id} 在 ${species} 有多个成员，冲突将并存待决`,
        record_id: row.record_id,
      });
    }
  }
}

function validateLink(row, ctx, errors, warnings) {
  const { from, to } = row;
  if (!from?.species_code || !from?.stable_id || !to?.species_code || !to?.stable_id) {
    errors.push({ code: 'bad_link_ends', message: `${row.record_id}: 关系缺少 from/to 端点`, record_id: row.record_id });
    return;
  }
  for (const end of [from, to]) {
    if (!SPECIES_BY_CODE.has(end.species_code)) {
      errors.push({ code: 'unknown_species', message: `${row.record_id}: 关系端点物种未知 ${end.species_code}`, record_id: row.record_id });
    }
  }
  const a = geneKey(from.species_code, from.stable_id);
  const b = geneKey(to.species_code, to.stable_id);
  if (a === b) {
    errors.push({ code: 'self_link', message: `${row.record_id}: 关系端点指向自身`, record_id: row.record_id });
  }
  if (!ctx.genes.has(a) || !ctx.genes.has(b)) {
    warnings.push({
      code: 'link_end_unknown',
      message: `${row.record_id}: 关系端点尚无已批准基因事实（${!ctx.genes.has(a) ? a : ''}${!ctx.genes.has(a) && !ctx.genes.has(b) ? ', ' : ''}${!ctx.genes.has(b) ? b : ''}）`,
      record_id: row.record_id,
    });
  }
}
