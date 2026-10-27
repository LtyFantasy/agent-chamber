/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 空间词表与 hint 开关（`doc_spaces.settings` 的 docTypes / canonicalTags /
 *     pathTypes / hintToggles 四键）的**读侧形状解析单源**：把可能被直改库 / bundle
 *     回导 / 历史版本写坏的 jsonb 值收敛为「可安全消费」的形态。
 *
 * [代码职责]
 *   - 四个纯函数解析器（无 IO、无副作用）：非数组/非 object → null（= 无该族词表 /
 *     全关）；数组内**逐元素**校验形状，异形元素剔除；剔除后无有效元素 → null。
 *     `null` 是唯一的「无词表 / 全关」信号——消费方据此整段省略状态/短路归一。
 *   - 两个存量治理纯函数（3 期，v1.92.0-dev）：`applyTagRenameToVocabulary`（rename/
 *     merge 的词表 alias 声明变换，含创建/合并 canonical/alias 迁移/幂等重入）与
 *     `expandTagQueryValues`（读侧 alias 兼容的集合展开——返回 `[canonical, ...aliases]`，
 *     未命中原样单元素）。同为无 IO、永不抛的纯函数。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16.4（空间词表三字段语义/校验 +
 *     hintToggles 六族开关）
 *   - 补充: 线上 docs/spec.md §4.1a「空间词表类型」（DocSpaceCanonicalTag /
 *     DocSpacePathType / DocSpaceHintToggles）
 *
 * [关键不变量]
 *   - **返回 null ⟺ 该族无有效配置**：空数组与「全元素异形」都归 null，消费方
 *     不必区分「没配」与「配了但全脏」（两者行为一致 = 零归一 / 状态省略 / 族关）；
 *   - 解析器**永不抛**（脏数据是 jsonb 现实，抛 = 整个 facets/upsert 读面 500）；
 *   - `aliases` **缺省 = 合法空表**（v1.92.0-dev 起 aliases 可选，契约见 DTO 与
 *     shared 类型）；`aliases` **存在但形状非法**（非数组 / 含非字符串）→ 整条剔除
 *     （无法判断该别名集合的意图，宁可丢弃也不猜）；
 *   - 解析器不做 trim / 大小写归一（那是写侧 `validateVocabulary` 与匹配侧
 *     `resolveTags` 的职责）——这里只做形状闸门，避免两处语义分叉。
 *   - `parseHintToggles` **只认 boolean**：非 boolean 值剔除、未知族键剔除、全剔除
 *     → null（= 全关）——族开关是稀疏触发的闸门，任何「真值化」猜测都会让 hint
 *     在未开启的空间意外出现。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc.service.ts — getSpaceWriteContext（四键的
 *     唯一解析入口：词表 + hint 族闸门 + pathTypes，一次 settings 读供写路径复用）与
 *     findFacets（状态/回显读侧）
 *   - apps/backend/src/modules/docspace/doc-bundle.service.ts — overwriteSpaceMeta
 *     （唯一绕过 DTO 的 settings 写口）用同一解析器过滤四键，脏键剔除 + warn
 *   - apps/backend/src/modules/docspace/docspace.service.ts — validateVocabulary
 *     （**写侧**校验，非本文件职责；DTO 已保证形状）
 *
 * [持久踩坑]
 *   - VOCAB-SHAPE-1（jsonb 脏形状）：只挡「非数组」不挡元素形状时，`["openviking"]`
 *     这类字符串数组会让 `entry.value.toLowerCase()` 抛 TypeError，把 facets 读面与
 *     **所有带 tags 的 upsert/patchMetadata** 一起打成 500；`{aliases:"NPC"}` 则让
 *     aliases 被逐字符迭代，tag `"n"` 被静默归一成 `"npc"`。安全方向：元素级形状闸门
 *     收口在本文件，消费方一律先过解析器。详情：Board 任务 4bb77ff8 code-review F1
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import type {
  DocSpaceCanonicalTag,
  DocSpaceHintToggles,
  DocSpacePathType,
} from '@agent-chamber/shared';
import { DOC_HINT_FAMILIES, DOC_SPACE_TAG_ALIASES_MAX } from '@agent-chamber/shared';

/**
 * 解析 `settings.canonicalTags` 为可安全消费的词表。
 *
 * 元素形状要求：`{ value: string(非空非全空白), aliases?: string[] }`；
 * `aliases` 缺省视为 `[]`（可选字段），存在但非字符串数组 → 整条剔除。
 *
 * @param raw settings 里的原始值（类型 unknown——jsonb 现实）
 * @returns 有效条目数组；非数组 / 无有效元素 → null（= 无词表）
 */
