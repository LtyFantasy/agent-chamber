/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块的 **Usage 读面服务**（hument alpha.19）：以**项目当前引擎身份**代理
 *     `GET /v1/usage/summary|trace`，并把身份/版本/cursor 失败翻成**可行动**的机器码
 *
 * [代码职责]
 *   - 五步闸门：项目存在性 → Usage 权限（admin 或**全部**绑定可读）→ 引擎可用性 →
 *     **共享/claim 归属**（全量 `withDeleted` 扫描 + 永久占用表）→ 并发闸内调引擎
 *   - 默认时间窗物化（省略 since/until 时用 `MEMORY_USAGE_CLOCK` 一次性生成 7 天绝对窗口，
 *     经 `engine.filter` 回声；第二页绝不重算 now）
 *   - 响应装配：`{ engine, target, usageCaveat }`，**engine 不含 `target`**（身份回声只在外层
 *     camelCase target，不透出 binding/namespace/credentialRef）
 *   - 错误分桶：version / data / identity / cursor / 429 / 通用不可用（见 `throwUsageFailure`）
 *
 * [权威文档]
 *   - 合同事实源（只读）: `~/.hument/chamber-dev/upgrade-alpha19/` 的
 *     `usage-summary.schema.json` / `usage-trace.schema.json` / `hument-v1.yaml`
 *   - 计划 `constantine-pantha-lockjaw.md` §2.1–2.3 / §3.2（终审合同，不重新设计）
 *
 * [关键不变量]
 *   - **权限不是 `assertProjectContentRead`**：Usage 是项目级引擎聚合，要求**非空且每条绑定
 *     都可读**（admin 例外）。治理观察者/部分可读 ⇒ 403/1009；非治理且零绑定或全不可读 ⇒
 *     404/14001（存在性防泄露）。**拒绝时 Hub 调用为 0**。
 *   - **共享扫描覆盖 `withDeleted` 的全部项目行**（active + archived + 软删，**不按 status
 *     过滤**）：软删项目的历史引擎身份仍然存在，漏掉它 = 用量被当成"只属于当前项目"。
 *   - **共享扫描与 claim 归属是 AND + deny 优先**：任一否决即 409/14006
 *     `hintCode=shared_engine_binding`，不能互相覆盖；文案不回显 credentialRef/workspace/
 *     actor/其他项目 id。claim 缺失/他人占用同样拒绝（迁移前/历史数据 = 无证据 ⇒ fail-closed）。
 *   - **两道闸都在引擎调用之前**：拒绝时 Hub 零调用（e2e 用计数器钉住）。
 *   - **不重算 totals**：引擎的 `totals` 覆盖完整匹配集，**禁止**从 `rows`/`groups` 重算或
 *     把小计相加；`null`/`absent`/`0` 三态逐字透传（actual cost 未知不是 0）。
 *   - **默认时间窗只在服务端物化一次**：两侧都省略才生成；带 cursor 时 DTO 已强制显式
 *     since/until——服务层**不得**在第二页重新计算"现在"。
 *   - **engine 块去掉 `target`**：合同响应有 target（binding_id/namespace_id），平台只在外层
 *     回声 workspaceId/actorId/scope。normalizer 已在引擎层校验 target 与请求一致。
 *   - **错误分桶优先级**：`schema_incompatible`（数据）> `scope_denied`/target（身份）>
 *     404（版本）> 409/携 cursor 400（cursor）> 429；400 不带 cursor 视为合同不匹配
 *     （版本不支持），因为 DTO 已把平台能产生的参数错误挡在边界层。
 *   - **并发闸只包 engine 调用**（权限/扫描/窗口物化在占槽之前）；`finally` 释放。
 *
 * [关联代码]
 *   - ./memory-engine-access.ts — 项目存在性/引擎可用性/标准失败分派的共享前置件
 *   - ./memory-access.service.ts — `canReadMemoryUsage`（权限判据单源）与绑定解析
 *   - ./engines/hument.engine.ts — usage 两动词的真实现（独立 query builder，禁 scope）
 *   - ./engines/fake.engine.ts — 确定性替身（过滤/分页/null 三态/游标双通道）
 *   - ./memory.constants.ts — 14000/14006/429 构造器与上限
 *   - ./dto/memory-usage.dto.ts — 闭合请求词表（summary 无分页、trace limit 1–200）
 *
 * [持久踩坑]
 *   MEMORY-USAGE-SHARED(共享身份当独占): 只看当前项目行 ⇒ 软删/归档的同三元组项目被忽略，
 *     用量被当成独占。安全方向: `withDeleted` 全表扫描 + claim 归属 AND。
 *   MEMORY-USAGE-TARGET-ECHO(跨身份交付): 直接把 Hub 响应交付 ⇒ 外层出现 binding_id/
 *     namespace_id/credentialRef，或 target 与请求不符时仍返回 200。安全方向: 引擎层校验
 *     target + 服务层剥掉 engine.target。
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 改权限/共享判定必须同步 `memory-usage.service.spec` 与 `test/memory-usage.e2e-spec.ts`
 *   □ 改错误分桶必须同步 controller 的 Swagger 行动表与 hint-registry 计数
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode, MEMORY_ENGINE, MEMORY_UNAVAILABLE_REASON } from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { MemoryEngineBindingClaim } from '../../database/entities/memory-engine-binding-claim.entity';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type HumentUsageSummaryQuery,
  type HumentUsageTraceQuery,
  type MemoryEngine as MemoryEnginePort,
  type MemoryEngineFailure,
  type MemoryEngineTarget,
} from './engines/memory-engine.interface';
import {
  assertEngineAvailable,
  findProjectForEngineCall,
  type MemoryEngineAccessDeps,
} from './memory-engine-access';
import {
  canReadMemoryUsage,
  MemoryAccessService,
  type MemoryProjectAccess,
} from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { MemoryUsageConcurrencyGate } from './memory-usage-concurrency.gate';
import {
  MEMORY_USAGE_DEFAULT_WINDOW_DAYS,
  MEMORY_USAGE_TRACE_DEFAULT_LIMIT,
  MemoryUsageRateLimitedException,
  memoryProjectNotFound,
  memoryUnavailable,
  memoryUsageCursorReset,
  memoryUsageSharedBinding,
} from './memory.constants';
import {
  MEMORY_USAGE_CAVEAT,
  type MemoryUsageSummaryResponse,
  type MemoryUsageTarget,
  type MemoryUsageTraceResponse,
} from './dto/memory-contract';
import type { QueryMemoryUsageSummaryDto, QueryMemoryUsageTraceDto } from './dto/memory-usage.dto';

