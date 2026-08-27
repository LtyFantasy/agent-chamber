import { Visibility, BoardMemberRole, MilestoneStatus, Priority, TaskStatus } from '../enums';
import type { TaskSummary } from './task-response.dto';

/**
 * 看板成员（关系表聚合视图）
 * 由 board_members join actors 实时组装
 */
export interface BoardMember {
  /** 成员 Actor ID */
  id: string;
  /** 成员名称 */
  name: string;
  /** 成员类型 */
  type: 'human' | 'agent';
  /** 头像 URL */
  avatarUrl?: string | null;
  /** 软删时间；非空 = 该成员已删除，name 仍可显示（历史归因保留） */
  deletedAt?: string | null;
  /** 成员角色：editor 可编辑看板内容，member 只读 */
  role: BoardMemberRole;
  /** 邀请者 Actor ID（可空） */
  invitedBy?: string | null;
  /** 加入时间 */
  createdAt?: string | Date;
}

/**
 * 看板基本信息（列表视图）
 */
export interface Board {
  /** 看板 ID */
  id: string;
  /** 看板名称 */
  name: string;
  /** 描述摘要片段：≤200 字符截断，无描述时 null，仅列表视图返回 */
  descriptionSnippet?: string | null;
  /** 关联话题 ID */
  topicId?: string | null;
  /** 可见性 */
  visibility?: Visibility;
  /** 创建者 ID */
  creatorId?: string;
  /** 创建者类型 */
  creatorType?: 'human' | 'agent' | 'system';
  /** 创建者 ID（遗留字段，部分历史代码仍在使用） */
  createdBy?: string;
  /** 任务数量 */
  taskCount?: number;
  /** 已完成任务数量 */
  completedTaskCount?: number;
  /** 成员数量（替代 invitedAgentCount） */
  memberCount?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 看板详情（聚合视图）
 * 字段来自 Board + board_members + lists
 */
export interface BoardDetail extends Board {
  /** 详情完整描述 */
  description: string | null;
  /** 看板列列表（仅含 list 元数据，不再嵌套 tasks） */
  lists: BoardListSummary[];
  /** 成员列表（替代 invitedAgentIds/editorIds/editorAgents/invitedAgents/topicParticipants/topicParticipantAgents/topicParticipantHumans） */
  members?: BoardMember[];
  /** 列数量（动态计算） */
  listCount?: number;
}

/**
 * 看板列摘要（不含 tasks）
 */
export interface BoardListSummary {
  /** 列 ID */
  id: string;
  /** 所属看板 ID */
  boardId: string;
  /** 列名称 */
  name: string;
  /** 排序位置 */
  position: number;
  /** 颜色 */
  color?: string;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus?: string | null;
  /** 该列未删除任务总数 */
  taskCount: number;
  /** 创建时间 */
  createdAt: string | Date;
  /** 更新时间 */
  updatedAt: string | Date;
}

/**
 * 看板列
 */
export interface BoardList {
  /** 列 ID */
  id: string;
  /** 所属看板 ID */
  boardId: string;
  /** 列名称 */
  name: string;
  /** 排序位置 */
  position: number;
  /** 颜色 */
  color?: string;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus?: string | null;
  /** 任务数量 */
  taskCount?: number;
  /** 任务列表 */
  tasks: TaskSummary[];
}

// ─── Board Digest（v1.41 项目总揽视图，实时装配、永不存储） ─────────────────────

/**
 * Board Digest 列摘要（getDigest 装配，口径对齐 BoardListSummary：未删除任务计数）
 */
export interface BoardDigestList {
  /** 列 ID */
  id: string;
  /** 列名称 */
  name: string;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus: string | null;
  /** 该列未删除任务总数（口径对齐 GET /boards/:id 的列 taskCount） */
  taskCount: number;
}

/**
 * Board Digest 里程碑关联任务统计（milestones 与 versions 两段复用）
 * 口径对齐 milestones 列表端点（done 含 archived；open 不含 in_progress/done/archived）
 */
export interface BoardDigestMilestoneStats {
  /** 任务总数 */
  total: number;
  /** 已完成数（含 archived） */
  done: number;
  /** 进行中数 */
  inProgress: number;
  /** 开放数（backlog/todo/review/blocked，不含 in_progress） */
  open: number;
}

/**
 * Board Digest 里程碑条目（v1.42 起 Release 化：version 非空 = Release 里程碑，
 * 附加 deployedAt/verifiedAt 部署事实；列表投影不返回 body/deployMeta）
 */
export interface BoardDigestMilestone {
  /** 里程碑 ID */
  id: string;
  /** 里程碑名称 */
  name: string;
  /** 里程碑状态（普通四态或 release 五态之一） */
  status: MilestoneStatus;
  /** 开始日期（可空） */
  startDate: string | Date | null;
  /** 目标日期（可空） */
  targetDate: string | Date | null;
  /** Release 版本号（null/省略 = 普通里程碑） */
  version?: string;
  /** 最近一次部署时间（仅 release 里程碑可能非空） */
  deployedAt?: string | Date;
  /** 验收时间（仅 release 里程碑可能非空） */
  verifiedAt?: string | Date;
  /** 关联任务统计 */
  stats: BoardDigestMilestoneStats;
}

/**
 * Board Digest 版本区条目（versions.production/development/history 共用）
 * 仅 version 非空的 Release 里程碑进入版本区；stats 口径同 milestones 段
 */
export interface BoardDigestVersionRef {
  /** 里程碑 ID */
  id: string;
  /** Release 版本号（版本区条目必非空） */
  version: string;
  /** 里程碑名称 */
  name: string;
  /** 里程碑状态（release 态：dev/ready/deployed/verified） */
  status: MilestoneStatus;
  /** 最近一次部署时间（未部署过的 release 条目为 null/省略） */
  deployedAt?: string | Date;
  /** 验收时间（未验收为 null/省略） */
  verifiedAt?: string | Date;
  /** 关联任务统计 */
  stats: BoardDigestMilestoneStats;
}

/**
 * Board Digest 风险任务条目：labels 含 bug/debt 之一 且状态未完成（done/archived 之外）
 */
export interface BoardDigestRisk {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 优先级（p0 最高） */
  priority: Priority;
  /** 任务状态 */
  status: TaskStatus;
  /** 标签数组（含 bug/debt 之一） */
  labels: string[] | null;
  /** 负责人显示名（未分配为 null） */
  assigneeName: string | null;
  /** 软删时间；非空 = 该 assignee 已删除，assigneeName 仍可显示（历史归因保留） */
  assigneeDeletedAt?: string | null;
}

/**
 * Board Digest 开放任务条目（nextUp：backlog/todo/in_progress/blocked/review，priority 序）
 */
export interface BoardDigestOpenTask {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 优先级（p0 最高） */
  priority: Priority;
  /** 任务状态 */
  status: TaskStatus;
  /** 负责人显示名（未分配为 null） */
  assigneeName: string | null;
  /** 软删时间；非空 = 该 assignee 已删除，assigneeName 仍可显示（历史归因保留） */
  assigneeDeletedAt?: string | null;
}

/**
 * Board Digest 最近完成任务条目（recentDone：status=done，completedAt desc）
 */
export interface BoardDigestDoneTask {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 完成时间（status=done 时非空） */
  completedAt: string | Date;
  /** 负责人显示名（未分配为 null） */
  assigneeName: string | null;
  /** 软删时间；非空 = 该 assignee 已删除，assigneeName 仍可显示（历史归因保留） */
  assigneeDeletedAt?: string | null;
}

/**
 * Board Digest docs 段：board 绑定 DocSpace 的元数据快照
 *
 * 权限语义（v1.41 契约层决定，评审已拍板）：board 可读即蕴含其绑定空间的
 * 元数据可读——spaceName/descriptionSnippet/文档 path+title+updatedAt（不含正文），
 * 不做 DocSpace 成员校验。
 */
export interface BoardDigestDocs {
  /** 绑定 DocSpace ID */
  spaceId: string;
  /** 绑定 DocSpace 名称 */
  spaceName: string;
  /** 空间图例摘要（≤200 字符截断，无图例为 null） */
  spaceDescriptionSnippet: string | null;
  /** 最近更新文档列表（updatedAt desc，docsLimit 截断） */
  recentlyUpdated: {
    /** 文档路径（空间内唯一） */
    path: string;
    /** 文档标题 */
    title: string;
    /** 文档更新时间 */
    updatedAt: string | Date;
  }[];
}

/**
 * Board Digest 版本区（v1.42）：Release 版本三区视图，全部内存装配（复用 milestones 段
 * 已加载的 milestone 全量集合 + stats 批量结果，零新查询）
 *
 * - production：version 非空 ∧ status∈{deployed,verified} 中 deployedAt 最新（并列取 createdAt 最新）
 * - development：version 非空 ∧ status∈{dev,ready} 中 createdAt 最新
 * - history：version 非空全体按 deployedAt DESC NULLS LAST + createdAt DESC，slice(0, versionLimit)
 * - total：version 非空总数（不受 versionLimit 截断影响）
 */
export interface BoardDigestVersions {
  /** 当前生产版（无已部署 release 时为 null） */
  production: BoardDigestVersionRef | null;
  /** 当前开发版（无 dev/ready release 时为 null） */
  development: BoardDigestVersionRef | null;
  /** 版本史（deployedAt DESC NULLS LAST，versionLimit 截断） */
  history: BoardDigestVersionRef[];
  /** version 非空的 Release 里程碑总数（截断判断用：total > history.length） */
  total: number;
}

/**
 * Board Digest（v1.41）：项目总揽实时装配视图，替代 PROJECT.md 的人工快照
 *
 * 由 GET /boards/:id/digest 从 task/milestone/docspace 事态实时装配，永不存储。
 * 设计原则：机器能从事态算出的绝不人填；必须人写的（图例）写在 board.description。
 *
 * taskCount 口径（v1.41 核实结论）：对齐 GET /boards/:id 详情（enrich）——
 * 未删除列 + 未删除任务，含 archived；与 topic digest 口径（innerJoin 不排除
 * 已删除列）存在已知差异，不修 trigger，仅以 board 详情口径为准。
 */
export interface BoardDigest {
  /** 看板 ID */
  boardId: string;
  /** 看板名称 */
  boardName: string;
  /** 项目图例全文（includeDescription=false 时为 null；始终全量不截断） */
  description: string | null;
  /** 看板可见性（settings.visibility，缺省 open） */
  visibility: Visibility;
  /** 任务总数（口径同上注释） */
  taskCount: number;
  /** 已完成任务数（status=done 计数） */
  completedTaskCount: number;
  /** 列摘要（未删除列，position 序） */
  lists: BoardDigestList[];
  /** 里程碑（v1.42 起含 version/deployedAt/verifiedAt 投影） */
  milestones: BoardDigestMilestone[];
  /**
   * 版本区（v1.42）：production/development/history/total；
   * 无任何 release 里程碑时 production/development 为 null、history 为空数组、total 0
   */
  versions: BoardDigestVersions;
  /** 开放任务优先级分布（open 任务按 priority 内存聚合，p0/p1/p2/p3） */
  priorityDistribution: {
    open: Record<Priority, number>;
  };
  /** 风险任务（labels 含 bug/debt 且状态非 done/archived，priority 序，riskLimit 截断） */
  risks: BoardDigestRisk[];
  /**
   * 风险任务总数（截断元数据补齐）：risks 全量计数，不受 riskLimit 截断影响；
   * 截断判断用：risksTotal > risks.length
   */
  risksTotal: number;
  /** 下一步任务（open 任务 priority 序，openLimit 截断） */
  nextUp: BoardDigestOpenTask[];
  /**
   * 开放任务总数（截断元数据补齐）：nextUp 全量计数，不受 openLimit 截断影响；
   * 截断判断用：nextUpTotal > nextUp.length
   */
  nextUpTotal: number;
  /** 最近完成任务（completedAt desc，doneLimit 截断） */
  recentDone: BoardDigestDoneTask[];
  /**
   * 最近完成任务总数（截断元数据补齐）：recentDone 全量计数，不受 doneLimit
   * 截断影响；截断判断用：recentDoneTotal > recentDone.length
   */
  recentDoneTotal: number;
  /** 绑定 DocSpace 元数据；无绑定空间时为 null */
  docs: BoardDigestDocs | null;
  /**
   * 绑定空间最近更新文档总数（截断元数据补齐）：docs.recentlyUpdated 全量计数，
   * 不受 docsLimit 截断影响；截断判断用：docsTotal > docs.recentlyUpdated.length。
   * 无绑定空间（docs 为 null）时缺省。
   */
  docsTotal?: number;
  /**
   * 测试基线等机器事实（settings.metrics，由 report-metrics.mjs 上报；透传不加工）。
   * 无 metrics 时 null。设计与 metrics 端点的唯一写口对齐：digest 永不写入。
   */
  metrics: Record<string, unknown> | null;
  /**
   * 圆桌平台级指标（v1.44.0-dev，M2 阶段 7，实时装配新段）。
   *
   * 平台级口径：topic/seat/message 均不隶属于 board——digest 虽按 board 调用，
   * 本段统计的是**全平台**（设计文档 §12 r10）。永远输出该段：平台无圆桌时
   * 全零（形状可预测，不返回 undefined）。
   */
  roundtable: {
    /** 圆桌 topic 数（topics.kind='roundtable' 全平台计数） */
    topicCount: number;
    /** 座位数（roundtable_seats.status='active' 全平台计数） */
    seatCount: number;
    /** 日均轮次：近 7 天座位消息数（metadata.seatLabel 非空）÷ 7，保留两位小数 */
    dailyRounds: number;
    /**
     * 沉默拦截率：Σseat.state.silentCount ÷ (ΣsilentCount + 座位消息全时段累计)。
     * 分母 = 全时段座位消息总数（非 7 天窗口）；分母为 0 时为 0（防除零）。
     */
    silentRate: number;
    /** 熔断触发总次数：Σseat.state.valveTripCount（圆桌安全阀跨过阈值次数） */
    valveTripCount: number;
  };
  /** 任一列表段（risks/nextUp/recentDone/recentlyUpdated/versions.history）被 limit 截断时为 true */
  truncated: boolean;
}
