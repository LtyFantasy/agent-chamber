/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Formation content 的**装配与截断**（方案 §4）：把主张三要素 + 理由 + 来源摘录
 *     拼成一段可重放的正文，并在超限时**只截摘录区**
 *
 * [代码职责]
 *   - `assembleFormationContent`：装配（纯函数，无 IO——来源摘录由调用方回取后传入）
 *   - `truncateUtf8Bytes` / `utf8ByteLength`：**按 UTF-8 字节**截断（不按字符；中文一字 3 字节）
 *   - `buildSourceLocator`：`chamber://<type>/<id>[#h<hash12>]` 的**唯一**产出点
 *   - `EXCERPT_AREA_PREFIX`：摘录区锚点的**唯一**字面量（写侧装配与读侧抽摘要共用）
 *   - `extractContentExcerpt`：**读面**从形成正文反抽摘要（`contentExcerpt` 的唯一产出点）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §4 Formation content 装配契约
 *     （模板 / 截断不变式 / locator 形态）+ §6 端点面（`contentTruncated` 透出）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **截断只作用于摘录区**：三要素（category/subject/scope）与 rationale **永不截**
 *     （§4 截断不变式）。理由：它们决定"这条主张是什么、适用范围到哪"——截掉主张本身
 *     等于形成一条语义残缺的记忆，而摘录只是佐证（佐证不全可以接受，主张残缺不可以）。
 *   - **超限处理分两条路**：固定区超限 ⇒ `overflow: true`（调用方 400，**不静默截主张**）；
 *     摘录区超限 ⇒ 截 + `[truncated]` 标记 + `truncated: true`。
 *   - **截断按 UTF-8 字节且不切开代理对**：`slice` 在码元上切会把 emoji/生僻字切成
 *     半个字符（存进 text 列后是 U+FFFD），故截断后要回退到"最后一个完整码点"。
 *   - **`[truncated]` 标记是契约不是装饰**（P8）：消费方要能看出"这条摘录不全"，
 *     否则会把不完整的佐证当成完整依据引用（且标记本身要占预算，先扣再填）。
 *   - **`sourceRefs` 的摘录来自**服务端实取**的冻结快照**：本函数只负责拼装，
 *     不查库、不补摘录——"边拼边查库"会让同一段正文在不同时刻拼出不同结果，
 *     而重放（retry/recover）用的是**冻结原文**（`findForReplay`），两者一旦分叉，
 *     重放就会把"另一版正文"发给引擎。
 *   - **读面摘要与写侧模板共用同一个锚点常量**（`EXCERPT_AREA_PREFIX`，见二期 D1①）：
 *     任何第二处 `'关键依据摘录:'` 字面量都会在模板微调时**静默**切错位置。
 *   - **`content` 有两条一等公民写路径**：服务端装配（§4 模板）与 `contentOverride`
 *     （**客户端自由正文：无模板头、无锚点**）。任何"按固定行数/固定位置切一刀"的读法都会在
 *     自由正文上**静默丢数据**（单行正文被吞成空摘要、多行丢前两行）——`extractContentExcerpt`
 *     的退化分支因此**按形状**判定头部（`withoutTemplateHead`），不是按行数。
 *   - **`extractContentExcerpt` 只读 `content` 字符串**：它不读也不写 `contentTruncated`
 *     （展示层截断 ≠ 形成时截断），也不查库（摘要只是正文的一个投影）。
 *
 * [关联代码]
 *   - ../memory-formation.service.ts — 回取来源 + 冻结 + 调用本函数 + 落库；
 *     列表/详情投影调用 `extractContentExcerpt` 产出 `contentExcerpt`
 *   - ../memory.constants.ts — `MEMORY_CONTENT_MAX_BYTES` / `MEMORY_CONTENT_EXCERPT_MAX_CHARS` /
 *     三要素与理由的字节闸门
 *   - ../ledger.repository.ts — 重放的冻结原文来源（**永不重装配**）
 *   - database/entities/memory-nomination.entity.ts — `MemorySourceRef`（冻结字段的形状）
 *
 * [修改检查]
 *   □ 已读 [权威文档] §4，改模板必须同步 e2e 的装配断言（三要素保全 / 截断标记）
 *   □ 改 locator 形态必须同步来源回取与前端/消费方解析（形态是公开契约）
 *   □ 改模板行序/行数必须同步 `TEMPLATE_HEAD_ROW_ONE` / `TEMPLATE_HEAD_ROW_TWO`
 *     （退化抽取的形状判定守卫用例会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MEMORY_SOURCE_REF_TYPE } from '@agent-chamber/shared';
