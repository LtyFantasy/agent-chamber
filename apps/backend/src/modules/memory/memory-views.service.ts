/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块的**引擎投影读面**（hument alpha.5 四读面 + alpha.6 关系建议读面）：关系图 /
 *     单记忆分节详情（含五槽分辨率阶梯）/ 某一分辨率的旧版本 / 单份表示正文 / **关系建议**
 *     （JEV 判定的语义关系，作者自报）。**纯读**——不触发 Recall/Formation/Provider/Jev，
 *     也不改 active resolution
 *
 * [代码职责]
 *   - 五个端点共用的**五步模板**（项目存在性/引擎可用性/失败分派三件套已下沉到
 *     `memory-engine-access.ts`，与 usage 读面共用）：`findProjectOrThrow` → `assertProjectContentRead` →（单记忆族
 *     先做映射与来源判定）→ 引擎可用性闸 → 调引擎 → 错误分派
 *   - **graph 的逐节点来源过滤链** 与 **relations 的逐 case 来源过滤链**（与 recall 同源判据，
 *     但多两个计数出口）
 *   - 信封装配：引擎块**整块**透传 + 平台字段平铺（图另有 `ledgerMapping`）
 *
 * [权威文档]
 *   - 合同事实源（只读）: Hument 仓 `contracts/schema/memory-view-*.schema.json` +
 *     `contracts/openapi/hument-v1.yaml` 的 `MemoryView*` 参数
 *   - 权限判据单源: `./memory-access.service.ts`（三处同源约束 + `loadMemoryIdMapping`）
 *     ⚠️ **闭环缺口（已知）**：方案与本读面的逐字段说明，批次收尾落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **五端点统一 `assertProjectContentRead`**（≥1 绑定 read）：治理观察者（creator/admin）
 *     拿到 403/1009 而**不是**内容面——图是引擎投影，属内容面（见 memory-access 文件头）。
 *   - **graph 的权限过滤与 recall 同源、但计数出口不同**：
 *     ①未映射节点 ⇒ `unmappedCount`（**透出**；recall 只落遥测——这是刻意的分歧）；
 *     ②来源不可见的节点 ⇒ 丢弃 + `filteredNodeCount`；③**关联边级联丢弃** ⇒ `filteredEdgeCount`
 *     （边被权限砍掉必须有出口，否则治理观察者拿到一张**静默失真**的图）。
 *     `engineDataSuspect` 判据**逐字复用 recall 的三条件**
 *     （`unmappedCount > 0 && hasCommitted && !hasInFlight`）——**禁止简化成单条件**：
 *     在途行能解释"引擎有你映射不到的记忆"，此时喊狼来了会让消费方怀疑整批数据。
 *   - **过滤是批式的一次调用**（`evaluateSourceRefs` 喂全部已映射节点/候选 case 的 refs，
 *     再按切片还原）：逐节点调用会把"8 张表预载"乘以节点数（graph 的 200 档 ≈ 200 次全表预载），
 *     relations 同理乘以 case 数。**调用次数**由 `memory-views.service.spec` 与 e2e 的
 *     `nodeLimit` 用例钉住（relations 侧同一份切片还原代码，故同一道闸门覆盖两族）。
 *   - **单记忆族（detail / history / representation / relations）：本项目映射 + 全源可见，否则
 *     404/14003**（不确认存在性，与 19.16 同码同语义）。
 *     判定顺序 = **先 404 后 503**：存在性/权限先于引擎可用性，"没这条记忆"不该因为引擎没配而
 *     变成"引擎不可用"（反之则泄露项目外记忆的存在性）。
 *   - **relations 的 case 级过滤是"必须有出口"的那一类**（与 graph 的 filterNodeCount 同律）：
 *     case 里**与本请求不同的那一侧**（方向相关：new 侧读取 `old_memory_id`、old 侧读取
 *     `new_memory_id`——见 `otherSideMemoryId`）指向**另一条记忆**，而 `label`/`reason`/
 *     `confidence` 全是描述那条记忆的内容面文本 ⇒ 未映射 ⇒ `unmappedCaseCount`、来源不可见
 *     或**归因失败** ⇒ `filteredCaseCount`。
 *     **块级**：`matched_memory_id !== 本请求` 的 advisory **整块丢弃** + `droppedAdvisoryCount`。
 *     块内 advisory 级字段（`state`/`coverage`/`usage`/`reason`）**不逐字段过滤**——但那只在
 *     块级守卫成立之后才谈得上；它们仍是**整次作业**的量（可能覆盖多条记忆），不是"你已授权那部分"的分母。
 *     计数与 graph 的 `filteredNodeCount`/`unmappedCount` **同语义但不同量纲**
 *     （那边数节点、这边数 case；`coverage.candidate_count` 是引擎口径，不是过滤后的分母）。
 *   - **错误分派只两档**：`http` / `invalid_response` ⇒ `502/14004` + `engineCode` 逐字透传
 *     （铁律 #9 由 engineCode 承载）；`timeout` / `unreachable` ⇒ `503/14000` + reason。
 *     ⚠️ **cursor 失效双通道（`snapshot_stale` 409 / `invalid_argument` 400）走前一条**——
 *     都是"引擎可达但拒了这次请求"，且消费动作相同：丢弃已累积页 + 重拉第一页。
 *   - **引擎块整块透传，平台字段只在外层**：每个引擎响应都是 `additionalProperties: false`，
 *     往里塞一个平台字段就会让"契约镜像"变成第二份契约（且平台字段会被引擎合同判为非法）。
 *     `nodes[]`/`edges[]`/`advisories[].cases[]` 的**内容**按权限过滤——故
 *     `node_page.loaded ≠ nodes.length`、`coverage.candidate_count ≠ cases.length`，前端口径见 DTO。
 *   - **不写遥测**：这是纯读面（与 recall 的"失败也落行"相反——那张表是**召回**质量的分母，
 *     图/详情的失败没有对应用户动作可统计）。GET 一律零副作用。
 *
 * [关联代码]
 *   - ./memory-access.service.ts — 内容闸门 + 来源可见性 + `loadMemoryIdMapping`（同源判据）
 *   - ./memory-recall.service.ts — 同族读面（召回 / 19.16 记忆详情），过滤链的先例
 *   - ./engines/memory-engine.interface.ts — 五个 view 动词与合同镜像类型（整族逐字透传）
 *   - ./dto/memory-contract.ts — 五个响应信封（平台字段与引擎块的边界写在注释里）
 *   - ./memory.constants.ts — 14000/14004 的**唯一**错误构造点
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 改过滤链必须同步：`memory-views.service.spec` + `test/memory.e2e-spec.ts`（⑮ 节）
 *   □ 新增响应字段必须同步 controller 的 Swagger 文案（automcp 工具 description 的唯一来源）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnifiedActor } from '../../common/types/actor.types';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type HumentGraphNode,
  type HumentMemoryGraphViewQuery,
  type HumentRelationAdvisoryCase,
  type MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';
