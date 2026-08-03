/**
 * 资源 owner 判定 helper（v1.37 owner 代理权限）
 *
 * 视同资源创建者（canManage）的两个条件：
 * 1. creatorId === currentUserId —— 人类直接创建
 * 2. creatorId ∈ myAgentIds —— creator 是当前用户拥有的 agent（owner 代理）
 *
 * 与后端 OwnerProxyService 语义严格同步：人类 owner 对其 agent 创建的
 * Topic / Board / DocSpace（含其下 Task）拥有 creator 级完整权限。
 * myAgentIds 来自 GET /agents 列表（非 admin 只返回自己拥有的 agents），
 * 由页面级 useQuery 拉取后传入，禁止在页面内重复 fetch。
 */
export function isCreatorOrOwner(
  creatorId: string | null | undefined,
  currentUserId: string | null | undefined,
  myAgentIds: string[],
): boolean {
  if (!creatorId || !currentUserId) return false;
  if (creatorId === currentUserId) return true;
  return myAgentIds.includes(creatorId);
}
