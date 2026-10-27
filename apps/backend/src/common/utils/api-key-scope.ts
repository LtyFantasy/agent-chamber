/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - API Key scopes（read / write）的**判定单一事实来源**：从 `api_keys.permissions`
 *     jsonb 收窄出权限集合，并回答"这个 HTTP 方法需要哪个 scope"
 *
 * [代码职责]
 *   - 纯函数、零依赖、零 IO：HTTP 全局守卫（`common/guards/api-key-scope.guard.ts`）
 *     与 WS 握手（`modules/roundtable/runner.gateway.ts`）**共用**本文件，禁止任一侧
 *     自写判定（两处漂移 = 通道间权限不一致，属安全缺陷）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.1 —— API Key scope 语义表（read/write 定义、
 *     fail-closed 规则、豁免面、判定规则）
 *   - 补充: 线上 docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *
 * [关键不变量]
 *   - **fail-closed**：scopes 缺失 / 非数组 / 空数组 / 含任何未知值 → 返回 null，调用方
 *     必须拒绝。存量生产 47 把 key 全部为 `['read','write']`，故现网零影响（只读盘点为证）。
 *   - **write 不蕴含 read**：`hasScope(['write'], 'read') === false`（对齐"task 写不蕴含读"
 *     的既有判定）。因此只读豁免端点必须显式 `@AgentScope('read')` 而非靠方法判定。
 *   - 值域单源 = shared `API_KEY_SCOPE_VALUES`；本文件**禁止**出现 `['read','write']`
 *     字面量（新增档位只应改 shared 常量一行）。
 *
 * [关联代码]
 *   - ../guards/api-key-scope.guard.ts — HTTP 唯一消费者（APP_GUARD）
 *   - ../decorators/agent-scope.decorator.ts — 方法判定的显式覆写载体
 *   - ../services/api-key-auth.service.ts — 把 permissions 放进 request.agent
 *   - ../../modules/roundtable/runner.gateway.ts — WS 握手消费者（恒需 write）
 *   - ./api-key-scope.spec.ts — 判定矩阵单测
 *
 * [持久踩坑]
 *   - SCOPE-FAILOPEN(权限判定默认放行): 把"缺失 scopes"当"无限制"是本类缺陷的经典形态
 *     （与 auth 软删 fail-open 同源）。缺失必须等于**拒绝**，且拒绝路径要有可观测点
 *     （守卫侧 warn 日志带 actor id + keyPrefix + method + path）。旧数据/旧客户端因此
 *     被拒是可接受的代价——宽放行不可回滚，窄拒绝可加豁免。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（HTTP guard 与 WS 握手两侧同改）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { API_KEY_SCOPE_VALUES, type ApiKeyScope } from '@agent-chamber/shared';

/** 全部合法 scope（运行时白名单，取自 shared 单源常量） */
const KNOWN_SCOPES: readonly string[] = API_KEY_SCOPE_VALUES;

/**
 * 从 `api_keys.permissions` jsonb 收窄出权限集合。
 *
 * 入参按 `unknown` 处理（DB jsonb 不可信、历史行可能被外部工具改写），**逐元素**运行时
 * 校验，禁止 `as ApiKeyScope[]` 类型断言。
 *
 * @param permissions `api_keys.permissions` 列值（形状 `{ scopes: string[] }`）
 * @returns 合法 scope 数组（非空、元素已收窄）；任何非法形态 → `null`（调用方 fail-closed 拒绝）
 */
export function resolveKeyScopes(permissions: unknown): readonly ApiKeyScope[] | null {
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return null;
  }
  const raw = (permissions as { scopes?: unknown }).scopes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const out: ApiKeyScope[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !KNOWN_SCOPES.includes(item)) {
      // 未知值 = 无法证明其含义 → 整体拒绝（而非静默丢弃后按剩余集合放行）
      return null;
    }
    if (!out.includes(item as ApiKeyScope)) {
      out.push(item as ApiKeyScope);
    }
  }
  return out;
}

/**
 * 权限集合是否满足所需 scope。
 *
 * @param scopes {@link resolveKeyScopes} 的返回值（null = 非法，恒不满足）
 * @param required 所需 scope
 * @returns true 当且仅当 scopes 非 null 且包含 required
 */
export function hasScope(scopes: readonly ApiKeyScope[] | null, required: ApiKeyScope): boolean {
  return scopes !== null && scopes.includes(required);
}

/** HTTP 方法 → 所需 scope 的映射结果：`null` 表示该方法无条件放行 */
export type RequiredScopeVerdict = { required: ApiKeyScope } | { required: null; reason: string };

/**
 * 按 HTTP 方法推导所需 scope（方法维度的**唯一**映射点）。
 *
 * 规则（docs/api-definition.md §2.1）：
 * - `GET` / `HEAD` → `read`
 * - 其余（POST / PATCH / PUT / DELETE / …）→ `write`
 * - `OPTIONS` → 无条件放行（CORS 预检无业务语义，且浏览器不携带自定义头）
 *
 * ⚠️ 只按**方法**判定，绝不按路径字符串清单判定——路由改名会静默失效。读语义的 POST
 * 端点靠 `@AgentScope('read')` 元数据显式覆写（守卫侧生效），本函数不做路径匹配。
 *
 * @param method Express `request.method`（大写）
 * @returns 所需 scope；OPTIONS 返回 `{ required: null }`
 */
export function requiredScopeForMethod(method: string): RequiredScopeVerdict {
  const upper = method.toUpperCase();
  if (upper === 'OPTIONS') {
    return {
      required: null,
      reason: 'CORS 预检无业务语义（浏览器不携带 X-API-Key，无权限面可判）',
    };
  }
  if (upper === 'GET' || upper === 'HEAD') {
    return { required: 'read' };
  }
  return { required: 'write' };
}