import type { MemorySourceRef } from '../../database/entities/memory-nomination.entity';
import {
  MEMORY_CONTENT_EXCERPT_MAX_CHARS,
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_EXCERPT_TRUNCATION_MARKER,
  MEMORY_TRUNCATION_RESERVE_BYTES,
} from './memory.constants';

/** UTF-8 字节长度（Node 侧 `Buffer.byteLength` 比手写循环快且不会算错代理对） */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 摘录区的前缀行（§4 模板里的"关键依据摘录:"，后随换行）。
 *
 * 抽成常量是为了**一个地方**算字节：它的字符长度 8 而字节长度 20，预算计算里少扣一次
 * 就会让截断后的正文超出闸门（见 `excerptBudget` 的注释）。
 *
 * ⚠️ **必须导出**（Memory web 二期 D1①）：读面的 `extractContentExcerpt` 要按**同一个**锚点
 * 把摘录区切出来——第二处字面量 = 模板一改就静默切错位置（消费方拿到整段固定区或空串，
 * 且没有任何测试会红）。本常量是**唯一**产出点。
 */
export const EXCERPT_AREA_PREFIX = '关键依据摘录:\n';

/**
 * 模板头**第 1 行**的形状：`[category] subject`（`fixedLines()` 的写法）。
 *
 * ⚠️ 与 `fixedLines()` 耦合：它写的头两行就是下面 `withoutTemplateHead()` 要认的那两行；
 * 改模板头两行的形态必须同步改这两个判据（单测有一条"按真实装配产物比对"的守卫用例会红）。
 */
const TEMPLATE_HEAD_ROW_ONE = /^\[.+\] .+$/;

/** 模板头**第 2 行**的形状：`范围: …`（`fixedLines()` 的写法） */
const TEMPLATE_HEAD_ROW_TWO = '范围:';

/**
 * 模板头占的行数（头两行 = 上面两个形状判据认出来的那两行）。
 *
 * ⚠️ **只在形状判定命中后才用它切片**，绝不拿它做"无条件跳两行"——`content` 有两条一等公民
 * 写路径（见 `extractContentExcerpt`），自由正文按固定行数跳会**静默丢数据**。
 */
const TEMPLATE_HEAD_ROWS = 2;

/**
 * 摘录行里的来源定位前缀（`- [chamber://<type>/<id>[#h<hash12>] `）。
 *
 * 形态单源 = `buildSourceLocator`（本文件）；这条正则也留在本文件，理由同上：
 * locator 形态一变，写侧与读侧的剥离规则必须一起动。
 */
const EXCERPT_LOCATOR_PREFIX = /^-\s*\[chamber:\/\/[^\]]*\]\s?/;

/**
 * 按 UTF-8 字节截断字符串（**不切开代理对**）。
 *
 * 实现：先按字节切，再判断切点是否落在代理对中间——若是则回退一个码元。
 * 注意 JS 的 `Buffer.from(str).subarray(0, n).toString()` 已经会把不完整的 UTF-8 序列
 * 替换成 U+FFFD，故这里用"逐码元累加字节"的确定性写法（避免 U+FFFD 混进正文）。
 *
 * @param value 原文
 * @param maxBytes 字节上限（≥0）
 * @returns 截断后的字符串（未超限时原样返回）
 */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8ByteLength(value) <= maxBytes) return value;

  let used = 0;
  let result = '';
  // for...of 按码点迭代（代理对作为一个整体），保证切点永远落在码点边界
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (used + size > maxBytes) break;
    used += size;
    result += char;
  }
  return result;
}

/**
 * 构造来源 locator（方案 §4 的**唯一**产出点）。
 *
 * 形态：`chamber://doc/<id>#h<contentHash12>`（doc 带冻结版本锚）/ `chamber://message/<id>` /
 * `chamber://task/<id>` / `chamber://comment/<id>`。
 *
 * @param ref 来源引用（含冻结快照）
 * @returns locator 字符串
 */
