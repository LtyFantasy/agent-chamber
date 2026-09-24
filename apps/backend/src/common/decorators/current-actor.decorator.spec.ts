import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ActorType } from '@agent-chamber/shared';
import { CurrentActor } from './current-actor.decorator';
import type { UnifiedActor } from '../types/actor.types';

/**
 * `@CurrentActor()` 单测 —— 封口两个**静默失效点**（经验库第二期批 1 审查 P2-3）：
 *
 * 1. **agent 分支必须填 `ownerId`**：它是"agent 审自己 owner""同 owner 兄弟 agent 互审"
 *    两态（禁自审四态的后两态）的判定输入；漏填不会报错，只会让这两态**静默放行**。
 * 2. **human 分支必须没有 `ownerId` 键**：human 即 owner 自身，填成 actor.id 会让
 *    "自己审自己"类判定意外命中；用 `toHaveProperty` / `in` 断言键**存在性**（若只是
 *    `expect(actor.ownerId).toBeUndefined()`，把 human 的 ownerId 填成 undefined 与
 *    "键不存在"无法区分，也测不出误填成 actor.id 的情形）。
 *
 * 为什么用 `ROUTE_ARGS_METADATA` 取 factory（本仓无 decorator 测试先例）：
 * `createParamDecorator` 把 factory 存进 `__routeArguments__` 元数据（NestJS
 * `create-route-param-metadata.decorator.js`），故用探针类挂一次装饰器再读元数据即可拿到
 * 真实 factory——**不需要起 HTTP app**，也不会因 Nest 内部签名变化而静默跳过断言。
 */

/** 探针类：只为让装饰器把 factory 写进元数据（方法体不会被调用） */
class Probe {
  handler(_actor?: unknown): void {
    void _actor;
  }
}

/** 取出 `@CurrentActor()` 注册的真实 factory（每个用例重新注册，元数据键含自增 paramtype） */
function resolveCurrentActorFactory(): (
  data: keyof UnifiedActor | undefined,
  ctx: ExecutionContext,
) => UnifiedActor | UnifiedActor[keyof UnifiedActor] | null {
  CurrentActor()(Probe.prototype, 'handler', 0);
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { factory: (data: keyof UnifiedActor | undefined, ctx: ExecutionContext) => never }
  >;
  const entry = Object.values(args)[0];
  return entry.factory as unknown as (
    data: keyof UnifiedActor | undefined,
    ctx: ExecutionContext,
  ) => UnifiedActor | UnifiedActor[keyof UnifiedActor] | null;
}

/** 构造只含 `switchToHttp().getRequest()` 的最小 ExecutionContext（装饰器只消费这一处） */
function contextWithRequest(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CurrentActor 装饰器', () => {
  describe('agent 分支（API Key 认证）', () => {
    const agentRequest = {
      agent: {
        id: 'agent-1',
        name: 'Test Agent',
        ownerId: 'human-owner-1',
        permissions: { scopes: ['read', 'write'] },
        keyPrefix: 'ask_abcD',
      },
    };

    it('透传 ownerId（禁自审后两态的判定输入，漏填 = 静默放行）', () => {
      const actor = resolveCurrentActorFactory()(undefined, contextWithRequest(agentRequest));
      expect(actor).toEqual({
        id: 'agent-1',
        type: ActorType.AGENT,
        name: 'Test Agent',
        permissions: { scopes: ['read', 'write'] },
        keyPrefix: 'ask_abcD',
        ownerId: 'human-owner-1',
      });
    });

    it('ownerId 是自有键且为字符串（防止未来被折叠进其它字段）', () => {
      const actor = resolveCurrentActorFactory()(
        undefined,
        contextWithRequest(agentRequest),
      ) as UnifiedActor | null;
      expect(actor).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(actor, 'ownerId')).toBe(true);
      expect(typeof actor?.ownerId).toBe('string');
    });

    it("data 参数取标量：@CurrentActor('ownerId') 直接返回 ownerId", () => {
      const ownerId = resolveCurrentActorFactory()('ownerId', contextWithRequest(agentRequest));
      expect(ownerId).toBe('human-owner-1');
    });
  });

  describe('human 分支（JWT 认证）', () => {
    const userRequest = {
      user: { userId: 'human-1', email: 'h@example.com', role: 'editor', name: 'Human' },
    };

    it('human 分支刻意不填 ownerId（人即 owner 自身，态 2 走 isOwnerProxy）', () => {
      const actor = resolveCurrentActorFactory()(undefined, contextWithRequest(userRequest));
      expect(actor).toEqual({
        id: 'human-1',
        type: ActorType.HUMAN,
        name: 'Human',
        role: 'editor',
      });
      // 键必须**不存在**（不是"存在但 undefined"）：否则消费方按 type 分叉的判定会踩空
      expect(Object.prototype.hasOwnProperty.call(actor, 'ownerId')).toBe(false);
      expect('ownerId' in (actor as object)).toBe(false);
    });
  });

  describe('无认证身份', () => {
    it('request.user / request.agent 均缺失 → null（不产出空壳 actor）', () => {
      expect(resolveCurrentActorFactory()(undefined, contextWithRequest({}))).toBeNull();
    });
  });
});