import {
  allSourcesVisible,
  MemoryAccessService,
  type MappedLedgerRow,
  type MemoryIdMapping,
} from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { memoryNominationNotFound } from './memory.constants';
import {
  assertEngineAvailable,
  findProjectForEngineCall,
  throwMemoryEngineFailure,
  type MemoryEngineAccessDeps,
} from './memory-engine-access';
import {
  MEMORY_DECISION_AUTHORITY,
  MEMORY_TRUST_LEVEL,
  MEMORY_USAGE_NOTE,
  type MemoryGraphViewResponse,
  type MemoryViewHistoryResponse,
  type MemoryViewRelationsResponse,
  type MemoryViewRepresentationResponse,
  type MemoryViewResponse,
} from './dto/memory-contract';
import type {
  QueryMemoryViewGraphDto,
  QueryMemoryViewHistoryDto,
  QueryMemoryViewRelationsDto,
} from './dto/memory-view.dto';
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import type { MemoryEngineTarget } from './engines/memory-engine.interface';

const logger = new Logger('MemoryViews');

/**
 * 取一条关系建议 case 里**"另一条记忆"**的那一侧（= 与本请求引擎记忆不同的那侧）。
 *
 * ⚠️ **为什么不能恒取 `old_memory_id`**（引擎事实源逐行取证，改本函数前重读一遍）：
 * 引擎的读侧**方向决定哪一侧是"另一条"**（`hument/internal/adapter/sqlite/relation_advisory.go`）：
 * - 查询命中 = `job.new_memory_ids ∋ 请求id`（new 侧）**或** `batch.cases[].old.id == 请求id`（old 侧）；
 * - 视图对每个 `new_id` 产出 `matched_memory_id = 请求id`、`new_memory_id = new_id`，并只保留
 *   `item.new_memory_id == new_id && (new_id == 请求id || item.old_memory_id == 请求id)` 的 case。
 * ⇒ **new 侧读**（请求记忆就是 new）：case 为 `{new: 请求, old: 另一条}`；
 * ⇒ **old 侧读**（请求记忆是 old）：case 为 `{new: 另一条, old: 请求}`。
 * 引擎自测 `TestRelationAdvisoryReadOldMemoryReturnsOnlyItsPair` 正是后者。
 *
 * 因此恒取 `old_memory_id` 会在 old 侧把**过滤键取成调用方刚刚被授权的那条记忆**
 * （`resolveMemoryContext` 已判过它全源可见）⇒ 过滤恒 no-op：`label`/`reason`/`confidence`
 * （描述另一条记忆的内容面文本）越权交付，两个计数也恒 0。
 *
 * fail-closed 三态（**都不返回 id** ⇒ 归因失败，调用方按 `filteredCaseCount` 计数）：
 * - 两侧**都等于**请求（自指，不是"与另一条的关系"）；
 * - 两侧**都不等于**请求（这条 case 根本不属于本次请求的记忆）；
 * - 任一字段**缺席/非字符串**（合同破损的退化路径）。
 *
 * ⚠️ 第三态必须**显式归一成 `null`**：读面归一化只保证 `advisories[].cases` 是**数组**、
 * 不逐字段校验元素（见 `hument.engine.ts` 的归一化粒度），所以元素字段在运行期可能缺席。
 * 若让 `undefined` 漏出去，调用点的 `!== null` 判空会**放过它**，最终落到
 * `mapping.byMemoryId.get(undefined)` ⇒ 被记成 `unmappedCaseCount`——把"归因失败（合同破损）"
 * 与"另一条记忆在本项目没有映射（数据可疑）"两类**成因完全不同**的丢 case 记混。
 *
 * @param item 引擎返回的一条 case（`old_memory_id` / `new_memory_id`；**字段刻意声明为可选**，
 *   因为运行期真会缺席——类型如实反映"这里可能什么都没有"）
 * @param requested 本请求的引擎记忆 id
 * @returns 另一侧的 memory id；`null` = 归因失败（调用方按 fail-closed 丢弃并计数）
 */