export function buildSourceLocator(ref: MemorySourceRef): string {
  const base = `chamber://${ref.type}/${ref.id}`;
  // 只有 doc 有版本列（§6）：message/task/comment 编 h 锚 = 让"来源未改"永假
  if (ref.type === MEMORY_SOURCE_REF_TYPE.DOC && ref.versionHash) {
    return `${base}#h${ref.versionHash.slice(0, 12)}`;
  }
  return base;
}

/** 装配入参（三要素 + 理由 + 已冻结的来源引用） */
export interface FormationAssemblyInput {
  category: string;
  subject: string;
  scope: string;
  /** 生效/撤销说明（可空；存在时永不截断） */
  effectiveNote: string | null;
  rationale: string;
  /** 已由调用方回取并冻结的来源引用（≤4；空数组 = 纯著述） */
  sourceRefs: MemorySourceRef[];
}

/** 装配产物 */
export interface FormationAssemblyResult {
  content: string;
  /** 摘录区是否被截断（落 `content_truncated` 并透出） */
  truncated: boolean;
  /**
   * 固定区（三要素 + 理由）本身超限——**调用方必须 400**，
   * 而不是把主张截掉（见文件头不变量）。
   */
  overflow: boolean;
}

/** 固定区行（永不截断；`生效/撤销` 行仅在给出说明时出现） */
function fixedLines(input: FormationAssemblyInput): string[] {
  const lines = [`[${input.category}] ${input.subject}`, `范围: ${input.scope}`];
  if (input.effectiveNote?.trim()) lines.push(`生效/撤销: ${input.effectiveNote}`);
  lines.push(`理由: ${input.rationale}`);
  return lines;
}

/** 摘录区行（可截断；逐条带来源标记 = locator） */
function excerptLine(ref: MemorySourceRef): string {
  const locator = buildSourceLocator(ref);
  const excerpt = (ref.excerpt ?? '').trim();
  return excerpt ? `- [${locator}] ${excerpt}` : `- [${locator}]`;
}

/**
 * 装配形成正文（纯函数；见文件头不变量）。
 *
 * @param input 三要素 + 理由 + 冻结来源
 * @returns `{content, truncated, overflow}`（`overflow=true` 时 `content` 仅为固定区，调用方须 400）
 */
export function assembleFormationContent(input: FormationAssemblyInput): FormationAssemblyResult {
  const fixed = fixedLines(input).join('\n');
  const fixedBytes = utf8ByteLength(fixed);

  // overflow 闸门（**必须恒真**，见文件头"改上限数字必须同步"）：
  // 固定区 + 摘录区前缀 + 分隔换行 + 截断标记占位都放不下时才判 overflow。
  // ⚠️ 前缀占用是 UTF-8 **字节**（`关键依据摘录:` 20 字节，不是 `.length` 的 8）——
  // 只算固定区会让"勉强放得下"的请求先被判成"能装"，进了截断分支后照样超限。
  // 无 sourceRefs（纯著述）时不产生摘录区，故只有固定区自身超限才算 overflow。
  const excerptOverhead =
    input.sourceRefs.length === 0
      ? 0
      : utf8ByteLength(EXCERPT_AREA_PREFIX) + 1 + MEMORY_TRUNCATION_RESERVE_BYTES;
  if (fixedBytes + excerptOverhead > MEMORY_CONTENT_MAX_BYTES) {
    return { content: fixed, truncated: false, overflow: true };
  }

  if (input.sourceRefs.length === 0) {
    return { content: fixed, truncated: false, overflow: false };
  }

  const excerptLines = input.sourceRefs.map(excerptLine);
  const excerptArea = `${EXCERPT_AREA_PREFIX}${excerptLines.join('\n')}`;
  const composed = `${fixed}\n${excerptArea}`;

  if (utf8ByteLength(composed) <= MEMORY_CONTENT_MAX_BYTES) {
    return { content: composed, truncated: false, overflow: false };
  }

  // 摘录区超限：逐条装填，装不下就停；至少保留第一条的截断形态（"有摘录但被截"）
  const prefix = `${fixed}\n${EXCERPT_AREA_PREFIX}`;
  const budget = excerptBudget(fixedBytes);
  let used = 0;
  const kept: string[] = [];
  for (const line of excerptLines) {
    const lineBytes = utf8ByteLength(line) + 1;
    if (used + lineBytes <= budget) {
      kept.push(line);
      used += lineBytes;
      continue;
    }
    const remaining = budget - used;
    if (remaining > 2) {
      kept.push(truncateUtf8Bytes(line, remaining - 1));
    }
    break;
  }

  return {
    content: `${prefix}${kept.join('\n')}\n${MEMORY_EXCERPT_TRUNCATION_MARKER}`,
    truncated: true,
    overflow: false,
  };
}

