/**
 * `ApiKeyScopeGuard` 判定矩阵单测（2026-10-16 卡 72566c2e）。纯单测，不依赖 PG。
 *
 * 覆盖契约（docs/api-definition.md §2.1）：
 * - 只读 key：GET 通 / POST 拒 403+1011 / 标了 `@AgentScope('read')` 的读语义 POST 通
 * - fail-closed：`permissions={}`、`{scopes:[]}`、含未知值 → 403
 * - human JWT（request.agent 缺失）直通；OPTIONS 直通
 * - 非 http 上下文（WS）直通——WS 的 scope 判定在 runner.gateway 内显式做
 * - 403 message 三要素齐备（所需 scope 名 / 恢复指引 / 无法自助）
 */
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@agent-chamber/shared';
import { ApiKeyScopeGuard } from './api-key-scope.guard';
import { AGENT_SCOPE_KEY } from '../decorators/agent-scope.decorator';

/** 构造一个最小 ExecutionContext 替身（http 或非 http） */
function makeContext(
  request: Record<string, unknown>,
  handler: () => void,
  type: 'http' | 'ws' = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

/** 普通 handler（无元数据） */
function plainHandler(): void {
  /* noop */
}

/** 带 `@AgentScope('read')` 元数据的 handler（形状与 SetMetadata 落点一致） */
function readScopedHandler(): void {
  /* noop */
}
Reflect.defineMetadata(AGENT_SCOPE_KEY, 'read', readScopedHandler);

describe('ApiKeyScopeGuard', () => {
  const guard = new ApiKeyScopeGuard(new Reflector());

  const readOnlyAgent = { id: 'agent-1', keyPrefix: 'ask_abcd', permissions: { scopes: ['read'] } };
  const fullAgent = {
    id: 'agent-2',
    keyPrefix: 'ask_efgh',
    permissions: { scopes: ['read', 'write'] },
  };

  describe('只读 key 的判定矩阵', () => {
    it('GET → 放行（方法判定 read）', () => {
      const ctx = makeContext({ method: 'GET', agent: readOnlyAgent }, plainHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('HEAD → 放行', () => {
      const ctx = makeContext({ method: 'HEAD', agent: readOnlyAgent }, plainHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('POST → 403 + code 1011', () => {
      const ctx = makeContext({ method: 'POST', agent: readOnlyAgent }, plainHandler);
      let caught: unknown;
      try {
        guard.canActivate(ctx);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      const response = (caught as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(response.code).toBe(ErrorCode.AGENT_SCOPE_INSUFFICIENT);
      expect(response.code).toBe(1011);
      // 必须数字（all-exceptions.filter 只在 typeof code === 'number' 时透传，否则降级 FORBIDDEN）
      expect(typeof response.code).toBe('number');
    });

    it('DELETE/PATCH/PUT → 403', () => {
      for (const method of ['DELETE', 'PATCH', 'PUT']) {
        const ctx = makeContext({ method, agent: readOnlyAgent }, plainHandler);
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      }
    });

    it("POST 但标了 @AgentScope('read')（读语义豁免端点）→ 放行", () => {
      const ctx = makeContext({ method: 'POST', agent: readOnlyAgent }, readScopedHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('只写 key 的 GET → 403（write 不蕴含 read）', () => {
      const writeOnly = { id: 'agent-3', permissions: { scopes: ['write'] } };
      const ctx = makeContext({ method: 'GET', agent: writeOnly }, plainHandler);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  describe('fail-closed', () => {
    it.each([
      ['permissions = {}', {}],
      ['scopes = []', { scopes: [] }],
      ['scopes 含未知值', { scopes: ['read', 'admin'] }],
      ['permissions = null', null],
      ['permissions = undefined', undefined],
      ['scopes 非数组', { scopes: 'read' }],
    ])('%s → GET 也 403', (_label, permissions) => {
      const agent = { id: 'agent-x', permissions };
      const ctx = makeContext({ method: 'GET', agent }, plainHandler);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  describe('非 API Key 身份与旁路', () => {
    it('human JWT（无 request.agent）→ 直通', () => {
      const ctx = makeContext({ method: 'POST', user: { userId: 'u-1' } }, plainHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('未认证（user/agent 皆无）→ 直通（由上游守卫负责 401）', () => {
      const ctx = makeContext({ method: 'POST' }, plainHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('OPTIONS → 无条件放行（仅读 key 且 POST 语义也不拦）', () => {
      const ctx = makeContext({ method: 'OPTIONS', agent: readOnlyAgent }, plainHandler);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('WS 上下文 → 直通（runner 握手自行判定，见 runner.gateway.ts）', () => {
      const ctx = makeContext({ method: 'POST', agent: readOnlyAgent }, plainHandler, 'ws');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('双权 key 全通', () => {
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        const ctx = makeContext({ method, agent: fullAgent }, plainHandler);
        expect(guard.canActivate(ctx)).toBe(true);
      }
    });
  });

  describe('403 响应体（教学化三要素 + 不构成存在性 oracle）', () => {
    it('message 含所需 scope 名 / 恢复指引 / 无法自助', () => {
      const ctx = makeContext(
        { method: 'POST', agent: readOnlyAgent, url: '/api/v1/tasks' },
        plainHandler,
      );
      let response: Record<string, unknown> = {};
      try {
        guard.canActivate(ctx);
      } catch (e) {
        response = (e as ForbiddenException).getResponse() as Record<string, unknown>;
      }
      const message = String(response.message);
      // ① 所需 scope 名
      expect(message).toContain("'write'");
      // ② 恢复指引（找 owner 签发 / 重签发）
      expect(message).toContain('owner');
      expect(message).toContain('re-issue');
      // ③ 无法自助（POST /agents/:id/keys 自身需 write）
      expect(message).toContain('cannot self-serve');
      expect(message).toContain('POST /agents/:id/keys');
      // 与请求目标无关：不得回显路径/资源信息（否则成为存在性 oracle）
      expect(message).not.toContain('/api/v1/tasks');
    });
  });
});
