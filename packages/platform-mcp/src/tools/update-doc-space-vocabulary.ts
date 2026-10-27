/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 空间词表配置面（DocSpace 元数据治理 1/2 期，v1.92.0-dev）：一步写
 *     `settings.{docTypes,canonicalTags,pathTypes,hintToggles}` 四键，免切 curl 走
 *     REST `PATCH /doc-spaces/:id`（治理动线 facets → 配词表 → rename 的中间一环）。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 update_doc_space_vocabulary：spaceName 三层匹配（或直传
 *     spaceId）→ PATCH /doc-spaces/:id（仅四键）→ 响应投影（剔内部键 repoManifest）
 *     → 4xx 结构化透传（铁律 #9，不包装成 500）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（PATCH /doc-spaces/:id 契约：四键三态
 *     merge 语义、422/10014 conflicts 修复凭据、422/10015 allowedFamilies）
 *   - 补充: 线上 docs/integrations/platform-mcp.md（update_doc_space_vocabulary 工具条目）
 *   - 补充: packages/shared/src/dto/docspace.dto.ts — 四键类型与上限常量单一事实来源
 *
 * [关键不变量]
 *   - **四键在请求体顶层**：不接受 `settings` / `vocabulary` 包装（get_doc_facets 把四键
 *     嵌在 `vocabulary` 下回显，LLM 最自然的动作是把整段传回来）——handler 只挑四键，
 *     包装体一律落到「四键全 undefined」守卫 → 400 validate_args，绝不静默丢弃后
 *     发空 body 假成功（后端空 body 是无条件 save() 的静默 no-op）；
 *   - **null 逐跳保真**：handler 只做 `!== undefined` 判定并原样透传（null 与
 *     `[]`/`{}` 语义不同，不得 truthy 化、不得归一）；三态 = 值整键替换 / null 删键 /
 *     省略保留；
 *   - **响应必须投影**：PATCH 返回裸实体，`settings.repoManifest.files` 上限 2 万条
 *     （~50KB）且属内部键（仓内成文约定「内部键不外泄」，同 doc.service.ts findFacets
 *     只回显三词表键）——投影为 `{spaceId,name,vocabulary,appliedKeys}`，形状与
 *     get_doc_facets 的 `vocabulary` 回显同名同构（读写配对零翻译成本）；
 *   - **投影对四键做读侧同口径归一（空容器 → null）**：`[]`/`{}` 与 null 在一切读面
 *     等价（doc-vocabulary.helper.ts 的 parse* 闸门把空容器折叠为 null），投影若不折叠，
 *     同一存储态写面回 `[]`、读面省略，「写完读回校验」当场自相矛盾；
 *   - 0 或 >1 个 spaceName 候选 → isError:true + 结构化候选，绝不静默挑选（_resolve-space 单源）。
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/_resolve-space.ts — spaceId/spaceName 解析单源
 *   - packages/platform-mcp/src/tools/get-doc-facets.ts — 四键唯一读回路径（读写配对）
 *   - packages/platform-mcp/src/tools/rename-doc-tags.ts — 同批治理工具（写入侧消费 canonicalTags）
 *   - apps/backend/src/modules/docspace/docspace.service.ts — validateVocabulary /
 *     validateHintToggles（422 时零写入）
 *   - apps/backend/src/modules/docspace/doc-vocabulary.helper.ts — 读侧形状闸门
 *     （本项目投影的归一基准：空容器 → null）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import {
  DOC_HINT_FAMILIES,
  DOC_SPACE_CANONICAL_TAGS_MAX,
  DOC_SPACE_DOC_TYPES_MAX,
  DOC_SPACE_DOC_TYPE_MAX_LENGTH,
  DOC_SPACE_PATH_PREFIX_MAX_LENGTH,
  DOC_SPACE_PATH_TYPES_MAX,
  DOC_SPACE_TAG_ALIASES_MAX,
  DOC_SPACE_TAG_MAX_LENGTH,
  type DocHintFamily,
} from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import { resolveSpaceId } from './_resolve-space';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 本工具可写的四个词表键（请求体顶层，顺序即 appliedKeys 回执顺序）。
 *
 * 与后端 `UpdateDocSpaceInput` 的四键一一对应；DTO 的其余字段（name/description/
 * visibility/topicId/boardId/overviewFilter）**刻意不暴露**——结构字段 creator-only、
 * 换绑/可见性与词表治理无关，混进来只会让权限错误面难以诊断。
 */
