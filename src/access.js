import { GovernanceError, CODES } from './errors.js';

/**
 * 访问控制：未公开物种（visibility = 'restricted'）仅对授权项目可见。
 * principal 形态：{ name, projects: string[] }，projects 含 '*' 表示平台级管理员。
 */
export function canViewSpecies(principal, species) {
  if (!species) return false;
  if (species.visibility !== 'restricted') return true;
  const projects = principal?.projects ?? [];
  return projects.includes('*') || species.projects.some((p) => projects.includes(p));
}

export function visibleTaxa(store, principal) {
  const visible = new Set();
  for (const species of store.species.values()) {
    if (canViewSpecies(principal, species)) visible.add(species.taxon_id);
  }
  return visible;
}

/**
 * 按权限拆分成员列表：可见成员原样返回，受限物种的成员计入 redacted，
 * 不泄露其稳定标识与原始标识。
 */
export function partitionMembers(store, principal, members) {
  const visible = [];
  const redacted = [];
  for (const member of members) {
    const species = store.species.get(member.species);
    if (canViewSpecies(principal, species)) visible.push(member);
    else redacted.push(member);
  }
  return { visible, redacted };
}

/**
 * 训练锁定等“新引用”动作要求对涉及的物种有完整可见性，
 * 否则锁定的词表在无权者手中会泄露未公开物种的存在与标识。
 */
export function requireSpeciesAccess(store, principal, taxa) {
  const denied = [];
  for (const taxon of taxa) {
    const species = store.species.get(taxon);
    if (species && !canViewSpecies(principal, species)) denied.push(taxon);
  }
  if (denied.length > 0) {
    throw new GovernanceError(CODES.FORBIDDEN, '存在未授权访问的受限物种', { denied });
  }
}
