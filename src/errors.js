/**
 * 治理后端的统一错误类型。code 用于程序化判断，details 携带结构化上下文
 * （如冲突编号、被暂停的词表项），便于调用方向研究者展示依据。
 */
export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.details = details;
  }
}

export const CODES = Object.freeze({
  VALIDATION: 'validation-failed',
  NOT_FOUND: 'not-found',
  BATCH_MISMATCH: 'batch-mismatch',
  CANDIDATE_STATE: 'candidate-state',
  CONFLICT_OPEN: 'conflict-open',
  CONFLICT_STATE: 'conflict-state',
  SUSPENDED: 'suspended-reference',
  FORBIDDEN: 'forbidden',
  UNKNOWN_GROUP: 'unknown-group',
  MISSING_SLOT: 'missing-slot',
  MANIFEST_DIVERGED: 'manifest-diverged',
  SOURCE_STATE: 'source-state',
});
