/**
 * 内存存储：只负责集合、序号与审计日志，不含业务规则。
 * 支持 snapshot()/restore() 以便服务重启后词表、锁与标记完整恢复。
 *
 * 集合说明：
 * - species      物种目录（含可见性与项目授权）
 * - sources      证据来源（数据库发布），撤回只改状态不删记录
 * - batches      导入批次与分片状态（幂等重试的依据）
 * - candidates   自动导入的候选关系（待规则校验与专家复核）
 * - genes        已批准的基因（稳定标识、别名、原始标识）
 * - memberships  已批准的同源组成员关系
 * - supersedes   已批准的标识替代关系（有向，参与循环检测）
 * - conflicts    并存冲突及其显式裁定
 * - versions     已发布的词表版本（深冻结，不可变）
 * - locks        训练任务启动时的词表+缺失策略锁定
 * - experiments  实验及其影响标记
 * - audit        追加式审计日志（复核、裁定、发布、锁定、撤回）
 */
export class Store {
  constructor() {
    this.seq = { relation: 0, conflict: 0, version: 0, lock: 0, mark: 0 };
    this.species = new Map();
    this.sources = new Map();
    this.batches = new Map();
    this.candidates = new Map();
    this.genes = new Map();
    this.memberships = new Map();
    this.supersedes = new Map();
    this.conflicts = new Map();
    this.versions = new Map();
    this.locks = new Map();
    this.experiments = new Map();
    this.audit = [];
  }

  nextSeq(name) {
    if (!(name in this.seq)) throw new Error(`未知序号: ${name}`);
    this.seq[name] += 1;
    return this.seq[name];
  }

  log(entry) {
    this.audit.push(Object.freeze({ ...entry }));
  }

  ensureExperiment(experimentId) {
    if (!this.experiments.has(experimentId)) {
      this.experiments.set(experimentId, { experiment_id: experimentId, lock_ids: [], marks: [] });
    }
    return this.experiments.get(experimentId);
  }

  /** 在全部关系集合中按 relation_id 定位（基因可能携带多个 relation_id）。 */
  findRelation(relationId) {
    if (this.memberships.has(relationId)) return { type: 'membership', relation: this.memberships.get(relationId) };
    if (this.supersedes.has(relationId)) return { type: 'supersedes', relation: this.supersedes.get(relationId) };
    for (const gene of this.genes.values()) {
      if (gene.relation_ids.includes(relationId)) return { type: 'gene', relation: gene };
    }
    return null;
  }

  snapshot() {
    const mapToArray = (map) => [...map.entries()];
    return JSON.stringify({
      seq: this.seq,
      species: mapToArray(this.species),
      sources: mapToArray(this.sources),
      batches: mapToArray(this.batches),
      candidates: mapToArray(this.candidates),
      genes: mapToArray(this.genes),
      memberships: mapToArray(this.memberships),
      supersedes: mapToArray(this.supersedes),
      conflicts: mapToArray(this.conflicts),
      versions: mapToArray(this.versions),
      locks: mapToArray(this.locks),
      experiments: mapToArray(this.experiments),
      audit: this.audit,
    });
  }

  static restore(json) {
    const data = JSON.parse(json);
    const store = new Store();
    store.seq = data.seq;
    for (const key of ['species', 'sources', 'batches', 'candidates', 'genes', 'memberships', 'supersedes', 'conflicts', 'versions', 'locks', 'experiments']) {
      store[key] = new Map(data[key]);
    }
    store.audit = data.audit;
    return store;
  }
}
