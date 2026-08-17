import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Event } from '../../database/entities/event.entity';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';
import { Message } from '../../database/entities/message.entity';
import { SseModule } from '../sse/sse.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditLog,
      RoundtableRunner,
      RoundtableSeat,
      Event,
      WebhookDelivery,
      Message,
    ]),
    SseModule, // overview 的 sse.activeConnections gauge 依赖 SseService（1.54.0 埋点批）
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
