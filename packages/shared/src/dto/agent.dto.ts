import { AgentStatus } from '../enums';

/**
 * Agent 配置输入
 */
export interface AgentConfigInput {
  /** LLM 模型 */
  model?: string;
  /** 温度参数 */
  temperature?: string;
  /** 最大 Token 数 */
  maxTokens?: string;
  /** 自定义参数 */
  customParams?: Record<string, unknown>;
}

/**
 * 创建 Agent 请求输入
 */
export interface CreateAgentInput {
  /** Agent 名称 */
  name: string;
  /** Agent 描述 */
  description?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 能力列表 */
  capabilities?: string[];
  /** Agent 配置 */
  config?: AgentConfigInput;
  /** 头像 URL */
  avatar?: string;
}

/**
 * 更新 Agent 请求输入
 */
export interface UpdateAgentInput {
  /** Agent 名称 */
  name?: string;
  /** Agent 描述 */
  description?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 能力列表 */
  capabilities?: string[];
  /** Agent 配置 */
  config?: AgentConfigInput;
  /** 头像 URL；传 null 表示清空头像（回落确定性生成头像），并联动清除 avatar_svg */
  avatar?: string | null;
  /** Agent 状态 */
  status?: AgentStatus;
}

/**
 * Agent 心跳请求输入（plan plastic-man-wonder-man-raven.md §1，全部字段可选）
 *
 * 写入语义 =「全列快照 upsert」：agent_heartbeats 每 agent 恒一行，未提供的遥测列
 * 被显式清空（省略 = null/0/{}），调用方必须每拍全量自报；status 省略回退 agent
 * 当前 status，timestamp 省略 = now()，lastError 非空时服务端同步写 lastErrorAt。
 */
export interface AgentHeartbeatInput {
  /** 状态（省略时服务端回退 agent 当前 status，不回退上一拍心跳值） */
  status?: AgentStatus;
  /** 负载（折叠进 meta.load 存储） */
  load?: number;
  /** 版本（折叠进 meta.version 存储） */
  version?: string;
  /** 上报时刻（ISO 8601；省略时服务端取 now()） */
  timestamp?: string;
  /** 延迟毫秒数 */
  latencyMs?: number;
  /** 内存占用 MB */
  memoryMb?: number;
  /** CPU 百分比（0~100） */
  cpuPercent?: number;
  /** 活跃任务数 */
  activeTasks?: number;
  /** 队列深度 */
  queueDepth?: number;
  /** 已处理事件数（累计） */
  processedEvents?: number;
  /** 错误计数（累计） */
  errorCount?: number;
  /** 最近错误信息；非空时服务端同步写 lastErrorAt = timestamp */
  lastError?: string;
  /** 扩展元数据（load/version 折叠进本字段，与 meta 键共存） */
  meta?: Record<string, unknown>;
}

/**
 * 创建 Agent Key 请求输入
 */
export interface CreateAgentKeyInput {
  /** Key 名称 */
  name: string;
}