export function parseCanonicalTags(raw: unknown): DocSpaceCanonicalTag[] | null {
  if (!Array.isArray(raw)) return null;

  const out: DocSpaceCanonicalTag[] = [];
  for (const element of raw) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const candidate = element as { value?: unknown; aliases?: unknown };
    if (typeof candidate.value !== 'string' || candidate.value.trim() === '') continue;

    let aliases: string[] = [];
    if (candidate.aliases !== undefined) {
      // 存在即须为纯字符串数组（含非字符串 = 形状非法，整条剔除——见 [关键不变量]）
      if (
        !Array.isArray(candidate.aliases) ||
        candidate.aliases.some((alias) => typeof alias !== 'string')
      ) {
        continue;
      }
      aliases = candidate.aliases as string[];
    }

    out.push({ value: candidate.value, aliases });
  }

  return out.length > 0 ? out : null;
}

/**
 * 解析字符串列表型词表键（`settings.docTypes`）。
 *
 * @param raw settings 里的原始值
 * @returns 有效字符串数组（仅保留非空非全空白项）；非数组 / 无有效元素 → null
 */
export function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;

  const out: string[] = [];
  for (const element of raw) {
    if (typeof element !== 'string' || element.trim() === '') continue;
    out.push(element);
  }

  return out.length > 0 ? out : null;
}

/**
 * 解析 `settings.pathTypes` 为可安全消费的声明。
 *
 * 元素形状要求：`{ pathPrefix: string(非空非全空白), docType: string(非空非全空白) }`。
 *
 * @param raw settings 里的原始值
 * @returns 有效条目数组；非数组 / 无有效元素 → null
 */
export function parsePathTypes(raw: unknown): DocSpacePathType[] | null {
  if (!Array.isArray(raw)) return null;

  const out: DocSpacePathType[] = [];
  for (const element of raw) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const candidate = element as { pathPrefix?: unknown; docType?: unknown };
    if (typeof candidate.pathPrefix !== 'string' || candidate.pathPrefix.trim() === '') continue;
    if (typeof candidate.docType !== 'string' || candidate.docType.trim() === '') continue;
    out.push({ pathPrefix: candidate.pathPrefix, docType: candidate.docType });
  }

  return out.length > 0 ? out : null;
}

/**
 * 解析 `settings.hintToggles` 为可安全消费的族开关 map（v1.92.0-dev 2 期）。
 *
 * 形状闸门（D1 定形）：非 object（含数组/null/标量）→ null；**未知族键剔除**；
 * **非 boolean 值剔除**；全剔除 → null。返回的 map 里出现的键恒为 `true | false`
 * ——消费方一律用 `toggles?.<family> === true` 判定（`null` 与缺键同为「关」）。
 *
 * @param raw settings 里的原始值（类型 unknown——jsonb 现实）
 * @returns 有效族开关 map；非 object / 无任何合法族键 → null（= 全关）
 */
export function parseHintToggles(raw: unknown): DocSpaceHintToggles | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const out: DocSpaceHintToggles = {};
  let any = false;
  for (const family of DOC_HINT_FAMILIES) {
    const value = source[family];
    if (typeof value !== 'boolean') continue;
    out[family] = value;
    any = true;
  }

  return any ? out : null;
}

// ─── 存量治理纯函数（DocSpace 元数据治理 3 期，v1.92.0-dev）─────────────────
//
// 两个纯函数（无 IO、无副作用、永不抛）：
// - applyTagRenameToVocabulary：rename/merge 执行时的词表 alias 声明变换（plan D6）；
// - expandTagQueryValues：读侧 alias 兼容的**集合展开**语义（plan D3/A1）。
// 二者与上方解析器的分工：解析器做「形状闸门」（脏 jsonb → null），这里做「语义变换」。

/**
 * tag rename/merge 的 `from` 归一（**单源**：`applyTagRenameToVocabulary` 与
 * `DocRenameService.renameTags` 的受影响集口径共用，禁各自实现）。
 *
 * 语义：逐值 trim → 去空 → 剔除**字节全等** `to` 的自映射值（canonical 自身已在展开集内，
 * 无可替换对象）→ **字节精确去重**（保序）。
 *
 * ⚠️ **不做 ci 合并**（评审 M1）：`['npc','NpC','NPC']` 是三个**不同的存量存储值**，
 * 必须全部保留——它们都要进 `array_replace` 的匹配集合与词表 aliases。ci 合并会让第 3+
 * 个字节变体既不被改写、也不进 aliases ⇒ 读侧集合展开漏召回（A1 同一失败模式）。
 * ci 变体之间的去重只在**写入端词表**由写侧 `validateVocabulary` 把关，不在读取端合并。
 *
 * @param from 调用方原始 from 数组
 * @param to 目标值
 * @returns 归一后的 from 值（保序、字节精确去重；可能为空数组 = 无可替换值）
 */
