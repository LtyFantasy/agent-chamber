/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - MCP Agent 消费模型投影与共用文本截断
 *
 * [代码职责]
 *   - 集中投影消息、话题与 DocSpace 摘要；提供共用 truncateField
 *
 * [权威文档]
 *   - 主文档: 线上 docs/integrations/platform-mcp.md §2.3 — digest 字段投影/截断/去重
 *   - 补充: 线上 docs/api-definition.md §6.11 — 上游 MessageAttachment 投影
 *
 * [关键不变量]
 *   - 只拷贝上游实际存在的白名单字段；附件数组完整保留，不派生 URL/TTL 或裁剪条目
 *   - recent 仅截断正文，unread 全文；maxChars=0 不截断，其余按字符裸 slice
 *   - Batch F（任务 fdc1851b）剔除人类 UI 字段；共用 truncateField 保持调用方截断语义
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/get-topic-digest.ts — recent/unread 共用投影
 *   - packages/platform-mcp/src/tools/get-topic-digest.spec.ts — 附件与截断/标读合同
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
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

/**
 * 通用字段截断（plan forge-jubilee-robin WS-C 从 projectMessage 提取，行为不变）。
 *
 * 语义：
 * - slice 裸截断，无省略号
 * - maxChars=0 是「不截断」哨兵，跳过
 * - 仅 typeof string 的字段参与——无 content 的 task 型 activity 天然豁免
 * - 标记命名统一 = `{field}Truncated`（content → contentTruncated），挂条目级
 *
 * @param obj      - 目标对象（原地修改）
 * @param field    - 要截断的字段名
 * @param maxChars - 截断上限（字符）；0 = 不截断返全文
 */
export function truncateField(obj: Record<string, unknown>, field: string, maxChars: number): void {
  if (
    maxChars !== 0 &&
    typeof obj[field] === 'string' &&
    (obj[field] as string).length > maxChars
  ) {
    obj[field] = (obj[field] as string).slice(0, maxChars);
    obj[`${field}Truncated`] = true;
  }
}

/** 消息投影保留的字段白名单（剔除 senderAvatar/topicId 等人类 UI / 冗余字段） */
const MESSAGE_KEPT_FIELDS = [
  'id',
  'senderId',
  'senderName',
  'senderType',
  'content',
  /** 上游已投影的附件发现元数据原样保留，正文 snippet 不影响附件。 */
  'attachments',
  'replyTo',
  'type',
  'createdAt',
] as const;

/**
 * 投影单条消息：按白名单保留字段（仅拷贝实际存在的字段）。
 * attachments 沿用上游数组；不解析正文、不重算 URL/TTL，也不为旧后端补字段。
 *
 * @param msg      - 后端返回的原始消息对象
 * @param truncate - true 时对 content 应用 snippet 截断（仅 recent 用；unread 保持全文）
 * @param maxChars - 截断上限（字符），缺省 SNIPPET_MAX_CHARS(300)；传 0 表示不截断返全文
 * @returns 投影后的消息对象；content 被截断时附加 contentTruncated: true
 */
export function projectMessage(
  msg: Record<string, unknown>,
  truncate: boolean,
  maxChars: number = SNIPPET_MAX_CHARS,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of MESSAGE_KEPT_FIELDS) {
    if (msg[field] !== undefined) {
      projected[field] = msg[field];
    }
  }

  // snippet 截断：超过 maxChars（缺省 300）截到该长度 + contentTruncated 标记；
  // ≤maxChars 原样不加标记；maxChars=0 是「不截断」哨兵（get_topic_digest 的
  // maxContentLength=0 语义），跳过截断返全文。
  // 需要全文的 Agent 自行用原子工具 topic_controller_get_messages 翻页。
  if (truncate) {
    truncateField(projected, 'content', maxChars);
  }

  return projected;
}

/**
 * 投影消息数组（逐条应用 projectMessage）。
 *
 * @param messages - 原始消息数组
 * @param truncate - 是否对 content 应用 snippet 截断
 * @param maxChars - 截断上限（字符），缺省 SNIPPET_MAX_CHARS；0 = 不截断返全文
 */
export function projectMessages(
  messages: unknown[],
  truncate: boolean,
  maxChars: number = SNIPPET_MAX_CHARS,
): Record<string, unknown>[] {
  return messages.map((m) =>
    projectMessage(
      m !== null && typeof m === 'object' ? (m as Record<string, unknown>) : {},
      truncate,
      maxChars,
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
 * @param maxChars - 截断上限（字符），缺省 SNIPPET_MAX_CHARS；0 = 不截断返全文
 */
export function projectMessagesPage(
  page: unknown,
  truncate: boolean,
  maxChars: number = SNIPPET_MAX_CHARS,
): unknown {
  if (Array.isArray(page)) {
    return projectMessages(page, truncate, maxChars);
  }
  if (page !== null && typeof page === 'object') {
    const obj = page as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return { ...obj, messages: projectMessages(obj.messages, truncate, maxChars) };
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
  // v1.42 批次 C3：可解释性透出——路由/任务链接加权来源（后端仅在存在 boost 时产出该键，原样透传）
  'boosts',
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
  // 透传重排标记（v1.85.0 批次 3）：调用方据此知道"这条命中的页内位置由模型排序决定"
  // （**只在重排启用且成功时出现**；缺省不出现 = SQL 序）
  if (hit['reranked'] === true) {
    projected['reranked'] = true;
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
