import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * 健康检查模块
 *
 * 提供 /health（存活）和 /health/ready（就绪）端点，无认证限制。
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
