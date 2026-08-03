import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { ApiLogQueryDto } from './dto/api-log-query.dto';

@Injectable()
export class MonitoringService {
  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
  ) {}

  async getApiLogs(query: ApiLogQueryDto) {
    const { page = 1, pageSize = 20 } = query;
    const [items, total] = await this.auditRepo.findAndCount({
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

  async exportApiLogs(_query: ApiLogQueryDto) {
    const logs = await this.auditRepo.find({
      order: { createdAt: 'DESC' },
      take: 1000,
    });
    // 返回 JSON 格式（简化实现）
    return {
      data: logs,
      count: logs.length,
      exportedAt: new Date().toISOString(),
    };
  }
}
