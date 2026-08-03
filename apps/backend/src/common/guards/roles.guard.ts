/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *
 * [踩坑索引] D5(RolesGuard修复)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: RolesGuard 原只检查 req.user.role，API Key 认证的 Agent 无 user 对象
 *       → @Roles(ADMIN) 对 Agent 永远失效。修复：增加 req.agent 分支处理。
 *       见 memory/2026-06-05.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, ErrorCode } from '@agent-chamber/shared';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * 角色守卫：支持 JWT 用户和 API Key Agent 双身份
 *
 * - JWT 用户：从 req.user.role 获取角色
 * - Agent：当前阶段 Agent 无 role 字段，视为非 admin
 *   未来可通过 API Key permissions 扩展 'admin' scope
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // JWT 用户：从 user.role 获取
    if (request.user?.role && requiredRoles.includes(request.user.role)) {
      return true;
    }

    // Agent：当前阶段 Agent 不能访问 @Roles(ADMIN) 端点
    // 如需允许，可扩展 API Key permissions 包含 'admin' scope
    if (request.agent) {
      throw new ForbiddenException({
        message: 'Permission denied: Agent cannot access admin endpoints',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    throw new ForbiddenException({
      message: 'Permission denied: insufficient role',
      code: ErrorCode.PERMISSION_DENIED,
    });
  }
}
