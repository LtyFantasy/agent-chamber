import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { Task } from '../../database/entities/task.entity';
import { ErrorCode, TaskDependencyType, TaskStatus } from '@agent-chamber/shared';
import { AddTaskDependencyDto } from './dto';

/**
 * 依赖三端点（dependencies/dependents/blockers）单次返回行数上限。
 * rationale：依赖列表是摘要消费（web 只读 id/dependsOnTaskId/嵌套 title），
 * 无分页契约；take 100 防止极端依赖图下全量实体泄漏与响应膨胀，
 * 与 findOne 内嵌依赖的既有体量（无上限）相比是收紧而非破坏。
 */
const MAX_DEPENDENCY_ROWS = 100;

@Injectable()
export class TaskDependencyService {
  constructor(
    @InjectRepository(TaskDependency)
    private depRepo: Repository<TaskDependency>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
  ) {}

  /**
   * 添加任务依赖关系
   * - 自依赖检测
   * - 循环依赖检测（BFS，最大深度 50）
   * - 重复依赖检测
   */
  async addDependency(taskId: string, dto: AddTaskDependencyDto) {
    const { dependsOnTaskId, type = TaskDependencyType.BLOCKS } = dto;

    // 自依赖检测
    if (taskId === dependsOnTaskId) {
      throw new BadRequestException({
        message: 'A task cannot depend on itself',
        code: ErrorCode.TASK_DEPENDENCY_SELF,
      });
    }

    // 验证被依赖任务存在
    const dependsOnTask = await this.taskRepo.findOne({ where: { id: dependsOnTaskId } });
    if (!dependsOnTask) {
      throw new NotFoundException({
        message: `Task ${dependsOnTaskId} not found`,
        code: ErrorCode.TASK_NOT_FOUND,
      });
    }

    // 重复依赖检测
    const existing = await this.depRepo.findOne({
      where: { taskId, dependsOnTaskId },
    });
    if (existing) {
      throw new BadRequestException({
        message: 'Dependency already exists',
        code: ErrorCode.TASK_ALREADY_DEPENDS,
      });
    }

    // 循环依赖检测（BFS：从 dependsOnTaskId 出发，看能否到达 taskId）
    await this.detectCycle(taskId, dependsOnTaskId);

    const dep = this.depRepo.create({ taskId, dependsOnTaskId, type });
    return this.depRepo.save(dep);
  }

