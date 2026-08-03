import { Injectable, NotFoundException } from '@nestjs/common';
import { EventType, WebhookStatus, ErrorCode } from '@agent-chamber/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';
import { QueryWebhookDto } from './dto/query-webhook.dto';
import { TestWebhookDto } from './dto/test-webhook.dto';

@Injectable()
export class WebhookService {
  constructor(
    @InjectRepository(WebhookDelivery)
    private webhookRepo: Repository<WebhookDelivery>,
  ) {}

  async findAll(query: QueryWebhookDto) {
    const { page = 1, pageSize = 20 } = query;
    const [items, total] = await this.webhookRepo.findAndCount({
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });
    const totalPages = Math.ceil(total / pageSize);
    return {
      items,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  async findOne(id: string) {
    const log = await this.webhookRepo.findOne({ where: { id } });
    if (!log) {
      throw new NotFoundException({ message: 'Webhook not found', code: ErrorCode.NOT_FOUND });
    }
    return log;
  }

  async test(dto: TestWebhookDto) {
    const log = this.webhookRepo.create({
      agentId: '00000000-0000-0000-0000-000000000000',
      eventType: EventType.SYSTEM,
      targetUrl: dto.url,
      payload: dto.payload,
      status: WebhookStatus.SUCCESS,
      responseStatus: 200,
    });
    await this.webhookRepo.save(log);
    return { success: true, message: 'Webhook test simulated', log };
  }
}
