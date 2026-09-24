/**
 * 经验库（Experience Base）web 侧共享工具
 *
 * 三块内容，全部是「web 与后端契约的翻译层」，不含任何 UI：
 * 1. **数量/长度常量镜像**：signals/domains 上限与元素长度、env 值长度、sourceProject
 *    长度、分页上限。这些常量后端落在 `modules/experience/experience.constants.ts`
 *    （web 不能 import backend 包），故此处镜像一份——**改任一侧必须同步另一侧**，
 *    否则前端放行的输入会被后端 400（铁律 #21 双层校验的必然代价）。
 *    列宽类常量（title/summary/content）不镜像：shared 已单源，直接 import。
 * 2. **数组参数序列化**（`serializeRepeatedParams`）：后端数组参数契约 = **重复 query
 *    键**（`?signals=a&signals=b`，plan §2）。axios 默认产出方括号形态 `signals[]=`
 *    会被后端 `assertNoBracketedArrayQuery` 明确 400，故列表/分面请求必须显式传本
 *    序列化器（与 platform-mcp `platform-client.ts:124` 同语义，两处各自实现——web
 *    不能依赖 MCP 包）。
 * 3. **展示值域映射**：quality/intent → Badge variant，env 键固定顺序。
 */
import {
  EXPERIENCE_ENV_KEYS,
  EXPERIENCE_QUALITIES,
  type ExperienceEnv,
  type ExperienceIntent,
  type ExperienceQuality,
  type ExperienceSort,
} from '@agent-chamber/shared';

// ─── 常量镜像（后端 experience.constants.ts 单源的 web 副本）──

/**
 * 列表查询串长度上限（backend `EXPERIENCE_QUERY_MAX_LENGTH`）
 *
 * 用途：搜索框 `maxLength` + 提交前本地拦截，避免"超长 q 打到后端才 400"。
 */
export const EXPERIENCE_QUERY_MAX_LENGTH = 200;

/** 单条经验的 signals 元素上限（数组元素数；backend `EXPERIENCE_MAX_SIGNALS`） */
export const EXPERIENCE_MAX_SIGNALS = 20;

/** 单条经验的 domains 元素上限（backend `EXPERIENCE_MAX_DOMAINS`） */
export const EXPERIENCE_MAX_DOMAINS = 20;

/**
 * signals/domains 单个元素长度上限（backend `EXPERIENCE_ELEMENT_MAX_LENGTH`）
 *
 * 语义提醒：元素是**一个区分性关键词**（`ECONNREFUSED`），不是整句报错。
 */
export const EXPERIENCE_ELEMENT_MAX_LENGTH = 50;

/** env 值长度上限（backend `EXPERIENCE_ENV_VALUE_MAX_LENGTH`） */
export const EXPERIENCE_ENV_VALUE_MAX_LENGTH = 100;

/** sourceProject 长度上限（backend `EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH`） */
export const EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH = 128;

/** 列表默认每页条数（backend `EXPERIENCE_DEFAULT_PAGE_SIZE`） */
export const EXPERIENCE_DEFAULT_PAGE_SIZE = 20;

/** 列表每页条数上限（backend `EXPERIENCE_MAX_PAGE_SIZE`） */
export const EXPERIENCE_MAX_PAGE_SIZE = 100;

/**
 * facets `byCreator` 的 top-N 上限（backend `EXPERIENCE_BY_CREATOR_LIMIT`）
 *
 * 用途：截断提示文案里的数字（"仅列出前 N 位录入者"）。**必须镜像**——文案写死数字
 * 会与服务端常量漂移（改一侧漏另一侧 = 界面撒谎），故数字只从这里取。
 */
export const EXPERIENCE_BY_CREATOR_LIMIT = 20;

/**
 * 搜索框防抖窗口（ms）
 *
 * rationale：与仓内全局搜索页同一取值（300ms）——用户停止输入即触发，避免逐字符
 * 打后端（每次列表查询都会带融合打分 + 分面聚合）。仓内无共享 debounce hook，
 * 统一用 `useRef + setTimeout` 写法（search 页先例），本常量是唯一取值单源。
 */
export const EXPERIENCE_SEARCH_DEBOUNCE_MS = 300;

/** env 四键的固定渲染顺序（os → tool → version → runtime；取自 shared 键白名单，禁手抄） */
export const EXPERIENCE_ENV_KEY_ORDER = EXPERIENCE_ENV_KEYS;