const VOCABULARY_KEYS = ['docTypes', 'canonicalTags', 'pathTypes', 'hintToggles'] as const;

/**
 * hint 族 gloss（六族逐族说明，写进 `properties.hintToggles.properties.<family>.description`）。
 *
 * 类型 `Record<DocHintFamily, string>` 是**防漂移闸门**：shared 新增/改名族时 TS 穷尽
 * 检查在此编译报错，逼本文件与后端白名单同步（漏一族的静默后果 = LLM 看不到该族说明）。
 */
const HINT_FAMILY_GLOSS: Record<DocHintFamily, string> = {
  metadata:
    'metadata family: missing_category / empty_tags / empty_summary hints on writes. ' +
    'Noisy in diary-heavy spaces (a diary without a category is normal) — prefer leaving it ' +
    'OFF there and enabling it for guide/reference/architecture spaces.',
  tags:
    'tags family: tag_near_dup — a written tag is absent from the vocabulary but highly ' +
    'similar to an existing tag (response data.candidates). Suggestion only, never auto-rewritten.',
  categories:
    'categories family: category_near_dup — a newly created category is near-synonymous with ' +
    'an existing one (response data.candidates[{name,slug}]).',
  pathType:
    'pathType family: path_type_mismatch — the doc path matches a declared settings.pathTypes ' +
    'prefix but its docType differs from the declaration. Needs pathTypes to be declared, ' +
    'otherwise there is nothing to compare against.',
  routes:
    'routes family: route_target_excluded / route_anchor_recheck / route_anchor_broken — ' +
    'hints about doc_routes pointing at this document (excluded by overviewFilter, anchor no ' +
    'longer resolves after a rename, doc deleted).',
  read:
    'read family: query_looks_like_path / suggest_relaxing — search-side hints (the query looks ' +
    'like a doc path, or a zero-hit search carried filters that could be dropped).',
};

/** 六族可选名单（描述文案用；与 DOC_HINT_FAMILIES 同源，不手写第二份字面量） */
const HINT_FAMILY_LIST = DOC_HINT_FAMILIES.join(' / ');

// ---------------------------------------------------------------------------
// 响应投影（读侧同口径）
// ---------------------------------------------------------------------------

/**
 * 空容器折叠：`[]` → null（与后端 `parseStringList` / `parseCanonicalTags` /
 * `parsePathTypes` 的「无有效元素 → null」一致）。
 *
 * 只折叠空值，**不重做元素形状过滤**：能走到这里说明写入已成功，服务端
 * `validateVocabulary` 已按白名单归一落库，元素形状不可能非法。
 *
 * @param raw settings 里的原始值（类型 unknown——jsonb 现实）
 * @returns 非空数组原样；其余（含 null / undefined / 非数组）→ null
 */