/**
 * 摘录区可用字节预算（**先扣标记占位再填内容**，见文件头不变量）。
 *
 * ⚠️ 前缀与标记的占用一律按 **UTF-8 字节**算（`utf8ByteLength`），不是 `.length`：
 * `'关键依据摘录:\n'` 字符长度 8 而字节长度 20——按字符扣会**超出闸门 12 字节**
 * （单测的"总字节 ≤ 8192"断言就是这条的守卫，实测曾超 11 字节）。
 *
 * @param fixedBytes 固定区已占字节
 * @returns 摘录区可用字节（含行分隔符）
 */
function excerptBudget(fixedBytes: number): number {
  return (
    MEMORY_CONTENT_MAX_BYTES -
    fixedBytes -
    utf8ByteLength(EXCERPT_AREA_PREFIX) -
    MEMORY_TRUNCATION_RESERVE_BYTES
  );
}

/**
 * 整篇覆盖（`contentOverride`）的闸门：**同闸门**语义 = 同字节上限 + 同截断标记。
 *
 * @param override 客户端给的正文
 * @returns `{content, truncated}`（超限时截断并标记，**不静默丢弃**）
 */
export function applyContentOverride(override: string): { content: string; truncated: boolean } {
  if (utf8ByteLength(override) <= MEMORY_CONTENT_MAX_BYTES) {
    return { content: override, truncated: false };
  }
  const body = truncateUtf8Bytes(
    override,
    MEMORY_CONTENT_MAX_BYTES - MEMORY_TRUNCATION_RESERVE_BYTES,
  );
  return { content: `${body}\n${MEMORY_EXCERPT_TRUNCATION_MARKER}`, truncated: true };
}

// ══════════════════════════════════════════════════════════════════════════
// 读面：从形成正文里抽出**可直接展示的摘要**（列表/详情 `contentExcerpt`）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 从形成正文里抽摘要（`contentExcerpt` 的**唯一**产出点）。
 *
 * ⚠️ 先记住一件决定性的事实：`content` 有**两条一等公民写路径**
 * ① 服务端装配 `assembleFormationContent()` —— 恒为 §4 模板（`[category] subject` / `范围:` / …），
 *    有来源时末尾带摘录区；
 * ② `applyContentOverride(dto.contentOverride)` —— **客户端自由正文**，无模板头、无锚点。
 * 所以任何"按固定行数/固定位置切一刀"的读法都会在 ② 上**静默丢数据**（单行正文甚至被吞成空摘要）。
 *
 * 规则（Memory web 二期 D1③④，评审后修订）：
 * 1. **有摘录区**（锚点 `EXCERPT_AREA_PREFIX`）⇒ 取锚点之后的内容，逐行剔除
 *    `- [chamber://…] ` 的 locator 前缀（那段 locator ≈66 字符/条，消费方本来就能从
 *    `sources[].locator` 拿到同一条信息——留在摘要里既重复又白占 280 码点预算）；
 *    剥完为空的行走（来源无摘录）丢弃。
 *    **回落**：锚点存在但一条摘录都没剥出来（来源无 excerpt）⇒ 不返回空串，而是把摘录区
 *    **连同锚点一起当作不存在**（取锚点之前的正文）再走退化分支——"锚点附近没东西"不等于
 *    "整篇没东西"，`理由:` 仍然有展示价值；留着裸锚点行反而是纯脚手架噪音。
 * 2. **退化分支**（无锚点，或摘录区里没内容）⇒ **按形状**判定头部是不是 §4 模板头
 *    （`withoutTemplateHead()`）：是 ⇒ 丢掉那两行（`[category] subject` 与 `范围:`，它们的信息
 *    已由结构化字段 category/subject/scope 给出，摘要复述等于零信息量），从 `生效/撤销:`（若有）/
 *    `理由:` 起截；**不是 ⇒ 整段照用**（自由正文一个字都不许丢，仍剥 locator、仍封顶）。
 * 3. 最多 `MEMORY_CONTENT_EXCERPT_MAX_CHARS` 个**码点**，超出即截并追加
 *    `MEMORY_EXCERPT_TRUNCATION_MARKER`。按码点（`Array.from`）而不是 `slice`：后者按码元切，
 *    会把 emoji / 生僻字切成半个代理对（渲染出 U+FFFD）。
 *
 * ⚠️ **不读也不写行级 `contentTruncated`**：那个字段的语义是"**形成时**摘录区被 8192 字节闸门
 * 截掉了"，是落库事实；摘要在读面被截到 280 字符是**展示**行为。二者混用会让列表把
 * "展示被截"误报成"佐证残缺"（或反过来把残缺佐证说成完好）。
 *
 * @param content 账本行的形成正文（`select:false` 列，调用方须已显式取；缺省/空 ⇒ 空串）
 * @returns 摘要（无任何可用内容时为空串，**不是** null——消费方按空串渲染占位）
 */