/** quality 全部取值（Badge 渲染分支完备性用；shared 单源） */
export const EXPERIENCE_QUALITY_VALUES = EXPERIENCE_QUALITIES;

// ─── 列表过滤参数 ────────────────────────────────────────

/**
 * 列表页过滤态（同时是 react-query 的 queryKey 片段）
 *
 * 空串语义：`intent`/`quality` 的 UI「全部」选项用空串表示不传（不用 undefined——
 * 受控 `<select>` 的值域里空串是稳定值，undefined 会让 React 在受控/非受控间跳变）。
 * `buildExperienceQueryParams` 负责把空串转成"不发送该参数"。
 */
export interface ExperienceListFilters {
  /** 全文查询串（既有过滤也有排序语义；存在时后端忽略 sort） */
  q?: string;
  /** 症状信号（ANY-overlap：多个 signal 是扩大而非缩小结果集） */
  signals?: string[];
  /** 领域标签（ANY-overlap，开放式词表） */
  domains?: string[];
  /** 类型过滤（空串 = 全部） */
  intent?: ExperienceIntent | '';
  /** 质量过滤（空串 = 全部；显式 suspect 才会放开后端的 suspect 排除） */
  quality?: ExperienceQuality | '';
  /**
   * 录入者过滤（空串 = 全部）。
   *
   * 取值是 **actor UUID**（来自条目投影的 `createdById` 或 facets `byCreator` 元素的
   * 同名字段）——**名字不能当筛选值**：后端是精确相等匹配，传显示名恒零命中。
   * v1.81.0 新增（`?createdById=`），与"按 creator 预筛自审队列"无关（四态已退役）。
   */
  createdById?: string;
  /** 排序模式（无 q 时生效：recent 缺省 / most_used） */
  sort?: ExperienceSort;
  /** 页码（1 起） */
  page?: number;
  /** 每页条数 */
  pageSize?: number;
}

/**
 * 过滤态 → 后端 query 参数对象
 *
 * 规则：
 * - `undefined` / `null` / 空串 / 空白串 → **不发送该键**（避免 `?intent=` 触发后端
 *   `@IsIn` 400：空串不是词表成员）
 * - 空数组 → 不发送（空信号列表不是过滤条件；后端对空数组同样会拒绝）
 * - 数组保持数组形态（由 `serializeRepeatedParams` 展开成重复键）
 * - `signals`/`domains` 元素先 trim + lowercase（与后端写侧/查询侧归一化对齐：
 *   不归一时用户输入的大写 token 永远匹配不上库里的归一化值）
 *
 * @param filters - UI 过滤态
 * @returns 可直接交给 axios `params` 的扁平对象（数组值展平交给序列化器）
 */
export function buildExperienceQueryParams(
  filters: ExperienceListFilters,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const trimmedQ = filters.q?.trim();
  if (trimmedQ) params.q = trimmedQ;

  const signals = normalizeElements(filters.signals);
  if (signals.length > 0) params.signals = signals;

  const domains = normalizeElements(filters.domains);
  if (domains.length > 0) params.domains = domains;

  if (filters.intent) params.intent = filters.intent;
  if (filters.quality) params.quality = filters.quality;
  if (filters.createdById) params.createdById = filters.createdById;
  if (filters.sort) params.sort = filters.sort;
  if (filters.page !== undefined) params.page = filters.page;
  if (filters.pageSize !== undefined) params.pageSize = filters.pageSize;
  return params;
}

/**
 * 数组元素归一化（trim + lowercase + 去空）
 *
 * 与后端写侧归一化（plan §2）逐字对齐——查询侧不归一会让「用户输入 `ECONNREFUSED`」
 * 匹配不上库里归一化后的 `econnrefused`，且后端匹配是**精确相等**语义。
 *
 * @param values - 原始元素数组（可能含空白/大小写混杂）
 * @returns 归一化并剔除空元素后的数组（顺序保持）
 */
export function normalizeElements(values?: readonly string[]): string[] {
  if (!values) return [];
  return values.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
}

/**
 * 生成幂等键（`clientRequestId`，录入与反馈共用）
 *
 * 优先 `crypto.randomUUID()`（浏览器标准，每次调用新值——**改判必须是新键**：
 * 复用旧键会被后端判成 409/9002 重放冲突）。jsdom 等环境可能没有该 API，降级为
 * 时间戳 + 随机串拼接（进程内唯一足够；仓内 notification.store 的 toast id 同款兜底）。
 *
 * @returns 1~64 字符的幂等键（后端 DTO 长度约束内）
 */
