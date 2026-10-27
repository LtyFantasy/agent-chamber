/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - API Key 的**响应投影白名单**：`api_keys` 行的对外形状（逐 key 端点唯一出口）
 *
 * [代码职责]
 *   - 把 `ApiKey` 实体收窄为固定字段表；任何新增字段必须先进白名单才可能外泄
 *   - 供 `agent.service.ts` 的 findKeys / createKey / resetKey 共用（三处同形，禁止各写一份）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §5. Agents（agent keys 响应字段表）
 *
 * [关键不变量]
 *   - **禁止 `...spread` 裸实体**：`keyHash`（sha256 全文）一旦外泄即等于"离线校验 API Key"
 *     的字典，属凭证泄露；`ipWhitelist` 当前无任何保护语义（见 spec 登记）。
 *   - **scopes 只挂逐 key 端点**：agent 级 latest-key 投影（`agent.service.ts` findAll 的
 *     `DISTINCT ON (agent_id)` 单 key 查询）**禁止**加 scopes——一 agent 多 key 时必说谎。
 *   - 字段表是**契约**：web（agents/[id]/keys 页）与 MCP 消费方按此读取；删字段 = 破坏性变更。
 *
 * [关联代码]
 *   - ../agent.service.ts — 唯一消费者
 *   - ../agent.service.spec.ts — 白名单守卫（`findKeys` / `createKey` / `resetKey` 三个用例组断言
 *     keyHash 与 ipWhitelist 不外泄 + 字段表严格相等；本文件刻意不建同名 spec——
 *     白名单只有在真实消费路径上断言才有意义，独立 spec 只会变成恒绿的空转）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增字段前确认它不是凭证/内部治理字段
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { ApiKeyScope } from '@agent-chamber/shared';
import { resolveKeyScopes } from '../../common/utils/api-key-scope';
import type { ApiKey } from '../../database/entities/api-key.entity';

/** API Key 对外形状（逐 key 端点契约，字段顺序即文档顺序） */
export interface ApiKeyProjection {
  id: string;
  name: string;
  keyPrefix: string;
  /** 权限范围（收窄后的合法值域；非法/缺失 → 空数组，**不**回退为全权） */
  scopes: readonly ApiKeyScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * 实体 → 对外投影。
 *
 * @param key api_keys 行
 * @returns 白名单字段；`scopes` 经 {@link resolveKeyScopes} 收窄（非法形态 → `[]`，
 *          使读侧"看起来没有权限"，与执行面的 fail-closed 一致）
 */
export function projectApiKey(key: ApiKey): ApiKeyProjection {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: resolveKeyScopes(key.permissions) ?? [],
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}
