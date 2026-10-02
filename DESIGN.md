# 设计说明：基因词表治理后端

面向跨物种（12 物种）细胞模型的基因/同源关系词表治理。核心命题：**映射会修订、来源会撤回、
别名会冲突，但任何一次训练使用的词表都必须能逐字节复现，任何选择都必须能追到依据。**

## 1. 数据合同与迁移

`src/contracts.js`

- **v1**（初始脱敏样例 `fixtures/gene_mapping.json`）：`schema_version / record_id / domain /
  occurred_at / revision / source`。旧读取器 `loadRecord()` 的行为保持不变，v1 样例仍可读取。
- **v2**（当前）：包封字段不增删、不改时间含义；新增的是对业务载荷的*校验函数* `validateContract()`
  和 12 物种登记表 `ALL_SPECIES`。治理状态（候选/有效/撤回、复核决定、发布、锁定）不进入合同字段，
  而由事件流承载——因此未来新增状态不会让旧读取器失效，这就是约定的迁移方式：
  **合同管“最小标识不变”，事件类型管“状态演进”，旧事件永不改写。**
- `migrateEnvelope()` 只把可识别的 v1 包封标到当前版本，不触碰任何业务值。

## 2. 有效区间

`src/time.js`：全部使用 UTC 整日、半开区间 `[effective_from, effective_to)`。

- 相邻修订可在同一天接续：`[d1,d2)` 与 `[d2,null)` 不重叠。
- `to` 为空 = 至今有效；同源组修订随数据库发布前进，旧区间事实原样保留。
- `as_of` 用于冲突计算与训练锁定的时点；发布快照包含全部未撤回事实（含历史修订，保证可追溯），
  其中冲突集严格按 `as_of` 的有效区间计算。

## 3. 事件流与状态机

`src/events.js`（只追加日志，可 JSON 持久化、原子 rename、链式内容哈希）＋
`src/state.js`（归约器与查询视图）。所有写操作只 `append` 事件；当前状态靠回放得到。

```
证据来源 source:  active ──retract(原因)──▶ retracted（事实打标、旧快照不动）

导入批次 batch:
  receiving ──全分片到齐+校验和一致──▶ received
            ──规则校验──▶ validated（无 error）/ rejected（有 error）
  validated ──专家批准(理由+确认全部 warning)──▶ approved
            ──专家驳回(原因)──▶ rejected
  approved 不可驳回；修订必须用更大 revision 走新批次

发布 release:  每次 publish 产生不可变快照 v_n（内容 sha256）；内容不变返回 unchanged

训练作业 job:  locked（版本哈希+缺失策略+冲突策略+as_of）──▶ ready（input_hash）
              新版本/撤回只追加 IMPACT_FLAGS，状态与旧产物不变
```

冲突决定 `CONFLICT_RESOLVED` 独立留痕，再次决定通过 `supersedes` 指向旧决定时间，
历史在 `decisionHistory` 中完整保留。

## 4. 导入、校验与复核

`src/service.js` + `src/validation.js`

- **大批分片导入**：`startImport(total_shards, overall_checksum)` → `PUT shards/{i}`（可乱序）→
  `complete`。每片哈希 `sha256(canonicalize(rows))`；整批校验和 = 有序片哈希拼接的再哈希。
- **幂等重试**：开始（`idempotency_key`）、上传（同片同内容 → `duplicate`，同片不同内容 →
  409 `SHARD_CONFLICT`，绝不覆盖）、汇总、批准、锁定、撤回均可安全重试。
- **规则校验**分两级：
  - error（阻断）：未知物种/来源、区间非法、批次内重复记录、别名重复、组成员重复/超 12、
    自指关系、修订号不大于该基因最新有效修订、撤回来源导入等。
  - warning（须专家逐条确认 ID + 写理由才能批准）：别名区间重叠指向不同稳定标识、
    同组同物种多成员（一对多）、候选关系**成环**（`src/graph.js` 给出环路径）、
    成员/端点尚无已批准事实、事实区间重叠。

## 5. 冲突并存，不静默选定

- 两类冲突由事实在 `as_of` 的有效区间计算：
  `alias:<species>::<别名小写>`（别名跨基因重叠）与
  `membership:<group>:<species>`（同源组在一物种内一对多）。