function foldEmptyArray(raw: unknown): unknown {
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

/**
 * hintToggles 空对象折叠：`{}` → null（与后端 `parseHintToggles` 的「无任何合法族键 → null」一致）。
 *
 * 同上，不重做「未知族键剔除 / 非 boolean 剔除」——写成功即已过 `validateHintToggles`
 * 白名单归一，非法形态到不了这一步。
 *
 * @param raw settings.hintToggles 原始值
 * @returns 非空对象原样；其余 → null
 */
function foldEmptyHintToggles(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.keys(raw as Record<string, unknown>).length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * update_doc_space_vocabulary — 空间词表配置面（v1.92.0-dev）
 *
 * 双通道定位：spaceId 直传（优先）或 spaceName 三层匹配 → `PATCH /doc-spaces/:id`
 * （只带 docTypes/canonicalTags/pathTypes/hintToggles 四键）。四键三态透传（值=整键
 * 替换 / null=删键 / 省略=保留），四键全缺 → 本地 400（后端空 body 是静默 no-op）。
 * 响应投影为 `{spaceId,name,vocabulary,appliedKeys}`，不原样透传实体（settings.repoManifest
 * 可达 2 万条、~50KB，且属内部键）。
 */
export const updateDocSpaceVocabularyTool: CustomTool = {
  tool: {
    name: 'update_doc_space_vocabulary',
    description:
      'Configure the declared vocabulary of a DocSpace — wrapper of PATCH /doc-spaces/:id, ' +
      'writing only the four vocabulary keys of `settings`. ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive); ' +
      'pass spaceId (UUID) to skip name resolution. 0 or >1 name candidates returns isError:true ' +
      'with structured candidates — never silently picks one. ' +
      'Response: { spaceId, name, vocabulary, appliedKeys } — vocabulary is the stored state ' +
      'after the write (empty containers folded to null), and appliedKeys lists the keys you ' +
      'actually passed (a key passed as null is applied = deleted). ' +
      'THE FOUR KEYS ARE TOP-LEVEL ARGUMENTS: docTypes / canonicalTags / pathTypes / hintToggles. ' +
      'This tool does NOT accept a `vocabulary` or a `settings` wrapper. get_doc_facets echoes ' +
      'them nested under `vocabulary`, but here each key is its own argument — re-sending that ' +
      'echo verbatim nests them one level too deep, so the tool sees no top-level key: the ' +
      'request goes out empty and you get 400 back. Lift the four keys out of the facets ' +
      'response before calling. ' +
      'THE VOCABULARY IS ADVISORY, NOT A GATE: a docType or tag outside the declaration is still ' +
      'accepted on write (only alias normalization and an `undeclared` status flag happen). ' +
      'Declaring values here never restricts writes. ' +
      'TRI-STATE, PER KEY: (a) a value REPLACES THE WHOLE KEY — the whole array, or the whole ' +
      'hintToggles map (never a deep merge, and for hintToggles every family you omit is turned ' +
      'OFF); (b) null DELETES the key from settings — destructive, use it only to intentionally ' +
      'clear a declaration; (c) omitted = that key is left untouched, which is the only way to ' +
      'mean "do not change". NEVER pass null to mean "leave unchanged". An empty container ' +
      '(`[]` / `{}`) is also stored as-is, but every read path folds it to null, making it ' +
      'indistinguishable from a deleted key — so do NOT use `[]` / `{}` to clear; use null. ' +
      '(This reply folds empty containers to null too, so write-side and read-side agree.) ' +
      '⚠️ WHOLE-REPLACEMENT GUARDRAILS: (1) each key you pass replaces the WHOLE map/array — ' +
      "merging is your job, not the server's. (2) MUST call get_doc_facets FIRST and merge its " +
      '`vocabulary` with your change before writing; for hintToggles any of the six families ' +
      'you leave out is switched OFF. (3) After writing, read `vocabulary` back (from this ' +
      'reply, or get_doc_facets) to verify what actually landed. ' +
      'KNOWN LIMITATION — no optimistic locking: doc_spaces has no version column and this ' +
      'endpoint takes no hash token, so two concurrent PATCHes on the same space are ' +
      'last-write-wins. Retrying is safe regardless: whole-key replacement is idempotent, so ' +
      're-sending the same payload is harmless and no idempotency key is needed. ' +
      'ERRORS — READ THE NUMBER AND FIX THE RIGHT THING. ' +
      '400 `9000` = SHAPE or LIMIT error (wrong JSON shape, a string where an array is ' +
      'expected, more items than the cap, an element over its maxLength): `message` names the ' +
      'offending field and `details.errors[]` carries one entry per violation. CHANGE THE ' +
      'PAYLOAD SHAPE — re-sending the same payload fails identically. ' +
      '422 `10014` (DOC_SPACE_VOCABULARY_INVALID) = SEMANTIC conflict inside docTypes / ' +
      'canonicalTags / pathTypes (duplicate canonical value, an alias colliding with another ' +
      'entry, duplicate pathPrefix, or an empty value after trim). Read `details.conflicts[]` — ' +
      'each entry carries field / kind / value / `index` (0-based position in the array YOU ' +
      'passed) / conflictsWith / conflictingIndex — fix each one and re-send. Nothing is ' +
      'written when this fires. ' +
      '422 `10015` (DOC_SPACE_HINT_TOGGLES_INVALID) = an unknown family key or a non-boolean ' +
      'value in hintToggles; read `details.unknownKeys` / `details.invalidKeys` / ' +
      '`details.allowedFamilies` (the six legal family names) and re-send. ' +
      '403 `1009` = no write access. 404 `10000` = DocSpace not found. ' +
      'Requires write access (creator, editor, owner-proxy or admin) — these are content ' +
      'fields, NOT creator-only. ' +
      'RELATED: get_doc_facets (read the current vocabulary + hintToggles first), ' +
      'rename_doc_tags (bulk tag rename/merge — it declares aliases into canonicalTags for you), ' +
      'merge_doc_category (categories are a separate resource, NOT part of this vocabulary), ' +
      'upsert_doc / patch_doc_metadata (the write paths that consume canonicalTags for alias ' +
      'normalization).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required unless spaceId is given.',
        },
        spaceId: {
          type: 'string',
          description:
            'DocSpace UUID. When provided, spaceName resolution is skipped (takes priority).',
        },
        docTypes: {
          type: ['array', 'null'],
          items: { type: 'string', minLength: 1, maxLength: DOC_SPACE_DOC_TYPE_MAX_LENGTH },
          maxItems: DOC_SPACE_DOC_TYPES_MAX,
          description:
            `Declared docType vocabulary (settings.docTypes) — up to ${DOC_SPACE_DOC_TYPES_MAX} ` +
            `values, each 1\u2013${DOC_SPACE_DOC_TYPE_MAX_LENGTH} chars; duplicates are ` +
            'rejected case-insensitively (422/10014). Whole-array replacement: pass the ' +
            'COMPLETE list. null deletes the key; omit to keep it; never use [] to mean ' +
            '"clear" (reads treat [] and a deleted key alike). Advisory — values outside this ' +
            'list are still accepted on write.',
        },
        canonicalTags: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                minLength: 1,
                maxLength: DOC_SPACE_TAG_MAX_LENGTH,
                description:
                  `Canonical tag value (\u2264${DOC_SPACE_TAG_MAX_LENGTH} chars, trimmed, ` +
                  'unique case-insensitively across the space).',
              },
              aliases: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: DOC_SPACE_TAG_MAX_LENGTH },
                maxItems: DOC_SPACE_TAG_ALIASES_MAX,
                description:
                  `Alias values that normalize to \`value\` on write — up to ` +
                  `${DOC_SPACE_TAG_ALIASES_MAX} items, each 1\u2013${DOC_SPACE_TAG_MAX_LENGTH} ` +
                  'chars. Optional — omitted means an empty list. An alias must not collide ' +
                  "with another entry's canonical value or alias (422/10014); an alias equal to " +
                  'its own canonical value is NOT an error.',
              },
            },
            required: ['value'],
            additionalProperties: false,
          },
          maxItems: DOC_SPACE_CANONICAL_TAGS_MAX,
          description:
            `Declared canonical tag vocabulary (settings.canonicalTags) — up to ` +
            `${DOC_SPACE_CANONICAL_TAGS_MAX} entries. Consumed by the write paths (upsert_doc / ` +
            'patch_doc_metadata / import_docs) for alias normalization. Whole-array ' +
            'replacement: pass the COMPLETE list. null deletes the key; omit to keep it; never ' +
            'use [] to mean "clear". ⚠️ This REPLACES the WHOLE map — read get_doc_facets first ' +
            'and merge, or you will drop aliases you did not intend to (rename_doc_tags writes ' +
            'aliases here automatically).',
        },
        pathTypes: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              pathPrefix: {
                type: 'string',
                minLength: 1,
                maxLength: DOC_SPACE_PATH_PREFIX_MAX_LENGTH,
                description:
                  `Path prefix (\u2264${DOC_SPACE_PATH_PREFIX_MAX_LENGTH} chars, unique in the ` +
                  'space, stored verbatim — no trailing-slash requirement).',
              },
              docType: {
                type: 'string',
                minLength: 1,
                maxLength: DOC_SPACE_DOC_TYPE_MAX_LENGTH,
                description:
                  `Recommended docType for this prefix (\u2264${DOC_SPACE_DOC_TYPE_MAX_LENGTH} ` +
                  'chars). The value is NOT validated against docTypes — the vocabulary is ' +
                  'advisory.',
              },
            },
            required: ['pathPrefix', 'docType'],
            additionalProperties: false,
          },
          maxItems: DOC_SPACE_PATH_TYPES_MAX,
          description:
            `Declared pathPrefix → docType mappings (settings.pathTypes) — up to ` +
            `${DOC_SPACE_PATH_TYPES_MAX} entries, pathPrefix unique. Enables the pathType hint ` +
            'family; on its own it does not change write behavior. Whole-array replacement: pass ' +
            'the COMPLETE list. null deletes the key; omit to keep it; never use [] to mean ' +
            '"clear".',
        },
        hintToggles: {
          type: ['object', 'null'],
          properties: {
            metadata: { type: 'boolean', description: HINT_FAMILY_GLOSS.metadata },
            tags: { type: 'boolean', description: HINT_FAMILY_GLOSS.tags },
            categories: { type: 'boolean', description: HINT_FAMILY_GLOSS.categories },
            pathType: { type: 'boolean', description: HINT_FAMILY_GLOSS.pathType },
            routes: { type: 'boolean', description: HINT_FAMILY_GLOSS.routes },
            read: { type: 'boolean', description: HINT_FAMILY_GLOSS.read },
          },
          additionalProperties: false,
          description:
            `Per-family hint switches (settings.hintToggles); legal families: ` +
            `${HINT_FAMILY_LIST}. A missing family is OFF, and disabling a family costs ` +
            'nothing (no hint computation, no extra queries). ⚠️ REPLACES the WHOLE map — any ' +
            'family you omit is turned OFF, so read get_doc_facets first and merge the six ' +
            'families you want to keep. An unknown key or a non-boolean value → 422/10015. ' +
            'null deletes the key (all families OFF); omit to keep it; never use {} to mean ' +
            '"clear".',
        },
      },
      // 四键全可选（三态：值 / null / 省略）——required 锁空数组防漂移
      required: [],
      additionalProperties: false,
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    // 步骤 1：四键收集 + 空 body 守卫（先于空间解析——省一次必然失败的列表拉取）。
    // 只挑四键，null 原样透传（三态保真）；顶层 additionalProperties:false 已挡包装体，
    // 但 MCP 客户端不保证强制 schema，故 { settings: {...} } / { vocabulary: {...} } 会落到
    // 这里 → 零键 → 400，而不是后端「空 body 无条件 save()」的静默 no-op 假成功。
    const body: Record<string, unknown> = {};
    const appliedKeys: string[] = [];
    for (const key of VOCABULARY_KEYS) {
      if (args[key] === undefined) continue;
      body[key] = args[key];
      appliedKeys.push(key);
    }
    if (appliedKeys.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              status: 400,
              failedStep: 'validate_args',
              message:
                'At least one of docTypes / canonicalTags / pathTypes / hintToggles must be ' +
                'provided as a TOP-LEVEL argument — the request body was empty and the server ' +
                'would silently no-op (200) without changing anything. Note the nesting trap: ' +
                'get_doc_facets echoes these four keys under `vocabulary` (which itself lives ' +
                'under the space `settings`), but this tool takes them flat — destructure the ' +
                'echo before calling instead of passing `vocabulary` or `settings` back.',
            }),
          },
        ],
        isError: true,
      };
    }

    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 2：解析 spaceId（spaceId 直传优先，否则 spaceName 三层匹配）
    const resolution = await resolveSpaceId(client, args.spaceName, args.spaceId);
    if (!resolution.ok) return resolution.result;
    const spaceId = resolution.spaceId;

    // 步骤 3：写四键 + 投影响应（不原样透传实体：settings.repoManifest 可达 2 万条 ~50KB
    // 且属内部键，仓内成文约定不外泄）
    try {
      const result = await client.request<Record<string, unknown>>(
        'PATCH',
        `/doc-spaces/${spaceId}`,
        { body },
      );

      const settings = (result.settings ?? {}) as Record<string, unknown>;
      const projected = {
        spaceId: (result.id ?? result.spaceId ?? spaceId) as string,
        name: result.name ?? null,
        vocabulary: {
          docTypes: foldEmptyArray(settings.docTypes),
          canonicalTags: foldEmptyArray(settings.canonicalTags),
          pathTypes: foldEmptyArray(settings.pathTypes),
          hintToggles: foldEmptyHintToggles(settings.hintToggles),
        },
        appliedKeys,
      };
      return { content: [{ type: 'text', text: JSON.stringify(projected) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, 'update_doc_space_vocabulary');
    }
  },
};
