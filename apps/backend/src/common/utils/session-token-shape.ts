/**
 * 会话 token 的 payload 形状断言（security B1-A，P2 批 2 双管之一）。
 *
 * 根因（安全评审实证）：会话守卫链把 JWT payload 直接当主键用——
 * `jwt-or-api-key.guard.ts:62-65` 与 `jwt.strategy.ts:25-28` 都是
 * `findOne({ where: { id: payload.sub } })`。当 token **没有 sub** 时
 * `id === undefined`，TypeORM 默认行为（`invalidWhereValuesBehavior` 未收紧）
 * 是**静默丢弃该 WHERE 条件**，于是查询退化为"users 表任意一条"，命中首条用户
 * → 认证绕过。附件短时签名 URL 的 token（`{aid, var, scope}`）正好无 sub，
 * 若两族凭证签名密钥一旦同值（或用同一密钥签发），就能直接换取会话身份。
 *
 * 防线分工（双管齐下，任一条单独成立即可阻断）：
 * ① 密钥隔离：附件 URL 用独立 `ATTACHMENT_URL_SECRET`（config/attachment-url.config.ts
 *    生产拒绝与 JWT_SECRET 同值）；
 * ② 本断言：在**任何 DB 查询之前**确认 payload 具备非空字符串 `sub`——
 *    guard 侧失败按"Bearer 分支不成立"处理（继续 API Key 兜底，最终 401），
 *    strategy 侧抛 TOKEN_INVALID。
 *
 * 存量会话 token 全部带 sub（auth.service generateTokens），零兼容影响。
 *
 * @param payload 已验签的 JWT payload（形状不可信，故按 unknown 处理）
 * @returns true 当且仅当 payload 是对象且 `sub` 为非空字符串
 */
export function hasSessionSubject(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const sub = (payload as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0;
}