const logger = new Logger('MemoryUsage');

/**
 * Usage 默认时间窗的**时钟端口**（唯一用途：省略 since/until 时物化 7 天窗口）。
 *
 * ⚠️ 生产装配 = `() => new Date()`；e2e 用可控时钟证明「默认窗口只物化一次、
 * 第二页绝不重算 now」。这不是 API 合同的一部分（响应仍由 `engine.filter` 回声）。
 */
export const MEMORY_USAGE_CLOCK = 'MEMORY_USAGE_CLOCK';

/** 时钟端口值类型 */
export type MemoryUsageClock = () => Date;

/** 已解析的项目引擎上下文（权限/可用性/身份闸之后的产物） */
interface UsageContext {
  project: MemoryProject;
  target: MemoryEngineTarget;
}

/** 默认时间窗（**一次物化**；两侧都省略时才生成） */
interface UsageWindow {
  since?: string;
  until?: string;
}

/**
 * 引擎错误码的**形态门**（开放字符串；越界整值丢弃，不截断）。
 *
 * 与 `hument.engine.ts` 的诊断门同纪律：错误码是上游供给的不受信文本，进响应/日志前
 * 只允许标识符字符集与有限长度。
 */
const USAGE_ENGINE_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

function gateUsageEngineCode(value: string | undefined): string | undefined {
  return value !== undefined && USAGE_ENGINE_CODE_PATTERN.test(value) ? value : undefined;
}

/** 一条项目行的完整非 none 三元组（键用于共享扫描；不完整 = null） */
function completeBindingKey(
  project: Pick<
    MemoryProject,
    'engine' | 'engineWorkspaceId' | 'engineActorId' | 'engineCredentialRef'
  >,
): string | null {
  if (
    project.engine === MEMORY_ENGINE.NONE ||
    !project.engineWorkspaceId?.trim() ||
    !project.engineActorId?.trim() ||
    !project.engineCredentialRef?.trim()
  ) {
    return null;
  }
  return JSON.stringify([
    project.engine,
    project.engineWorkspaceId,
    project.engineActorId,
    project.engineCredentialRef,
  ]);
}

/**
 * Usage 读面服务（见文件头）。
 *
 * 注入 `MemoryProject` 仓储做共享扫描；claim 表**刻意不做 `forFeature` 注入**
 * （memory.module.ts 的纪律：claim 只通过 `manager.getRepository()` 访问），
 * 这里用 `projects.manager.getRepository(MemoryEngineBindingClaim)` 只读查一行。
 */
