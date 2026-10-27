/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期 + 二期）服务层的**共用常量与错误构造器**：闸门数值、
 *     治理白名单、信任框文案、§6 逐态 HTTP/错误码、§7 子态驱动的 hint、
 *     **裁决词表 + 拦截器通道 hint 码/文案**（阶段二：写路径"该提名了"提示）
 *
 * [代码职责]
 *   - 数值闸门单源（正文/理由的 UTF-8 字节上限、读面摘要的码点上限、引擎 epoch 的**平台护栏**
 *     上限、来源条数上限、恢复扫描上界、分页上界）
 *   - 账本**降级投影**的治理白名单（唯一实现 = `toNominationDto` 的 `projection:'metadata'` 分支）
 *   - 14000 段错误（含 usage 的 version/data/identity 三 reason）、14006 共享身份、
 *     usage cursor/429 的**唯一构造点**（message 必须指导下一步，且区分两态引擎不可用）
 *   - `buildFormationHint`：由 §7 子态（`recoveryPath` / `engineCode`）产出 `hint` + `hintCode`
 *   - `MEMORY_RULING_KEYWORDS`：**裁决词表**——**可选精调层**（env
 *     `MEMORY_NOMINATION_HINT_KEYWORDS` = `preset` 时生效）的正文命中判据；**缺省通用模式
 *     不读正文**（修订通道 = chamber 意见箱 topic `f2ea7a89`）
 *   - `MEMORY_USAGE_HINT`：Usage 的动作码（cursor_reset_required / shared_engine_binding）
 *   - `MEMORY_NOMINATION_HINT_CODE` + `MEMORY_NOMINATION_HINT_MESSAGE`：拦截器 `hints[]`
 *     通道的机器码与文案（**不进** {@link MEMORY_HINT}——那张表是 formation 子态语义）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §4（截断不变式）/§5（治理白名单）/
 *     §6（逐态 HTTP 语义与错误码）/§7（恢复三通道与 hint 驱动）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **降级投影白名单 是白名单而不是黑名单**：降级投影按它**逐字段取**，
 *     新增列默认不出现——黑名单写法会让"后来加的敏感列"默认泄露。
 *   - **上限数字是"闸门"不是"建议"**：`content` 8192 **UTF-8 bytes**（不是字符——
 *     中文一字 3 字节，按字符算等于放宽 3 倍），`rationale` 1024 bytes，
 *     `sourceRefs` ≤ 4。DTO 层的 `@MaxLength` 只挡字符数，**字节闸门在服务层**
 *     （铁律 #21 双层校验：DTO 管格式、服务管业务）。
 *   - **hint 由 §7 子态驱动，不由 HTTP 状态一刀切**：同样是 202，`same_key_resend`
 *     与 `inspect_backfill` 的下一步动作不同；同样是 409，`rejected`（勿重试）
 *     与 `conflict`（稍后查详情）文案不能互换。
 *   - **`committed` 不是无条件终态**：更正行 `oldClaimStatus='still_current'` ⇒
 *     `correction_link_pending`（新主张已落账本，但引擎侧链接未建立）——此时 `retry` **会**
 *     重试链接步，统一回 "Nothing further to do" 会误导消费方（卡 61688768 生产实证）。
 *     其余 committed（含 `superseded`、普通提名）维持 `committed` 码。
 *   - **`provisioning_*` 四值（二期自助开通）同样复用 `MEMORY_UNAVAILABLE(14000)`**：
 *     只由 `POST /memory/projects` 的自动注册分支产出（`memory-project.service.ts`），
 *     文案逐值给出下一步（换 slug / 查 Hub catalog / 显式传三键绕过），**不新增错误码段位**。
 *   - **错误 message 不回显正文/凭据**：只用账本 id、字段名、引擎 code 三个安全标识符
 *     （正文可能是判决策略原文，凭据是机密——日志与响应体都是长期留存面）。
 *   - **`MEMORY_CREDENTIAL_REF_PATTERN` 是本模块的本地副本**：`judgment.config.ts` 的
 *     `KEY_SHAPED` 是**模块私有**（未导出），本模块不越界改它；两处判据同为
 *     `^(apikey|sk)[_-]`，改一处必须改另一处（已在 [关联代码] 互指）。
 *
 * [关联代码]
 *   - ../../config/judgment.config.ts — `KEY_SHAPED` 的原始判据与 `sanitizeLogValue`（回显净化）
 *   - dto/memory-contract.ts — 信任框三件套与响应形状（本文件的文案落点）
 *   - memory-access.service.ts — 降级投影白名单 的消费者
 *   - memory-nomination-hint.provider.ts — 本文件 `MEMORY_RULING_KEYWORDS` /
 *     `MEMORY_NOMINATION_HINT_*` 的唯一消费方（阶段二拦截器通道）
 *   - ../hints/hint-registry.ts — 同源对手（`memory_nomination_suggested` 的字面量内联条目）
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（拦截器通道的接线处）
 *   - memory.constants.spec.ts — 码值双向同源守卫
 *   - packages/shared/src/enums/index.ts — `MEMORY_UNAVAILABLE_REASONS` /
 *     `MEMORY_RECALL_VIEWS` / `MEMORY_RECALL_EMPTY_REASONS` 值域单源
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改上限数字必须同步 DTO 的 `@MaxLength` 与 e2e 的边界用例（两处不同步 = 一边说谎）
 *   □ 新增降级白名单字段前先确认它**不泄露内容面**（正文/理由/来源摘录都属内容面）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ErrorCode,
  MEMORY_UNAVAILABLE_REASON,
  type MemoryUnavailableReason,
} from '@agent-chamber/shared';
// 仅类型引用（运行期擦除）：MemoryFailureData 的嵌套诊断槽与 buildFormationHint 的入参
// 共用 dto 的单一形状；本文件**不**反向依赖 dto 的运行期代码。
import type { MemoryEngineDiagnostics } from './dto/memory-contract';

/**
 * 形成正文的 UTF-8 字节上限（方案 §4 截断不变式：三要素 + 理由永不截，只截摘录区）。
 *
 * 与 Hument 合同的 `maxLength: 8192` 关系：合同按**字符**，平台按**字节**取更严的一侧。
 */
export const MEMORY_CONTENT_MAX_BYTES = 8192;

/** 审计理由的 UTF-8 字节上限（方案 §4；**永不截断**——进形成正文的关键依据区，服务层超限即 400） */
export const MEMORY_RATIONALE_MAX_BYTES = 1024;

/** 来源引用条数上限（方案 §4；Hument `source_locators` ≤4 同值） */
export const MEMORY_SOURCE_REFS_MAX = 4;

/** 摘录被截断时追加的标记（**可见性**是契约：消费方要能看出"这条摘录不全"） */
export const MEMORY_EXCERPT_TRUNCATION_MARKER = '[truncated]';