export function otherSideMemoryId(
  item: Partial<Pick<HumentRelationAdvisoryCase, 'old_memory_id' | 'new_memory_id'>>,
  requested: string,
): string | null {
  const oldSide = item.old_memory_id;
  const newSide = item.new_memory_id;
  // 三态之一：字段缺席/非字符串 ⇒ 归因失败（显式归一，不放 `undefined` 出去）
  if (typeof oldSide !== 'string' || typeof newSide !== 'string') return null;
  const oldIsRequested = oldSide === requested;
  const newIsRequested = newSide === requested;
  // 恰好一侧是请求本身才有"另一侧"可言（同真 = 自指；同假 = 不属本次请求）
  if (oldIsRequested === newIsRequested) return null;
  return oldIsRequested ? newSide : oldSide;
}

@Injectable()
export class MemoryViewsService {
  constructor(
    private readonly access: MemoryAccessService,
    private readonly projectService: MemoryProjectService,
    private readonly formation: MemoryFormationService,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
  ) {}

  /**
   * 关系图投影（`GET /memory/projects/:id/views/graph`）。
   *
   * 引擎块的 `nodes` / `edges` 是**过滤后**的内容；`page` / `budget` / `omitted_edge_count`
   * 保持引擎口径（前端渲染与进度用 `nodes.length` / `filteredNodeCount`，不用 `loaded`）。
   *
   * @param actor 调用者（决定逐节点的来源可见性）
   * @param projectId 项目
   * @param dto 过滤 + 分页 + 游标（引擎参数的全集由引擎层持，这里只填 DTO 允许的 12 个）
   * @returns 信封：engine 块 + 四个平台计数 + ledgerMapping + 信任框三件套
   */
  async getGraphView(
    actor: UnifiedActor,
    projectId: string,
    dto: QueryMemoryViewGraphDto,
  ): Promise<MemoryGraphViewResponse> {
    const { target } = await this.resolveContext(actor, projectId);

    const result = await this.engine!.getGraphView(target, {
      // camelCase（平台）→ snake_case（引擎合同）的**唯一**映射点：改 DTO 字段名必须同时看这里
      kind: dto.kind,
      status: dto.status,
      active_resolution: dto.activeResolution,
      available_resolution: dto.availableResolution,
      anchor_state: dto.anchorState,
      relation_type: dto.relationType,
      created_from: dto.createdFrom,
      created_to: dto.createdTo,
      node_limit: dto.nodeLimit,
      edge_limit: dto.edgeLimit,
      preview_scalars: dto.previewScalars,
      cursor: dto.cursor,
    } satisfies HumentMemoryGraphViewQuery);
    if (!result.ok) throwMemoryEngineFailure(result.failure, 'read the memory graph');

    const mapping = await this.access.loadMemoryIdMapping(projectId);

    // ① 映射：无映射节点 ⇒ 丢弃 + 计数（同时是 engineDataSuspect 的输入）
    const candidates: Array<{ node: HumentGraphNode; row: MappedLedgerRow }> = [];
    let unmappedCount = 0;
    for (const node of result.value.nodes) {
      const row = mapping.byMemoryId.get(node.memory_id);
      if (!row) {
        unmappedCount += 1;
        continue;
      }
      candidates.push({ node, row });
    }

    // ② 权限：**一次喂全部行**的 refs（批式——逐节点查库 = 200 档下 200 次 8 表预载）
    const verdicts = await this.access.evaluateSourceRefs(
      actor,
      candidates.flatMap((entry) => entry.row.sourceRefs ?? []),
    );

    const visibleNodes: HumentGraphNode[] = [];
    const ledgerMapping: Record<string, string> = {};
    let cursor = 0;
    let filteredNodeCount = 0;
    for (const entry of candidates) {
      const refs = entry.row.sourceRefs ?? [];
      const slice = verdicts.slice(cursor, cursor + refs.length);
      cursor += refs.length;
      // 无 sourceRefs 的纯著述记忆：项目级已过闸即放行（`allSourcesVisible([])` = true）
      if (!allSourcesVisible(slice)) {
        filteredNodeCount += 1;
        continue;
      }
      visibleNodes.push(entry.node);
      // 可见节点 ⇒ 必有映射（前端据此做"图 → 详情"钻取）
      ledgerMapping[entry.node.memory_id] = entry.row.id;
    }

    // ③ 边级联：端点被权限砍掉的边一并丢弃并计数（没有这个出口，图会静默失真）
    const visibleIds = new Set(visibleNodes.map((node) => node.memory_id));
    const visibleEdges = result.value.edges.filter(
      (edge) => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id),
    );
    const filteredEdgeCount = result.value.edges.length - visibleEdges.length;