@Injectable()
export class MemoryUsageService {
  constructor(
    private readonly access: MemoryAccessService,
    private readonly projectService: MemoryProjectService,
    private readonly formation: MemoryFormationService,
    private readonly concurrency: MemoryUsageConcurrencyGate,
    @Inject(MEMORY_USAGE_CLOCK) private readonly clock: MemoryUsageClock,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
    @InjectRepository(MemoryProject) private readonly projects: Repository<MemoryProject>,
  ) {}

  /**
   * 已记录用量汇总（`GET /memory/projects/:id/usage/summary`）。
   *
   * @throws 403/404 权限；409/14006 共享/claim；503/14000 不可用/版本/身份；
   *   502/14004 cursor；429 限流
   */
  async getSummary(
    actor: UnifiedActor | null,
    projectId: string,
    dto: QueryMemoryUsageSummaryDto,
  ): Promise<MemoryUsageSummaryResponse> {
    const { target } = await this.resolveContext(actor, projectId);
    const window = this.resolveWindow(dto, false);

    const query: HumentUsageSummaryQuery = {
      operation: dto.operation,
      provider_operation: dto.providerOperation,
      model: dto.model,
      since: window.since,
      until: window.until,
    };

    const result = await this.concurrency.run(() => this.engine!.getUsageSummary(target, query));
    if (!result.ok) this.throwUsageFailure(result.failure, false);

    return {
      engine: stripUsageTarget(result.value),
      target: this.toTarget(target),
      usageCaveat: MEMORY_USAGE_CAVEAT,
    };
  }

