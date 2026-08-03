/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §关键设计决策-认证
 *   - 补充: AGENTS.md §6 (Platform 协作规范)
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { AuthConfig } from '../types';

/**
 * 认证提供者
 *
 * 管理 API 认证配置，支持 API Key、Bearer Token、Basic Auth 三种方式。
 * 根据 CLI 参数构建认证配置对象，供 HttpProxy 注入请求头。
 */
export class AuthProvider {
  private readonly config: AuthConfig;

  /**
   * 创建认证提供者实例
   * @param config - 认证配置
   */
  constructor(config: AuthConfig) {
    this.config = config;
  }

  /**
   * 获取当前认证配置
   * @returns 认证配置对象
   */
  getConfig(): AuthConfig {
    return this.config;
  }

  /**
   * 从 CLI 选项构建认证配置
   * @param options - CLI 选项对象（包含 apiKey / bearerToken）
   * @returns 认证配置，如无认证信息则返回 undefined
   */
  static fromOptions(options: { apiKey?: string; bearerToken?: string }): AuthConfig | undefined {
    if (options.apiKey !== undefined) {
      return { type: 'apiKey', apiKey: options.apiKey };
    }

    if (options.bearerToken !== undefined) {
      return { type: 'bearer', bearerToken: options.bearerToken };
    }

    return undefined;
  }
}