    const engineDataSuspect = unmappedCount > 0 && mapping.hasCommitted && !mapping.hasInFlight;
    if (engineDataSuspect) {
      logger.warn(
        `memory engine data suspect (graph) project=${projectId} unmapped=${unmappedCount} — the ` +
          'engine returned memories that map to no committed ledger row of this project',
      );
    }

    return {
      engine: { ...result.value, nodes: visibleNodes, edges: visibleEdges },
      filteredByPermission: filteredNodeCount > 0,
      filteredNodeCount,
      filteredEdgeCount,
      unmappedCount,
      engineDataSuspect,
      ledgerMapping,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  /**
   * 单记忆分节详情 + 五槽分辨率阶梯（`GET …/views/memories/:engineMemoryId`）。
   *
   * 两道 404（与 19.16 同码同语义）：① 本项目无账本行映射该 memory id ② **任一来源不可见**。
   */
  async getMemoryView(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
    dto: QueryMemoryViewRelationsDto,
  ): Promise<MemoryViewResponse> {
    const { target } = await this.resolveMemoryContext(actor, projectId, engineMemoryId);

    const result = await this.engine!.getMemoryView(target, engineMemoryId, {
      relation_limit: dto.relationLimit,
      relation_cursor: dto.relationCursor,
    });
    if (!result.ok)
      throwMemoryEngineFailure(result.failure, `read memory view '${engineMemoryId}'`);

    return {
      engine: result.value,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  /**
   * 某一分辨率的旧版本列表（`GET …/views/memories/:engineMemoryId/history/:resolution`）。
   *
   * ⚠️ 空 `items` 是**合法常态**（同记忆同分辨率被重新形成才有旧版本；更正是跨记忆的取代链，
   * 不产生旧版本）——不要把它读成缺陷，也不要在空列表上重试。
   */
  async getMemoryViewHistory(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
    resolution: string,
    dto: QueryMemoryViewHistoryDto,
  ): Promise<MemoryViewHistoryResponse> {
    const { target } = await this.resolveMemoryContext(actor, projectId, engineMemoryId);

    const result = await this.engine!.getMemoryViewHistory(target, engineMemoryId, resolution, {
      history_limit: dto.historyLimit,
      cursor: dto.cursor,
    });
    if (!result.ok) {
      throwMemoryEngineFailure(
        result.failure,
        `read the representation history of '${engineMemoryId}'`,
      );
    }

    return {
      engine: result.value,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  /**
   * 单份表示正文（`GET …/views/memories/:engineMemoryId/representations/:representationId`）。
   *
   * 正文是**纯文本**（≤64KiB，`whitespace-pre-wrap` 渲染即可）——不经 markdown、无 HTML 注入面。
   */
  async getMemoryViewRepresentation(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
    representationId: string,
  ): Promise<MemoryViewRepresentationResponse> {
    const { target } = await this.resolveMemoryContext(actor, projectId, engineMemoryId);

    const result = await this.engine!.getMemoryViewRepresentation(
      target,
      engineMemoryId,
      representationId,
    );
    if (!result.ok) {
      throwMemoryEngineFailure(
        result.failure,
        `read representation '${representationId}' of '${engineMemoryId}'`,
      );
    }

    return {
      engine: result.value,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  /**
   * 一条记忆的**关系建议**（`GET …/views/memories/:engineMemoryId/relations`）。
   *
   * 与 detail 的 `sections.relations`（引擎内已落库的边）不同：本读面是 **JEV 判定的语义关系
   * 建议**，`advisories[].cases[]` 是"这条记忆 vs 那条记忆像不像同一件事"的作者自报结论。
   *
   * 闸门与三个单记忆端点**完全同档**（`resolveMemoryContext`：404 先于 503）；差别只在
   * 响应装配——本端点多一条**块级归因守卫 + 逐 case 的来源过滤链**（与 graph 的逐节点过滤同源判据）：
   * ①`matched_memory_id !== 本请求` ⇒ **整块丢弃** + `droppedAdvisoryCount`；
   * ②case 里**与本请求不同的那一侧**（`otherSideMemoryId`：new 侧读取 `old`、old 侧读取 `new`）
   *   未映射到本项目 ⇒ 丢弃 + `unmappedCaseCount`；
   * ③该侧记忆的**任一来源对调用者不可见**，或该 case **归因失败**（两侧同真/同假）⇒ 丢弃
   *   + `filteredCaseCount`。
   * 丢弃是**必须的**：case 的 `label`/`reason`/`confidence` 是描述**另一条**记忆的内容面文本，
   * 不过滤就等于绕过那条记忆自己的 404 闸门（`reason` 尤其会直述"它与谁重复/冲突"）。
   *
   * @param actor 调用者（决定逐 case 的来源可见性）
   * @param projectId 项目
   * @param engineMemoryId 引擎侧 memory id（**不是** UUID）
   * @returns 信封：engine 块（`advisories` 经块级守卫 + 仅 `cases[]` 过滤）+ 三个计数 + 信任框三件套
   * @throws NotFoundException 404/14003（无映射 / 来源不可见——**同码同语义**，不泄露存在性）
   * @throws BadGatewayException 502/14004（引擎答错，`engineCode` 逐字）/ 503/14000（引擎不可用）
   */
  async getMemoryRelations(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
  ): Promise<MemoryViewRelationsResponse> {
    // ⚠️ `mapping` 由闸门一并返回（P2-6）：过滤链**复用**它，不再第二次 `loadMemoryIdMapping`
    //    （那是一次 `memory_nominations` 全表投影读，每请求跑两遍是纯浪费）
    const { target, mapping } = await this.resolveMemoryContext(actor, projectId, engineMemoryId);

    // ⚠️ 没有 query 可传（合同无 filter/limit/cursor；有界性在引擎的 `truncated` 里）
    const result = await this.engine!.getMemoryRelations(target, engineMemoryId);
    if (!result.ok) {
      throwMemoryEngineFailure(result.failure, `read relation advisories of '${engineMemoryId}'`);
    }

    // ① **块级归因守卫**：`matched_memory_id` 必须是本请求的引擎记忆——引擎按构造保证
    //    （`relation_advisory.go` 里 `view.MatchedMemoryID = memory.ID`，两侧方向都一样），
    //    但**平台不替它背书**：对不上就整块丢弃（块级字段 `state`/`coverage`/`usage`/`reason`
    //    属于那次作业的上下文，归因不明就一个字都不该交付）+ `droppedAdvisoryCount`。
    const verified: number[] = [];
    let droppedAdvisoryCount = 0;
    for (const [advisoryIndex, advisory] of result.value.advisories.entries()) {
      if (advisory.matched_memory_id !== engineMemoryId) {
        droppedAdvisoryCount += 1;
        logger.warn(
          `memory relation advisory dropped (attribution mismatch) project=${projectId} ` +
            `requested=${engineMemoryId} matched=${advisory.matched_memory_id}`,
        );
        continue;
      }
      verified.push(advisoryIndex);
    }

    // ② 逐 case：过滤对象 = **与本请求不同的那一侧**（见 `otherSideMemoryId` 的论证）
    const candidates: Array<{
      advisoryIndex: number;
      item: HumentRelationAdvisoryCase;
      row: MappedLedgerRow;
    }> = [];
    let unmappedCaseCount = 0;
    let filteredCaseCount = 0;
    for (const advisoryIndex of verified) {
      for (const item of result.value.advisories[advisoryIndex].cases) {
        const otherMemoryId = otherSideMemoryId(item, engineMemoryId);
        if (otherMemoryId === null) {
          // 归因失败（自指 / 两侧都不是本请求）⇒ fail-closed 丢弃，与前一类共用出口（见契约注释）
          filteredCaseCount += 1;
          continue;
        }
        const row = mapping.byMemoryId.get(otherMemoryId);
        if (!row) {
          unmappedCaseCount += 1;
          continue;
        }
        candidates.push({ advisoryIndex, item, row });
      }
    }

    // ③ 权限：**一次喂全部候选 case 的 refs**（批式——逐 case 调用会把"8 张表预载"乘以
    //    case 数；与 graph 的逐节点过滤同款成本护栏，调用次数由单测与 e2e 钉住）
    const verdicts = await this.access.evaluateSourceRefs(
      actor,
      candidates.flatMap((entry) => entry.row.sourceRefs ?? []),
    );

    // 切片还原：`evaluateSourceRefs` 的返回与入参**一一对应**，按每个 case 自己的 refs 长度推进
    const keptByAdvisory = new Map<number, HumentRelationAdvisoryCase[]>();
    let cursor = 0;
    for (const entry of candidates) {
      const refs = entry.row.sourceRefs ?? [];
      const slice = verdicts.slice(cursor, cursor + refs.length);
      cursor += refs.length;
      if (!allSourcesVisible(slice)) {
        filteredCaseCount += 1;
        continue;
      }
      const kept = keptByAdvisory.get(entry.advisoryIndex) ?? [];
      kept.push(entry.item);
      keptByAdvisory.set(entry.advisoryIndex, kept);
    }

    // ④ advisory 级字段不过滤，**前提是上一步的块级守卫已经成立**（`matched_memory_id === 本请求`）：
    //    守卫保证了"这块作业确实与本请求那条记忆有关"（引擎按构造如此，平台复核过）；
    //    它**不**保证 `coverage.candidate_count` / `state` / `usage` 只反映本记忆——那些是**整次
    //    判定作业**（可能同时覆盖多条记忆）的量，故仍是引擎口径，不能当"你已授权的那部分"的分母。
    //    ⚠️ 块被守卫丢弃时**整块不交付**（连 `state` 也不给）：归因不明的作业上下文一个字都不该出。
    // ⑤ 未被守卫放行的块**整块**从 `advisories` 里消失（不是清空 `cases`）——消费方据
    //    `droppedAdvisoryCount` 知道"少了几块"，而不是把空块读成"没有关系"。
    //    `verified` 按升序构建 ⇒ 保留引擎的块序（不重排）。
    const advisories = verified.map((index) => ({
      ...result.value.advisories[index],
      cases: keptByAdvisory.get(index) ?? [],
    }));

    return {
      engine: { ...result.value, advisories },
      filteredByPermission: filteredCaseCount > 0,
      filteredCaseCount,
      unmappedCaseCount,
      droppedAdvisoryCount,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 图端点的前置三步（项目 → 内容闸门 → 引擎可用性）。
   *
   * ⚠️ 返回的 `engine` 已被断言非空（返回类型里仍是 `MemoryEnginePort | null`，故调用点用 `!`
   * ——这是本文件唯一的断言，理由是"闸门就在上一行"）。
   */
  private async resolveContext(
    actor: UnifiedActor,
    projectId: string,
  ): Promise<{ project: MemoryProject; target: MemoryEngineTarget }> {
    const project = await findProjectForEngineCall(this.accessDeps(), projectId);
    await this.access.assertProjectContentRead(actor, project);
    return { project, target: assertEngineAvailable(this.accessDeps(), project) };
  }

  /**
   * 单记忆四端点的前置五步（**先存在性/权限，后引擎可用性**，见文件头不变量）。
   *
   * ⚠️ **`mapping` 一并返回**（P2-6）：闸门为了判 404 已经加载过它，而 relations 的过滤链还要
   * 用它把 case 的另一侧映到账本行——**每请求只该有一次** `loadMemoryIdMapping`
   * （那是一次 `memory_nominations` 的投影读）。其余三个端点不用这个字段（它们没有逐条过滤链），
   * 但共用同一个闸门 ⇒ 统一返回，避免"为了省一次查询再抄一份判据"。
   *
   * @throws NotFoundException 404/14003（无映射 / 来源不可见——**同码同语义**，不泄露存在性）
   * @throws ServiceUnavailableException 503/14000（引擎未配/未绑）
   */
  private async resolveMemoryContext(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
  ): Promise<{
    project: MemoryProject;
    row: MappedLedgerRow;
    mapping: MemoryIdMapping;
    target: MemoryEngineTarget;
  }> {
    const project = await findProjectForEngineCall(this.accessDeps(), projectId);
    await this.access.assertProjectContentRead(actor, project);

    const mapping = await this.access.loadMemoryIdMapping(projectId);
    const row = mapping.byMemoryId.get(engineMemoryId);
    if (!row) throw memoryNominationNotFound(engineMemoryId, 'Memory');

    const refs = row.sourceRefs ?? [];
    const verdicts = await this.access.evaluateSourceRefs(actor, refs);
    if (!allSourcesVisible(verdicts)) {
      // 来源不可见 = 整条记忆不可见（404 不确认存在性；防撤权逃逸）
      throw memoryNominationNotFound(engineMemoryId, 'Memory');
    }

    return { project, row, mapping, target: assertEngineAvailable(this.accessDeps(), project) };
  }

  /**
   * 共享前置件的依赖面（每次现取；服务实例字段不可变，无需缓存）。
   *
   * ⚠️ 投影读面的权限闸仍在本类（`assertProjectContentRead`），**不在**共享 helper 里：
   * usage 的权限判据（admin 或全绑定可读）与内容面**不同**，混进 helper 会让两个读面
   * 共用一个"看起来通用、实则任选其一"的闸门。
   */
  private accessDeps(): MemoryEngineAccessDeps {
    return {
      engine: this.engine,
      projectService: this.projectService,
      formation: this.formation,
    };
  }
}