/** 截断标记占位（含换行），预算计算时先扣掉 */
export const MEMORY_TRUNCATION_RESERVE_BYTES = MEMORY_EXCERPT_TRUNCATION_MARKER.length + 1;

/**
 * 读面摘要 `contentExcerpt` 的**字符**（码点）上限（Memory web 二期 D1④）。
 *
 * ⚠️ 三条容易踩错的边界：
 * - 单位是**码点不是字节**（与上面的 `MEMORY_CONTENT_MAX_BYTES` 相反）：摘要只为卡片展示，
 *   没有引擎合同的字节闸门，按字符算才是"用户看到的长度"；
 * - 与 `MEMORY_EXCERPT_MAX_BYTES`（formation service 内部、2048 字节）不是同一件事——
 *   那个是**写入**时单条来源摘录的取用上限，本常量是**读出**时的展示上限；
 * - 截断后**必须**补 `MEMORY_EXCERPT_TRUNCATION_MARKER`，且**不得**触碰行级
 *   `contentTruncated`（那是"形成时摘录区被字节闸门截了"的事实，见 assembler 文件头）。
 */
export const MEMORY_CONTENT_EXCERPT_MAX_CHARS = 280;

/**
 * 引擎 `context_epoch` 的平台**护栏**上限（召回请求的世代字段）。
 *
 * ⚠️ 上限来源 = **平台主动保留的护栏，不是引擎当前的运行时限制**。历史事实（留作排障）：
 * hument alpha.3 的 `recall-request.schema.json` 只写 `minimum: 0`、**没写 maximum**，而运行时
 * 会拒 `context_epoch > 1e9`（边界二分实证：`1_000_000_000` → 200，`1_000_000_001` → 400
 * `invalid_argument`）。**alpha.4 起引擎已放宽到 JS 安全整数**（`0..9007199254740991`，
 * FEEDBACK-10 已修复）。
 *
 * 那为什么平台**仍然**卡 1e9？因为它拦的不是"引擎会拒的值"，而是**一个几乎总是错的用法**：
 * epoch 的语义是"同一 identity 下的第几轮"（逻辑序号 / 相对纪元），引擎只拿它做呈现去重、
 * 绝对值无意义，而 `Date.now()` 毫秒（≈1.76e12）恒为误用。**连 Unix 秒（≈1.76e9）也在护栏
 * 之上**——所谓"秒级"必须是相对纪元。保留更严的一侧 = 让"传了绝对时间"在**边界层**
 * （铁律 #21）就被指出来，而不是静默收下一个语义荒谬的巨大数字。
 *
 * 所以本常量是**防误用的护栏**；DTO 的 `@Max` 与 Swagger 文案都从这里取（改它就三处同步）。
 */
export const MEMORY_CONTEXT_EPOCH_MAX = 1_000_000_000;

/** 单次恢复扫描的行数上界（方案 §7：启动扫描与 `POST recover` 共用，防一次扫描烧光配额） */
export const MEMORY_RECOVERY_SCAN_LIMIT = 10;

/** 账本/项目列表缺省页大小 */
export const MEMORY_DEFAULT_PAGE_SIZE = 20;

/** 账本/项目列表最大页大小（越界钳制，不报错——列表是只读面） */
export const MEMORY_MAX_PAGE_SIZE = 100;

/**
 * 投影读面 graph 的 **node_limit 平台护栏**（Hument 合同允许 ≤1000）。
 *
 * ⚠️ 这**不是**引擎默认值（引擎默认档就是 200，平台不设自己的默认值），而是**平台输入上限**：
 * 权限过滤是逐节点的——`evaluateSourceRefs` 的 `preloadSourceChains` 会按引用数做一次
 * **无投影的 `find()`**（8 张表全列），recall 喂入 ≤128 项 / 512 refs 已是这个量级；
 * 1000 节点档会到 ~4000 refs（8×）。卡在引擎默认档 = 客户端要更大页时**明确被拒**，
 * 而不是让一次请求把库拖住。
 */
export const MEMORY_VIEW_NODE_LIMIT_MAX = 200;

/**
 * 投影读面 graph 的 **edge_limit 平台护栏**（Hument 合同允许 ≤3000）。
 *
 * 口径与 `node_limit` **不同**：边**不参与**引用预载（不产生过滤成本），600 只是与节点默认档
 * 同档匹配（引擎自认的"一页图"规模）。要更大页本批不支持——记录在案，不是遗漏。
 */
export const MEMORY_VIEW_EDGE_LIMIT_MAX = 600;

/** 投影读面 graph 的 `preview_scalars` 上限（Hument 合同上限 512；引擎默认 160） */
export const MEMORY_VIEW_PREVIEW_SCALARS_MAX = 512;

/** 投影读面游标长度上限（Hument 合同 `cursor`/`relation_cursor` maxLength 4096） */
export const MEMORY_VIEW_CURSOR_MAX_LENGTH = 4096;

/** 投影读面 detail 的 `relation_limit` 上限（Hument 合同 128） */
export const MEMORY_VIEW_RELATION_LIMIT_MAX = 128;

/** 投影读面 history 的 `history_limit` 上限（Hument 合同 100） */
export const MEMORY_VIEW_HISTORY_LIMIT_MAX = 100;

/** 投影读面的记忆/表示 id 长度上限（Hument 合同 minLength 1 / maxLength 128，**不是** UUID） */
export const MEMORY_VIEW_ENGINE_ID_MAX_LENGTH = 128;

// ══════════════════════════════════════════════════════════════════════
// Usage 读面（alpha.19）护栏
// ══════════════════════════════════════════════════════════════════════

/**
 * trace 缺省页大小（Hument `usage.trace_page_size` DefaultFile = 100）。
 *
 * ⚠️ **平台必须显式发它**（不是"省略让引擎用默认"）：合同的省略值随部署配置变化，
 * 而平台 UI 的"已加载 X / 共 total_rows"需要一个平台可解释的分母。`limit=0`（无上限）
 * 平台**拒绝**——一次无上限 trace 会扫描该 binding 的全部 ledger 并一次性返回。
 */
export const MEMORY_USAGE_TRACE_DEFAULT_LIMIT = 100;

/** trace 页大小上限（Hument 合同 `limit` 只要求 ≥0；200 是平台容量护栏） */
export const MEMORY_USAGE_TRACE_LIMIT_MAX = 200;

/** 时间窗最大跨度（天；`until - since` 超过即 400——summary 会扫全 binding，窗口越大越贵） */
export const MEMORY_USAGE_WINDOW_MAX_DAYS = 90;

/** 缺省时间窗（天；API 省略 since/until 时由服务端物化一次绝对窗口并经 `engine.filter` 回声） */
export const MEMORY_USAGE_DEFAULT_WINDOW_DAYS = 7;

/** usage 游标长度上限（合同未给 maxLength；与 views 同档 4096，防超长串进引擎/日志） */
export const MEMORY_USAGE_CURSOR_MAX_LENGTH = 4096;

