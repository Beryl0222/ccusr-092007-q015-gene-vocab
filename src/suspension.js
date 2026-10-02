/**
 * 暂停（suspension）判定：来源被撤回后，沿依赖链传递。
 * 依赖方向：source -> gene -> membership；source -> supersedes。
 * 基因被暂停，其成员关系视同暂停；成员关系被暂停不影响基因本体。
 * 判定是“当前治理状态”的读时叠加，不改写任何已发布版本。
 */
export function isGeneSuspended(store, stableId) {
  const gene = store.genes.get(stableId);
  return Boolean(gene?.suspended_at);
}

export function isMembershipSuspended(store, membership) {
  if (!membership) return false;
  if (membership.suspended_at) return true;
  return isGeneSuspended(store, membership.stable_id);
}

export function isSupersedesSuspended(relation) {
  return Boolean(relation?.suspended_at);
}

/** 版本条目的成员是否处于暂停态（成员关系或基因本体被暂停）。 */
export function isEntryMemberSuspended(store, member) {
  if (isGeneSuspended(store, member.stable_id)) return true;
  if (member.relation_id) {
    const membership = store.memberships.get(member.relation_id);
    if (isMembershipSuspended(store, membership)) return true;
  }
  return false;
}
