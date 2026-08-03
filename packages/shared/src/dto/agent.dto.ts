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
 * Agent 心跳请求输入
 */
export interface AgentHeartbeatInput {
  /** 状态 */
  status?: string;
  /** 负载 */
  load?: number;
  /** 版本 */
  version?: string;
  /** 时间戳 */
  timestamp?: string;
}

/**
 * 创建 Agent Key 请求输入
 */
export interface CreateAgentKeyInput {
  /** Key 名称 */
  name: string;
}