export function extractContentExcerpt(content: string): string {
  const raw = content ?? '';
  if (!raw.trim()) return '';

  const anchorAt = raw.indexOf(EXCERPT_AREA_PREFIX);
  if (anchorAt >= 0) {
    const fromExcerptArea = cleanExcerptLines(raw.slice(anchorAt + EXCERPT_AREA_PREFIX.length));
    if (fromExcerptArea) return clampExcerpt(fromExcerptArea);
    // 摘录区在、但一条摘录都没剥出来（来源无 excerpt）⇒ 回落退化分支：摘录区连同锚点一起
    // 当它不存在，只把**锚点之前**的正文交给退化规则（这样形状判定才拿得到模板头）。
    return clampExcerpt(cleanExcerptLines(withoutTemplateHead(raw.slice(0, anchorAt))));
  }

  // 无锚点 = 纯著述模板产物，或 `contentOverride` 的自由正文 ⇒ 按形状判定要不要丢头部
  return clampExcerpt(cleanExcerptLines(withoutTemplateHead(raw)));
}

/**
 * 若 `raw` 的头部**确实是 §4 模板头**，返回头两行之后的正文；否则**原样返回**。
 *
 * 判据 = 头两行同时命中形状（`[category] subject` + `范围:`）**且其后还有内容**（`rows.length >
 * TEMPLATE_HEAD_ROWS`）：只看第 1 行的形状太松（自由正文里随手一句 `[x] y` 就会被误跳两行）；
 * 而两行就收尾的"命中"只会把摘要清空——真实的模板产物永远有 `理由:` 行，所以这条额外的长度
 * 要求只会挡住自由正文的巧合匹配，不会挡住任何模板产物。
 *
 * subject/scope 的 DTO 校验只限长度、**不禁换行**——subject 含换行时头两行形状不成立，
 * 判定为"不是标准模板头"⇒ 整段照用；表现为多显示两行主张，但**不丢数据**（刻意选这个方向的取舍）。
 *
 * @param raw 账本行完整正文
 * @returns 判定命中 ⇒ 去掉模板头两行；未命中 ⇒ 原样
 */
function withoutTemplateHead(raw: string): string {
  const rows = raw.split('\n');
  const isTemplateHead =
    rows.length > TEMPLATE_HEAD_ROWS &&
    TEMPLATE_HEAD_ROW_ONE.test(rows[0].trim()) &&
    rows[1].trim().startsWith(TEMPLATE_HEAD_ROW_TWO);
  return isTemplateHead ? rows.slice(TEMPLATE_HEAD_ROWS).join('\n') : raw;
}

/**
 * 摘要正文的逐行清洗（两条分支共用）：剥 locator 前缀 + 去首尾空白 + 丢空行。
 *
 * @param text 摘录区内容或退化正文
 * @returns 清洗后的文本（全为空行时是空串）
 */
function cleanExcerptLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(EXCERPT_LOCATOR_PREFIX, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * 摘要按**码点**封顶（见 `extractContentExcerpt` 规则 3）。
 *
 * @param body 已剥 locator / 已去空行的摘要正文
 * @returns 未超限原样返回；超限 = 前 N 个码点 + 截断标记
 */
function clampExcerpt(body: string): string {
  const points = Array.from(body);
  if (points.length <= MEMORY_CONTENT_EXCERPT_MAX_CHARS) return body;
  return `${points.slice(0, MEMORY_CONTENT_EXCERPT_MAX_CHARS).join('')}${MEMORY_EXCERPT_TRUNCATION_MARKER}`;
}