/** 过滤器开放字符串的平台限长（`operation` / `provider_operation`；合同只声明 string） */
export const MEMORY_USAGE_FILTER_MAX_LENGTH = 128;

/** `model` 的平台限长（合同只声明 string；模型名可能带版本后缀，放宽到 200） */
export const MEMORY_USAGE_MODEL_MAX_LENGTH = 200;

/**
 * usage 端点的进程内全局并发闸（同一时刻最多 N 个 engine 调用）。
 *
 * rationale：Usage 会扫描该 binding 的**大量 ledger**（limit 只限返回不限扫描），且 Hub 单元格
 * 连接可能串行——多个并发 usage 请求会把 Hub 拖成队列。进程内闸只保护**本进程**；多实例
 * 部署下每个实例各有 N 个槽（这是"按实测容量复核"前的保守初值，不是全局配额）。
 */
export const MEMORY_USAGE_CONCURRENCY_LIMIT = 2;

/** usage 双桶限流窗口（ms） */
export const MEMORY_USAGE_THROTTLE_TTL_MS = 60_000;

/**
 * usage 双桶限流阈值（每窗口；初始 10/60s，待容量实测复核）。
 *
 * 与 recall 同款双桶（见 `common/utils/throttler-trackers.ts`）：IP 桶拦洪、actor 桶公平。
 * env 逃生口只影响本端点的生产阈值（测试环境放宽，见 controller 顶层常量）。
 */
export const MEMORY_USAGE_THROTTLE_LIMIT = 10;

/**
 * 账本**降级投影**的治理白名单（方案 §5：全部绑定不可读时只放行元数据）。
 *
 * ⚠️ 白名单语义见文件头：新增列默认不出现。列里的每一个都必须是**元数据**
 * （不含正文/理由/来源摘录/引擎 id 之外的内容面）。
 */
// ⚠️ 账本降级投影的字段白名单**刻意不在本文件导出**：它的唯一实现（也是唯一事实源）是
// `memory-formation.service.ts` 的 `toNominationDto` 的 `projection: 'metadata'` 分支。
// 曾经在这里放过一份数组常量——无任何 import 消费它，且与实际投影是"两份事实"
// （改一处另一处不会红），已删除。

/**
 * 引擎凭据引用**禁止**出现的形态（本模块本地副本，见文件头不变量）。
 *
 * 判据 = `judgment.config.ts` 的 `KEY_SHAPED`（`apikey_` / `sk_` 前缀）——`engine_credential_ref`
 * 非机密（存引用名），但把真 key 填进去是最常见的配置手滑，且它会随项目投影**回显给任何
 * 有 read 权限的人**（比日志泄露面更大）。
 */
export const MEMORY_CREDENTIAL_REF_PATTERN = /^(apikey|sk)[_-]/i;

/**
 * 引擎标识符字符集（`engineWorkspaceId` / `engineActorId` / `engineCredentialRef` 三列同一闸门）。
 *
 * ⚠️ 三列都是引擎侧**标识符**：只校验、**永不改写/截断**。越界值一旦落库，后续所有引擎调用
 * 都会打到不存在的 workspace/actor/credential，症状是"引擎每次都 403/404"（plan D7 / §5）。
 * 单源消费方 = `dto/project.dto.ts`（层 1）与 `memory-project.service.ts`（层 2）。
 */
export const MEMORY_ENGINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * 校验凭据引用不是"真 key 形态"。
 *
 * @param credentialRef 待写入的引用名
 * @returns true = 形态安全（可以落库）
 */
export function isSafeCredentialRef(credentialRef: string): boolean {
  return !MEMORY_CREDENTIAL_REF_PATTERN.test(credentialRef.trim());
}

/** 404/14001：项目不存在（含软删，不泄露存在性） */
export function memoryProjectNotFound(projectId: string): NotFoundException {
  return new NotFoundException({
    message:
      `Memory project '${projectId}' not found. It may never have existed, or it may have been ` +
      'soft-deleted — the response is identical by design. Do NOT retry the same id; list the ' +
      'current projects (GET /memory/projects) and pick a fresh one. 勿重试同 id',
    code: ErrorCode.MEMORY_PROJECT_NOT_FOUND,
  });
}

/** 404/14003：账本行不存在（含软删）；`GET .../memories/:id` 的无映射同码见枚举注释 */
export function memoryNominationNotFound(ledgerId: string, what = 'Nomination'): NotFoundException {
  return new NotFoundException({
    message:
      `${what} '${ledgerId}' not found in this project (it may never have existed, may have been ` +
      'soft-deleted, or — for a memory id — may not be mapped by any ledger row of THIS project). ' +
      'Do NOT retry the same id; read the ledger list (GET /memory/projects/:id/nominations) and ' +
      'pick a fresh id. 勿重试同 id',
    code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND,
  });
}

/**
 * 409/14002：项目级冲突（slug 占用 / 换绑 workspace / 归档项目写路径）。
 *
 * @param reason 已写好的具体场景说明（调用点各自给下一步动作）
 */
export function memoryProjectConflict(reason: string): ConflictException {
  return new ConflictException({
    message: reason,
    code: ErrorCode.MEMORY_PROJECT_CONFLICT,
  });
}

/**
 * 409/14005：提名/更正冲突（conflict 态 / rejected 态 / 更正预检失败 / 幂等键复用）。
 *
 * @param reason 已写好的具体场景说明（**必须含下一步动作**，见文件头不变量）
 */
export function memoryNominationConflict(
  reason: string,
  extra: MemoryFailureData = {},
): ConflictException {
  return new ConflictException({
    message: reason,
    code: ErrorCode.MEMORY_NOMINATION_CONFLICT,
    // data 槽透传：消费方按 hintCode / formationState 分支，而不必解析文案
    data: { ...extra },
  });
}

/** 403：项目级无写权限（复用平台 1009，与"来源级 403"文案分开） */
export function memoryProjectForbidden(projectId: string): ForbiddenException {
  return new ForbiddenException({
    message:
      `No write permission on memory project '${projectId}': none of its bindings grants you ` +
      'write access, or the project is archived (writes require status=active). 无本项目写权限 — ' +
      'ask a binding owner to grant you write access (topic participant role=editor / board ' +
      'member role=editor / doc-space member role=editor), or archive-and-recreate with bindings you own.',
    code: ErrorCode.PERMISSION_DENIED,
  });
}

/**
 * 403：来源级无权（**下标级指认**，方案 §4；与项目级 403 文案分开）。
 *
 * 文案尾句逐字采用方案 §6 的写法（`source_refs[i] 无权读取或不存在`）——它是**契约文案**，
 * 消费方（与 e2e）按它断言；改文案必须同步契约文档。
 */
