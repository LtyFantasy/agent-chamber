/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Avatars（Wave 3 补充契约）
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释强制)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { API_PREFIX } from '@agent-chamber/shared';

/**
 * 头像分发短链模板（GET /avatars/:actorId.svg 公开端点，image/svg+xml）。
 *
 * 全仓单源（review-0831 任务 e013af33 收敛）：avatar.service 写、user.service /
 * agent.service 校验（dto.avatar 是否本站短链 → 决定 avatar_svg 保留/清除）统一
 * 经 {@link buildAvatarUrl} 构造，禁止散落 `/api/v1/avatars/...` 手拼字面量。
 * 模板基于 shared API_PREFIX 构造，前缀变更自动跟随。
 */
export const AVATAR_URL_TEMPLATE = `${API_PREFIX}/avatars/:actorId.svg`;

/**
 * 按 actorId 构造头像分发短链（写/校验共用入口）。
 *
 * @param actorId 目标 actor UUID
 * @returns 形如 `/api/v1/avatars/<actorId>.svg` 的短链
 */
export function buildAvatarUrl(actorId: string): string {
  return AVATAR_URL_TEMPLATE.replace(':actorId', actorId);
}
