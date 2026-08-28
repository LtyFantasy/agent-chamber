/**
 * AuditModule DI 接线回归测试。
 *
 * 回归来源（2026-08-28 棒3 coder 实证）：GET /activity-logs 方法级
 * @UseGuards(JwtOrApiKeyGuard) 使 guard 在 AuditModule 上下文实例化，其构造
 * 注入 @InjectRepository(User)——但 forFeature 漏注册 User，运行时 DI 直接炸
 * （backend.log: Nest can't resolve ... UserRepository at index [2]）。
 * 单测 overrideGuard、e2e test-setup.ts:189-193 全局 overrideGuard，双双漏网。
 * 本测试用反射钉住 forFeature 清单，不依赖 DB。
 */
import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditModule } from './audit.module';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { User } from '../../database/entities/user.entity';

describe('AuditModule DI wiring', () => {
  it('forFeature 必须注册 User（JwtOrApiKeyGuard 注入 UserRepository）与 AuditLog', () => {
    // @Module({ imports }) 元数据中的 TypeOrmModule.forFeature 动态模块，
    // 其 providers 携带 { provide: getRepositoryToken(entity), ... }
    const imports = (Reflect.getMetadata('imports', AuditModule) ?? []) as Array<{
      providers?: Array<{ provide?: string | symbol }>;
    }>;
    const tokens = imports.flatMap((m) =>
      (m.providers ?? []).map((p) => p?.provide).filter(Boolean),
    );
    expect(tokens).toContain(getRepositoryToken(User));
    expect(tokens).toContain(getRepositoryToken(AuditLog));
  });
});