- 发布快照的 `conflicts` 数组**并列保留全部候选**；`decisions` 只记录专家选了哪个
  `chosen_gene_key`、依据、决定人与时间。快照本身不因决定而删除任何候选。
- 训练锁定默认 `require_decision`：存在未决冲突即拒绝（409），迫使人先留痕；
  `keep_all` 才允许把多个候选都放进输入，且槽位 `pending_conflicts` 显式标注；
  `fail_locked` 同拒绝，供调用方区分语义。

## 6. 发布快照、差异与可复现输入

- 快照经 `canonicalize`（对象按键排序、数组保序、无空白）后求 sha256。撤回事实从新快照排除，
  但历史事件与旧快照永不改变。
- `diff(v_a, v_b)` 报告：基因键增删、**按基因键聚合的别名增删**、同源组成员变化、
  关系增删、冲突新增/已决，以及并集 `changed_gene_keys`。
- 训练锁定记录 `(version, vocab_hash, missing_policy ∈ error/skip/mask_token,
  conflict_policy, as_of)`。输入文档只含词表与策略（**不含 job_id**，使不同作业在同词表同策略下
  字节一致），位置按基因键排序；`input_hash` 相同即输入逐字节一致，可重复生成验证。

## 7. 影响标记与撤回级联

- 新版本发布：用差异的 `changed_gene_keys` 与作业实际 `used_keys`（生成输入时记录）求交，
  只给受影响实验追加 `IMPACT_FLAGS`。**旧作业仍锁在旧哈希，旧产物不删不改。**
- 来源撤回（必须给原因）：该来源全部事实打 `retracted`、从后续发布快照排除（暂停*新的*引用）、
  立即发布一个新版本触发影响标记；旧版本、旧 `input_hash`、旧模型产物继续可读、可复现；
  撤回来源不允许再开新导入（422 `SOURCE_RETRACTED`）。

## 8. 权限（未公开物种）

`src/permissions.js`：公开物种对任何已认证调用方开放；受限物种
（`ALL_SPECIES` 中 `visibility=restricted`，如昆士兰海绵/水母/扁盘动物）登记到项目，
只有项目成员可见。角色：`importer / reviewer / researcher / admin`（admin 持全部角色）。

- 写路径强约束（服务层，不经 HTTP 也生效）：导入分片、批次批准、冲突决定、训练锁定
  触及/包含受限物种时都要求项目成员资格。
- 读路径脱敏：发布快照、溯源、复核队列中无权物种的稳定标识替换为 `<species>::***` 且标
  `access=restricted_hidden`，关系两端任一不可见则整条关系隐藏。

## 9. HTTP 接口一览

身份头：`x-user`、`x-roles`（逗号分隔）。

| 方法 路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET /species` | 用户 | 12 物种目录及本人 `accessible` |
| `POST /species/:code/project` · `POST /projects/grants` | admin | 物种-项目登记、成员授权 |
| `POST /sources` · `POST /sources/:id/retract` | importer / reviewer | 来源登记、撤回（原因） |
| `POST /imports` | importer | 开始批次（分片数、整批校验和、幂等键） |
| `PUT /imports/:id/shards/:i` | importer | 分片上传（幂等；受限物种需授权） |
| `POST /imports/:id/complete` | importer | 汇总核对＋规则校验 |
| `POST /imports/:id/approve|reject` | reviewer | 复核决定（理由；批准需确认全部 warning） |
| `GET /review` | reviewer | 待批批次与未决/已决冲突 |
| `POST /conflicts/:key/resolve` | reviewer | 记录选择与依据（候选仍并存） |
| `POST /releases` · `GET /releases` | reviewer / 用户 | 发布／版本列表 |
| `GET /releases/:v` · `GET /releases/:a/diff/:b` | 用户 | 快照（脱敏）／差异 |
| `POST /jobs` | researcher | 锁定词表与策略 |
| `POST /jobs/:id/input` · `GET /jobs/:id` | researcher / 用户 | 确定性输入／锁定与影响标记 |
| `GET /trace?slot=group:X` 或 `?gene_key=species::id` | 用户 | 槽位→12 物种原始标识、别名、证据、来源与选择依据 |

运行：`node src/server.js`（`PORT`、`DATA_FILE` 环境变量；未给 `DATA_FILE` 为内存模式）。
