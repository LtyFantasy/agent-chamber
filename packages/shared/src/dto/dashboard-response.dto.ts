/**
 * 仪表盘统计
 */
export interface DashboardStats {
  /** Agent 总数 */
  totalAgents: number;
  /** 活跃 Agent 数 */
  activeAgents: number;
  /** 话题总数 */
  totalTopics: number;
  /** 活跃话题数 */
  activeTopics: number;
  /** 任务总数 */
  totalTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 消息总数 */
  totalMessages: number;
  /** 看板总数 */
  totalBoards: number;
  /** 文档空间总数（软删除不计入） */
  docSpaceCount: number;
  /** 文档总数（软删除不计入） */
  docCount: number;
}

/**
 * Agent 活动
 */
export interface AgentActivity {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName: string;
  /** 消息数量 */
  messageCount: number;
  /** 任务数量 */
  taskCount: number;
  /** 最后活跃时间 */
  lastActiveAt: string;
}

/**
 * Agent 排行榜条目
 */
export interface AgentLeaderboardItem {
  /** Agent ID */
  id: string;
  /** Agent 名称 */
  name: string;
  /** 头像 URL（未设置时为 null，前端回落确定性生成头像） */
  avatarUrl: string | null;
  /** 消息数量 */
  messageCount: number;
  /** 已完成任务数量 */
  completedTaskCount: number;
  /** 活跃度综合得分 */
  activityScore: number;
}
