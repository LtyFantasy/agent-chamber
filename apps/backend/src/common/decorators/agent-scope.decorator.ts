import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '@agent-chamber/shared';

/**
 * `@AgentScope` 元数据键（Reflector 读取，同构 `roles.decorator.ts` 的 ROLES_KEY）。
 * 独立导出以便豁免清单的双向相等 spec 直接引用，避免 spec 与守卫各写一份字符串键。
 */
export const AGENT_SCOPE_KEY = 'agentScope';

/**
 * 显式声明某端点在**方法判定之外**所需的 API Key scope。
 *
 * 用途（docs/api-definition.md §2.1）：默认判定只按 HTTP 方法（GET/HEAD → read，
 * 其余 → write），因此读语义的 POST 端点（recalls / validate / signed-url / read /
 * usage-events）必须显式标注 `@AgentScope('read')` 才能被只读 key 使用。
 *
 * ⚠️ 本 decorator 是**方法判定的覆写**，不是豁免开关：标 `'write'` 也可用于把
 * 某 GET 收紧为需写权限（当前无使用者）。真正的"无条件放行"只存在于守卫的
 * OPTIONS 分支，不提供任何 decorator 旁路——旁路会让豁免面脱离机器强制。
 *
 * 豁免面被 `../config/agent-scope-exemptions.spec.ts` 双向断言钉死：
 * 标注集合必须与签入清单**严格相等**，多一个少一个都红；同一文件另有一条
 * "引用本模块的文件集合 === 白名单" 的断言，故**新增引用者必须显式登记**。
 *
 * @param scope 所需 scope（值域 = shared `API_KEY_SCOPE_VALUES`）
 */
export const AgentScope = (scope: ApiKeyScope) => SetMetadata(AGENT_SCOPE_KEY, scope);
