/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - board **digest 截断续读码的文案与元数据单源**（阶段三，决策 9）：一条码
 *     （`board_digest_truncated`）的**唯一真源** + 一个零 IO 的候选构造器。
 *   - 形态 = board digest 响应的**运行期附挂** hints（`BoardDigest` DTO **不声明**
 *     hints 键，形状与 `DocHint` 同构）——与 memory 侧、task 侧同款先例。
 *
 * [代码职责]
 *   - `BOARD_HINT` / `BOARD_HINT_CODES` / `BoardHintCode`：机器码（与
 *     `hints/hint-registry.ts` 的 `BOARD_DIGEST_DEFINITIONS` 同源，由
 *     `board-hint.constants.spec.ts` 双向守卫——注册表侧是**字面量内联**，因为它不能
 *     import 领域模块）。
 *   - `BOARD_HINT_MESSAGES`：code → 文案（**禁在 service 手写字面量**）。
 *   - `buildBoardDigestTruncatedHint`：**纯函数**构造器（零 IO、永不抛），把
 *     `{section, returnedCount, totalCount}` 落成 `data` 四字段 + 最便宜的下一步参数。
 *   - `BOARD_HINT_PROFILE` / `BOARD_HINT_SURFACE`：交给 `hint-emit.emitHints` 的领域侧
 *     配置与埋点面（内核不认识任何 code）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.4（截断续读：**教学定位**，不是每次提醒）
 *   - 补充: 线上 docs/api-definition.md §2.7（hints 信封消费契约）、§7（digest 各段 limit）
 *
 * [关键不变量]
 *   - **教学定位**（decision 9）：本码是「分页姿势教一次」，**不是**每次截断都提醒。
 *     故：文案必须含「已够用可忽略」+ 最便宜下一步；`ttlMs` = **24h**（注册表侧声明）；
 *     且触发判据要求**调用方未显式传该段 limit**（显式传 = 调用方自己管预算，无需教学）。
 *   - **`limit=0` 不参与截断判定**：`0` 是「显式要求空段」（board.service 既有惯例），
 *     不是截断——判定由调用方（service）在做，本文件只负责「已判定为截断」后的构造。
 *   - **`suggestedParams` 给的是「该段自己的 limit」**：`limit=0` 也是合法建议（不要该段），
 *     但这里给的是「要全」的方向（传 totalCount）——教学的目标是拿到数据，不是省 token。
 *   - **改码名 = 观测断裂**：code 是稳定标识（日志按 code 聚合）；改名同步注册表 + 本文件
 *     + 两侧守卫 spec。
 *
 * [关联代码]
 *   - ./board.service.ts — 唯一生产消费者（getDigest 内判定截断段后调用构造器）
 *   - ./board.controller.ts — actorId 透传（否则去重键落 'system' 全局共享）
 *   - ../hints/hint-registry.ts — `BOARD_DIGEST_DEFINITIONS`（元数据登记，字面量内联）
 *   - ../hints/hint-emit.ts — `HintEmitProfile`（本文件装配的接口来源）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增码 ⇒ 本文件四件套 + 注册表 + 守卫 spec 齐步
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { makeHintCandidate, type HintCandidate } from '../hints/hint-core';
import type { HintEmitProfile } from '../hints/hint-emit';
// 去重窗口长度的单源 = 注册表（`HintDefinition.ttlMs`）——profile 只做委托，
// 不写死数字（P1-1：缺 `ttlOf` 钩子会让 `hint-emit` 落 6h 缺省，声明窗口静默失效）
import { hintTtlOf } from '../hints/hint-registry';

/** board digest 机器码（命名 = 领域前缀 + snake_case；**稳定标识，禁改名**） */
export const BOARD_HINT = {
  /** digest 某段被 limit 截断（且调用方未显式传该段 limit）→ 分页教学 */
  DIGEST_TRUNCATED: 'board_digest_truncated',
} as const;

/** 码值联合（`BOARD_HINT` 派生——不手写第二份字面量） */
export type BoardHintCode = (typeof BOARD_HINT)[keyof typeof BOARD_HINT];

