/**
 * 项目权限。
 *
 * 公开物种对任何已认证调用方可见；未公开物种（如海绵、水母、扁盘动物样例）
 * 只有携带该物种项目授权的成员可见。角色决定能做什么：
 *   importer 提交/重试导入；reviewer 复核/解决冲突/撤回来源；
 *   researcher 锁定词表、生成输入、溯源；admin 管理项目成员。
 * 同一用户可持多角色。
 */
import { isRestrictedSpecies } from './contracts.js';

export const ROLES = Object.freeze(['importer', 'reviewer', 'researcher', 'admin']);

/**
 * 授权注册表：
 *   projectGrants: projectId -> Set<user>
 *   speciesProjects: restrictedSpeciesCode -> projectId
 * 用户访问受限物种时，必须同时是该物种所登记项目的成员。
 */
export class PermissionRegistry {
  constructor({ projectGrants = new Map(), speciesProjects = new Map() } = {}) {
    this.projectGrants = new Map(
      [...projectGrants].map(([id, members]) => [id, new Set(members)]),
    );
    this.speciesProjects = new Map(speciesProjects);
  }

  grant(projectId, user) {
    let members = this.projectGrants.get(projectId);
    if (!members) {
      members = new Set();
      this.projectGrants.set(projectId, members);
    }
    members.add(user);
  }

  registerSpeciesProject(speciesCode, projectId) {
    this.speciesProjects.set(speciesCode, projectId);
  }

  isMember(user, projectId) {
    return this.projectGrants.get(projectId)?.has(user) ?? false;
  }

  /** 校验调用方可读该物种；公开物种恒允许。 */
  canReadSpecies(user, speciesCode) {
    if (!isRestrictedSpecies(speciesCode)) return true;
    const projectId = this.speciesProjects.get(speciesCode);
    if (!projectId) return false; // 受限物种未登记项目时默认拒绝
    return this.isMember(user, projectId);
  }

  requireSpecies(user, speciesCode) {
    if (!this.canReadSpecies(user, speciesCode)) {
      const err = new Error(`无权访问物种 ${speciesCode} 的未公开数据`);
      err.code = 'FORBIDDEN_SPECIES';
      err.speciesCode = speciesCode;
      throw err;
    }
  }

  hasRole(userRoles, role) {
    return userRoles.includes(role) || userRoles.includes('admin');
  }

  requireRole(userRoles, role) {
    if (!this.hasRole(userRoles, role)) {
      const err = new Error(`需要 ${role} 角色`);
      err.code = 'FORBIDDEN_ROLE';
      err.requiredRole = role;
      throw err;
    }
  }
}
