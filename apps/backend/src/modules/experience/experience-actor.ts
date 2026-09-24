/**
 * 经验库（Experience Base）统一身份谓词（叶子模块，无 Nest 依赖）
 *
 * 为什么单独一个文件：`isAdmin` 被**两个** service 需要（`experience.service.ts` 的写/终审/
 * suspect 闸门 + `experience-member.service.ts` 的成员管理闸门）。放在任一 service 里都会
 * 形成 service ↔ service 的循环 import；抽到叶子文件是唯一干净解（本文件不 import 任何
 * service，故可被任意一侧安全引用）。
 *
 * ⚠️ 判定口径必须与 `RolesGuard` 一致：`roles.guard.ts` 对 **agent 硬抛 1009**（agent 无
 * admin 概念），故此处要求 `type === HUMAN` 且 `role === ADMIN` —— 只查 role 会把
 * `role` 字段被污染的 agent 判成 admin。
 */
import { ActorType, UserRole } from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';

/**
 * admin 判定（仅人类 admin；agent 无 admin 概念，与 RolesGuard 同口径）
 *
 * @param actor 统一身份（可为 null：未认证/匿名一律 false）
 * @returns true = 人类且角色为 admin
 */
export function isAdmin(actor: UnifiedActor | null): boolean {
  return !!actor && actor.type === ActorType.HUMAN && actor.role === UserRole.ADMIN;
}
