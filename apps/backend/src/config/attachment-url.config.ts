/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件短时签名 URL（capability URL）：独立密钥签发/校验的公开读取凭证
 *
 * [代码职责]
 *   - 提供 `attachmentUrl.secret`（JWT HS256 签名密钥）与
 *     `attachmentUrl.ttlDefaultSeconds`（未显式指定 ttlSeconds 时的生效时长）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments — 签名 URL 端点契约与错误码语义
 *   - 补充: DEPLOY.md — 生产密钥配置（ATTACHMENT_URL_SECRET 必须强随机）
 *
 * [关键不变量]
 *   - 生产（NODE_ENV=production）缺失 / 占位 / 与 JWT_SECRET 同值 → 启动即崩
 *     （fail-fast）。理由：同值意味着附件 token 的签名对会话守卫也合法，只剩
 *     payload 形状断言一层防线；黑名单则防"沿用占位值等于无密钥"
 *   - dev/test 保留默认值（本地零配置起步），与 jwt.config 同款回退策略
 *   - 本密钥**只签附件 URL**，会话 token 密钥（jwt.secret）不得复用——两族凭证的
 *     密钥隔离是 security B1 双管之一（另一管是守卫侧 session 形状断言）
 *
 * [关联代码]
 *   - config/jwt.config.ts — 同构先例（占位黑名单 + 生产 fail-fast）
 *   - modules/attachments/attachment-signed-url.service.ts — 唯一消费方（sign/verify）
 *   - common/guards/jwt-or-api-key.guard.ts, modules/auth/jwt.strategy.ts —
 *     会话守卫的 payload 形状断言（密钥隔离失效时的第二道防线）
 *
 * [持久踩坑]
 *   P2-#1(JWT_SECRET 静默回退占位值): 密钥缺失时静默回退公开硬编码默认值 =
 *     可伪造任意凭证。安全方向: 生产启动期 fail-fast，不回退。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';

/**
 * 已知占位/默认密钥黑名单（生产环境必须拒绝）。
 * 覆盖本文件历史默认值——若 .env 缺失，工厂会回退到该默认值，
 * 因此它本身也必须被视为"不可用占位值"。
 */
const PLACEHOLDER_SECRETS = ['default-attachment-url-secret-change-me'];

/** 签名 URL 未指定 ttlSeconds 时的默认生效时长（秒） */
const DEFAULT_TTL_SECONDS = 300;

/**
 * 判断密钥是否不可用（缺失 / `change-me` 前缀 / 已知默认值）。
 * rationale：docker-compose 用 `${ATTACHMENT_URL_SECRET:-change-me-…}` 兜底、
 * .env.example 用 `change-me-…` 占位，若被直接沿用进生产等于无密钥；
 * 这里把"缺失"与"占位"统一判定，启动即崩而非静默回退默认值。
 */
function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return true;
  if (value.startsWith('change-me')) return true;
  return PLACEHOLDER_SECRETS.includes(value);
}

export default registerAs('attachmentUrl', () => {
  // 生产环境 fail-fast（照 jwt.config:45-61 同构）：
  // ① 缺失或占位 → 抛（启动即崩，不静默回退默认值）；
  // ② 与 JWT_SECRET 同值 → 抛（运维防呆：附件 token 与会话 token 必须异钥，
  //    否则附件 token 的签名对会话守卫也合法，密钥隔离防线消失）。
  // development/test 保留默认值便于本地开发与测试（e2e 刻意用同值构造
  // "签名合法但 payload 无 sub" 场景，见 attachments.e2e-spec.ts signed-url 段）。
  if (process.env.NODE_ENV === 'production') {
    if (isPlaceholderSecret(process.env.ATTACHMENT_URL_SECRET)) {
      throw new Error(
        'ATTACHMENT_URL_SECRET is missing or set to a known placeholder value. ' +
          'Set a strong random secret for production (see .env.example).',
      );
    }
    if (process.env.ATTACHMENT_URL_SECRET === process.env.JWT_SECRET) {
      throw new Error(
        'ATTACHMENT_URL_SECRET must differ from JWT_SECRET. ' +
          'Signed attachment URLs are a separate credential family; sharing the ' +
          'session signing key removes the key-isolation defense (see .env.example).',
      );
    }
  }

  // TTL 解析防御：NaN/非正数一律回落默认值（避免 expiresIn=NaN 让签发路径 500）
  const rawTtl = parseInt(
    process.env.ATTACHMENT_SIGNED_URL_TTL_DEFAULT || String(DEFAULT_TTL_SECONDS),
    10,
  );
  const ttlDefaultSeconds = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEFAULT_TTL_SECONDS;

  return {
    secret: process.env.ATTACHMENT_URL_SECRET || 'default-attachment-url-secret-change-me',
    /**
     * 默认 TTL（秒），文档化区间 60..3600 与 DTO @Min/@Max 同口径；
     * 越界的 env 值原样生效（运维责任，不在配置层静默钳制——钳制会掩盖误配）。
     */
    ttlDefaultSeconds,
  };
});
