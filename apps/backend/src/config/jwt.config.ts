/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Auth / JWT)
 *   - 补充: DEPLOY.md (生产环境密钥配置)
 *
 * [踩坑索引] P2-#1(JWT 密钥静默回退硬编码默认值)
 *
 * [铁律关联] #11(注释) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   P2-#1: JWT_SECRET 缺失时静默回退公开硬编码字符串，可伪造任意角色 token。
 *          修复：NODE_ENV=production 下缺失/占位值黑名单双拒，启动即崩；
 *          development 保留默认值便于本地开发。见 memory/2026-08-02.md §批次 A1。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';

/**
 * 已知占位/默认密钥黑名单（生产环境必须拒绝）。
 * 覆盖本文件历史默认值——若 .env 缺失，工厂会回退到这两个默认值，
 * 因此它们本身也必须被视为"不可用占位值"。
 */
const PLACEHOLDER_SECRETS = ['default-jwt-secret-change-me', 'default-refresh-secret-change-me'];

/**
 * 判断密钥是否不可用（缺失 / `change-me` 前缀 / 已知默认值）。
 * rationale：docker-compose 用 `${JWT_SECRET:-change-me-in-production}` 兜底、
 * .env.example 用 `change-me-...` 占位，若被直接沿用进生产等于无密钥；
 * 这里把"缺失"与"占位"统一判定，启动即崩而非静默回退默认值。
 */
function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return true;
  if (value.startsWith('change-me')) return true;
  return PLACEHOLDER_SECRETS.includes(value);
}

export default registerAs('jwt', () => {
  // 生产环境 fail-fast：缺失或占位密钥直接 throw（启动即崩，不静默回退）。
  // development 保留默认值便于本地开发；走 setup.sh 的用户已随机生成密钥，不受影响。
  if (process.env.NODE_ENV === 'production') {
    if (isPlaceholderSecret(process.env.JWT_SECRET)) {
      throw new Error(
        'JWT_SECRET is missing or set to a known placeholder value. ' +
          'Set a strong random secret for production (see .env.example).',
      );
    }
    if (isPlaceholderSecret(process.env.JWT_REFRESH_SECRET)) {
      throw new Error(
        'JWT_REFRESH_SECRET is missing or set to a known placeholder value. ' +
          'Set a strong random secret for production (see .env.example).',
      );
    }
  }

  return {
    secret: process.env.JWT_SECRET || 'default-jwt-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '2h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  };
});