export function memorySourceRefForbidden(index: number, sourceRefId: string): ForbiddenException {
  return new ForbiddenException({
    message:
      `source_refs[${index}] (${sourceRefId}) is not readable by you or does not exist. Source ` +
      'excerpts are fetched with YOUR permission — ask a reader of that resource to nominate it, ' +
      'or drop index ' +
      `${index} from source_refs. 来源无权或不存在（source_refs[${index}] 无权读取或不存在，下标级指认）`,
    code: ErrorCode.PERMISSION_DENIED,
  });
}

/**
 * 引擎/账本失败附件的**机器可读槽**（进异常体的 `data`；全局异常过滤器 v1.55 起透传）。
 *
 * ⚠️ 白名单式：只允许诊断标识（**绝不含正文/理由/凭据**）——响应体与日志都会长期留存。
 */
export interface MemoryFailureData {
  /** 引擎错误码（Hument `error.code`） */
  engineCode?: string;
  /** 相关账本行 id（消费方据此查详情或 retry） */
  ledgerId?: string;
  /** §7 子态驱动的下一步提示（与 `hintCode` 同源） */
  hint?: string | null;
  /** 提示的机器可读孪生（消费方按它分支，不读文案） */
  hintCode?: string | null;
  /** 失败时的形成态（便于消费方在不重读账本的情况下分支） */
  formationState?: string;
  /**
   * 引擎自报诊断（嵌套槽；**动作权威仍是 `hintCode`**）。
   *
   * 503 只会含 `{requestId}`——`admissionCause` 只在 409 的 HTTP 错误体里有，
   * 其余三个只在 200 回执的 `diagnostics` 里有。
   */
  engineDiagnostics?: MemoryEngineDiagnostics;
}

/**
 * 503/14000：引擎动词不可用（**两态必须分开**，方案 §3 引擎闸）。
 *
 * @param reason 不可用原因（值域单源 = shared `MEMORY_UNAVAILABLE_REASONS`）
 * @param extra 诊断附件（见 `MemoryFailureData`；**不含正文与凭据**）
 */
export function memoryUnavailable(
  reason: MemoryUnavailableReason,
  extra: MemoryFailureData = {},
): ServiceUnavailableException {
  // 文案逐 reason 定制：处置动作完全不同（配 env / 绑引擎 / 稍后重试 / 查账本 / 修注册表）
  // ⚠️ 本函数被**没有账本行**的读路径调用（recall / views 五读面），所以任何"续跑本行 /
  //    读账本详情"的动作句都必须以 `extra.ledgerId` 为开关：无行时只能给通用重试指引。
  const hasLedger = extra.ledgerId !== undefined;
  const guidance: Record<MemoryUnavailableReason, string> = {
    [MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED]:
      'The memory engine is not configured on this deployment (MEMORY_ENGINE is unset or none). ' +
      'Memory is an OPTIONAL enhancement — every local endpoint (projects/ledger/detail) still ' +
      'works. Ask the operator to set MEMORY_ENGINE (+HUMENT_BASE_URL) to enable engine verbs.',
    [MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND]:
      'This project has no engine bound (memory_projects.engine=none or its engine binding ' +
      'columns are empty). Memory is an OPTIONAL enhancement — local endpoints still work. ' +
      'Bind an engine with PATCH /memory/projects/:id (engine + engineWorkspaceId/' +
      'engineActorId/engineCredentialRef) before using engine verbs.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE]: hasLedger
      ? 'The memory engine is unreachable (connection refused / DNS / TLS — the request never ' +
        'arrived, so nothing was recorded). Resume THIS row with POST /memory/nominations/:id/retry ' +
        "later (the platform re-sends with the row's own engine idempotency key) — a bare re-POST " +
        'with the same clientRequestId only replays the recorded result. Check the project engine ' +
        'endpoint if it keeps failing.'
      : 'The memory engine is unreachable (connection refused / DNS / TLS — the request never ' +
        'arrived, so nothing was recorded). Nothing was read and no ledger row exists for this ' +
        'operation — retry the same operation later. Check the project engine endpoint if it ' +
        'keeps failing.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT]: hasLedger
      ? 'Timed out waiting for the memory engine. The request MAY already have been submitted — ' +
        'there is no receipt, so the ledger row is kept as `unknown` (NOT recoverable from ' +
        'Chamber). Read the ledger row detail first'
      : 'Timed out waiting for the memory engine. Nothing was read — this read has no ledger row ' +
        'to inspect; retry the same operation later.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR]: 'The memory engine answered with an error',
    [MEMORY_UNAVAILABLE_REASON.PROVISIONING_UNAVAILABLE]:
      'Auto-registration is unavailable: the Hub operator endpoint (or the launcher control ' +
      'socket) could not be reached, so nothing was registered. Nothing was saved either — ' +
      're-sending the same create request is safe. Check the Hub process and ' +
      'HUMENT_OPERATOR_SOCKET_PATH, or pass the engine binding triple explicitly to skip ' +
      'auto-registration.',
    [MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT]:
      'Timed out while auto-registering this project on the Hub. The registration MAY already ' +
      'have landed (the Hub keeps no client-visible receipt): re-sending the SAME create request ' +
      'is safe — the idempotency key `chamber-provision-<slug>` makes the Hub replay it. If it ' +
      'keeps timing out, read the Hub catalog for this slug before retrying.',
    [MEMORY_UNAVAILABLE_REASON.PROVISIONING_CONFLICT]:
      'The Hub refused the registration with a conflict (409). Two indistinguishable causes: ' +
      '(a) a workspace with this slug already exists under the same tenant but with a DIFFERENT ' +
      'shape (actor/credential/binding), or (b) the Hub holds a stale cell/file for this project ' +
      'from an earlier attempt or a manual edit. Both are Hub-side registry states that need ' +
      'operator alignment — nothing was saved in Chamber. Pick another slug, or pass the engine ' +
      'binding triple explicitly to reuse the existing workspace.',
    [MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED]:
      'Auto-registration failed on the Hub operator endpoint (see data.engineCode for the exact ' +
      'cause: invalid_argument / unauthenticated / scope_denied / ' +
      'project_registration_disabled / project_feature_unavailable, or a half-registered state ' +
      'that never converged). Nothing was saved in Chamber. Pass the engine binding triple ' +
      'explicitly to bypass auto-registration, or fix the reported cause and retry.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED]:
      'The memory engine does not support the recorded-usage API (old Hub without the usage ' +
      'routes, missing usage capability, or a response that violates the usage contract). ' +
      'Nothing was read. Upgrade the Hub to a build that ships the usage API (v0.1.0-alpha.19 or ' +
      'a contract-fix build) — retrying the same request will NOT help until then.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_DATA_INCOMPATIBLE]:
      'The Hub answered with `schema_incompatible`: its EXISTING ledger or receipts cannot be ' +
      'decoded, or the evidence conflicts. This is a DATA condition, NOT a version signal — do ' +
      'not upgrade and do not retry blindly. Ask the Hub operator to reconcile the ledger and ' +
      'receipts, then retry once they confirm.',
    [MEMORY_UNAVAILABLE_REASON.ENGINE_IDENTITY_INVALID]:
      'The Hub denied the usage read for this engine identity (403 scope_denied: the binding is ' +
      'missing/ambiguous or lacks inspect_read), or the response echoed a different ' +
      'workspace/actor/scope. Nothing was read. Fix the project engine binding and its ' +
      'inspect_read authorization — retrying and upgrading are both ineffective until then.',
  };
  const ledgerSuffix = extra.ledgerId
    ? `. Ledger row: ${extra.ledgerId} (read it with GET /memory/nominations/${extra.ledgerId})`
    : '';
  const codeSuffix = extra.engineCode ? ` (engine code: ${extra.engineCode})` : '';
  return new ServiceUnavailableException({
    message: `${guidance[reason]}${codeSuffix}${ledgerSuffix}`,
    code: ErrorCode.MEMORY_UNAVAILABLE,
    // data 槽透传（全局异常过滤器 v1.55 起支持）：reason 是机器可读孪生，消费方按它分支
    data: { reason, ...extra },
  });
}

