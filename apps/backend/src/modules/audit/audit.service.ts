import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import type { PaginatedResponse, AuditLog as AuditLogDto } from '@agent-chamber/shared';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private auditRepo: Repository<AuditLog>,
  ) {}

  async log(dto: Partial<AuditLog>) {
    const log = this.auditRepo.create(dto);
    return this.auditRepo.save(log);
  }

  async findAll(query: AuditLogQueryDto): Promise<PaginatedResponse<AuditLogDto>> {
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
}
