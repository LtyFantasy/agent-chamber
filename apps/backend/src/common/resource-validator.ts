/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.1 (整体架构)
 *   - 补充: AGENTS.md §2.6 输入校验与资源存在性校验铁律
 *
 * [踩坑索引]
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Repository, In, ObjectLiteral, FindOneOptions, FindOptionsWhere } from 'typeorm';
import { ErrorCode } from '@agent-chamber/shared';

/**
 * 资源存在性校验基础设施
 *
 * 封装 "findOne/findBy + 判空抛 NotFoundException" 的重复模式，
 * 供各 Service 在写操作前校验依赖资源是否存在，避免孤立数据、幽灵分配与脏 settings。
 *
 * 使用原则：
 * - DTO/Controller 只负责格式正确性（UUID、长度、必填）
 * - Service 通过本类负责业务存在性校验
 */
@Injectable()
export class ResourceValidator {
  constructor() {}

  /**
   * 校验单个资源是否存在
   * @param repo TypeORM Repository
   * @param id 资源 ID
   * @param errorCode 不存在时抛出的错误码
   * @param options 额外查询选项（如 relations、withDeleted）
   * @returns 存在的实体
   * @throws NotFoundException - 资源不存在时抛出，响应体带 { message, code }
   */
  async exists<T extends ObjectLiteral>(
    repo: Repository<T>,
    id: string,
    errorCode: ErrorCode,
    options?: FindOneOptions<T>,
  ): Promise<T> {
    const entity = await repo.findOne({
      where: { id } as unknown as FindOptionsWhere<T>,
      ...options,
    });
    if (!entity) {
      throw new NotFoundException({ message: 'Resource not found', code: errorCode });
    }
    return entity;
  }

  /**
   * 批量校验资源是否存在
   *
   * 使用 IN 批量查询，避免 N+1；数量不匹配时抛出 NotFoundException。
   *
   * @param repo TypeORM Repository
   * @param ids 资源 ID 数组
   * @param errorCode 有不存在的 ID 时抛出的错误码
   * @returns 存在的实体数组
   * @throws NotFoundException - 任意 ID 不存在时抛出，响应体带 { message, code }
   */
  async existsMany<T extends ObjectLiteral>(
    repo: Repository<T>,
    ids: string[],
    errorCode: ErrorCode,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const entities = await repo.findBy({ id: In(ids) } as unknown as FindOptionsWhere<T>);
    if (entities.length !== ids.length) {
      throw new NotFoundException({ message: 'Some resources not found', code: errorCode });
    }
    return entities;
  }
}
