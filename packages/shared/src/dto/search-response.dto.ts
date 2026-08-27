import type { PaginatedResponse } from '../interfaces';
import type { TaskSummary } from './task-response.dto';
import type { DocSearchHit } from './docspace-response.dto';

/**
 * 搜索类型
 */
export type SearchType = 'all' | 'messages' | 'tasks' | 'docs';

/**
 * 搜索查询
 */
export interface SearchQuery {
  /** 搜索关键词 */
  q: string;
  /** 搜索类型 */
  type?: SearchType;
  /** 页码 */
  page?: number;
  /** 每页数量 */
  pageSize?: number;
}

/**
 * 消息搜索结果（摘要视图，不含消息全文/元数据/提及/编辑历史）
 *
 * 与 Message DTO 不同：本接口仅返回搜索场景所需的最小字段集合，
 * 内容截断为 contentSnippet（≤200 字符），senderType/senderName
 * 由 Service 层通过批量查询注入。
 */
export interface MessageSearchResult {
  /** 消息 ID */
  id: string;
  /** 所属话题 ID */
  topicId: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者类型（human / agent / system），Service 层注入 */
  senderType: string;
  /** 发送者名称，Service 层注入 */
  senderName: string;
  /** 软删时间；非空 = 发送者已删除，senderName 仍可显示（历史归因保留） */
  senderDeletedAt?: string | null;
  /** 消息类型 */
  type: string;
  /** 创建时间 */
  createdAt: string | Date;
  /** 消息内容截断片段（≤200 字符，不含省略号） */
  contentSnippet: string;
  /** 搜索高亮摘要，关键词用 <<< >>> 标记 */
  highlight: string | null;
}

/**
 * 任务搜索结果（TaskSummary + 摘要字段）
 *
 * 与 TaskSummary DTO 的区别：不暴露 description 全文/customFields，
 * 改为返回 descriptionSnippet（≤200 字符截断）；boardId/topicId
 * 由 Service 层批量推断填充。
 */
export interface TaskSearchResult extends TaskSummary {
  /** 搜索高亮摘要，关键词用 <<< >>> 标记 */
  highlight: string | null;
  /** 任务描述截断片段（≤200 字符，无描述时为 null） */
  descriptionSnippet: string | null;
}

/**
 * 全局搜索结果中的文档命中项
 *
 * DocSearchHit 本身不含 spaceId（空间内搜索的调用方已知所属空间）；
 * 全局搜索需要跳转目标 `/docs/:spaceId?doc=:docId`，由 SearchService
 * 在命中后批量补全 spaceId（见 search.service.ts searchDocs）。
 */
export interface DocSearchHitWithSpace extends DocSearchHit {
  /** 所属 DocSpace ID */
  spaceId: string;
}

/**
 * 搜索结果聚合
 */
export interface SearchResult {
  /** 消息搜索结果 */
  messages: PaginatedResponse<MessageSearchResult> | null;
  /** 任务搜索结果 */
  tasks: PaginatedResponse<TaskSearchResult> | null;
  /**
   * 文档搜索结果（非分页，固定 limit 20，与空间内搜索同构）
   *
   * 复用 DocSearchService.search（无 count/offset 分页语义），
   * 全局搜索暂不做文档分页（MVP 决策，见 v1.48.0 plan）。
   */
  docs: DocSearchHitWithSpace[] | null;
}
