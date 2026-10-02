import { Store } from './store.js';
import { GovernanceError, CODES } from './errors.js';
import { importBatch, retryBatch } from './imports.js';
import { reviewCandidate, resolveConflict, listConflicts } from './review.js';
import { publishVersion, diffVersions, getVersionView } from './releases.js';
import { createTrainingLock, buildInput } from './training.js';
import { retractSource } from './retraction.js';
import { tracePosition } from './lineage.js';

/**
 * 基因词表治理后端门面。
 * 所有写操作经此进入并留下审计日志；时钟可注入以保证测试可复现。
 */
export class GeneVocabService {
  constructor({ now } = {}) {
    this.store = new Store();
    this.clock = now ?? (() => new Date().toISOString());
  }

  /** 从快照恢复（服务重启后词表、锁与标记完整还原）。 */
  static restore(json, { now } = {}) {
    const service = new GeneVocabService({ now });
    service.store = Store.restore(json);
    return service;
  }

  snapshot() {
    return this.store.snapshot();
  }

  // ---- 目录登记 ----

  registerSpecies({ taxon_id, name, visibility = 'public', projects = [] }) {
    if (!taxon_id || !name) throw new GovernanceError(CODES.VALIDATION, '物种需要 taxon_id 与 name');
    if (this.store.species.has(taxon_id)) throw new GovernanceError(CODES.VALIDATION, `物种已注册: ${taxon_id}`);
    if (!['public', 'restricted'].includes(visibility)) {
      throw new GovernanceError(CODES.VALIDATION, `未知可见性: ${visibility}`);
    }
    const species = { taxon_id, name, visibility, projects: [...projects] };
    this.store.species.set(taxon_id, species);
    this.store.log({ at: this.clock(), actor: 'admin', action: 'species-register', details: { taxon_id, visibility } });
    return species;
  }

  registerSource({ source_id, name, release }) {
    if (!source_id || !name) throw new GovernanceError(CODES.VALIDATION, '来源需要 source_id 与 name');
    if (this.store.sources.has(source_id)) throw new GovernanceError(CODES.VALIDATION, `来源已注册: ${source_id}`);
    const source = {
      source_id,
      name,
      release: release ?? null,
      status: 'active',
      received_at: this.clock(),
      retracted_at: null,
      retraction_reason: null,
      retracted_by: null,
    };
    this.store.sources.set(source_id, source);
    this.store.log({ at: this.clock(), actor: 'admin', action: 'source-register', details: { source_id, release } });
    return source;
  }

  // ---- 导入与复核 ----

  importBatch(input) {
    return importBatch(this.store, this.clock, input);
  }

  retryBatch(input) {
    return retryBatch(this.store, this.clock, input);
  }

  listCandidates({ status, kind } = {}) {
    let all = [...this.store.candidates.values()];
    if (status) all = all.filter((c) => c.status === status);
    if (kind) all = all.filter((c) => c.kind === kind);
    return all;
  }

  reviewCandidate(input) {
    return reviewCandidate(this.store, this.clock, input);
  }

  listConflicts(filter) {
    return listConflicts(this.store, filter);
  }

  resolveConflict(input) {
    return resolveConflict(this.store, this.clock, input);
  }

  // ---- 版本发布与差异 ----

  publishVersion(input = {}) {
    return publishVersion(this.store, this.clock, input);
  }

  getVersion(versionId, principal) {
    return getVersionView(this.store, versionId, principal);
  }

  diffVersions(fromId, toId, principal) {
    return diffVersions(this.store, fromId, toId, principal);
  }

  // ---- 训练锁定与输入重建 ----

  createTrainingLock(input) {
    return createTrainingLock(this.store, this.clock, input);
  }

  buildInput(lockId) {
    return buildInput(this.store, lockId);
  }

  getLock(lockId) {
    const lock = this.store.locks.get(lockId);
    if (!lock) throw new GovernanceError(CODES.NOT_FOUND, `未知训练锁: ${lockId}`);
    return lock;
  }

  // ---- 谱系追溯 ----

  tracePosition(lockId, position, principal) {
    return tracePosition(this.store, lockId, position, principal);
  }

  // ---- 来源撤回 ----

  retractSource(input) {
    return retractSource(this.store, this.clock, input);
  }

  // ---- 实验影响与审计 ----

  experimentMarks(experimentId) {
    return this.store.ensureExperiment(experimentId).marks;
  }

  listExperiments() {
    return [...this.store.experiments.values()];
  }

  auditLog() {
    return [...this.store.audit];
  }
}