/**
 * 502/14004：引擎可达但返回错误，且该端点**没有账本态可回报**（召回 / 记忆详情）。
 *
 * 与 14000 的分工见 shared `MEMORY_ENGINE_ERROR` 注释：写入路径永远有账本行可查，
 * 故走 503 + 账本态；只读路径没有，走本码。
 */
export function memoryEngineError(
  engineCode: string | undefined,
  message: string,
  extra: MemoryFailureData = {},
): BadGatewayException {
  return new BadGatewayException({
    message,
    code: ErrorCode.MEMORY_ENGINE_ERROR,
    data: { reason: MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR, engineCode, ...extra },
  });
}

// ══════════════════════════════════════════════════════════════════════
// Usage 读面的错误动作码与构造器
// ══════════════════════════════════════════════════════════════════════

/**
 * Usage 读面的 hintCode（**机器可读、稳定、大写下划线**；消费方按它分支，不读文案）。
 *
 * - `cursor_reset_required`：丢弃已累积页，按**原 filter/limit** 重拉首页一次。
 *   它登记在 hint-registry 的独立 `memory_read` family（**不进** formation 的
 *   `MEMORY_HINT`——那个值域的语义是"形成子态"）。
 * - `shared_engine_binding`：引擎身份共享/归属不明，Usage 关闭；**不要**重试、不要换 cursor。
 *   它是错误动作码而非拦截器 hint（不参与 hints[] 排序/去重），故不登记 registry。
 */
export const MEMORY_USAGE_HINT = {
  CURSOR_RESET_REQUIRED: 'cursor_reset_required',
  SHARED_ENGINE_BINDING: 'shared_engine_binding',
} as const;

/** usage hint 码 */
export type MemoryUsageHintCode = (typeof MEMORY_USAGE_HINT)[keyof typeof MEMORY_USAGE_HINT];

/**
 * 409/14006：引擎身份共享/归属不明，Usage 关闭（**Hub 零调用**）。
 *
 * ⚠️ 文案**不含** creditorRef / workspace / actor / 其他项目 id：这些值会随响应长期留存，
 * 而共享关系的存在本身就是敏感信息。两个成因（多行引用 / claim 缺失或他人占用）共用本码。
 */
export function memoryUsageSharedBinding(): ConflictException {
  return new ConflictException({
    message:
      'Recorded usage is DISABLED for this project because its engine identity is shared with ' +
      'another memory project, or its permanent ownership claim is missing / owned by another ' +
      'project. Usage is only served when this project is the single permanent owner of its ' +
      'engine identity — no engine call was made. Do NOT retry: an operator must audit and ' +
      'resolve the identity claim (self-service release is deliberately unavailable). ' +
      '共享引擎身份，用量关闭',
    code: ErrorCode.MEMORY_USAGE_CONFLICT,
    data: { hintCode: MEMORY_USAGE_HINT.SHARED_ENGINE_BINDING },
  });
}

/**
 * 502/14004：usage 游标失效（快照变化 = 409 `conflict`；携 cursor 的过滤/页大小不符 =
 * 400 `invalid_argument`）。
 *
 * 消费动作只有一条：**丢弃已累积页，按原 filter/limit 重拉首页一次**（不要每页重算时间窗）。
 * `engineCode` 逐字透传（`conflict` / `invalid_argument`），但**不带上游自由正文**。
 */
export function memoryUsageCursorReset(
  engineCode: string | undefined,
  requestId: string | undefined,
): BadGatewayException {
  return memoryEngineError(
    engineCode,
    'The usage cursor is no longer valid (the data snapshot changed, or the cursor does not ' +
      'match the current filter/page size). Drop the accumulated pages and refetch page 1 once ' +
      'with the SAME filter and limit — do not recompute the time window per page. ' +
      '用量游标失效，重拉首页',
    {
      hintCode: MEMORY_USAGE_HINT.CURSOR_RESET_REQUIRED,
      ...(requestId ? { engineDiagnostics: { requestId } } : {}),
    },
  );
}

/**
 * 429 的**携带 Retry-After 的异常**（controller 据此设置响应头）。
 *
 * Nest 的 `HttpException` 不带头部槽——header 只能在 controller 的 `@Res({passthrough})`
 * 上落。用子类而不是"返回体里塞 retryAfterSeconds 让客户端自己读"：HTTP 语义要求
 * `Retry-After` 是头（代理/客户端按头退避），body 只做人可读补充。
 */
