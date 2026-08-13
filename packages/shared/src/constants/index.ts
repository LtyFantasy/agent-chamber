export const API_PREFIX = '/api/v1';
export const JWT_EXPIRES_IN = '15m';
export const REFRESH_TOKEN_EXPIRES_IN = '7d';
export const SSE_HEARTBEAT_INTERVAL_MS = 30000;

/**
 * headingPath 的层级分隔符（DocSpace markdown-chunker 契约）。
 *
 * headingPath 形如 "一级标题§二级标题§三级标题"，由 chunker 写入、全链路只读。
 * 消费方：backend reconstructContent / getSection 标题行还原、platform-mcp
 * read_doc 节标题渲染、web scrollToHeading。类型系统够不着的跨层字符串契约，
 * 收敛为常量避免各方裸写字面量漂移。
 */
export const HEADING_PATH_SEPARATOR = '§';
