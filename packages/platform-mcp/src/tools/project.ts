/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/platform-mcp.md §2.3（get_topic_digest 契约）
 *   - 补充: 看板任务 fdc1851b（Batch F：MCP 语义工具 token 瘦身）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * MCP 语义工具返回投影（Batch F token 瘦身）
 *
 * 背景：platform-mcp 的消费者是 Agent（按 token 计费上下文），不是人类 UI。
 * 后端 web DTO 中的头像、加入时间等字段对 Agent 无价值，消息全文重复返回
 * （recent + unread 重叠）更会放大上下文占用。本模块集中实现「按 Agent
 * 消费模型做字段投影」的规则，避免 9 个工具各自重复裁剪逻辑。
 */

/** recent 消息 snippet 截断上限（字符）。超出截到此长度并标记 contentTruncated */
export const SNIPPET_MAX_CHARS = 300;

/** 消息投影保留的字段白名单（剔除 senderAvatar/topicId 等人类 UI / 冗余字段） */
const MESSAGE_KEPT_FIELDS = [
  'id',
  'senderId',
  'senderName',
  'senderType',
  'content',
  'replyTo',
  'type',
  'createdAt',
] as const;

/**
 * 投影单条消息：按白名单保留字段（仅拷贝实际存在的字段）。
 *
 * @param msg      - 后端返回的原始消息对象
 * @param truncate - true 时对 content 应用 snippet 截断（仅 recent 用；unread 保持全文）
 * @returns 投影后的消息对象；content 被截断时附加 contentTruncated: true
 */
export function projectMessage(
  msg: Record<string, unknown>,
  truncate: boolean,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of MESSAGE_KEPT_FIELDS) {
    if (msg[field] !== undefined) {
      projected[field] = msg[field];
    }
  }

  // snippet 截断：>300 字符截到 300 + contentTruncated 标记；≤300 原样不加标记。
  // 需要全文的 Agent 自行用原子工具 topic_controller_get_messages 翻页。
  if (
    truncate &&
    typeof projected.content === 'string' &&
    projected.content.length > SNIPPET_MAX_CHARS
  ) {
    projected.content = projected.content.slice(0, SNIPPET_MAX_CHARS);
    projected.contentTruncated = true;
  }

  return projected;
}

/** 投影消息数组（逐条应用 projectMessage） */
export function projectMessages(messages: unknown[], truncate: boolean): Record<string, unknown>[] {
  return messages.map((m) =>
    projectMessage(
      m !== null && typeof m === 'object' ? (m as Record<string, unknown>) : {},
      truncate,
    ),
  );
}

/**
 * 投影 recentMessages 分页对象 { messages, nextCursor, hasMore }。
 *
 * 防御性兼容裸数组形状（旧测试 mock / 上游形状漂移）：裸数组按消息列表投影。
 * 分页对象保留 nextCursor/hasMore 等分页元数据，仅投影 messages 数组。
 *
 * @param page     - GET /topics/:id/messages 的响应
 * @param truncate - 是否对 content 应用 snippet 截断
 */
export function projectMessagesPage(page: unknown, truncate: boolean): unknown {
  if (Array.isArray(page)) {
    return projectMessages(page, truncate);
  }
  if (page !== null && typeof page === 'object') {
    const obj = page as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return { ...obj, messages: projectMessages(obj.messages, truncate) };
    }
  }
  // 无法识别的形状原样透传（保守，不破坏数据）
  return page;
}

/**
 * 投影 topic 详情：
 * - participants[] 每项只保留 { participantId, participantType, name, role, status }
 *   （剔除 avatarUrl/joinedAt/description 等人类 UI 字段）
 * - 剔除顶层 invitedAgentIds（邀请管理信息，速览场景无价值）
 */
export function projectTopic(topic: Record<string, unknown>): Record<string, unknown> {
  const { invitedAgentIds: _invitedAgentIds, ...rest } = topic;
  const projected: Record<string, unknown> = { ...rest };

  if (Array.isArray(projected.participants)) {
    projected.participants = (projected.participants as Array<Record<string, unknown>>).map((p) => {
      const item: Record<string, unknown> = {};
      // 按白名单拷贝（仅保留实际存在的字段，避免补出 undefined 键）
      for (const field of ['participantId', 'participantType', 'name', 'role', 'status'] as const) {
        if (p[field] !== undefined) {
          item[field] = p[field];
        }
      }
      return item;
    });
  }

  return projected;
}

/**
 * 浅拷贝并剔除指定字段（用于 me 等「剔除少数字段、其余原样保留」的投影）。
 *
 * @param obj    - 原始对象
 * @param fields - 要剔除的字段名列表
 */
export function omitFields(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...obj };
  for (const field of fields) {
    delete projected[field];
  }
  return projected;
}

// ─── DocSpace 投影 ───────────────────────────────────────────────

/** 搜索命中保留字段白名单（剔除后端内部字段，仅保留定位与摘要所需） */
const DOC_HIT_KEPT_FIELDS = [
  'docId',
  'docPath',
  'docTitle',
  'headingPath',
  'position',
  'snippet',
  'score',
] as const;

/**
 * 投影单条搜索命中：按白名单保留字段。
 *
 * contentTruncated 标记一并透传（不属白名单，但有价值保留）。
 */
export function projectDocHit(hit: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of DOC_HIT_KEPT_FIELDS) {
    if (hit[field] !== undefined) {
      projected[field] = hit[field];
    }
  }
  // 透传截断标记（非白名单字段但有语义价值）
  if (hit['contentTruncated'] !== undefined) {
    projected['contentTruncated'] = hit['contentTruncated'];
  }
  return projected;
}

/** 投影搜索命中数组 */
export function projectDocHits(hits: unknown[]): Record<string, unknown>[] {
  return hits.map((h) =>
    projectDocHit(h !== null && typeof h === 'object' ? (h as Record<string, unknown>) : {}),
  );
}

/** 文档摘要保留字段（TaskDocLinkItem 投影用） */
const DOC_SUMMARY_KEPT_FIELDS = ['docId', 'path', 'title', 'summary'] as const;

/**
 * 投影单条文档摘要（用于 task.docs 内嵌投影）。
 */
export function projectDocSummary(doc: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of DOC_SUMMARY_KEPT_FIELDS) {
    if (doc[field] !== undefined) {
      projected[field] = doc[field];
    }
  }
  return projected;
}

/** 投影文档摘要数组 */
export function projectDocSummaries(docs: unknown[]): Record<string, unknown>[] {
  return docs.map((d) =>
    projectDocSummary(d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : {}),
  );
}