export function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 数组参数 → **重复键** query 串（axios `paramsSerializer` 函数形态）
 *
 * axios 收到函数型 `paramsSerializer` 时原样采用返回值作为 query 串，故返回值就是
 * 最终到达后端的形态（`signals=a&signals=b`）。`undefined`/`null` 值跳过（不产出
 * `key=undefined` 噪音）；数组元素各占一个键值对；逐键逐值 `encodeURIComponent`。
 *
 * @param params - query 参数对象（数组值展开为多对同名键）
 * @returns 形如 `signals=a&signals=b&q=port%20unreachable` 的 query 串（不含 `?`）
 */
export function serializeRepeatedParams(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const encodedKey = encodeURIComponent(key);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        pairs.push(`${encodedKey}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    pairs.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
  }
  return pairs.join('&');
}

// ─── 归属人展示（v1.81.0：卡片 / 详情 / 筛选下拉**共用同一规则**）──

/**
 * 归属人展示态（`experienceActorLabel` 的返回值）
 *
 * 归属人 = 录入者（`createdBy*` 族）与终审人（`verifiedBy*` 族）——两族字段形状同构，
 * 渲染规则也同一条，故共用本类型与下方唯一的转换函数。
 */
export interface ExperienceActorLabel {
  /** 是否有可展示的归属：`id` 与 `name` **双缺失** → false，调用方整行/整项隐藏 */
  visible: boolean;
  /** 展示名（visible 时必为非空串）：真名优先（软删也保留）；真孤儿回退 id 前 8 位 */
  name: string;
  /** 完整 actor UUID（`title` 排查通道用，**不截断**）；id 缺失时为 undefined */
  title?: string;
  /** 是否软删（名字仍是真名 → 调用方加删除标记 + 灰化，**不换名字**） */
  deleted: boolean;
  /** 是否真孤儿（档案解析不到名字 → 展示的是 id 前 8 位） */
  orphan: boolean;
}

/**
 * 归属人三态 → 展示值（**唯一实现**，卡片 / 详情 / 筛选下拉都调这里，禁各写一套）
 *
 * 三态规则（后端契约见 `ExperienceCreatorFacet` 的 JSDoc，两处必须一致）：
 * 1. **活**（`name` 有值 + `deletedAt` 为空）→ 真名；头像照常；
 * 2. **软删**（`name` 有值 + `deletedAt` 非空）→ **真名照常**（历史归因不丢）+ 删除标记；
 * 3. **真孤儿**（`name` 为 null，actor 行已硬删）→ id 前 8 位，**刻意不加"未知用户"类兜底词**
 *    ——兜底词会掩盖"档案已不可解析"这一事实，截断前缀 + `title` 里的完整 UUID 才是排查通道。
 *
 * `title` 恒给完整 UUID（即便孤儿态）：这是唯一能拿回被截断身份的地方，任何态都不能丢。
 *
 * @param actor - 归属人三件套（`createdBy*` 或 `verifiedBy*`；字段名由调用方映射）
 * @returns 展示态（`visible=false` 时其余字段为占位值，调用方不应渲染）
 */
export function experienceActorLabel(actor: {
  id?: string | null;
  name?: string | null;
  deletedAt?: string | null;
}): ExperienceActorLabel {
  const id = actor.id ?? '';
  const name = actor.name ?? '';
  // 双缺失 → 整行隐藏（后端极端数据：actor 行连 id 都丢了）。不渲染空行/裸占位。
  if (!id && !name) {
    return { visible: false, name: '', deleted: false, orphan: false };
  }
  return {
    visible: true,
    name: name || id.slice(0, 8),
    title: id || undefined,
    deleted: !!actor.deletedAt,
    orphan: !name,
  };
}

// ─── 展示映射 ────────────────────────────────────────────

/** Badge 变体值域（对齐 `components/ui/badge.tsx` 的 variant 联合） */
type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'subtle';

/**
 * quality → Badge 变体
 *
 * verified = success（终审通过，检索加权）；unverified = subtle（缺省态，**中性不警示**
 * ——冷启动期绝大多数条目都是它，用警示色会让整页泛黄失去信号）；suspect = warning
 * （终审判可疑，默认从检索排除但详情可见可改回）。
 *
 * @param quality - 条目质量取值
 * @returns Badge variant（未知取值回落 subtle，不抛错——展示层不该因数据面新值崩页）
 */
export function experienceQualityBadgeVariant(quality: ExperienceQuality): BadgeVariant {
  switch (quality) {
    case 'verified':
      return 'success';
    case 'suspect':
      return 'warning';
    default:
      return 'subtle';
  }
}

/**
 * intent → Badge 变体
 *
 * 类型是**中性分类**而非可信度信号，一律 outline（不抢 quality Badge 的视觉权重）。
 *
 * @param _intent - 条目类型（当前不分支，保留入参以便未来按类型细分色调）
 * @returns Badge variant
 */
export function experienceIntentBadgeVariant(_intent: ExperienceIntent): BadgeVariant {
  return 'outline';
}

/**
 * env 指纹 → 固定顺序的 `键: 值` 展示行
 *
 * 只渲染**有值**的键（env 全部键可选）；顺序取 `EXPERIENCE_ENV_KEYS`（写入侧白名单
 * 单源），不按对象 key 的插入顺序——否则同一份 env 在不同条目上渲染顺序不一致。
 *
 * @param env - 环境指纹对象（可能为缺省空对象）
 * @returns `[{ key, value }]`（仅含有非空值的键，顺序 = 白名单顺序）
 */
export function experienceEnvRows(
  env: ExperienceEnv | undefined,
): { key: string; value: string }[] {
  if (!env) return [];
  const rows: { key: string; value: string }[] = [];
  for (const key of EXPERIENCE_ENV_KEY_ORDER) {
    const value = env[key];
    if (value && value.trim().length > 0) rows.push({ key, value });
  }
  return rows;
}

// ─── 录入/编辑表单辅助 ───────────────────────────────────

/**
 * 四节正文模板（markdown 骨架）
 *
 * rationale：后端在缺「验证方式」节时只软告警不拒绝（`experience.constants.ts` 的
 * `EXPERIENCE_VERIFICATION_SECTION_PATTERN` 同时认 `how verified` 与 `验证`）——
 * 模板按当前语言生成对应节名，两种语言都能过该模式，避免"录完立即收一条无意义告警"。
 *
 * @param sections - 四节标题（由 i18n 提供，保证与界面语言一致）
 * @returns 预填进 content 编辑框的 markdown 骨架
 */
export function buildExperienceContentTemplate(sections: {
  symptom: string;
  rootCause: string;
  fix: string;
  howVerified: string;
}): string {
  return [
    `## ${sections.symptom}`,
    '',
    '',
    `## ${sections.rootCause}`,
    '',
    '',
    `## ${sections.fix}`,
    '',
    '',
    `## ${sections.howVerified}`,
    '',
    '',
  ].join('\n');
}