export class MemoryUsageRateLimitedException extends HttpException {
  constructor(
    /** 等待秒数（1..3600；已由上游/并发闸钳制） */
    readonly retryAfterSeconds: number,
    reason: 'engine' | 'concurrency',
  ) {
    super(
      {
        message:
          `Recorded usage is rate limited (${reason}). Wait for the Retry-After header (seconds) ` +
          'and retry the SAME request — for a trace page, reuse the SAME cursor and filter; do ' +
          'not drop the accumulated rows. 用量限流，按 Retry-After 等待后重试',
        code: ErrorCode.RATE_LIMITED,
        data: { reason, retryAfterSeconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** hint 的机器可读孪生码（与文案同源；消费方按 code 分支，不读文案） */
export const MEMORY_HINT = {
  /**
   * 非终态：续跑**本行**（`POST /memory/nominations/:id/retry`）。
   * ⚠️ 不是"同 key 重发"——同 `clientRequestId` 的 POST 只会回放已有结果，永不推进引擎 job。
   */
  SAME_KEY_RESEND: 'same_key_resend',
  /** 请求未到达：续跑本行安全（同 key 重发同样只回放，见上） */
  NOT_DELIVERED_RESEND: 'not_delivered_resend',
  /** 配置错：修注册表/凭据，重试无效 */
  CONFIG_INVALID: 'config_invalid',
  /** 参数错：换新 client_request_id 重提 */
  PARAM_INVALID: 'param_invalid',
  /** 无回执且不可恢复：查账本详情，勿盲重试 */
  OUTCOME_UNKNOWN: 'outcome_unknown',
  /** 引擎拒绝：勿重试，需 Owner recovery */
  REJECTED_HUB_MANUAL: 'rejected_hub_manual',
  /**
   * 引擎 409 的**兜底桶**（未分类）：alias 归属 / schema_incompatible /
   * 引擎未给 admission cause（含引擎侧幂等冲突分支）。
   */
  CONFLICT_MANUAL: 'conflict_manual',
  /** 409 逐因：namespace 前缀未结算（在途 blocker 会自愈；终拒未结算只能运营侧结算） */
  CONFLICT_PREFIX_UNRESOLVED: 'conflict_prefix_unresolved',
  /** 409 逐因：三元（scope + workspace + actor）配额耗尽（退避后**续跑本行**，勿同 key POST） */
  CONFLICT_QUOTA_EXCEEDED: 'conflict_quota_exceeded',
  /** 409 逐因：内容完全重复（同 digest 的 current representation 已存在；不会自愈） */
  CONFLICT_EXACT_CONTENT: 'conflict_exact_content',
  /** 已形成：终态，无后续动作（recallId 采纳回写是召回侧纪律，不在提名路径提示） */
  COMMITTED: 'committed',
  /**
   * 更正行已 `committed`（新主张形成并落账本）但**引擎侧更正链接未建立**，旧主张仍 current。
   *
   * 下一步与 `committed` **不同**：续跑本行（`retry`）只重试链接步、不重烧形成配额；
   * **勿对同一 old 主张重提更正**（`uq_memory_nominations_correction_of` 部分唯一索引会 409）。
   */
  CORRECTION_LINK_PENDING: 'correction_link_pending',
  /** 无需记忆：引擎判定与既有记忆无实质变化 */
  NO_MEMORY: 'no_memory',
} as const;

/** hint 码 */
export type MemoryHintCode = (typeof MEMORY_HINT)[keyof typeof MEMORY_HINT];

/**
 * 文案作用域（**flow 只作用于 `conflict` / `rejected` 分支**）。
 *
 * - `nomination`（默认）：普通提名 / retry 的 409 与终拒
 * - `correction`：更正路径的 409 与终拒——这些行**已被撤回**（`withdrawn`），
 *   所以文案必须点名撤回语义；非终态分支（failed/unknown/submitted）**不得**出现
 *   WITHDRAWN / "NEW clientRequestId"（那些行保持 active，可续跑）。
 */
export type FormationHintFlow = 'nomination' | 'correction';

/** 409 的逐因词表（引擎 `admission_cause` 三值；缺席/未知 ⇒ 兜底桶） */
const CONFLICT_CAUSES = ['prefix_unresolved', 'quota_exceeded', 'exact_content'] as const;
type ConflictCause = (typeof CONFLICT_CAUSES)[number];

/**
 * `admissionCause` 的**闭合词表门**（与引擎层 `asAdmissionCause` 同构）：未登记值 → undefined。
 *
 * ⚠️ 不做推断（不猜"第四因"）：未知值 = 兜底桶，动作由 `conflict_manual` 承接。
 */
function asConflictCause(value: unknown): ConflictCause | undefined {
  if (typeof value !== 'string') return undefined;
  return (CONFLICT_CAUSES as readonly string[]).includes(value)
    ? (value as ConflictCause)
    : undefined;
}

/**
 * 409 逐因文案单源（**逐字定稿**：方案 §5.2 的 nominate/retry 版与 §5.3 的 correct 版）。
 *
 * ⚠️ 这是**评审逐字定稿的契约文案**：改措辞会改变消费方（agent）的下一步动作，
 * 必须同步线上 `docs/api-definition.md` 与 skill `memory/SKILL.md`。
 *
 * @param flow 文案作用域（correct 版带"已撤回"语义）
 * @param cause 引擎 admission 失败因（undefined = 未给/未知 ⇒ 兜底桶）
 * @param ledgerId 账本行 id（文案里的具体行指认）
 */
function conflictText(
  flow: FormationHintFlow,
  cause: ConflictCause | undefined,
  ledgerId: string,
): string {
  if (cause === 'prefix_unresolved') {
    if (flow === 'correction') {
      return (
        'The engine has this namespace FENCED for scope + workspace + actor: either an earlier ' +
        'nomination is STILL IN FLIGHT, or an earlier one ended terminal (rejected/unknown) ' +
        'without a recovery receipt. This CORRECTION row was WITHDRAWN and the old claim is still ' +
        'current — retrying this row is a dead end. (1) If an earlier nomination was in flight, ' +
        'wait one round and start a NEW correction with a NEW clientRequestId. (2) If it still ' +
        'returns 409 prefix_unresolved, the blocker did not settle on its own and only the engine ' +
        'operator can settle it: report project id + the withdrawn ledger row ' +
        `${ledgerId} + the time you observed the 409. Do not change the key, do not switch ` +
        'projects, and do not replay in a loop.'
      );
    }
    return (
      'The engine has this namespace FENCED for scope + workspace + actor: either an earlier ' +
      'nomination is STILL IN FLIGHT, or an earlier one ended terminal (rejected/unknown) without ' +
      'a recovery receipt. No new nomination can be admitted until it settles. (1) Wait one ' +
      'round, then resume THIS row with POST /memory/nominations/:id/retry — an in-flight blocker ' +
      'usually settles by itself. (2) If it still answers 409 prefix_unresolved, the blocker did ' +
      'not settle on its own: only the engine operator can settle it. Report project id + ledger ' +
      `row ${ledgerId} + the time you observed the 409. Do not change the key, do not switch ` +
      'projects, and do not replay in a loop.'
    );
  }

  if (cause === 'quota_exceeded') {
    if (flow === 'correction') {
      return (
        'The engine admission quota for scope + workspace + actor is exhausted. This CORRECTION ' +
        'row was WITHDRAWN and the old claim is still current — POST ' +
        '/memory/nominations/:id/retry cannot resume it, and re-POSTing the correction with the ' +
        'same clientRequestId only replays this 409. Back off, lower your concurrency, then start ' +
        'a NEW correction with a NEW clientRequestId. The platform does NOT know the reset time: ' +
        'do not guess it. After several back-offs still failing, hand it to the operator. ' +
        `Withdrawn ledger row: ${ledgerId}.`
      );
    }
    return (
      'The engine admission quota for scope + workspace + actor is exhausted. Do NOT re-POST the ' +
      'nomination with the same clientRequestId — that only replays this recorded 409 and never ' +
      'calls the engine again. Back off, lower your concurrency, then resume THIS row with POST ' +
      "/memory/nominations/:id/retry (the platform re-sends with the row's own engine " +
      'idempotency key). The platform does NOT know the reset time: do not guess it. After ' +
      'several back-offs still failing, hand it to the operator. ' +
      `Ledger row: ${ledgerId}.`
    );
  }

  if (cause === 'exact_content') {
    if (flow === 'correction') {
      return (
        'The engine already admitted this EXACT content (content-addressed admission): the new ' +
        'content exists as a memory, so this correction cannot be applied while that memory stays ' +
        'current. Confirm that the existing memory already covers what the correction was meant ' +
        'to say; if it does, drop this correction. Do NOT reword the content to dodge ' +
        'de-duplication. This condition does NOT clear on its own — do not wait and retry, and do ' +
        `not re-issue the same correction. Withdrawn ledger row: ${ledgerId}.`
      );
    }
    return (
      'The engine already admitted this EXACT content (content-addressed admission; the digest ' +
      'matches an existing current representation). This condition does not clear on its own — ' +
      'waiting and resending will keep returning it. First recall / read the ledger to confirm ' +
      'the existing memory already covers this claim; if it does, drop this nomination. Rewording ' +
      'the same claim to dodge this gate pollutes the ledger — do not do it (semantic similarity ' +
      `is deliberately outside this admission check). Ledger row: ${ledgerId}.`
    );
  }

  // 兜底桶：alias 归属 / schema_incompatible / 引擎 409 未给 cause（含引擎侧幂等冲突分支）
  if (flow === 'correction') {
    return (
      'Unclassified conflict for this CORRECTION. This bucket covers: alias/canonical ownership ' +
      '(the canonical row lives in another project), engine schema-incompatible conflicts, and ' +
      "engine 409s that carried no admission cause (including the engine's own " +
      'idempotency-conflict branch). This correction row was WITHDRAWN and the old claim is still ' +
      `current. (1) Read the withdrawn row ${ledgerId} and check engineCanonicalNominationId — if ` +
      'it points outside this project, STOP resubmitting; read it in the canonical project if you ' +
      'have access, otherwise escalate. (2) Still unclear: hand it to the owner/operator with ' +
      'ledgerId + timestamp.'
    );
  }
  return (
    'Unclassified conflict. This bucket covers: alias/canonical ownership (the canonical row ' +
    'lives in another project), engine schema-incompatible conflicts, and engine 409s that ' +
    "carried no admission cause (including the engine's own idempotency-conflict branch). " +
    '(A 409 from re-POSTing with an already-used clientRequestId is answered by the platform ' +
    'pre-check and carries NO hintCode — see the last row of the table; read the existing row ' +
    `instead of resending.) (1) Read the row: GET /memory/nominations/${ledgerId} (full tier) and ` +
    'check engineCanonicalNominationId — if it points outside this project, STOP resubmitting and ' +
    'stop calling recover; read it in the canonical project if you have access, otherwise ' +
    'escalate. (2) POST /memory/projects/:id/recover may self-heal. (3) If it is still unclear, ' +
    'hand it to the owner/operator with ledgerId + timestamp.'
  );
}

/** 终拒文案（nomination / correction 两版；逐字定稿见方案 §5.2 / §5.3） */
function rejectedText(flow: FormationHintFlow, ledgerId: string): string {
  if (flow === 'correction') {
    return (
      "The engine REJECTED this correction's new claim (terminal; admission is " +
      'content-addressed, so the same content replays the rejection instantly). The old claim is ' +
      'still current. Do NOT retry, do NOT replay the same content with a new clientRequestId, ' +
      "and do NOT reword it to dodge de-duplication. data.engineDiagnostics carries the engine's " +
      'own evidence only — engineReasonCode / errorDetail / failureClass — the action is ' +
      'owner/Hub recovery. Report project id + the withdrawn ledger row ' +
      `${ledgerId} + the time you observed the failure to the operator.`
    );
  }
  return (
    'The engine REJECTED this nomination (terminal; admission is content-addressed, so the same ' +
    'content replays the rejection instantly). Do NOT retry with the same key, do NOT replay the ' +
    'same content with a new clientRequestId, and do NOT reword the claim to dodge de-duplication. ' +
    "data.engineDiagnostics (when present) carries the engine's own evidence — " +
    'engineReasonCode / errorDetail / failureClass — as EVIDENCE ONLY; the action is still ' +
    `owner/Hub recovery. Report project id + ledger row ${ledgerId} + the time you observed the ` +
    'failure to the operator.'
  );
}

/**
 * 非终态续跑的**唯一正确动作**（同一句单源；方案 §5.2 末段对 "re-send with the SAME key"
 * 误述的统一校正）。
 *
 * ⚠️ 为什么不能写"同 key 重发"：同 `clientRequestId` 的 POST 命中账本行后**直接回放已记录结果、
 * 永不调用引擎**（无限循环）。真正的续跑通道是 `POST /memory/nominations/:id/retry`。
 */
const RETRY_ROW_ACTION =
  'resume THIS row with POST /memory/nominations/:id/retry. Re-POSTing the nomination with the ' +
  'same clientRequestId only replays the recorded result — it never advances the engine job. ' +
  '"Same key" is the row\'s engine idempotency key, managed by the platform.';

/**
 * 由 §7 子态产出 `hint` + `hintCode`（**逐态语义**，见文件头不变量）。
 *
 * @param input `formationState` + `recoveryPath` + `engineCode` + `ledgerId`
 * @param input.engineDiagnostics 引擎自报诊断（**只有 `admissionCause` 参与分派**；409 逐因文案靠它）
 * @param input.flow 文案作用域（默认 `nomination`；correct 路径传 `correction`）
 * @param input.oldClaimStatus 更正链的旧主张终态（**只用于 committed 分流**：`still_current`
 *   ⇒ 链接未建立，续跑本行 retry 才是下一步；`superseded` / 未传 ⇒ 维持 `committed` 文案）
 * @returns 下一步提示与其机器可读孪生（无后续动作时 `hint=null`，如 committed）
 */
export function buildFormationHint(input: {
  formationState: string;
  recoveryPath: string | null;
  engineCode?: string;
  ledgerId: string;
  engineDiagnostics?: MemoryEngineDiagnostics | null;
  flow?: FormationHintFlow;
  oldClaimStatus?: 'superseded' | 'still_current';
}): { hint: string | null; hintCode: string | null } {
  const ledger = input.ledgerId;
  const flow = input.flow ?? 'nomination';
  // 未知 admission_cause 已在引擎层被丢弃；这里再用同一套词表门取一次，缺席 ⇒ 兜底桶，不猜第四因
  const cause = asConflictCause(input.engineDiagnostics?.admissionCause);
  switch (input.formationState) {
    case 'committed':
      // 更正行：新主张已形成并落账本，但引擎侧 correct **未成立**（旧主张仍 current）。
      // ⚠️ 它的下一步与普通提名**不同**——retry 本行会真正重试链接步（formation 服务的更正
      // 续跑分支），所以"Nothing further to do"是错的（2026-10-21 生产已因此误导两名消费 agent，
      // 卡 61688768）。链接失败的事实同时由响应体的 `correctionLinkFailure` 携带。
      if (input.oldClaimStatus === 'still_current') {
        return {
          hint:
            'New claim committed and durable — the ledger row is your receipt. BUT the correction ' +
            'link was NOT established on the engine side (the engine rejected or never acknowledged ' +
            'the correct() call), so the OLD claim is still current — see correctionLinkFailure for ' +
            `kind/engineCode/httpStatus. ${RETRY_ROW_ACTION} Resuming THIS row retries only the ` +
            'link step: no formation quota is burned again. Do NOT submit another correction ' +
            'against the same old claim — the platform enforces ONE active correction per old ' +
            `claim and answers 409; this row is the one to resume. Ledger row: ${ledger}.`,
          hintCode: MEMORY_HINT.CORRECTION_LINK_PENDING,
        };
      }
      return {
        hint:
          'Memory committed (terminal). Nothing further to do — no retry, no polling; the ' +
          'ledger row is the durable receipt.',
        hintCode: MEMORY_HINT.COMMITTED,
      };
    case 'no_memory':
      return {
        hint:
          'No new memory was formed this time (the input may have no durable value, or is just ' +
          'transient progress). Nothing was recorded — the engine validated that against existing ' +
          'memories. Recall and check if you need to confirm what is already remembered. For a ' +
          'correction this releases the correction slot, so the same old claim can be corrected ' +
          'again with new content.',
        hintCode: MEMORY_HINT.NO_MEMORY,
      };
    case 'rejected':
      return {
        hint: rejectedText(flow, ledger),
        hintCode: MEMORY_HINT.REJECTED_HUB_MANUAL,
      };
    case 'conflict':
      return {
        hint: conflictText(flow, cause, ledger),
        hintCode:
          cause === 'prefix_unresolved'
            ? MEMORY_HINT.CONFLICT_PREFIX_UNRESOLVED
            : cause === 'quota_exceeded'
              ? MEMORY_HINT.CONFLICT_QUOTA_EXCEEDED
              : cause === 'exact_content'
                ? MEMORY_HINT.CONFLICT_EXACT_CONTENT
                : MEMORY_HINT.CONFLICT_MANUAL,
      };
    case 'unknown':
      return {
        hint:
          input.recoveryPath === 'same_key_resend'
            ? `No receipt from the engine — it MAY already have been recorded. ${RETRY_ROW_ACTION} ` +
              `Ledger row: ${ledger}.`
            : `Engine outcome unknown and NOT recoverable from Chamber (client timeout / ` +
              `provider_outcome_unknown). Do not blind-retry — read the ledger row: ${ledger}.`,
        hintCode: MEMORY_HINT.OUTCOME_UNKNOWN,
      };
    case 'failed': {
      if (input.recoveryPath === 'config_invalid') {
        return {
          hint:
            `Engine configuration error${input.engineCode ? ` (${input.engineCode})` : ''}: fix the ` +
            'registry (workspace/actor/credential) before retrying — a retry with the same ' +
            'configuration will fail the same way.',
          hintCode: MEMORY_HINT.CONFIG_INVALID,
        };
      }
      if (input.recoveryPath === 'param_invalid') {
        return {
          hint:
            `Engine parameter error${input.engineCode ? ` (${input.engineCode})` : ''}: re-submit ` +
            'with a NEW client_request_id (same key would replay the rejected payload).',
          hintCode: MEMORY_HINT.PARAM_INVALID,
        };
      }
      return {
        hint:
          input.engineCode === undefined
            ? `The request never reached the engine — ${RETRY_ROW_ACTION} Ledger row: ${ledger}.`
            : `Engine error${input.engineCode ? ` (${input.engineCode})` : ''} — ${RETRY_ROW_ACTION} ` +
              `Ledger row: ${ledger}.`,
        hintCode:
          input.engineCode === undefined
            ? MEMORY_HINT.NOT_DELIVERED_RESEND
            : MEMORY_HINT.SAME_KEY_RESEND,
      };
    }
    default:
      // submitted（含 deferred 标志）
      return {
        hint: `Not converged yet — ${RETRY_ROW_ACTION} Ledger row: ${ledger}.`,
        hintCode: MEMORY_HINT.SAME_KEY_RESEND,
      };
  }
}

/** 命名访问视图（单源派生自 `MEMORY_HINT`）：服务层与 e2e 断言共用，避免各写一遍字面量 */
export const MEMORY_HINT_CODE = MEMORY_HINT;

/**
 * **裁决词**——词表**精调层**的正文命中判据（**可选**，决策 2）。
 *
 * 语义：env `MEMORY_NOMINATION_HINT_KEYWORDS=preset` 时，任务正文 / 评论 / 话题消息里
 * 出现下列词之一才提示（把通用触发收窄为「像裁决的内容」）。**缺省（通用模式）不读正文、
 * 不扫词**——「该资源上有值得进记忆的写入」本身就是提示理由。
 *
 * 来源与修订通道：对齐 kairos-project-engineering §14.2 的触发词清单；
 * **修订必须经 chamber 意见箱 topic `f2ea7a89`** 走同一份清单——两侧漂移会让
 * "为什么这条被提示了 / 为什么那条没有"变成无法解释的行为。
 */
export const MEMORY_RULING_KEYWORDS = [
  '拍板',
  '以后都',
  '不要再',
  '一律',
  '停用',
  '就用这个',
  '禁止',
] as const;

/** 拦截器通道的 hint 机器码（与注册表 `hint-registry.ts` 的字面量内联条目同源） */
export const MEMORY_NOMINATION_HINT_CODE = 'memory_nomination_suggested';

/**
 * 拦截器通道的提示文案（**通用触发**三要素：本资源已绑定记忆项目 / 若含跨会话价值 /
 * 动作入口 + 忽略语）。
 *
 * ⚠️ **不得再提「正文命中裁决词」**（决策 13）：通用模式（缺省）**从不读正文**——
 * 文案若声明一个没发生的判据，每次送达都在说谎。词表只是可选精调层（env
 * `MEMORY_NOMINATION_HINT_KEYWORDS`），不是提示的必要条件。
 *
 * 形态纪律（对齐 docspace `DOC_HINT_MESSAGES` 与 `buildFormationHint`）：一句话说清
 * 「发现了什么 + 下一步做什么」，不承诺结果、不描述内部实现；结构化信息一律走 `data`
 * 的四个字段（消费方**不解析 message**）：`projectIds` 命中项目全集、`source{type,id}`
 * 本次写入的来源、`suggestedTool` 查看已提名记录的现成入口、`suggestedParams` 其可执行参数。
 */
export const MEMORY_NOMINATION_HINT_MESSAGE =
  '这次写入的资源已绑定记忆项目；若其中包含值得跨会话复用的信息（裁决 / 约定 / 排障结论等），' +
  '建议把它提名进记忆：POST /api/v1/memory/projects/:id/nominations（项目 id 见 data.projectIds）。' +
  '若本次内容只是一次性进度或已就该资源提名过，可忽略本提示。';
