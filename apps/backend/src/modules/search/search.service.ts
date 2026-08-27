/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.6 (全文搜索)
 *   - 补充: docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] B-50(列表权限过滤) D5(统一权限重构) B-55(QueryBuilder orderBy select 风险) R1(公共解析收口)
 *
 * [铁律关联] #4(文档优先) #9(代理层透传) #17(测试契约) #6(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——withDeleted 只解除过滤不选
 *       列。本文件消息 sender 解析一律经 ActorProfileService.resolveProfiles（含 deletedAt/
 *       type/name），真孤儿不进 map 由调用方兜底 'System'；禁止散落 queryBuilder 或自建
 *       agents/users 查询（收口见 common/services/actor-profile.service.ts，契约 docs/spec.md
 *       §1）。2026-08-26 统一批 A2。
 *   B-55: searchMessages/searchTasks 中 skip/take + innerJoin + orderBy('rank')，
 *          若未 addSelect rank 会触发 TypeORM 0.3.30 distinctAlias 类错误。
 *          当前已显式 addSelect ts_rank(...) AS rank；单测锁住该约束防回归。
 *          见 memory/2026-07-02.md §1。
 *   B-50: SearchService 曾内联私有白名单方法，与 Policy 规则不同步，缺少
 *          invited/editor 条件。修复：统一注入 AccessQueryService，白名单规则
 *          只维护一份。见 docs/architecture.md §7.2。
 *   S1: searchMessages/searchTasks 曾直接 spread entity 返回完整对象，
 *       导致 Message content/metadata/mentions/editHistory 及 Task description
 *       全文/customFields 泄露到搜索结果。修复：显式构造摘要对象（contentSnippet
 *       ≤200 字符 / descriptionSnippet ≤200 字符），senderType/senderName 批量注入，
 *       boardId/topicId 批量推断。见 memory/2026-07-25.md。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSearchService } from '../docspace/doc-search.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { SearchQueryDto, SearchType } from './dto';
import type { PaginatedResponse, DocSearchHitWithSpace } from '@agent-chamber/shared';

/** 全局搜索文档一路的固定返回条数（对齐空间内搜索 MAX_LIMIT=20，非分页 MVP 决策） */
const GLOBAL_DOC_SEARCH_LIMIT = 20;

/**
 * 消息搜索结果（摘要视图）
 *
 * 与 Message 实体不同：仅包含搜索场景所需的最小字段集合，
 * 内容截断为 contentSnippet（≤200 字符），senderType/senderName
 * 由 Service 层批量注入。
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
  /** 软删时间；非空 = 发送者已删除，senderName 仍可显示（历史归因保留，契约 docs/spec.md §1） */
  senderDeletedAt?: string | null;
  /** 消息类型 */
  type: string;
  /** 创建时间 */
  createdAt: Date;
  /** 消息内容截断片段（≤200 字符，不含省略号） */
  contentSnippet: string;
  /** 搜索高亮摘要，关键词用 <<< >>> 标记 */
  highlight: string | null;
}

/**
 * 任务搜索结果（TaskSummary + boardId/topicId + 摘要字段）
 *
 * 不暴露 description 全文/customFields，改为返回
 * descriptionSnippet（≤200 字符截断）。
 */
export interface TaskSearchResult {
  /** 任务 ID */
  id: string;
  /** 所属列 ID */
  listId: string;
  /** 任务标题 */
  title: string;
  /** 任务状态 */
  status: string;
  /** 优先级 */
  priority: string;
  /** 分配对象 ID */
  assigneeId: string | null;
  /** 分配对象类型 */
  assigneeType: string | null;
  /** 排序位置 */
  position: number;
  /** 截止日期 */
  dueDate: Date | null;
  /** 标签列表 */
  labels: string[] | null;
  /** 里程碑 ID */
  milestoneId: string | null;
  /** 所属看板 ID（由 listId 推断填充） */
  boardId: string | null;
  /** 关联话题 ID（由 list → board 推断填充） */
  topicId: string | null;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 任务描述截断片段（≤200 字符，无描述时为 null） */
  descriptionSnippet: string | null;
  /** 搜索高亮摘要，关键词用 <<< >>> 标记 */
  highlight: string | null;
}

/** 搜索总响应 */
export interface SearchResponse {
  messages: PaginatedResponse<MessageSearchResult> | null;
  tasks: PaginatedResponse<TaskSearchResult> | null;
  /** 文档搜索结果（非分页数组，固定 limit 20） */
  docs: DocSearchHitWithSpace[] | null;
}