/** chip 输入校验失败原因（组件据此选 i18n 文案） */
export type ExperienceChipError = 'empty' | 'too_long' | 'comma' | 'too_many';

/**
 * chip 输入校验（signals / domains 共用）
 *
 * 三条与后端逐字对齐的规则（DTO 层校验，plan §2/§3）：
 * - 元素 ≤50 字符
 * - **元素内不得含逗号**——逗号是"一句话塞多个症状"的典型征兆，后端 400 并提示
 *   "one element per symptom"；前端提前拦下给出可操作提示
 * - 数组元素数 ≤20
 *
 * @param raw - 用户输入的原始文本（未 trim）
 * @param existing - 当前已存在的元素列表（含重复判定基准）
 * @param max - 元素数上限（signals/domains 不同上限，由调用方传入本文件常量）
 * @returns 失败原因；通过则 null（重复元素视为通过，由调用方去重）
 */
export function validateExperienceChip(
  raw: string,
  existing: readonly string[],
  max: number,
): ExperienceChipError | null {
  const value = raw.trim();
  if (value.length === 0) return 'empty';
  if (value.includes(',')) return 'comma';
  if (value.length > EXPERIENCE_ELEMENT_MAX_LENGTH) return 'too_long';
  if (!existing.includes(value.toLowerCase()) && existing.length >= max) return 'too_many';
  return null;
}

/**
 * 派生分页派生量（后端列表信封只给 items/total/page/pageSize）
 *
 * @param total - 满足过滤条件的总条数
 * @param page - 当前页（1 起）
 * @param pageSize - 每页条数
 * @returns totalPages（至少 1）/ hasPrev / hasNext
 */
export function experiencePagination(
  total: number,
  page: number,
  pageSize: number,
): { totalPages: number; hasPrev: boolean; hasNext: boolean } {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return { totalPages, hasPrev: page > 1, hasNext: page < totalPages };
}
