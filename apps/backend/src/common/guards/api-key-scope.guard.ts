/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - API Key scopes 的**执行面**：全局守卫（APP_GUARD）把「按方法 + 元数据覆写」判定出的
 *     所需 scope 与实际 key scopes 比对，不足即 403 + `AGENT_SCOPE_INSUFFICIENT`(1011)
 *
 * [代码职责]
 *   - 判定逻辑一律委托 `common/utils/api-key-scope.ts`（**单一事实来源**），本文件只做：
 *     身份判别（request.agent 存在否）、元数据读取（Reflector）、拒绝响应装配（教学化
 *     message）与归因日志
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.1 —— scope 语义表 + 判定规则 + 豁免清单指针
 *   - 补充: 线上 docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *
 * [关键不变量]
 *   - **只对 API Key 身份生效**：`request.agent` 不存在（human JWT 或 @Public）即放行。
 *     人类 JWT 无 scopes 概念，误判会把整个 web 端打成 403。
 *   - **fail-closed**：`resolveKeyScopes` 返回 null（scopes 缺失/非数组/空/含未知值）→ 403。
 *     禁止"拿不到 scopes 就当全权"（与 SCOPE-FAILOPEN 同源）。
 *   - **注册位次**：必须在 `JwtAuthGuard` **之后**（app.module.ts APP_GUARD 数组），否则
 *     `request.agent` 尚未装配，守卫恒等于直通。
 *   - **方法判定 ≠ 路径判定**：禁止在本文件或工具函数中出现路由字符串清单；读语义 POST
 *     只经 `@AgentScope('read')` 元数据覆写，路由改名不会静默失效。
 *   - OPTIONS 无条件放行是**唯一**旁路；不提供 decorator 级旁路。
 *
 * [关联代码]
 *   - ../utils/api-key-scope.ts — 判定单一事实来源（HTTP 与 WS 共用）
 *   - ../decorators/agent-scope.decorator.ts — 方法判定的显式覆写
 *   - ../../app.module.ts — APP_GUARD 注册位次
 *   - ../../config/agent-scope-exemptions.spec.ts — 豁免面双向相等断言 + 引用者集合断言
 *   - ./api-key-scope.guard.spec.ts — 判定矩阵单测
 *
 * [持久踩坑]
 *   - SCOPE-FAILOPEN(权限判定默认放行): 见 utils/api-key-scope.ts 同条。
 *   - 403 响应不得携带任何**资源状态**信息（不得泄露目标是否存在）：message 只描述
 *     "你的凭证能力不足"与恢复路径，与请求目标无关。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, type ApiKeyScope } from '@agent-chamber/shared';
import { AGENT_SCOPE_KEY } from '../decorators/agent-scope.decorator';
import { hasScope, requiredScopeForMethod, resolveKeyScopes } from '../utils/api-key-scope';

/** guard 消费的 request.agent 形状（api-key-auth.service.ts 装配；按 unknown 取用再收窄） */
interface RequestAgentLike {
  id?: unknown;
  keyPrefix?: unknown;
  permissions?: unknown;
}

@Injectable()
export class ApiKeyScopeGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyScopeGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // WS / RPC 上下文不经本守卫（runner 握手的 scope 判定在 gateway 内显式调用同一工具
    // 函数——见文件头[关联代码]）。此处防御性放行，避免 switchToHttp 误取 socket 对象。
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const agent = request.agent as RequestAgentLike | undefined | null;
    // human JWT / @Public：无 agent 身份 → 无 scopes 概念，放行
    if (!agent) {
      return true;
    }

    const verdict = requiredScopeForMethod(String(request.method ?? 'GET'));
    // 方法维度唯一旁路：OPTIONS 预检
    if (verdict.required === null) {
      return true;
    }
    // 元数据覆写优先于方法判定（只读 handler，不做类级/路径级匹配——保证"一处标注 = 一个方法"，
    // 使豁免清单的双向相等 spec 可以精确扫描源码）
    const override = this.reflector.get<ApiKeyScope | undefined>(
      AGENT_SCOPE_KEY,
      context.getHandler(),
    );
    const required: ApiKeyScope = override ?? verdict.required;

    const scopes = resolveKeyScopes(agent.permissions);
    if (hasScope(scopes, required)) {
      return true;
    }

    // 归因日志（sec 盲区 6）：只记 keyPrefix（对齐决策 9，禁记 hash / 明文）
    this.logger.warn(
      `API Key scope 不足拒访：actor=${String(agent.id)} keyPrefix=${String(
        agent.keyPrefix ?? 'n/a',
      )} method=${String(request.method)} path=${String(request.originalUrl ?? request.url)} required=${required} actual=${
        scopes === null ? '<invalid-or-missing>' : scopes.join('|')
      }`,
    );

    throw new ForbiddenException({
      // 教学化三要素：所需 scope 名 + 恢复指引 + "无法自助"的事实（后者的依据是
      // POST /agents/:id/keys 本身是写端点，恒需 write scope）
      message:
        `Insufficient API key scope: this endpoint requires the '${required}' scope. ` +
        `Ask the human owner of this agent to issue a key that includes '${required}' ` +
        `(or re-issue this key), then retry with the new key. ` +
        `You cannot self-serve this: POST /agents/:id/keys itself requires the 'write' scope, ` +
        `so a read-only key cannot mint a broader key.`,
      code: ErrorCode.AGENT_SCOPE_INSUFFICIENT,
    });
  }
}
