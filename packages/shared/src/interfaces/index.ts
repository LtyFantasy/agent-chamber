/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md §4.1 (前后端共享类型)
 *   - 补充: docs/api-definition.md §2.2 (分页响应格式)
 *
 * [踩坑索引] D6(PaginatedResponse格式不一致)
 *
 * [铁律关联] #6(类型前置) #11(注释强制)
 *
 * [详细踩坑]
 *   D6: shared 包的 PaginatedResponse 曾定义为 {data, pagination} 格式，但
 *       后端所有 service 实际返回 {items, total, page, pageSize, ...} 格式，
 *       前端也按 items 格式解析。UserService.findAll 误用 shared 包类型导致
 *       前端 data?.items 拿不到数据，显示"暂无用户"。修复：统一为 items 格式，
 *       前端从 shared 包 import，不再冗余定义。见 memory/2026-06-08.md §D6
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 修改本文件中任何接口 → 必须同步检查 apps/web/src/types/index.ts 和
 *     所有后端 service 的返回类型是否一致
 *   □ 修改 PaginatedResponse → 必须同步检查所有 list API 的返回结构
 * =============================================================================
 */

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  requestId: string;
}

/**
 * 分页响应标准格式
 * @warning 所有后端 list 接口必须严格遵循此结构返回，前端按此解析
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}
