import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WebhookDelivery])],
  providers: [WebhookService],
  controllers: [WebhookController],
})
export class WebhookModule {}