  /**
   * 已记录用量明细（`GET /memory/projects/:id/usage/trace`）。
   *
   * `limit` 省略时**显式发 100**（不让引擎用部署配置默认——UI 需要一个平台可解释的分母）。
   * `cursor` 原样透传；带 cursor 时 DTO 已强制显式 since/until。
   */
  async getTrace(
    actor: UnifiedActor | null,
    projectId: string,
    dto: QueryMemoryUsageTraceDto,
  ): Promise<MemoryUsageTraceResponse> {
    const { target } = await this.resolveContext(actor, projectId);
    const window = this.resolveWindow(dto, dto.cursor !== undefined);

    const query: HumentUsageTraceQuery = {
      operation: dto.operation,
      provider_operation: dto.providerOperation,
      model: dto.model,
      since: window.since,
      until: window.until,
      limit: dto.limit ?? MEMORY_USAGE_TRACE_DEFAULT_LIMIT,
      cursor: dto.cursor,
    };

    const result = await this.concurrency.run(() => this.engine!.getUsageTrace(target, query));
    if (!result.ok) this.throwUsageFailure(result.failure, query.cursor !== undefined);

    return {
      engine: stripUsageTarget(result.value),
      target: this.toTarget(target),
      usageCaveat: MEMORY_USAGE_CAVEAT,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 前置闸门
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 五步闸门（见文件头）：存在性 → Usage 权限 → 引擎可用性 → 共享/claim → 返回 target。
   *
   * ⚠️ 顺序：权限先于可用性（无权者不该通过 503 探测项目是否绑了引擎）；共享/claim 在
   * 可用性之后（没有完整三元组时"共享"没有意义，`project_engine_unbound` 更可行动）。
   */
  private async resolveContext(
    actor: UnifiedActor | null,
    projectId: string,
  ): Promise<UsageContext> {
    const project = await findProjectForEngineCall(this.accessDeps(), projectId);
    const access = await this.access.resolveProjectAccess(actor, project);
    this.assertUsagePermission(actor, access, project);

    const target = assertEngineAvailable(this.accessDeps(), project);
    await this.assertSingleOwner(project);
    return { project, target };
  }

  /**
   * Usage 权限闸（**与内容面 any-binding 不同**，见 `canReadMemoryUsage`）。
   *
   * 拒绝码按存在性防泄露分档：
   * - 治理观察者（creator/admin）**或部分可读** ⇒ 403/1009（TA 已知项目存在）
   * - 其余（非治理 + 零绑定/全不可读）⇒ 404/14001（不确认存在性）
   */
  private assertUsagePermission(
    actor: UnifiedActor | null,
    access: MemoryProjectAccess,
    project: MemoryProject,
  ): void {
    if (canReadMemoryUsage(actor, access)) return;

    if (access.isGovernanceViewer || access.resolved.some((entry) => entry.readable)) {
      throw new ForbiddenException({
        message:
          `Recorded usage for memory project '${project.id}' requires either admin or READ ` +
          'access on ALL of its bindings (usage is a project-level engine aggregate and cannot ' +
          'be filtered per source). You are a governance viewer or can read only part of the ' +
          'bindings, so the content-grade usage view is closed. Ask a binding owner to grant ' +
          'you read access on the remaining bindings, or ask an admin. ' +
          '用量需要全部绑定可读（或 admin）',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    throw memoryProjectNotFound(project.id);
  }

  /**
   * 引擎身份的**独占性**闸（共享扫描 + claim 归属，AND + deny 优先）。
   *
   * 扫描**全部** `memory_projects` 行（`withDeleted`，不按 status 过滤）：
   * 同一个完整三元组被任何其他行（含 archived/软删）引用 ⇒ 拒绝。
   * claim 表：没有该四列的占用行，或占用行不是本项目 ⇒ 拒绝。
   *
   * ⚠️ 两件事都算完再抛（不短路"反正第一个就失败了"），日志里也不打印三元组值。
   */
  private async assertSingleOwner(project: MemoryProject): Promise<void> {
    const currentKey = completeBindingKey(project);
    if (currentKey === null) {
      // 可用性闸已挡住不完整三元组；走到这里说明数据在两次读取之间变了 ⇒ fail-closed
      throw memoryUsageSharedBinding();
    }

    const rows = await this.projects.find({
      withDeleted: true,
      select: ['id', 'engine', 'engineWorkspaceId', 'engineActorId', 'engineCredentialRef'],
    });

    let references = 0;
    let otherProjectReferences = 0;
    for (const row of rows) {
      if (completeBindingKey(row) !== currentKey) continue;
      references += 1;
      if (row.id !== project.id) otherProjectReferences += 1;
    }

    const claim = await this.projects.manager.getRepository(MemoryEngineBindingClaim).findOne({
      where: {
        engine: project.engine,
        engineWorkspaceId: project.engineWorkspaceId as string,
        engineActorId: project.engineActorId as string,
        engineCredentialRef: project.engineCredentialRef as string,
      },
    });
    const claimOwnedByThisProject = claim !== null && claim.projectId === project.id;

    if (references !== 1 || otherProjectReferences > 0 || !claimOwnedByThisProject) {
      // ⚠️ 不打印 workspace/actor/credential/其他项目 id（共享关系的存在本身就是敏感信息）
      logger.warn(
        `usage disabled for project ${project.id}: engine identity is shared or its claim is ` +
          `missing/owned elsewhere (references=${references}, ` +
          `otherProjects=${otherProjectReferences}, claimOwned=${claimOwnedByThisProject})`,
      );
      throw memoryUsageSharedBinding();
    }
  }

  /**
   * 时间窗解析（**只在两侧都省略时物化一次**）。
   *
   * DTO 已保证"两侧同时给或同时不给"且 `since < until ≤ 90 天`；带 cursor 时两侧必填。
   * 服务端生成的窗口用 `toISOString()`（毫秒精度、UTC `Z`），并**原样**进 engine query——
   * 引擎会在 `filter.since/until` 回声同一串，客户端据此翻页（含精度）。
   */
  private resolveWindow(dto: QueryMemoryUsageSummaryDto, hasCursor: boolean): UsageWindow {
    const hasSince = dto.since !== undefined;
    const hasUntil = dto.until !== undefined;
    // 边界层（DTO）已挡住这些组合；服务层再挡一次是**防静默改写**：只给一侧时若落进
    // "生成默认窗口"分支，调用方给的那一侧会被悄悄丢掉（比 400 更危险）。
    if (hasSince !== hasUntil) {
      throw new BadRequestException({
        message:
          'Provide BOTH since and until, or neither: a one-sided window is unbounded and would ' +
          'bypass the 90-day platform guardrail. 时间窗必须两侧同时给或同时不给',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (hasCursor && (!hasSince || !hasUntil)) {
      throw new BadRequestException({
        message:
          "A trace cursor requires explicit since AND until (send back page 1's exact window). " +
          '带 cursor 时必须显式传 since 与 until',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (hasSince && hasUntil) {
      return { since: dto.since, until: dto.until };
    }
    const until = this.clock();
    const since = new Date(
      until.getTime() - MEMORY_USAGE_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    return { since: since.toISOString(), until: until.toISOString() };
  }

  /**
   * 引擎失败 → 平台错误的**唯一分桶点**（见文件头优先级）。
   *
   * @param failure 引擎失败面（不含上游自由正文；诊断值已过引擎层门）
   * @param hasCursor 本次请求是否携带 cursor（决定 400 `invalid_argument` 的处置）
   */
  private throwUsageFailure(failure: MemoryEngineFailure, hasCursor: boolean): never {
    const engineCode = gateUsageEngineCode(failure.engineCode);
    const diagnostics =
      failure.requestId !== undefined
        ? { engineDiagnostics: { requestId: failure.requestId } }
        : {};

    switch (failure.kind) {
      case 'timeout':
        throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT, diagnostics);
      case 'unreachable':
        throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE, diagnostics);
      case 'invalid_response':
        if (failure.usageRejection === 'target_mismatch') {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_IDENTITY_INVALID, {
            ...(engineCode ? { engineCode } : {}),
            ...diagnostics,
          });
        }
        // schema / cursor 自洽破损 = 合同/版本不匹配（回执不可信，升级或等合同修复）
        throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED, {
          ...(engineCode ? { engineCode } : {}),
          ...diagnostics,
        });
      case 'http': {
        // ① 上游 schema_incompatible 是**数据**问题（存量账本/回执无法解析），不是版本
        if (engineCode === 'schema_incompatible') {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_DATA_INCOMPATIBLE, {
            engineCode,
            ...diagnostics,
          });
        }
        // ② 身份授权失败（binding 不存在/歧义/缺 inspect_read）
        if (engineCode === 'scope_denied') {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_IDENTITY_INVALID, {
            engineCode,
            ...diagnostics,
          });
        }
        // ③ 旧 Hub 无 usage 路由（404，含空 body 与 resource_not_found 两变体）
        if (failure.httpStatus === 404) {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED, {
            ...(engineCode ? { engineCode } : {}),
            ...diagnostics,
          });
        }
        // ④ 403 但未给 scope_denied：同样是身份/授权面
        if (failure.httpStatus === 403) {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_IDENTITY_INVALID, {
            ...(engineCode ? { engineCode } : {}),
            ...diagnostics,
          });
        }
        // ⑤ cursor 快照失效（409 conflict）或携 cursor 的过滤/页大小不符（400 invalid_argument）
        if (failure.httpStatus === 409 || (failure.httpStatus === 400 && hasCursor)) {
          throw memoryUsageCursorReset(engineCode, failure.requestId);
        }
        // ⑥ 429：按上游 Retry-After 等待后**用同一 cursor**重试
        if (failure.httpStatus === 429) {
          throw new MemoryUsageRateLimitedException(failure.retryAfterSeconds ?? 1, 'engine');
        }
        // ⑦ 400 不带 cursor：DTO 已挡住平台可产生的参数错误 ⇒ 合同不匹配（版本不支持）
        if (failure.httpStatus === 400) {
          throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED, {
            ...(engineCode ? { engineCode } : {}),
            ...diagnostics,
          });
        }
        // ⑧ 其余 5xx / 非预期状态：引擎可达但不可用
        throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR, {
          ...(engineCode ? { engineCode } : {}),
          ...diagnostics,
        });
      }
      default: {
        // 穷尽性守卫（新增失败分类时当场编译报错）
        const unmapped: never = failure.kind;
        throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR, {
          engineCode: `unmapped_engine_failure_kind:${String(unmapped)}`,
        });
      }
    }
  }

  /** 共享前置件的依赖面（type-only 接口；每次现取） */
  private accessDeps(): MemoryEngineAccessDeps {
    return {
      engine: this.engine,
      projectService: this.projectService,
      formation: this.formation,
    };
  }

  /** 外层身份回声（camelCase；**不含** binding/namespace/credentialRef） */
  private toTarget(target: MemoryEngineTarget): MemoryUsageTarget {
    return {
      workspaceId: target.workspaceId,
      actorId: target.actorId,
      scope: 'actor_private',
    };
  }
}

/**
 * 去掉引擎块的 `target`（合同 `target` 含 binding_id/namespace_id；平台只在外层回声）。
 *
 * ⚠️ 用解构而不是 `delete`：不改动引擎返回值（同一个对象可能被调用方持有），且类型上
 * `Omit<..., 'target'>` 与实现对齐。
 */
function stripUsageTarget<T extends { target: unknown }>(value: T): Omit<T, 'target'> {
  const { target: _engineTarget, ...rest } = value;
  return rest;
}
