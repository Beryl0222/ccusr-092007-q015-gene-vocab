/**
 * 事件存储：只追加的治理日志。
 *
 * 所有状态变更（导入、复核、发布、锁定、撤回……）都是不可变事件；
 * 当前状态由归约得到，因此任何旧版本与旧决定都能被逐字节重建。
 * 持久化为单个 JSON 文件（适合单机/测试规模），内存模式 path 为 null。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contentHash } from './canonical.js';

let clock = () => new Date().toISOString();

/** 测试可用固定时钟覆盖。 */
export function setClock(fn) {
  clock = fn;
}

export function nowIso() {
  return clock();
}

export class EventStore {
  constructor(path = null) {
    this.path = path;
    this.events = [];
    this.seq = 0;
  }

  static async open(path) {
    const store = new EventStore(path);
    if (path) {
      try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        store.events = raw.events;
        store.seq = raw.seq;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return store;
  }

  async persist() {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ seq: this.seq, events: this.events }, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, this.path);
  }

  /**
   * 追加事件。seq 与 event_id 单调分配；payload 冻结以防归约后再被改写。
   * dedupeKey 支持显式幂等：同 key 事件不重复追加，返回已存在事件与 false。
   */
  append(type, payload, { by = null, dedupeKey = null } = {}) {
    if (dedupeKey) {
      const existing = this.events.find((e) => e.dedupe_key === dedupeKey);
      if (existing) return { event: existing, duplicated: true };
    }
    this.seq += 1;
    const event = Object.freeze({
      event_id: this.seq,
      type,
      ts: nowIso(),
      by,
      dedupe_key: dedupeKey,
      payload: Object.freeze(structuredClone(payload)),
    });
    this.events.push(event);
    return { event, duplicated: false };
  }

  /** 用给定归约函数回放全部事件。 */
  reduce(reducer, initial) {
    let state = initial;
    for (const event of this.events) {
      state = reducer(state, event) ?? state;
    }
    return state;
  }

  /** 到某条事件为止的内容指纹，用于核对日志完整性。 */
  chainHash() {
    return contentHash(this.events.map((e) => [e.event_id, e.type, e.ts, e.by, e.payload]));
  }
}
