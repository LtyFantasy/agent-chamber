export const API_PREFIX = '/api/v1';

/**
 * 系统 actor 哨兵 id（ActorUnification migration 1781364902335 播种的 actors 行，
 * display_name='system'；平台系统消息（失败回执等）以此为发送者，profile 查询按
 * senderId 命中 type='system'，展示为系统消息——与消息 type=SYSTEM 语义一致）。
 *
 * 全仓单源（review-0831 任务 e013af33 收敛）：roundtable.service / webhook.service
 * 及测试统一引用本常量，禁止散落裸 uuid 字面量。migration 播种值为冻结历史，不改。
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
export const JWT_EXPIRES_IN = '15m';
export const REFRESH_TOKEN_EXPIRES_IN = '7d';
export const SSE_HEARTBEAT_INTERVAL_MS = 30000;

/**
 * headingPath 的层级分隔符（DocSpace markdown-chunker 契约）。
 *
 * headingPath 形如 "一级标题 § 二级标题 § 三级标题"，由 chunker 写入、全链路只读。
 * 这是 chunker join 使用的实际结构 token；消费方禁止按裸字符 `§` 拆分，
 * 必须使用 {@link extractLastHeadingSegment} 取得末段，避免标题正文中的 `§3.2`
 * 被误判为层级边界。
 */
export const HEADING_PATH_SEPARATOR = ' § ';

/**
 * 取得 headingPath 的末段标题文本。
 *
 * 契约：只按 {@link HEADING_PATH_SEPARATOR}（带两侧空格）识别层级边界，并去除
 * 末段两侧空白。已知边界：标题正文自身包含带两侧空格的 ` § ` 仍会被拆分——
 * 这是字符串反解析的理论极限。
 *
 * **⚠️ 债 A 落地后（doc_sections.heading_text 独立列）禁止用于取标题**：新代码
 * 一律直读 headingText 列（chunker 清洗直写，标题正文中的 ` § ` 完整保留）。
 * 本 helper 仅作**兼容兜底**（旧数据/旧服务端无 headingText 列时的降级渲染，
 * 如 platform-mcp read-doc 的双通道 renderer）。
 *
 * @param headingPath - chunker 生成的完整 headingPath
 * @returns 最末级标题文本；空路径或无有效末段时返回空字符串
 */
export function extractLastHeadingSegment(headingPath: string): string {
  return headingPath.split(HEADING_PATH_SEPARATOR).pop()?.trim() ?? '';
}
