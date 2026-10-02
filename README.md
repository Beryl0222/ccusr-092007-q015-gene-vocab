# 跨物种基因词表治理

研究团队维护跨物种基因同源关系和模型输入词表的版本依据。

`fixtures/gene_mapping.json` 保存一条经过脱敏的业务样例，源代码只定义读取这份样例所需的最小合同。后续模块应保持既有标识和时间含义，新增状态必须说明迁移方式。

## 模块结构

治理后端以 `GeneVocabService`（`src/service.js`）为入口，内部按职责拆分：

| 模块 | 职责 |
| --- | --- |
| `src/store.js` | 内存集合、序号、审计日志、快照/恢复 |
| `src/imports.js` | 大批映射分片导入、幂等重试（候选标识由批次内容哈希派生） |
| `src/validation.js` | 候选关系规则校验、替代链循环检测 |
| `src/review.js` | 专家复核、冲突并存登记、显式裁定 |
| `src/releases.js` | 词表版本发布（不可变）、差异查询、受影响实验标记 |
| `src/training.js` | 训练锁（词表+缺失策略）、确定性输入重建 |
| `src/retraction.js` | 证据来源撤回、沿依赖链暂停新引用 |
| `src/suspension.js` | 暂停态的传递性判定（来源→基因→成员关系） |
| `src/lineage.js` | 从输入位置追溯各物种原始标识与选择依据 |
| `src/access.js` | 项目权限与未公开物种过滤 |

## 状态模型与迁移方式

既有合同（`schema_version: 1`、`record_id`、`occurred_at`、`revision`）保持不变；
以下状态均为**新增字段、纯追加**，旧样例无需迁移即可加载。未来任何破坏性变更
（字段改名、状态含义变化）必须提升 `schema_version` 并在 `src/contracts.js`
提供升级路径。

- **候选关系** `candidate.status`：`validated`（规则校验通过，待复核）→
  `approved` / `declined`；校验失败为 `rejected`（终态）。
- **关系治理叠加态**（不改写已发布版本）：`dropped_at`（冲突裁定丢弃）、
  `suspended_at`（来源撤回暂停）。两者只影响“新引用”：后续发布与新训练锁。
- **冲突** `conflict.status`：`open` → `resolved`。冲突双方保持 `approved`
  并存，只有显式裁定（keep/drop + 理由）才让被丢弃方退出后续发布；
  任何流程不得悄悄选定。
- **证据来源** `source.status`：`active` → `retracted`。撤回沿依赖链暂停
  新引用，旧版本与旧训练锁原样保留、仍可复现。
- **词表版本**：`v1, v2, …` 顺序发布，发布后深冻结，内容哈希可校验。
- **训练锁**：锁定版本、物种面板、缺失策略（`on_missing: skip|placeholder|error`）
  与冲突策略（`on_conflict: error|exclude`，默认 `error`），清单哈希在重建时复核。
- **实验标记**：`vocab-impact`（新版本差异波及）、`retraction-impact`
  （撤回波及），只标记不改动。

## 关键不变量

1. 已发布版本不可变；数据库修订只产生新版本，旧实验输入可逐 token 复现。
2. 自动导入的候选必须过规则校验与专家复核（复核人+理由）才进入词表。
3. 冲突并存可见；未决冲突默认阻断新训练锁，显式 `exclude` 或裁定才可继续。
4. 撤回不删除旧产物；新引用沿依赖链被暂停。
5. 未公开物种（`visibility: restricted`）对未授权项目只计数、不泄露标识。

## 本地检查

运行 `npm test`。
