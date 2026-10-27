/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - HTTP / WS 共用的 API Key 身份认证与认证遥测
 *
 * [代码职责]
 *   - 校验 Key 与 Agent 状态，原样返回认证上下文，并写入使用/活跃时间
 *
 * [权威文档]
 *   - 主文档: DocSpace Agent Chamber / docs/architecture.md §3.2.1 Account Module
 *   - 补充: 同空间 docs/api-definition.md §2.1 — 认证与 scopes 判定边界
 *   - 补充: 同空间 docs/modules/roundtable-design.md §7 — runner 使用普通 Agent API Key
 *
 * [关键不变量]
 *   - 本服务只做**认证**并把 `api_keys.permissions` 原样透传进 `AgentPayload.permissions`
 *     （**不做**任何权限判定）。scopes 的判定与执行在
 *     `common/guards/api-key-scope.guard.ts` + `common/utils/api-key-scope.ts`（HTTP）与
 *     `modules/roundtable/runner.gateway.ts`（WS 握手）三处，共用同一工具函数。
 *     ⚠️ 禁止在本服务内加"顺手"的 scope 检查或收窄 permissions——那会造成双源漂移。
 *   - 遥测只按 id 更新 lastUsedAt / lastActiveAt，不改变查询快照、不保存旧关系图。
 *     Key 写同步 await 且失败传播；Agent 写异步 catch，不阻塞认证返回。
 *
 * [关联代码]
 *   - apps/backend/src/common/guards/api-key-scope.guard.ts — HTTP 授权
 *   - apps/backend/src/common/utils/api-key-scope.ts — scopes 判定单源
 *   - apps/backend/src/modules/roundtable/runner.gateway.ts — WS 握手授权
 *   - apps/backend/src/common/services/api-key-auth.service.spec.ts — 遥测与失败时序回归
 *
 * [持久踩坑]
 *   - A3-1b(actor.deletedAt死代码): select:false 使正常查询的 deletedAt 恒 undefined；
 *     软删 Actor 被 eager LEFT JOIN 过滤，actor=null 由 status 校验拒绝。
 *     详情: 同空间 docs/architecture.md §3.2.1；apps/backend/src/modules/agent/agent.service.ts A3-1。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';

/**
 * API Key → Agent 身份认证结果（HTTP guard 挂到 request.agent，WS 握手直接消费）。
 * permissions 形状来自 api_keys 表 jsonb（{ scopes: [...] }，MCP/REST 通用）。
 *
 * keyPrefix（v1.69.0 活动日志插桩，plan shadowcat-sunspot-catwoman 决策 9）：
 * 多 key 粒度缓解——认证上下文携带本次所用 key 的前缀（8 字符，非明文），
 * 审计插桩塞进 newData（{keyId, keyPrefix, agentId}），「我的哪把 key 做了什么」
 * 可答。仅前缀不涉密；完整 apiKey 明文禁止入审计字段。
 */
export interface AgentPayload {
  id: string;
  name: string;
  ownerId: string;
  // 与 src/types/express.d.ts 的 request.agent.permissions 契约一致（均为 Record<string, unknown>）
  permissions: Record<string, unknown>;
  /** 本次认证所用 API Key 的前缀（rawKey.substring(0,8)，如 'ask_abcD'；可选——兼容 WS/其他构造方） */
  keyPrefix?: string;
}

/**
 * API Key 认证服务（纯抽取：原 ApiKeyGuard / JwtOrApiKeyGuard 的 API Key 分支，
 * 逻辑逐行原样搬入，M1 圆桌计划决策 4——三方共用：两个 HTTP guard + WS 握手）
 *
 * 语义约定（与抽取前完全一致）：
 * - sha256(key) → api_keys 表查 agent → actor 状态校验（revoked/deleted/expired/
 *   agent 不存在/非 active 任一命中即拒绝）
 * - 校验通过后更新 lastUsedAt（同步落库）与 lastActiveAt（异步 fire-and-forget，
 *   不阻塞热路径）
 * - 失败抛 UnauthorizedException + 具体业务 code（INVALID_API_KEY / TOKEN_EXPIRED /
 *   AGENT_NOT_FOUND / AGENT_DISABLED）——铁律 #9：禁止把认证失败包装成 500
 *
 * ⚠️ 行为基准 = ApiKeyGuard 的严格分支（逐条 throw）；JwtOrApiKeyGuard 的宽松分支
 * （try/catch 吞错 → 统一 UNAUTHORIZED）由其自身 catch 实现，两者条件判定等价
 * （抽取前已验证：inline boolean 链与 throw 链在每一分支判定结果相同）。
 */
@Injectable()
export class ApiKeyAuthService {
  constructor(
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
  ) {}

  /**
   * 校验 API Key 并返回 AgentPayload
   * @param apiKeyHeader 原始 API Key 明文（X-API-Key header 值）
   * @returns AgentPayload（agent id/name/ownerId/permissions）
   * @throws UnauthorizedException（缺失 key 由调用方处理；本方法只处理格式/存在性校验）
   */
  async authenticate(apiKeyHeader: string): Promise<AgentPayload> {
    const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');

    const apiKey = await this.apiKeyRepo.findOne({
      where: { keyHash },
      relations: ['agent'],
    });

    if (!apiKey) {
      throw new UnauthorizedException({
        message: 'Invalid API Key',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    if (apiKey.revokedAt || apiKey.deletedAt) {
      throw new UnauthorizedException({
        message: 'API Key has been revoked',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException({
        message: 'API Key has expired',
        code: ErrorCode.TOKEN_EXPIRED,
      });
    }

    const agent = await this.agentRepo.findOne({
      where: { id: apiKey.agentId },
      relations: { actor: true },
    });

    // ⚠️ 死代码清理（统一批 A3-1b）：此处只判 !agent——actor.deletedAt 是 select:false
    // 列，正常 findOne 恒 undefined，原 deletedAt 检查永不命中；软删 agent 的拦截语义
    // 由下方 status 检查兜底承担：actor 行被 eager LEFT JOIN 软删过滤 → agent.actor = null
    // → actor.status !== ACTIVE → AGENT_DISABLED 拒绝（另，A3-1 起软删已事务化吊销全部 Key）。
    if (!agent) {
      throw new UnauthorizedException({
        message: 'Agent not found',
        code: ErrorCode.AGENT_NOT_FOUND,
      });
    }

    if (agent.actor?.status !== AgentStatus.ACTIVE) {
      throw new UnauthorizedException({
        message: 'Agent is not active',
        code: ErrorCode.AGENT_DISABLED,
      });
    }

    /** 只写使用时间，避免旧 Key 快照回写吊销等生命周期字段；保留同步失败语义。 */
    await this.apiKeyRepo.update(apiKey.id, { lastUsedAt: new Date() });

    /** 不保存旧 Agent / Actor 关系图；活跃时间仍异步写入，失败不阻塞认证返回。 */
    this.agentRepo.update(agent.id, { lastActiveAt: new Date() }).catch(() => {});

    return {
      id: agent.id,
      name: agent.name,
      ownerId: agent.ownerId,
      permissions: apiKey.permissions,
      // 决策 9：认证上下文携带本次 key 前缀（审计 newData 缓解多 key 粒度）
      keyPrefix: apiKey.keyPrefix,
    };
  }
}