  /**
   * BFS 循环检测：从 startTaskId 出发，沿着依赖链（task → dependsOn）搜索
   * 如果在深度 maxDepth 内能到达 targetTaskId，则存在循环
   */
  private async detectCycle(targetTaskId: string, startTaskId: string, maxDepth = 50) {
    const visited = new Set<string>();
    const queue: string[] = [startTaskId];
    let depth = 0;

    while (queue.length > 0 && depth < maxDepth) {
      const levelSize = queue.length;
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!;
        if (current === targetTaskId) {
          throw new BadRequestException({
            message: 'Circular dependency detected',
            code: ErrorCode.TASK_DEPENDENCY_CYCLE,
          });
        }
        if (visited.has(current)) continue;
        visited.add(current);

        // 查找 current 依赖了哪些任务（current 作为 taskId）
        const deps = await this.depRepo.find({
          where: { taskId: current },
          select: ['dependsOnTaskId'],
        });
        for (const dep of deps) {
          if (!visited.has(dep.dependsOnTaskId)) {
            queue.push(dep.dependsOnTaskId);
          }
        }
      }
      depth++;
    }
  }

  async removeDependency(taskId: string, depId: string) {
    const dep = await this.depRepo.findOne({ where: { id: depId, taskId } });
    if (!dep) {
      throw new NotFoundException({
        message: 'Dependency not found',
        code: ErrorCode.TASK_DEPENDENCY_NOT_FOUND,
      });
    }
    await this.depRepo.remove(dep);
    return true;
  }

  /**
   * 依赖行摘要投影（接口瘦身二期）：行字段与 findOne 内嵌行逐字段一致
   * `{id, taskId, dependsOnTaskId, type, createdAt}`，嵌套 Task 仅保留
   * `{id, title, status}` 摘要（同构 shared TaskDependencyItem，task.service.ts:463-473 范式）。
   * 为什么显式投影而非 `...d` 展开：三端点契约收敛到 TaskDependencyItem 字段集，
   * 避免实体新增字段时摘要端点被动泄漏。
   * @param nested 嵌套键：dependencies/blockers 用 'dependsOnTask'，dependents 用 'task'
   *   （与 findOne 内嵌行一致：dependencies 行无 task 键，dependents 行无 dependsOnTask 键）
   */
  private toDependencyItem(
    d: TaskDependency,
    nested: 'dependsOnTask' | 'task',
  ): {
    id: string;
    taskId: string;
    dependsOnTaskId: string;
    type: TaskDependencyType;
    createdAt: Date;
    dependsOnTask?: { id: string; title: string; status: string } | null;
    task?: { id: string; title: string; status: string } | null;
  } {
    const base = {
      id: d.id,
      taskId: d.taskId,
      dependsOnTaskId: d.dependsOnTaskId,
      type: d.type,
      createdAt: d.createdAt,
    };
    if (nested === 'dependsOnTask') {
      return {
        ...base,
        dependsOnTask: d.dependsOnTask
          ? { id: d.dependsOnTask.id, title: d.dependsOnTask.title, status: d.dependsOnTask.status }
          : null,
      };
    }
    return {
      ...base,
      task: d.task ? { id: d.task.id, title: d.task.title, status: d.task.status } : null,
    };
  }

  /** 我依赖谁（taskId 作为依赖方） */
  async findDependencies(taskId: string) {
    const deps = await this.depRepo.find({
      where: { taskId },
      relations: ['dependsOnTask'],
      order: { createdAt: 'DESC' },
      take: MAX_DEPENDENCY_ROWS,
    });
    return deps.map((d) => this.toDependencyItem(d, 'dependsOnTask'));
  }

  /** 谁依赖我（taskId 作为被依赖方） */
  async findDependents(taskId: string) {
    const deps = await this.depRepo.find({
      where: { dependsOnTaskId: taskId },
      relations: ['task'],
      order: { createdAt: 'DESC' },
      take: MAX_DEPENDENCY_ROWS,
    });
    return deps.map((d) => this.toDependencyItem(d, 'task'));
  }

  /**
   * 直接阻塞者：blocks 类型 + 被依赖任务未完成。
   * status 过滤下沉 SQL（仿 hasBlockers :151-159）再 take——禁止查询层 take 后
   * JS 过滤（截断会破坏语义：先截断再过滤可能漏掉本应返回的 blocker）。
   */
  async findBlockers(taskId: string) {
    const deps = await this.depRepo
      .createQueryBuilder('dep')
      .leftJoinAndSelect('dep.dependsOnTask', 'task')
      .where('dep.task_id = :taskId', { taskId })
      .andWhere('dep.dependency_type = :type', { type: TaskDependencyType.BLOCKS })
      .andWhere('task.status NOT IN (:...doneStatuses)', {
        doneStatuses: [TaskStatus.DONE, TaskStatus.ARCHIVED],
      })
      .orderBy('dep.createdAt', 'DESC')
      .take(MAX_DEPENDENCY_ROWS)
      .getMany();
    return deps.map((d) => this.toDependencyItem(d, 'dependsOnTask'));
  }

  /** 批量查询哪些任务有未完成的 blockers（用于看板卡片渲染） */
  async hasBlockers(taskIds: string[]): Promise<Record<string, boolean>> {
    if (taskIds.length === 0) return {};

    const result: Record<string, boolean> = {};
    for (const id of taskIds) result[id] = false;

    // 查询所有 blocks 类型的依赖，且被依赖任务未完成的
    const deps = await this.depRepo
      .createQueryBuilder('dep')
      .leftJoinAndSelect('dep.dependsOnTask', 'task')
      .where('dep.task_id IN (:...taskIds)', { taskIds })
      .andWhere('dep.dependency_type = :type', { type: TaskDependencyType.BLOCKS })
      .andWhere('task.status NOT IN (:...doneStatuses)', {
        doneStatuses: [TaskStatus.DONE, TaskStatus.ARCHIVED],
      })
      .getMany();

    for (const dep of deps) {
      result[dep.taskId] = true;
    }

    return result;
  }
}
