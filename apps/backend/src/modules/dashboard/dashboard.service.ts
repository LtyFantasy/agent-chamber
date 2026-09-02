import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Task } from '../../database/entities/task.entity';
import { Message } from '../../database/entities/message.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Doc } from '../../database/entities/doc.entity';
import { AgentStatus, TopicStatus, TaskStatus } from '@agent-chamber/shared';
import type { DashboardStats, AgentActivity, AgentLeaderboardItem } from '@agent-chamber/shared';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(DocSpace)
    private docSpaceRepo: Repository<DocSpace>,
    @InjectRepository(Doc)
    private docRepo: Repository<Doc>,
  ) {}

  async stats(): Promise<DashboardStats> {
    const [
      totalAgents,
      activeAgents,
      totalTopics,
      activeTopics,
      totalTasks,
      completedTasks,
      totalMessages,
      totalBoards,
      boardTaskAgg,
      docSpaceCount,
      docCount,
    ] = await Promise.all([
      // Agent 公共字段已上提到 actor，统计时排除已软删除的 actor
      this.agentRepo
        .createQueryBuilder('agent')
        .innerJoin('agent.actor', 'actor')
        .where('actor.deleted_at IS NULL')
        .getCount(),
      this.agentRepo
        .createQueryBuilder('agent')
        .innerJoin('agent.actor', 'actor')
        .where('actor.status = :status', { status: AgentStatus.ACTIVE })
        .andWhere('actor.deleted_at IS NULL')
        .getCount(),
      this.topicRepo.count(),
      this.topicRepo.count({ where: { status: TopicStatus.ACTIVE } }),
      this.taskRepo.count(),
      this.taskRepo.count({ where: { status: TaskStatus.DONE } }),
      this.messageRepo.count(),
      this.boardRepo.count(),
      // Board 任务计数走冗余列聚合（task_count/completed_task_count 由任务写入路径维护），
      // SUM 只扫 boards 表（行数极小），不回扫 tasks 表；COALESCE 兜底空表 SUM→NULL。
      // createQueryBuilder 会自动过滤软删除 board（@DeleteDateColumn）。
      this.boardRepo
        .createQueryBuilder('board')
        .select('COALESCE(SUM(board.taskCount), 0)', 'boardTaskCount')
        .addSelect('COALESCE(SUM(board.completedTaskCount), 0)', 'boardCompletedTaskCount')
        .getRawOne<{ boardTaskCount: string; boardCompletedTaskCount: string }>()
        .then((raw) => ({
          boardTaskCount: parseInt(raw?.boardTaskCount ?? '0', 10),
          boardCompletedTaskCount: parseInt(raw?.boardCompletedTaskCount ?? '0', 10),
        })),
      // DocSpace/Doc 计数口径与现有 stats 一致：repo.count() 自动过滤软删除行
      // （@DeleteDateColumn select:false），stats 端点为 admin-only，无访问白名单
      this.docSpaceRepo.count(),
      this.docRepo.count(),
    ]);

    return {
      totalAgents,
      activeAgents,
      totalTopics,
      activeTopics,
      totalTasks,
      completedTasks,
      totalMessages,
      totalBoards,
      boardTaskCount: boardTaskAgg.boardTaskCount,
      boardCompletedTaskCount: boardTaskAgg.boardCompletedTaskCount,
      docSpaceCount,
      docCount,
    };
  }

  /**
   * 获取最近活跃的 Agent 列表。
   *
   * 权限说明：本 Service 不处理权限，由 DashboardController 通过 @Roles(ADMIN) 控制。
   * 返回全平台 Agent 的聚合数据。
   */
  async agentActivity(): Promise<AgentActivity[]> {
    const agents = await this.agentRepo
      .createQueryBuilder('agent')
      .innerJoinAndSelect('agent.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .getMany();

    // 在内存排序：last_active_at 优先，缺失时 fallback 到 actor.created_at。
    // 避免 TypeORM 在 PostgreSQL 下对 join 别名列做 COALESCE 排序时解析别名失败。
    agents.sort((a, b) => {
      const aTime = a.lastActiveAt ?? a.createdAt;
      const bTime = b.lastActiveAt ?? b.createdAt;
      return bTime.getTime() - aTime.getTime();
    });
    const topAgents = agents.slice(0, 10);

    const agentIds = topAgents.map((a) => a.id);
    const [messageCountMap, taskCountMap] = await Promise.all([
      this.countMessagesByAgents(agentIds),
      this.countTasksByAgents(agentIds),
    ]);

    return topAgents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      messageCount: messageCountMap.get(agent.id) || 0,
      taskCount: taskCountMap.get(agent.id) || 0,
      lastActiveAt: agent.lastActiveAt?.toISOString() ?? agent.createdAt?.toISOString() ?? '',
    }));
  }

  /**
   * 获取 Agent 活跃度排行榜。
   *
   * 排序规则：activityScore = messageCount + completedTaskCount * 3，按得分降序取前 5。
   * avatarUrl 取自 actor 根表（innerJoinAndSelect 已联查），未设置头像时为 null，
   * 前端回落到确定性生成头像。
   * 权限说明：本 Service 不处理权限，由 DashboardController 通过 @Roles(ADMIN) 控制。
   */
  async leaderboard(): Promise<AgentLeaderboardItem[]> {
    const agents = await this.agentRepo
      .createQueryBuilder('agent')
      .innerJoinAndSelect('agent.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .getMany();

    const agentIds = agents.map((a) => a.id);
    const [messageCountMap, completedTaskCountMap] = await Promise.all([
      this.countMessagesByAgents(agentIds),
      this.countCompletedTasksByAgents(agentIds),
    ]);

    const items = agents.map((agent) => {
      const messageCount = messageCountMap.get(agent.id) || 0;
      const completedTaskCount = completedTaskCountMap.get(agent.id) || 0;
      return {
        id: agent.id,
        name: agent.name,
        avatarUrl: agent.actor?.avatarUrl ?? null,
        messageCount,
        completedTaskCount,
        activityScore: messageCount + completedTaskCount * 3,
      };
    });

    return items.sort((a, b) => b.activityScore - a.activityScore).slice(0, 5);
  }

  /**
   * 最近活跃话题（admin 仪表盘，最多 5 条）。
   * 接口瘦身二期：投影 {id, title, status, lastMessageAt, updatedAt}——
   * admin-dashboard.tsx:363-368 只读 lastMessageAt（优先）/updatedAt（回落），
   * 全量 Topic 实体（agenda/settings jsonb 等）对消费端无价值。
   */
  async recentTopics() {
    const topics = await this.topicRepo.find({
      order: { updatedAt: 'DESC' },
      take: 5,
    });
    return topics.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      lastMessageAt: t.lastMessageAt,
      updatedAt: t.updatedAt,
    }));
  }

  /**
   * 批量统计每个 Agent 发送的消息数量。
   */
  private async countMessagesByAgents(agentIds: string[]): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    const rows = (await this.messageRepo.manager.query(
      `SELECT sender_id AS "agentId", COUNT(*) AS count
       FROM messages
       WHERE sender_id = ANY($1) AND deleted_at IS NULL
       GROUP BY sender_id`,
      [agentIds],
    )) as Array<{ agentId: string; count: string }>;
    return new Map(rows.map((r) => [r.agentId, parseInt(r.count, 10)]));
  }

  /**
   * 批量统计每个 Agent 被分配的任务数量。
   */
  private async countTasksByAgents(agentIds: string[]): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    const rows = (await this.taskRepo.manager.query(
      `SELECT assignee_id AS "agentId", COUNT(*) AS count
       FROM tasks
       WHERE assignee_id = ANY($1) AND deleted_at IS NULL
       GROUP BY assignee_id`,
      [agentIds],
    )) as Array<{ agentId: string; count: string }>;
    return new Map(rows.map((r) => [r.agentId, parseInt(r.count, 10)]));
  }

  /**
   * 批量统计每个 Agent 已完成的任务数量。
   */
  private async countCompletedTasksByAgents(agentIds: string[]): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    const rows = (await this.taskRepo.manager.query(
      `SELECT assignee_id AS "agentId", COUNT(*) AS count
       FROM tasks
       WHERE assignee_id = ANY($1) AND status = 'done' AND deleted_at IS NULL
       GROUP BY assignee_id`,
      [agentIds],
    )) as Array<{ agentId: string; count: string }>;
    return new Map(rows.map((r) => [r.agentId, parseInt(r.count, 10)]));
  }
}