/**
 * 全文搜索 Service
 *
 * 基于 PostgreSQL tsvector + GIN 索引实现高性能全文搜索。
 * 触发器自动维护 search_vector（见 migration AddSearchVectorTriggers）。
 *
 * 权限模型：
 * - 通过 AccessQueryService 计算当前 actor 可访问的 topic/board/docspace 白名单
 * - 再用白名单 IN 过滤消息/任务，文档一路复用 DocSearchService（同款白名单语义）
 */
@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Doc)
    private docRepo: Repository<Doc>,
    private accessQuery: AccessQueryService,
    private docSearchService: DocSearchService,
    private actorProfileService: ActorProfileService,
  ) {}

  /**
   * 执行全文搜索
   * @param dto 搜索查询参数
   * @returns 按类型分组的分页搜索结果（docs 一路为非分页数组）
   */
  async search(dto: SearchQueryDto, actor?: UnifiedActor): Promise<SearchResponse> {
    const { q, type, page = 1, pageSize = 20 } = dto;

    const promises: [
      Promise<PaginatedResponse<MessageSearchResult>> | undefined,
      Promise<PaginatedResponse<TaskSearchResult>> | undefined,
      Promise<DocSearchHitWithSpace[]> | undefined,
    ] = [undefined, undefined, undefined];

    if (type === SearchType.ALL || type === SearchType.MESSAGES) {
      promises[0] = this.searchMessages(q, page, pageSize, actor);
    }
    if (type === SearchType.ALL || type === SearchType.TASKS) {
      promises[1] = this.searchTasks(q, page, pageSize, actor);
    }
    if (type === SearchType.ALL || type === SearchType.DOCS) {
      promises[2] = this.searchDocs(q, actor);
    }

    const [messages, tasks, docs] = await Promise.all(promises);

    return {
      messages: messages ?? null,
      tasks: tasks ?? null,
      docs: docs ?? null,
    };
  }

  /**
   * 搜索消息（按相关性排序）
   *
   * 权限过滤：
   * - Admin 可搜索全部
   * - 普通用户只能搜索可访问 topic 下的消息
   *
   * 返回摘要对象而非完整 Message 实体：
   * - contentSnippet 截断 ≤200 字符，不暴露全文/mentions/metadata/editHistory
   * - senderType/senderName 批量查询注入（Message entity 不存储这两个字段）
   */
  private async searchMessages(
    q: string,
    page: number,
    pageSize: number,
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<MessageSearchResult>> {
    const accessibleTopicIds = await this.accessQuery.getAccessibleTopicIds(actor);

    // 1. 构建基础查询
    const qb = this.messageRepo
      .createQueryBuilder('m')
      .addSelect('ts_rank(m.search_vector, plainto_tsquery(:q))', 'rank')
      .innerJoin('m.topic', 't')
      .where('m.search_vector @@ plainto_tsquery(:q)', { q })
      .andWhere('m.deleted_at IS NULL');

    // 2. 非 Admin 用户添加权限过滤
    if (accessibleTopicIds !== null) {
      if (accessibleTopicIds.length === 0) {
        // 没有任何可访问 topic，直接返回空结果
        return this.buildPaginatedResponse([], 0, page, pageSize);
      }
      qb.andWhere('t.id IN (:...accessibleTopicIds)').setParameter(
        'accessibleTopicIds',
        accessibleTopicIds,
      );
    }

    const [entities, total] = await qb
      .orderBy('rank', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    // 3. 批量获取高亮摘要
    const highlights = await this.fetchMessageHighlights(
      entities.map((e) => e.id),
      q,
    );

    // 4. 批量解析发送者信息（一次查询完成，避免 N+1）
    const senderIds = [...new Set(entities.map((e) => e.senderId))];
    const { nameMap, typeMap, deletedAtMap } = await this.resolveSenderInfo(senderIds);

    // 5. 显式构造摘要对象（禁止 spread entity，防止 content/metadata/mentions 等字段泄露）
    const items: MessageSearchResult[] = entities.map((entity) => ({
      id: entity.id,
      topicId: entity.topicId,
      senderId: entity.senderId,
      senderType: typeMap.get(entity.senderId) ?? 'system',
      senderName: nameMap.get(entity.senderId) ?? 'System',
      // 软删信号：非空 = 发送者已删除，senderName 仍可显示（契约 docs/spec.md §1）；
      // 真孤儿（不进 map）兜底 null
      senderDeletedAt: deletedAtMap.get(entity.senderId) ?? null,
      type: entity.type,
      createdAt: entity.createdAt,
      contentSnippet: entity.content.slice(0, 200),
      highlight: highlights.get(entity.id) ?? null,
    }));

    return this.buildPaginatedResponse(items, total, page, pageSize);
  }

  /**
   * 搜索任务（按相关性排序）
   *
   * 权限过滤：
   * - Admin 可搜索全部
   * - 普通用户只能搜索可访问 board 下的任务
   *
   * 返回 TaskSummary + boardId/topicId + highlight + descriptionSnippet，
   * 不暴露 description 全文/customFields。
   */
  private async searchTasks(
    q: string,
    page: number,
    pageSize: number,
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<TaskSearchResult>> {
    const accessibleBoardIds = await this.accessQuery.getAccessibleBoardIds(actor);

    // 1. 构建基础查询
    const qb = this.taskRepo
      .createQueryBuilder('task')
      .addSelect('ts_rank(task.search_vector, plainto_tsquery(:q))', 'rank')
      .innerJoin('task.list', 'bl')
      .innerJoin('bl.board', 'b')
      .leftJoin('b.topic', 'top')
      .where('task.search_vector @@ plainto_tsquery(:q)', { q })
      .andWhere('task.deleted_at IS NULL');

    // 2. 非 Admin 用户添加权限过滤
    if (accessibleBoardIds !== null) {
      if (accessibleBoardIds.length === 0) {
        // 没有任何可访问 board，直接返回空结果
        return this.buildPaginatedResponse([], 0, page, pageSize);
      }
      qb.andWhere('b.id IN (:...accessibleBoardIds)').setParameter(
        'accessibleBoardIds',
        accessibleBoardIds,
      );
    }

    const [entities, total] = await qb
      .orderBy('rank', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    // 3. 批量获取高亮摘要
    const highlights = await this.fetchTaskHighlights(
      entities.map((e) => e.id),
      q,
    );

    // 4. 批量推断 boardId/topicId（通过 listId → board_list → board 链路）
    const boardTopicMap = await this.resolveBoardTopicIds(entities.map((e) => e.listId));

    // 5. 显式构造摘要对象（禁止 spread entity，防止 description 全文/customFields 泄露）
    const items: TaskSearchResult[] = entities.map((entity) => ({
      id: entity.id,
      listId: entity.listId,
      title: entity.title,
      status: entity.status,
      priority: entity.priority,
      assigneeId: entity.assigneeId ?? null,
      assigneeType: entity.assigneeType ?? null,
      position: entity.position,
      dueDate: entity.dueDate ?? null,
      labels: entity.labels ?? null,
      milestoneId: entity.milestoneId ?? null,
      boardId: boardTopicMap.get(entity.listId)?.boardId ?? null,
      topicId: boardTopicMap.get(entity.listId)?.topicId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      descriptionSnippet: entity.description?.slice(0, 200) ?? null,
      highlight: highlights.get(entity.id) ?? null,
    }));

    return this.buildPaginatedResponse(items, total, page, pageSize);
  }

  /**
   * 搜索文档（跨全部可访问 DocSpace）
   *
   * 复用 DocSpace 模块的 DocSearchService（双评分 + 意图融合 + 白名单过滤），
   * limit 固定 20 条（对齐空间内搜索 MAX_LIMIT=20，非分页 MVP 决策）。
   * 命中项补 spaceId（跳转 /docs/:spaceId?doc=:docId 必需）：
   * DocSearchHit 不含 spaceId，按 docId 批量反查 docs 表避免 N+1。
   *
   * 权限过滤：
   * - Admin（getAccessibleDocSpaceIds 返回 null）→ 全量空间
   * - 普通用户 → 可访问空间白名单；空白名单由 DocSearchService 内部短路返回 []
   */
  private async searchDocs(q: string, actor?: UnifiedActor): Promise<DocSearchHitWithSpace[]> {
    const accessibleSpaceIds = await this.accessQuery.getAccessibleDocSpaceIds(actor);
    const hits = await this.docSearchService.search(accessibleSpaceIds, {
      q,
      limit: GLOBAL_DOC_SEARCH_LIMIT,
    });

    if (hits.length === 0) return [];

    // 批量补 spaceId：一次 find 拉齐命中 doc 的空间归属（DocSearchService 已过滤权限，
    // 这里只做归属投影；'' 兜底理论上不可达，防御性保证跳转地址字段恒为 string）
    const docIds = [...new Set(hits.map((h) => h.docId))];
    const docs = await this.docRepo.find({
      select: ['id', 'spaceId'],
      where: { id: In(docIds) },
    });
    const spaceByDocId = new Map(docs.map((d) => [d.id, d.spaceId]));

    return hits.map((hit) => ({
      ...hit,
      spaceId: spaceByDocId.get(hit.docId) ?? '',
    }));
  }

  /**
   * 批量获取消息的高亮摘要
   * @returns Map<messageId, highlight>
   */
  private async fetchMessageHighlights(ids: string[], q: string): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.messageRepo
      .createQueryBuilder('m')
      .select('m.id', 'id')
      .addSelect(
        "ts_headline('simple', m.content, plainto_tsquery(:q), 'StartSel=<<<,StopSel=>>>')",
        'highlight',
      )
      .where('m.id IN (:...ids)', { ids })
      .setParameter('q', q)
      .getRawMany<{ id: string; highlight: string }>();

    return new Map(rows.map((r) => [r.id, r.highlight]));
  }

  /**
   * 批量获取任务的高亮摘要
   * @returns Map<taskId, highlight>
   */
  private async fetchTaskHighlights(ids: string[], q: string): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.taskRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .addSelect(
        "ts_headline('simple', COALESCE(t.title, '') || ' ' || COALESCE(t.description, ''), plainto_tsquery(:q), 'StartSel=<<<,StopSel=>>>')",
        'highlight',
      )
      .where('t.id IN (:...ids)', { ids })
      .setParameter('q', q)
      .getRawMany<{ id: string; highlight: string }>();

    return new Map(rows.map((r) => [r.id, r.highlight]));
  }

  /**
   * 批量解析发送者信息（一次查询完成，避免 N+1）
   *
   * 统一批 A2：改走公共 ActorProfileService（withDeleted 覆盖软删 actor——软删 sender
   * 解析出真名 + 真实类型 + deletedAt，不再是 'System'；真孤儿不进 map，由调用方
   * 以 'System'/'system' 兜底）。
   *
   * @param senderIds 去重后的发送者 ID 列表
   * @returns nameMap（senderId → 显示名称）、typeMap（senderId → 'human' | 'agent' | 'system'）、
   *          deletedAtMap（senderId → 软删 ISO 时间戳或 null）
   */
  private async resolveSenderInfo(senderIds: string[]): Promise<{
    nameMap: Map<string, string>;
    typeMap: Map<string, string>;
    deletedAtMap: Map<string, string | null>;
  }> {
    const nameMap = new Map<string, string>();
    const typeMap = new Map<string, string>();
    const deletedAtMap = new Map<string, string | null>();

    if (senderIds.length === 0) return { nameMap, typeMap, deletedAtMap };

    const profileMap = await this.actorProfileService.resolveProfiles(senderIds);
    for (const [id, profile] of profileMap) {
      nameMap.set(id, profile.name);
      typeMap.set(id, profile.type);
      deletedAtMap.set(id, profile.deletedAt ? profile.deletedAt.toISOString() : null);
    }

    return { nameMap, typeMap, deletedAtMap };
  }

  /**
   * 批量推断 boardId 和 topicId（通过 listId → board_list → board 链路）
   *
   * Task 实体不直接存储 boardId/topicId，需要通过 listId 关联查询。
   * 仿 fetchTaskHighlights 的批量 follow-up 查询模式。
   *
   * @param listIds 去重后的列表 ID 列表
   * @returns Map<listId, { boardId, topicId }>
   */
  private async resolveBoardTopicIds(
    listIds: string[],
  ): Promise<Map<string, { boardId: string; topicId: string | null }>> {
    const result = new Map<string, { boardId: string; topicId: string | null }>();

    if (listIds.length === 0) return result;

    // 通过 board_lists 表 join boards 表，一次查询获取 boardId + topicId
    const rows = await this.taskRepo.manager
      .createQueryBuilder()
      .select('bl.id', 'list_id')
      .addSelect('bl.board_id', 'board_id')
      .addSelect('b.topic_id', 'topic_id')
      .from('board_lists', 'bl')
      .innerJoin('boards', 'b', 'b.id = bl.board_id')
      .where('bl.id IN (:...listIds)', { listIds })
      .getRawMany<{ list_id: string; board_id: string; topic_id: string | null }>();

    for (const row of rows) {
      result.set(row.list_id, {
        boardId: row.board_id,
        topicId: row.topic_id ?? null,
      });
    }

    return result;
  }

  /**
   * 构建标准分页响应
   */
  private buildPaginatedResponse<T>(
    items: T[],
    total: number,
    page: number,
    pageSize: number,
  ): PaginatedResponse<T> {
    const totalPages = Math.ceil(total / pageSize);
    return {
      items,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }
}