/** 全部码（数组序 = 注册表同源守卫的比较基准） */
export const BOARD_HINT_CODES: readonly BoardHintCode[] = Object.values(BOARD_HINT);

/** 埋点产出面（开放词表值；注册表 `ownerSurface` 同值） */
export const BOARD_HINT_SURFACE = 'board_digest';

/**
 * digest 段 → 该段自己的 limit 查询参数名（`BoardDigestQueryDto`）。
 *
 * 键集合 = digest 全部**可截断**段（`versions` 的 limit 是 `versionLimit`）。
 * 与 `board.service.getDigest` 的段顺序一致，服务层按本表反查「哪一段截断了」。
 */
export const BOARD_DIGEST_SECTION_LIMIT_PARAM = {
  nextUp: 'openLimit',
  risks: 'riskLimit',
  recentDone: 'doneLimit',
  docs: 'docsLimit',
  versions: 'versionLimit',
} as const;

/** digest 可截断段（`BOARD_DIGEST_SECTION_LIMIT_PARAM` 的键联合） */
export type BoardDigestTruncatedSection = keyof typeof BOARD_DIGEST_SECTION_LIMIT_PARAM;

/** code → 文案（**单源**，禁在 service 里手写） */
export const BOARD_HINT_MESSAGES: Record<BoardHintCode, string> = {
  [BOARD_HINT.DIGEST_TRUNCATED]:
    'board digest 有一段被 limit 截断（已够用可忽略）。要看全的那一段：带上它自己的 limit ' +
    '参数重调本端点（limit=0 表示不要该段），或用 data.suggestedParams 给出的值直接拉全。',
};

/**
 * board 侧给通用内核的**领域侧配置**（与 docspace `DOC_HINT_PROFILE` 同款角色）。
 *
 * `familyOf` 恒 `'read'`：族归属的单源仍是注册表（`BOARD_DIGEST_DEFINITIONS` 的
 * `family: 'read'`），此处只是把它喂给内核——两处同值由守卫 spec 钉。
 *
 * ⚠️ **`ttlOf` 必须挂**（P1-1）：`hint-emit` 取 `profile.ttlOf?.(code)`，缺钩子 ⇒ 传
 * undefined ⇒ dedup 落 **6h 缺省**，注册表声明的 **24h**（教学定位）静默失效。
 * 单源仍是注册表——provider/in-service 侧一律委托 `hintTtlOf`，不在 profile 里写死数字。
 */
export const BOARD_HINT_PROFILE: HintEmitProfile<BoardHintCode> = {
  resolveMessage: (candidate: HintCandidate<BoardHintCode>) =>
    candidate.message ?? BOARD_HINT_MESSAGES[candidate.code],
  familyOf: () => 'read',
  // 去重窗口长度单源 = 注册表（本 code 声明 24h）；缺本钩子 ⇒ 静默落 6h 缺省
  ttlOf: (code) => hintTtlOf(code),
};

/**
 * 构造 digest 截断候选（**纯函数**，零 IO、永不抛）。
 *
 * `data` 四字段是消费方的结构化出口（**不要解析 message**）：
 * `{ section, returnedCount, totalCount, suggestedTool, suggestedParams }`。
 *
 * @param boardId 看板 ID（**去重资源键** = boardId：同一看板 24h 内提醒一次；
 *   也是为什么 controller 必须把 actorId 透传下 service——否则去重键退化成全局 'system'）
 * @param section 被截断的段
 * @param returnedCount 该段**实际返回**的条目数
 * @param totalCount 该段**全量**条目数（`suggestedParams` 给它的目的是「一次拉全」）
 */
export function buildBoardDigestTruncatedHint(
  boardId: string,
  section: BoardDigestTruncatedSection,
  returnedCount: number,
  totalCount: number,
): HintCandidate<BoardHintCode> {
  const limitParam = BOARD_DIGEST_SECTION_LIMIT_PARAM[section];
  return makeHintCandidate(BOARD_HINT.DIGEST_TRUNCATED, 'suggestion', boardId, {
    section,
    returnedCount,
    totalCount,
    suggestedTool: 'get_board_digest',
    suggestedParams: { [limitParam]: totalCount },
  });
}