export function normalizeTagRenameValues(from: string[], to: string): string[] {
  const toValue = to.trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of from) {
    const value = raw.trim();
    if (value === '') continue;
    // 字节全等于 to 的自映射值无替换对象（注意：**不**按 ci 剔除——`to='npc'` 时
    // `from='NPC'` 必须保留，那是存量存储形态）
    if (value === toValue) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** `applyTagRenameToVocabulary` 的返回（词表变换产物 + 变更报告） */
export interface TagRenameVocabularyOutcome {
  /** 变换后的 canonicalTags；空间原本无词表时 = 新建的单条词表 */
  next: DocSpaceCanonicalTag[];
  /** true = 空间原本未声明 canonicalTags（null/空），本次**创建**了词表键 */
  created: boolean;
  /** 新加入 `to` 条目的 alias 值（**含** movedAliases 的迁移项，按加入顺序） */
  addedAliases: string[];
  /** 被删除的 canonical 条目值（from 中本身是 canonical 的——merge 两个 canonical 的形态） */
  removedCanonicals: string[];
  /** alias 归属迁移（原属其他 canonical 的 alias 被摘除并转入 to） */
  movedAliases: Array<{ alias: string; fromCanonical: string; toCanonical: string }>;
  /**
   * 因触达 `DOC_SPACE_TAG_ALIASES_MAX` 上限而被裁掉的值（minor-1；恒存在，未裁剪 = 空数组）。
   * 调用方据此透明告知用户，不静默丢别名。
   */
  truncatedAliases: string[];
}

/**
 * 把 tag rename/merge（`from[] → to`）应用到空间词表，产出新的 canonicalTags 声明。
 *
 * 语义（plan D6，**无条件生成 alias**——词表未声明不跳过，而是创建词表键；理由：
 * tags 族 hint 闸门 = `hintToggles.tags === true` 显式 opt-in，词表键的存在不激活任何
 * hint，故「未声明则跳过」只会让首批客户场景断裂）：
 * - 词表为 null/空 → 创建 `[{value: to, aliases: [...from]}]`（`created=true`）；
 * - `to` 不在词表（ci）→ 追加 `{value: to, aliases: []}`（rename 目标成为 canonical）；
 * - `from` 中某值本身是 canonical 条目 → **删除该条目**，其 aliases 并入 to，f 自身
 *   也进 to.aliases（merge 两个 canonical 的形态，绕过写侧 `validateVocabulary` 对
 *   「alias 撞其他 canonical」的 422——变换语义本身保证产物合法）；
 * - `from` 中某值是其他 canonical g 的 alias → 从 g.aliases 摘除、加入 to.aliases
 *   （记入 `movedAliases` 报告归属迁移）；
 * - `from` 中某值不在词表 → 直接加入 to.aliases；
 * - **字节形态与 `to` 不同的 from 值一律保留为 alias（含 ci 等价者，且 ci 变体之间不合并）**
 *   ——这是 A1 的核心：存量文档按**精确字符串**存 tag，rename 前写入的 `NPC` / `NpC`
 *   不会被 canonical `npc` 命中，必须逐个留在 aliases 里供读侧集合展开（验收清单亦要求
 *   「词表 aliases 含旧值」）。仅**字节全等** `to` 的自映射值跳过（canonical 自身已在
 *   展开集内，加 alias 无意义）。
 *
 * ⚠️ 与 plan D6 字面「ci 等价于 `to` 的跳过」的差异（**有意，勿当 bug 改回**）：字面
 * 按 ci 跳过会与同一 bullet 的创建分支 `aliases: [...from]` 自相矛盾，且直接击穿
 * 首批 fixture（Wayward `npc`/`NPC` 61/11——11 篇存量存的是 `NPC`）与验收清单
 * 「词表 aliases 含旧值」，构成 A1 明令防止的召回回退。故取「字节等价跳过」。
 *
 * **幂等重入**：同一 rename 跑两遍，第二遍 `addedAliases/removedCanonicals/movedAliases`
 * 全空（已是 `to` 条目 alias 的值不再迁移、不重复加入）。
 *
 * **别名上限（minor-1）**：`to` 条目的 aliases 最终裁剪到 `DOC_SPACE_TAG_ALIASES_MAX`
 * ——保「先旧后新、截断溢出」，被裁值进 `truncatedAliases`（透明不静默）。理由：别名是
 * **召回兼容层**，溢出场景 = 极端反复 rename 累积；而超限的 canonicalTags 会让该空间的
 * `PATCH /doc-spaces/:id` 直接 422（`@ArrayMaxSize` 校验）——**编辑面锁死**比丢几个尾部
 * 别名糟得多。且被裁的形态对应的存量文档本次已被改写成 canonical（SQL 改写与词表无关），
 * 故当前数据零召回损失；损失面仅限「未来再用该旧形态查询」。
 *
 * @param vocabulary 空间声明的 canonicalTags（null/空 = 无词表，将被创建）
 * @param from 待替换的旧值数组（调用方已 trim；本函数再做一次**字节精确**去重）
 * @param to 目标值（trim 后成为 canonical 声明值）
 * @returns 变换产物 + 变更报告（见 TagRenameVocabularyOutcome）
 */
export function applyTagRenameToVocabulary(
  vocabulary: DocSpaceCanonicalTag[] | null | undefined,
  from: string[],
  to: string,
): TagRenameVocabularyOutcome {
  const toValue = to.trim();
  const toKey = toValue.toLowerCase();

  // from 归一（单源 = normalizeTagRenameValues，与 DocRenameService 的受影响集口径同一）
  const fromValues = normalizeTagRenameValues(from, toValue);

  const created = !vocabulary || vocabulary.length === 0;

  // 可变副本（保序；value/aliases trim，防御直改库/历史脏值）
  // 局部类型 aliases 必填——变换过程中恒持有数组，避免每处 `?? []` 噪音
  const entries: Array<{ value: string; aliases: string[] }> = (vocabulary ?? [])
    .filter((entry) => entry && typeof entry.value === 'string' && entry.value.trim() !== '')
    .map((entry) => ({
      value: entry.value.trim(),
      aliases: (entry.aliases ?? [])
        .filter((alias) => typeof alias === 'string' && alias.trim() !== '')
        .map((alias) => alias.trim()),
    }));

  const addedAliases: string[] = [];
  const removedCanonicals: string[] = [];
  const movedAliases: TagRenameVocabularyOutcome['movedAliases'] = [];
  /** 待并入 to.aliases 的值（顺序 = from 出现顺序：canonical 条目先并入自身与其 aliases） */
  const pendingAliases: string[] = [];

  for (const display of fromValues) {
    const key = display.toLowerCase();
    // ① from 命中某 canonical 条目（ci）
    const canonicalIndex = entries.findIndex((e) => e.value.toLowerCase() === key);
    if (canonicalIndex >= 0) {
      const entry = entries[canonicalIndex];
      if (entry.value === toValue) {
        // 就是 `to` 条目自身（字节全等）→ 不删除、不迁移；仅当 from 的字节形态不同
        // （如 to='npc'、from='NPC'）时保留为存量变体 alias——读侧集合展开需要它命中
        // rename 前写入的旧形态（A1：存量文档按精确字符串存 tag）
        if (display !== toValue) pendingAliases.push(display);
        continue;
      }
      // 字节形态不同的同 ci canonical（merge 两个 canonical 的形态）→ 删除条目，
      // 条目值 + 其 aliases 全部并入 to
      const [removed] = entries.splice(canonicalIndex, 1);
      removedCanonicals.push(removed.value);
      pendingAliases.push(removed.value, ...removed.aliases);
      continue;
    }

    // ② from 是某条目的 alias → 摘除；归属 `to` 条目时视为已就位（幂等重入的关键分支）
    let handled = false;
    for (const entry of entries) {
      const aliasIndex = entry.aliases.findIndex((a) => a.toLowerCase() === key);
      if (aliasIndex < 0) continue;
      handled = true;
      // 已经是 `to` 的 alias → 无变化（不摘除、不重复加入、不报迁移）
      if (entry.value.toLowerCase() === toKey) break;
      const [alias] = entry.aliases.splice(aliasIndex, 1);
      movedAliases.push({ alias, fromCanonical: entry.value, toCanonical: toValue });
      pendingAliases.push(alias);
      break;
    }
    // ③ from 不在词表 → 直接并入 to.aliases（字节全等于 to 的自映射跳过）
    if (!handled && display !== toValue) pendingAliases.push(display);
  }

  // 确保 `to` 条目存在（不存在则追加——rename 目标成为 canonical）
  let toIndex = entries.findIndex((e) => e.value.toLowerCase() === toKey);
  if (toIndex < 0) {
    entries.push({ value: toValue, aliases: [] });
    toIndex = entries.length - 1;
  }
  const toEntry = entries[toIndex];

  // 并入 pending：**字节精确**去重、跳过字节全等 to 的自映射、跳过 ci 撞其他 canonical 的值
  // ⚠️ 去重必须字节精确（评审 M1）：`NPC` 与 `NpC` 是两个不同的存量存储值，ci 去重会让
  // 后者既不进 aliases 也不被读侧展开命中（漏召回）。同条目内 ci 变体 alias 合法
  // （写侧 validateVocabulary 只对**跨条目**的 alias/canonical 冲突报 422）。
  // 「撞其他 canonical」仍用 ci 判定——那是写侧 422 红线，必须守住。
  for (const alias of pendingAliases) {
    const key = alias.toLowerCase();
    if (alias === toValue) continue;
    if (toEntry.aliases.includes(alias)) continue;
    if (entries.some((e, i) => i !== toIndex && e.value.toLowerCase() === key)) continue;
    toEntry.aliases.push(alias);
    addedAliases.push(alias);
  }

  // 别名上限裁剪（minor-1）：拼接后超 DOC_SPACE_TAG_ALIASES_MAX 截尾部——保「先旧后新」。
  // 被裁值进 truncatedAliases（透明不静默）；同时从 addedAliases 摘除（保持
  // 「addedAliases ⊆ next 里真实存在的 alias」）。理由见函数头 [别名上限] 段。
  const truncatedAliases: string[] = [];
  if (toEntry.aliases.length > DOC_SPACE_TAG_ALIASES_MAX) {
    truncatedAliases.push(...toEntry.aliases.slice(DOC_SPACE_TAG_ALIASES_MAX));
    toEntry.aliases = toEntry.aliases.slice(0, DOC_SPACE_TAG_ALIASES_MAX);
    for (const dropped of truncatedAliases) {
      const addedIndex = addedAliases.indexOf(dropped);
      if (addedIndex >= 0) addedAliases.splice(addedIndex, 1);
    }
  }

  return {
    next: entries,
    created,
    addedAliases,
    removedCanonicals,
    movedAliases,
    truncatedAliases,
  };
}

/**
 * 读侧 tag 查询的 alias **集合展开**（plan D3/A1）。
 *
 * 语义（不是单值映射——单值映射会漏掉 rename 前写入的存量旧值文档，造成召回回退）：
 * - `queryValue` ci 命中某条 canonical 或某条 alias → 返回**该条目全集**
 *   `[canonical, ...aliases]`（按精确字符串去重，canonical 恒在首位）；
 * - 未命中（或词表为 null/空）→ 返回 `[queryValue]` 原样单元素。
 *
 * SQL 消费方据此把单值 `:tag = ANY(d.tags)` 改为多值重叠 `d.tags && :tagValues`
 * （语义 = 交集非空）；未命中词表时单元素入参使行为**逐字节不变**。
 *
 * @param vocabulary 空间声明的 canonicalTags（null/空 = 无词表，原样返回）
 * @param queryValue 调用方传入的 tag 查询值
 * @returns 展开后的查询值集合（恒非空；首元素 = canonical 或原值）
 */
export function expandTagQueryValues(
  vocabulary: DocSpaceCanonicalTag[] | null | undefined,
  queryValue: string,
): string[] {
  if (!vocabulary || vocabulary.length === 0) return [queryValue];

  const key = queryValue.trim().toLowerCase();
  for (const entry of vocabulary) {
    const canonicalKey = entry.value.toLowerCase();
    const aliases = entry.aliases ?? [];
    if (canonicalKey !== key && !aliases.some((alias) => alias.toLowerCase() === key)) continue;

    // 命中：返回全集（canonical 首位 + aliases 保序）；按**精确字符串**去重——
    // 展开集直接喂 SQL `d.tags && :tagValues`（精确重叠），ci 去重会把 `NPC` 这类
    // 存量变体错误地并进 `npc` 而漏召回（A1）
    const out: string[] = [entry.value];
    const seen = new Set<string>([entry.value]);
    for (const alias of aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
    return out;
  }

  return [queryValue];
}
