/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎读面的**共享前置件**：项目存在性 → 引擎可用性闸 → 调用目标（target）→
 *     引擎失败的**标准两档分派**。投影读面（`memory-views.service.ts`）与 usage 读面
 *     （`memory-usage.service.ts`）共用，**禁止各抄一份**——两份 = 迟早一处少判一个 reason
 *
 * [代码职责]
 *   - `findProjectForEngineCall`：取项目（软删 = 404）
 *   - `assertEngineAvailable`：`MEMORY_ENGINE` token 是否装配 + 本项目三列是否齐
 *     （不可用 ⇒ 503/14000 + reason）；可用 ⇒ 返回 `MemoryEngineTarget`
 *   - `throwMemoryEngineFailure`：投影读面的两档分派（http/invalid_response ⇒ 502/14004 +
 *     engineCode；timeout/unreachable ⇒ 503/14000 + reason）
 *
 * [权威文档]
 *   - 线上 `docs/api-definition.md` §19.2（引擎闸「双组形状」）
 *   - `memory-views.service.ts` 的 [关键不变量]（先存在性/权限、后引擎可用性）
 *
 * [关键不变量]
 *   - **顺序不可互换**：调用方必须**先**做项目存在性与权限判定，**再**调本文件的可用性闸。
 *     "引擎没配"不该抢在"项目不存在/无权"前面变成 503（否则泄露项目外存在性，且把配置问题
 *     伪装成权限问题）。
 *   - **target 不由本层派生**：workspace/actor/credential 全部来自 `memory_projects` 注册表；
 *     任何"引擎自己找 workspace"的写法都会把权限判定从 Chamber 侧偷走。
 *   - **错误文案不含用户输入**：`action` 只允许调用方写死的英文动作短语（不含 id / 正文 /
 *     凭据引用），失败面只搬运 engineCode/requestId 这类诊断标量。
 *   - **usage 的错误分桶更细**（版本/身份/cursor），故 usage 服务**不直接**用
 *     `throwMemoryEngineFailure` 兜底，而是先做 usage 专属分桶、再把 timeout/unreachable
 *     交回本函数（或复用同一 `memoryUnavailable` 构造器）。
 *
 * [关联代码]
 *   - memory-views.service.ts — 五个投影读面的消费方
 *   - memory-usage.service.ts — usage 两读面的消费方
 *   - memory.constants.ts — 14000/14004 的唯一错误构造点
 * =============================================================================
 */
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import { memoryEngineError, memoryUnavailable } from './memory.constants';
import {
  type MemoryEngineFailure,
  type MemoryEngineTarget,
} from './engines/memory-engine.interface';
import type { MemoryEngine as MemoryEnginePort } from './engines/memory-engine.interface';
import type { MemoryProjectService } from './memory-project.service';
import type { MemoryFormationService } from './memory-formation.service';
import { MEMORY_UNAVAILABLE_REASON } from '@agent-chamber/shared';

/**
 * 共享前置件的最小依赖面（type-only：不制造运行时循环依赖）。
 *
 * 用 `Pick<>` 而不是整类：消费方只需知道"这两个方法存在"，测试替身也不必实现整类。
 */
export interface MemoryEngineAccessDeps {
  /** `MEMORY_ENGINE` token 的值（关闭态 = null） */
  engine: MemoryEnginePort | null;
  /** 项目服务（存在性 + 可用性判据） */
  projectService: Pick<MemoryProjectService, 'findProjectOrThrow' | 'engineAvailability'>;
  /** 形成服务（`engineTarget` 的唯一派生点） */
  formation: Pick<MemoryFormationService, 'engineTarget'>;
}

/**
 * 取项目（软删视为不存在 ⇒ 404/14001）。
 *
 * 调用方随后必须自行做权限判定（本函数**不判权限**：views 用内容闸、usage 用全绑定闸）。
 */
export async function findProjectForEngineCall(
  deps: Pick<MemoryEngineAccessDeps, 'projectService'>,
  projectId: string,
): Promise<MemoryProject> {
  return deps.projectService.findProjectOrThrow(projectId);
}

/**
 * 引擎可用性闸（与 recall / 详情 / views / usage 同款）。
 *
 * @returns 引擎调用目标（workspace / actor / credentialRef）
 * @throws ServiceUnavailableException 503/14000（全局未配 or 本项目未绑）
 */
export function assertEngineAvailable(
  deps: MemoryEngineAccessDeps,
  project: MemoryProject,
): MemoryEngineTarget {
  const availability = deps.projectService.engineAvailability(project);
  if (!availability.available || deps.engine === null) {
    throw memoryUnavailable(
      availability.reason ?? MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
    );
  }
  return deps.formation.engineTarget(project);
}

/**
 * 投影读面引擎失败的**唯一分派点**（两档）。
 *
 * ⚠️ usage 读面**不要**直接用它兜底：usage 对 404/invalid_response/409/403 有更细的
 * 版本/身份/cursor 分桶（见 `memory-usage.service.ts`）；只有 timeout/unreachable 与
 * "引擎答错但无更细分桶"的情况才落到这里。
 *
 * @param failure 引擎失败面（不含上游错误体原文）
 * @param action 英文动作短语（拼进 message，**不含用户输入**）
 */
export function throwMemoryEngineFailure(failure: MemoryEngineFailure, action: string): never {
  switch (failure.kind) {
    case 'http':
    case 'invalid_response':
      // 502/14004：引擎可达但拒了这次请求（含 cursor 失效双通道），engineCode 逐字透传
      throw memoryEngineError(
        failure.engineCode,
        `The memory engine could not ${action}` +
          `${failure.engineCode ? ` (${failure.engineCode})` : ''}. Nothing was read; ` +
          'retry later or check the project engine binding.',
      );
    case 'timeout':
      throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT);
    case 'unreachable':
      throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE);
    default: {
      // 穷尽性守卫：新增失败分类时当场编译报错（三档重试语义完全不同）
      const unmapped: never = failure.kind;
      throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE, {
        engineCode: `unmapped_engine_failure_kind:${String(unmapped)}`,
      });
    }
  }
}
