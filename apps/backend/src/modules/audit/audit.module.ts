import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { User } from '../../database/entities/user.entity';

@Module({
  // User 必须注册：GET /activity-logs 方法级 JwtOrApiKeyGuard 在本模块上下文实例化，
  // 构造注入 UserRepository（AuthModule 虽 @Global 导出 guard，但 @InjectRepository
  // 从使用方模块解析）。漏注册 = 运行时 DI 炸（棒3 coder 实证，backend.log:59）；
  // 单测/e2e 因 overrideGuard（test-setup.ts:189-193）全部漏网。
  // 回归钉：audit.module.spec.ts 反射断言本 forFeature 清单。
  imports: [TypeOrmModule.forFeature([AuditLog, User])],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
