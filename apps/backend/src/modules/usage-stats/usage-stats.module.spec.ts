/**
 * UsageStatsModule DI 接线回归测试（照 audit.module.spec.ts 先例）。
 *
 * 回归来源：批 2 的上报端点用了**方法/类级** `@UseGuards(JwtOrApiKeyGuard)`，
 * 该 guard 在**使用方模块**上下文实例化，构造注入 `@InjectRepository(User)`——
 * 本模块 forFeature 一旦漏注册 User，运行时 DI 直接炸；而单测与 e2e 都全局
 * overrideGuard（test-setup.ts:188-194），双双漏网。故用反射钉住接线清单，不依赖 DB。
 */
import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiUsageStatsHourly } from '../../database/entities/api-usage-stats-hourly.entity';
import { User } from '../../database/entities/user.entity';
import { ApiUsageController } from './api-usage.controller';
import { ApiUsageQueryService } from './api-usage-query.service';
import { UsageEventsController } from './usage-events.controller';
import { UsageStatsBufferService } from './usage-stats-buffer.service';
import { UsageStatsModule } from './usage-stats.module';
import { UsageStatsRetentionService } from './usage-stats-retention.service';

describe('UsageStatsModule DI wiring', () => {
  it('forFeature 必须注册 ApiUsageStatsHourly（查询面）与 User（JwtOrApiKeyGuard 注入依赖）', () => {
    const imports = (Reflect.getMetadata('imports', UsageStatsModule) ?? []) as Array<{
      providers?: Array<{ provide?: string | symbol }>;
    }>;
    const tokens = imports.flatMap((m) =>
      (m.providers ?? []).map((p) => p?.provide).filter(Boolean),
    );
    expect(tokens).toContain(getRepositoryToken(ApiUsageStatsHourly));
    expect(tokens).toContain(getRepositoryToken(User));
  });

  it('controllers 注册查询面与上报面两个 controller', () => {
    const controllers = (Reflect.getMetadata('controllers', UsageStatsModule) ?? []) as unknown[];
    expect(controllers).toContain(ApiUsageController);
    expect(controllers).toContain(UsageEventsController);
  });

  it('providers 注册聚合服务 / 查询服务 / 清理服务', () => {
    const providers = (Reflect.getMetadata('providers', UsageStatsModule) ?? []) as unknown[];
    expect(providers).toContain(UsageStatsBufferService);
    expect(providers).toContain(ApiUsageQueryService);
    expect(providers).toContain(UsageStatsRetentionService);
  });

  it('不得重复注册 ScheduleModule.forRoot()（imports 只有 forFeature 一项）', () => {
    const imports = (Reflect.getMetadata('imports', UsageStatsModule) ?? []) as unknown[];
    expect(imports).toHaveLength(1);
    const forFeature = TypeOrmModule.forFeature([ApiUsageStatsHourly, User]) as {
      providers?: unknown[];
    };
    expect(imports[0]).toBeInstanceOf(Object);
    // 形状核对：唯一 import 就是 forFeature 动态模块（providers 里带仓储 token）
    expect((imports[0] as { providers?: unknown[] }).providers?.length).toBe(
      forFeature.providers?.length,
    );
  });
});
