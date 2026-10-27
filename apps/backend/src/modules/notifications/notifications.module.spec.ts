/**
 * NotificationsModule 装配守卫（DI 接线：`forFeature` ↔ 构造函数的 `@InjectRepository`）。
 *
 * 设计意图：本模块的 `forFeature` 清单与编排器/仓储的构造函数是**两份必须逐项对齐的事实**，
 * 而它们写在不同文件里。漏一处的症状是 **应用启动即崩**
 * （`Nest can't resolve dependencies ... "TaskRepository"`），**不是**请求期 500——所以
 * 单测/e2e 若直接 `new` 出被测对象就完全查不出（先例 memory.module.ts 的血泪注释）。
 *
 * 这里用 **Nest 自己记的元数据**做双向对账（不手写一份 EXPECTED 清单——那是第三份事实）：
 * - 装饰器侧：`@InjectRepository(X)` ≡ `Inject(getRepositoryToken(X))`，落在
 *   `Reflect.getMetadata('self:paramtypes', Ctor)`（键常量 = @nestjs/common 的
 *   `SELF_DECLARED_DEPS_METADATA`）。
 * - 模块侧：`TypeOrmModule.forFeature([...])` 返回 DynamicModule，其 `providers[].provide`
 *   就是 `XRepository` 这组 token。
 *
 * 不 boot 应用、不连库（同 app.module.spec.ts 的纪律：刻意不走 AppModule——WS gateway /
 * schedule / DB 连接都不该进单测）。
 *
 * ⚠️ **S4 追加**：除 forFeature 对账外，本文件还守住"controller 与直发链路已装配"——挂漏
 * controller 的症状是**端点 404**（不是 500），挂漏 `NotifyDirectService` 是**启动即崩**，
 * 两者都不会被任何行为级用例抓到（它们只测服务内部）。
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';
import { NotificationSettingsController } from './notification-settings.controller';
import { NotificationSettingsService } from './notification-settings.service';
import { NotifyDeliveryRepository } from './notify-delivery.repository';
import { NotifyDirectService } from './notify-direct.service';
import { NotifyOrchestrator } from './notify-orchestrator.service';

/** `@nestjs/common` 的常量（此处逐字复刻，避免为一个字符串 import 内部路径） */
const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';

/**
 * 取某个类在装饰器里显式声明的依赖 token（`@InjectRepository` / `@Inject` 的产物）。
 *
 * @param target 类
 * @returns 依赖 token 数组（未声明时为空数组）
 */
function declaredTokens(target: unknown): unknown[] {
  const declared =
    (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target as object) as
      | Array<{ index: number; param: unknown }>
      | undefined) ?? [];
  return declared.map((entry) => entry.param);
}

/** 取 NotificationsModule 的 `TypeOrmModule.forFeature` 动态导入所提供的 repository token */
function forFeatureTokens(): string[] {
  const imports = (Reflect.getMetadata('imports', NotificationsModule) as unknown[]) ?? [];
  const tokens: string[] = [];
  for (const entry of imports) {
    const dynamic = entry as { module?: unknown; providers?: Array<{ provide?: unknown }> };
    if (dynamic?.module !== TypeOrmModule) continue;
    for (const provider of dynamic.providers ?? []) {
      if (typeof provider.provide === 'string') tokens.push(provider.provide);
    }
  }
  return tokens;
}

describe('NotificationsModule 装配（forFeature ↔ @InjectRepository 双向对账）', () => {
  it('编排器声明的每个 repository token 都由本模块 forFeature 提供（漏一个 = 启动即崩）', () => {
    const provided = forFeatureTokens();
    const required = declaredTokens(NotifyOrchestrator).filter(
      (token): token is string => typeof token === 'string' && token.endsWith('Repository'),
    );
    expect(required.length).toBeGreaterThanOrEqual(6);
    for (const token of required) expect(provided).toContain(token);
  });

  it('投递记录仓储声明的 repository token 同样被提供', () => {
    const provided = forFeatureTokens();
    const required = declaredTokens(NotifyDeliveryRepository).filter(
      (token): token is string => typeof token === 'string' && token.endsWith('Repository'),
    );
    expect(required).toContain('NotificationDeliveryRepository');
    for (const token of required) expect(provided).toContain(token);
  });

  it('forFeature 清单无冗余（多注册 = 第二个仓储实例 + 启动期 DI 噪声）', () => {
    const provided = forFeatureTokens();
    expect(new Set(provided).size).toBe(provided.length);
    // 当前清单 = 11 个实体仓储（NotificationDelivery + Task/Message/Topic/Doc/Board/DocSpace/User/
    // TopicParticipant + 二期 UserNotificationChannel/Agent）——v2 归属信息把 Board / DocSpace
    // 拉进渲染路径；二期渠道绑定与 agent creator 预警各拉一个
    expect(provided.sort()).toEqual(
      [
        'AgentRepository',
        'BoardRepository',
        'DocRepository',
        'DocSpaceRepository',
        'MessageRepository',
        'NotificationDeliveryRepository',
        'TaskRepository',
        'TopicParticipantRepository',
        'TopicRepository',
        'UserNotificationChannelRepository',
        'UserRepository',
      ].sort(),
    );
  });

  it('S4 + 二期：controller 与直发/设置服务已装配（挂漏 = 端点 404 / DI 解析失败）', () => {
    const controllers =
      (Reflect.getMetadata('controllers', NotificationsModule) as unknown[]) ?? [];
    expect(controllers).toEqual([NotificationsController, NotificationSettingsController]);

    const providers = (Reflect.getMetadata('providers', NotificationsModule) as unknown[]) ?? [];
    // 直发链路必须由本模块提供：controller 在构造期注入它，缺一个就是**启动即崩**
    expect(providers).toContain(NotifyDirectService);
    expect(providers).toContain(NotifyOrchestrator);
    expect(providers).toContain(NotifyDeliveryRepository);
    // 二期设置面：其 controller 构造期注入本服务，漏注册同样启动即崩
    expect(providers).toContain(NotificationSettingsService);
  });
});
