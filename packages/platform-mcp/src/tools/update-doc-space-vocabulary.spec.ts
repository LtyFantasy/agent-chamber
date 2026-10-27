/**
 * update_doc_space_vocabulary 单元测试（v1.92.0-dev，plan gamora-nova-nebula 批 3）
 *
 * 覆盖：
 * - description 契约（LLM 消费者按它行动，与代码同为契约面）：四键顶层/嵌套陷阱、
 *   advisory 非闸门、三态逐键（null 删键 / 省略保留 / 值整键替换）、空容器 ≡ null 劝退、
 *   整键替换三祈使句、并发 known limitation + 重试安全、400 与 422 两类动作指引、
 *   数字错误码、六族 gloss 齐备；
 * - inputSchema 契约：required 锁空、四键 union 三态、上限常量双写、六族键集合
 *   = DOC_HINT_FAMILIES（防 shared 加族后静默漂移）；
 * - handler：四键顶层收集 + 空 body 守卫（零 HTTP）、null 逐跳保真、四键同传、
 *   `hintToggles:{}` / `docTypes:[]` 原样上行；
 * - 定位双通道 + 0/>1 候选结构化信封；
 * - 响应投影：`{spaceId,name,vocabulary,appliedKeys}`、**不含 repoManifest**、
 *   空容器折叠为 null（与读侧 parse* 闸门同口径）；
 * - 错误透传：422/10014（conflicts 原样）、422/10015、403/1009 —— 不包装成 500（铁律 #9）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import {
  DOC_HINT_FAMILIES,
  DOC_SPACE_CANONICAL_TAGS_MAX,
  DOC_SPACE_DOC_TYPES_MAX,
  DOC_SPACE_DOC_TYPE_MAX_LENGTH,
  DOC_SPACE_PATH_PREFIX_MAX_LENGTH,
  DOC_SPACE_PATH_TYPES_MAX,
  DOC_SPACE_TAG_ALIASES_MAX,
  DOC_SPACE_TAG_MAX_LENGTH,
} from '@agent-chamber/shared';
import { updateDocSpaceVocabularyTool } from './update-doc-space-vocabulary';
import { PlatformApiClient, PlatformApiError } from '../platform-client';

jest.mock('../platform-client', () => {
  const actual = jest.requireActual('../platform-client');
  return { ...actual, PlatformApiClient: jest.fn() };
});
const MockClient = PlatformApiClient as jest.MockedClass<typeof PlatformApiClient>;

function ctx(): CustomToolContext {
  return { baseUrl: 'http://localhost:8743/api/v1' };
}

function mockRequest() {
  const mockFn = jest.fn();
  MockClient.prototype.request = mockFn;
  return mockFn;
}

/** 四键名（与后端 UpdateDocSpaceDto 的四个词表字段一一对应） */
const VOCAB_KEYS = ['docTypes', 'canonicalTags', 'pathTypes', 'hintToggles'] as const;

/**
 * PATCH 成功响应样本：**后端返回裸 DocSpace 实体**（含 settings 全量）。
 *
 * ⚠️ 刻意带 `settings.repoManifest`（上限 2 万条、~50KB 的内部键）——投影测试要能证明
 * 它被剔除；若实现改成原样透传，断言会当场失败。
 */
function savedEntity(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'sp-1',
    name: 'My Docs',
    slug: 'my-docs',
    settings: {
      visibility: 'private',
      repoManifest: {
        files: Array.from({ length: 3 }, (_, i) => ({ path: `docs/f${i}.md`, sha: 'x' })),
        updatedAt: '2026-10-06T00:00:00.000Z',
      },
      ...settings,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

/** 取 inputSchema 的 properties（测试内多处复用，收敛断言噪音） */
const props = (updateDocSpaceVocabularyTool.tool.inputSchema?.properties ??
  {}) as unknown as Record<string, Record<string, unknown>>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// description 契约（LLM 消费者按 description 行动——与代码同为契约面）
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — description 契约', () => {
  const desc = updateDocSpaceVocabularyTool.tool.description as string;

  it('首句摊开四键范围 + REST 对应关系 + 定位双通道', () => {
    expect(desc).toContain('PATCH /doc-spaces/:id');
    for (const key of VOCAB_KEYS) expect(desc).toContain(key);
    expect(desc).toContain('three-layer match');
    expect(desc).toContain('0 or >1 name candidates returns isError:true');
  });

  it('点名 facets 的 vocabulary/settings 双嵌套陷阱（LLM 最自然的错误动作）', () => {
    expect(desc).toContain('THE FOUR KEYS ARE TOP-LEVEL ARGUMENTS');
    expect(desc).toContain('does NOT accept a `vocabulary` or a `settings` wrapper');
    expect(desc).toContain('get_doc_facets echoes');
    // 失败机制要说清（旧句 "nests nothing ... goes out empty" 自相矛盾：没嵌套怎会空）
    expect(desc).toContain('nests them one level too deep');
    expect(desc).toContain('the tool sees no top-level key');
    expect(desc).toContain('Lift the four keys out of the facets response');
  });

  it('响应形状与 appliedKeys 语义写明（回执要能自证「我改了什么」）', () => {
    expect(desc).toContain('Response: { spaceId, name, vocabulary, appliedKeys }');
    expect(desc).toContain('vocabulary is the stored state after the write');
    expect(desc).toContain('appliedKeys lists the keys you actually passed');
    expect(desc).toContain('a key passed as null is applied = deleted');
  });

  it('advisory 半句：词表不是写入闸门（防 LLM 误判为校验器）', () => {
    expect(desc).toContain('THE VOCABULARY IS ADVISORY, NOT A GATE');
    expect(desc).toContain('Declaring values here never restricts writes');
  });

  it('三态总则：值=整键替换 / null=删键破坏性 / 省略=保留，且禁 null 表「不改」', () => {
    expect(desc).toContain('TRI-STATE, PER KEY');
    expect(desc).toContain('REPLACES THE WHOLE KEY');
    expect(desc).toContain('null DELETES the key from settings');
    expect(desc).toContain('omitted = that key is left untouched');
    expect(desc).toContain('NEVER pass null to mean "leave unchanged"');
  });

  it('空容器 ≡ null 等价劝退句（写读面自相矛盾的那个坑）', () => {
    expect(desc).toContain('do NOT use `[]` / `{}` to clear; use null');
    expect(desc).toContain('indistinguishable from a deleted key');
  });

  it('整键替换防呆三祈使句（WHOLE 警告 / 先读合并 / 写完读回）', () => {
    expect(desc).toContain('WHOLE-REPLACEMENT GUARDRAILS');
    expect(desc).toContain('replaces the WHOLE map/array');
    expect(desc).toContain('MUST call get_doc_facets FIRST');
    expect(desc).toContain('read `vocabulary` back');
  });

  it('并发 known limitation（last-write-wins）+ 重试安全声明', () => {
    expect(desc).toContain('KNOWN LIMITATION — no optimistic locking');
    expect(desc).toContain('last-write-wins');
    expect(desc).toContain('whole-key replacement is idempotent');
    expect(desc).toContain('no idempotency key is needed');
  });

  it('错误面：数字码齐备 + 400 与 422 两类动作指引分清', () => {
    expect(desc).toContain('400 `9000`');
    expect(desc).toContain('422 `10014`');
    expect(desc).toContain('422 `10015`');
    expect(desc).toContain('403 `1009`');
    // 400 = 改形状（同 payload 重试无效）
    expect(desc).toContain('CHANGE THE PAYLOAD SHAPE');
    expect(desc).toContain('re-sending the same payload fails identically');
    // 422 = 读凭据逐条修后重发
    expect(desc).toContain('details.conflicts[]');
    expect(desc).toContain('conflictingIndex');
    expect(desc).toContain('details.allowedFamilies');
  });

  it('权限句 + 关联工具点名（含 merge_doc_category 的正确单数名）', () => {
    expect(desc).toContain('Requires write access');
    expect(desc).toContain('NOT creator-only');
    expect(desc).toContain('get_doc_facets');
    expect(desc).toContain('rename_doc_tags');
    expect(desc).toContain('merge_doc_category');
    expect(desc).toContain('upsert_doc');
    expect(desc).toContain('patch_doc_metadata');
  });

  it('逐字段 description 重复三态警告（字段级才是 LLM 填参时读的地方）', () => {
    for (const key of VOCAB_KEYS) {
      expect(props[key].description as string).toContain('null deletes the key');
      expect(props[key].description as string).toContain('omit to keep it');
    }
  });

  it('六族 gloss 逐族写进 properties.<family>.description（穷尽，不靠人工记忆）', () => {
    const familyProps = props.hintToggles.properties as Record<string, { description: string }>;
    for (const family of DOC_HINT_FAMILIES) {
      expect(familyProps[family]).toBeDefined();
      expect(familyProps[family].description.length).toBeGreaterThan(20);
    }
    // 「缺失族 = 关」的语义必须在 hintToggles 描述里说明（整键替换的杀伤面）
    expect(props.hintToggles.description as string).toContain('any family you omit is turned OFF');
  });
});

// ---------------------------------------------------------------------------
// inputSchema 契约
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — inputSchema 契约', () => {
  it('四键全可选：required 锁空数组（防漂移），顶层 additionalProperties=false', () => {
    expect(updateDocSpaceVocabularyTool.tool.inputSchema?.required).toEqual([]);
    expect(updateDocSpaceVocabularyTool.tool.inputSchema?.additionalProperties).toBe(false);
  });

  it('四键 union 三态 + 上限常量双写进 schema 关键字', () => {
    expect(props.docTypes.type).toEqual(['array', 'null']);
    expect(props.canonicalTags.type).toEqual(['array', 'null']);
    expect(props.pathTypes.type).toEqual(['array', 'null']);
    expect(props.hintToggles.type).toEqual(['object', 'null']);

    // 上限常量插值（automcp 不做入参校验，但支持预检的客户端看得见——别省）
    expect(props.docTypes.maxItems).toBe(DOC_SPACE_DOC_TYPES_MAX);
    expect(props.canonicalTags.maxItems).toBe(DOC_SPACE_CANONICAL_TAGS_MAX);
    expect(props.pathTypes.maxItems).toBe(DOC_SPACE_PATH_TYPES_MAX);
    expect((props.canonicalTags.items as Record<string, unknown>).maxItems).toBeUndefined();

    // 元素层：canonicalTags 只必填 value；pathTypes 必填 pathPrefix + docType
    expect((props.canonicalTags.items as Record<string, unknown>).required).toEqual(['value']);
    expect((props.pathTypes.items as Record<string, unknown>).required).toEqual([
      'pathPrefix',
      'docType',
    ]);
    expect((props.canonicalTags.items as Record<string, unknown>).additionalProperties).toBe(false);
    expect((props.pathTypes.items as Record<string, unknown>).additionalProperties).toBe(false);

    // hintToggles 六族 properties 键集合 = shared 单一事实来源（多/少一族即失败）
    expect(Object.keys(props.hintToggles.properties as Record<string, unknown>)).toEqual([
      ...DOC_HINT_FAMILIES,
    ]);
    expect(props.hintToggles.additionalProperties).toBe(false);
  });

  it('元素级 minLength/maxLength 与后端 DTO 逐条对齐（形状预检面，审查补钉）', () => {
    // 元素形状（DTO `@MinLength(1,{each:true})` 拦空串：docTypes 元素 update-doc-space.dto.ts:237、
    // aliases 元素 :123）——漏掉会让支持预检的客户端放过一个必然 400/422 的空串
    expect((props.docTypes.items as Record<string, unknown>).minLength).toBe(1);
    expect((props.docTypes.items as Record<string, unknown>).maxLength).toBe(
      DOC_SPACE_DOC_TYPE_MAX_LENGTH,
    );

    const canonicalTagProps = (props.canonicalTags.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(canonicalTagProps.value.minLength).toBe(1);
    expect(canonicalTagProps.value.maxLength).toBe(DOC_SPACE_TAG_MAX_LENGTH);
    expect(canonicalTagProps.aliases.maxItems).toBe(DOC_SPACE_TAG_ALIASES_MAX);
    expect((canonicalTagProps.aliases.items as Record<string, unknown>).minLength).toBe(1);
    expect((canonicalTagProps.aliases.items as Record<string, unknown>).maxLength).toBe(
      DOC_SPACE_TAG_MAX_LENGTH,
    );

    const pathTypeProps = (props.pathTypes.items as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(pathTypeProps.pathPrefix.minLength).toBe(1);
    expect(pathTypeProps.pathPrefix.maxLength).toBe(DOC_SPACE_PATH_PREFIX_MAX_LENGTH);
    expect(pathTypeProps.docType.minLength).toBe(1);
    expect(pathTypeProps.docType.maxLength).toBe(DOC_SPACE_DOC_TYPE_MAX_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// handler — 三态透传与守卫
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — handler 三态与守卫', () => {
  it('spaceId 直传 + 四键同传：一次请求，body 逐键原样（含 null 与空容器）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(
      savedEntity({
        docTypes: ['guide'],
        canonicalTags: [{ value: 'openviking', aliases: [] }],
        pathTypes: [],
        hintToggles: { tags: true },
      }),
    );

    const args = {
      spaceId: 'sp-1',
      docTypes: ['guide'],
      canonicalTags: [{ value: 'openviking', aliases: [] }],
      pathTypes: [],
      hintToggles: { tags: true },
    };
    const result = await updateDocSpaceVocabularyTool.handler(args, ctx());

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('PATCH');
    expect(request.mock.calls[0][1]).toContain('/doc-spaces/sp-1');
    // 三态保真：null 存活、[] 不做 truthy 化、{} 不折叠——body 与入参的四键逐字段同形
    // （spaceId/spaceName 是定位通道，不是 body 键，不得混进请求体）
    expect(request.mock.calls[0][2].body).toEqual({
      docTypes: args.docTypes,
      canonicalTags: args.canonicalTags,
      pathTypes: args.pathTypes,
      hintToggles: args.hintToggles,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body.appliedKeys).toEqual([...VOCAB_KEYS]);
  });

  it('null 原样透传（删键语义），不被 truthy 判断吞掉', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(savedEntity({}));

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', docTypes: null, hintToggles: null },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[0][2].body).toEqual({ docTypes: null, hintToggles: null });

    const body = JSON.parse(result.content[0].text);
    expect(body.appliedKeys).toEqual(['docTypes', 'hintToggles']);
  });

  it('单键传递：只带该键，不补默认值（另三键保持服务端保留语义）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(savedEntity({ docTypes: ['guide'] }));

    await updateDocSpaceVocabularyTool.handler({ spaceId: 'sp-1', docTypes: ['guide'] }, ctx());

    const sent = request.mock.calls[0][2].body as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['docTypes']);
  });

  it('空 body 守卫：四键全缺 → 400 + validate_args，且零 HTTP 调用', async () => {
    const request = mockRequest();

    // ① 真的什么都没给 ② 走了 facets 的嵌套陷阱（把 vocabulary 整段传回来）
    const cases: Record<string, unknown>[] = [
      { spaceId: 'sp-1' },
      { spaceId: 'sp-1', vocabulary: { docTypes: ['guide'] } },
      { spaceId: 'sp-1', settings: { canonicalTags: [] } },
      { spaceName: 'My Docs' },
    ];

    for (const args of cases) {
      const result = await updateDocSpaceVocabularyTool.handler(args, ctx());
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.status).toBe(400);
      expect(body.failedStep).toBe('validate_args');
      expect(body.message).toContain('TOP-LEVEL argument');
      expect(body.message).toContain('silently no-op');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('hintToggles:{} 原样上行（不本地折算成 null）——写面如实反映调用方输入', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(savedEntity({ hintToggles: {} }));

    await updateDocSpaceVocabularyTool.handler({ spaceId: 'sp-1', hintToggles: {} }, ctx());

    expect(request.mock.calls[0][2].body).toEqual({ hintToggles: {} });
  });

  it('空间名解析走三层匹配（未传 spaceId 时多一次列表拉取）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-9', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce(savedEntity({ docTypes: ['guide'] }));

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceName: 'my docs', docTypes: ['guide'] },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[1][1]).toContain('/doc-spaces/sp-9');
  });
});

// ---------------------------------------------------------------------------
// handler — 解析失败信封
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — 空间解析失败', () => {
  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }] });

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceName: 'Ghost', docTypes: ['guide'] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project A', slug: 'project-a' },
        { id: 'sp-2', name: 'Project B', slug: 'project-b' },
      ],
    });

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceName: 'Project', docTypes: ['guide'] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('空间列表拉取失败 → 透传平台错误（不包装成 500）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 403, message: 'forbidden', code: 1009 }),
    );

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceName: 'My Docs', docTypes: ['guide'] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(403);
    expect(body.code).toBe(1009);
  });
});

// ---------------------------------------------------------------------------
// handler — 响应投影
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — 响应投影', () => {
  it('投影为 {spaceId,name,vocabulary,appliedKeys}，**不含 repoManifest**（内部键不外泄）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(
      savedEntity({
        docTypes: ['guide', 'reference'],
        canonicalTags: [{ value: 'openviking', aliases: [] }],
        pathTypes: [{ pathPrefix: 'memory/', docType: 'memory' }],
        hintToggles: { tags: true, routes: false },
      }),
    );

    const result = await updateDocSpaceVocabularyTool.handler(
      {
        spaceId: 'sp-1',
        docTypes: ['guide', 'reference'],
        canonicalTags: [{ value: 'openviking', aliases: [] }],
        pathTypes: [{ pathPrefix: 'memory/', docType: 'memory' }],
        hintToggles: { tags: true, routes: false },
      },
      ctx(),
    );

    const raw = result.content[0].text;
    // 原样透传实体会把 settings.repoManifest（上限 2 万条 ~50KB）灌进 LLM 上下文
    expect(raw).not.toContain('repoManifest');
    expect(raw).not.toContain('createdAt');

    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(['appliedKeys', 'name', 'spaceId', 'vocabulary']);
    expect(body.spaceId).toBe('sp-1');
    expect(body.name).toBe('My Docs');
    expect(body.vocabulary).toEqual({
      docTypes: ['guide', 'reference'],
      canonicalTags: [{ value: 'openviking', aliases: [] }],
      pathTypes: [{ pathPrefix: 'memory/', docType: 'memory' }],
      hintToggles: { tags: true, routes: false },
    });
    // 形状与 get_doc_facets 的 vocabulary 回显同名同构（读写配对零翻译成本）
    expect(Object.keys(body.vocabulary).sort()).toEqual(
      ['canonicalTags', 'docTypes', 'hintToggles', 'pathTypes'].sort(),
    );
  });

  it('空容器折叠为 null：docTypes:[] / hintToggles:{} 的存储态在读面 ≡ 删键', async () => {
    const request = mockRequest();
    // 服务端原样落库 [] 与 {}（validateVocabulary 空数组 → 存 []；validateHintToggles 空对象 → 存 {}）
    request.mockResolvedValueOnce(savedEntity({ docTypes: [], hintToggles: {} }));

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', docTypes: [], hintToggles: {} },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    // 不折叠的话：同一存储态写面回 []、读面（facets）省略 —— 「写完读回校验」当场自相矛盾
    expect(body.vocabulary.docTypes).toBeNull();
    expect(body.vocabulary.canonicalTags).toBeNull();
    expect(body.vocabulary.pathTypes).toBeNull();
    expect(body.vocabulary.hintToggles).toBeNull();
  });

  it('未配置任何词表 → 四键全 null（不省略键，形状恒定便于消费方解构）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(savedEntity({}));

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', docTypes: null },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.vocabulary).toEqual({
      docTypes: null,
      canonicalTags: null,
      pathTypes: null,
      hintToggles: null,
    });
    expect(body.appliedKeys).toEqual(['docTypes']);
  });
});

// ---------------------------------------------------------------------------
// handler — 错误透传（铁律 #9：不把上游 4xx 包装成 500）
// ---------------------------------------------------------------------------

describe('update_doc_space_vocabulary — 错误透传', () => {
  it('422/10014 词表语义冲突 → conflicts 修复凭据原样透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 422,
        message: 'vocabulary conflict',
        code: 10014,
        details: {
          conflicts: [
            {
              field: 'canonicalTags',
              kind: 'duplicate_canonical',
              value: 'openviking',
              index: 1,
              conflictsWith: 'openviking',
              conflictingIndex: 0,
            },
          ],
        },
      }),
    );

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', canonicalTags: [{ value: 'openviking' }, { value: 'OpenViking' }] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('update_doc_space_vocabulary');
    expect(body.status).toBe(422);
    expect(body.code).toBe(10014);
    expect(body.details.conflicts[0].index).toBe(1);
    expect(body.details.conflicts[0].conflictingIndex).toBe(0);
  });

  it('422/10015 hint 族开关非法 → allowedFamilies / unknownKeys 原样透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 422,
        message: 'hint toggles invalid',
        code: 10015,
        details: {
          unknownKeys: ['tagz'],
          invalidKeys: ['read'],
          allowedFamilies: [...DOC_HINT_FAMILIES],
        },
      }),
    );

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', hintToggles: { tagz: true } },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.code).toBe(10015);
    expect(body.details.unknownKeys).toEqual(['tagz']);
    expect(body.details.allowedFamilies).toEqual([...DOC_HINT_FAMILIES]);
  });

  it('400/9000 形状错 与 403/1009 权限错 → 状态码与分码逐字透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        message: 'shape error',
        code: 9000,
        details: { errors: [{ field: 'docTypes', message: 'must be an array' }] },
      }),
    );
    const badShape = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', docTypes: ['guide'] },
      ctx(),
    );
    const badShapeBody = JSON.parse(badShape.content[0].text);
    expect(badShapeBody.status).toBe(400);
    expect(badShapeBody.code).toBe(9000);
    expect(badShapeBody.details.errors).toHaveLength(1);

    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 403, message: 'forbidden', code: 1009 }),
    );
    const forbidden = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-1', docTypes: ['guide'] },
      ctx(),
    );
    const forbiddenBody = JSON.parse(forbidden.content[0].text);
    expect(forbiddenBody.status).toBe(403);
    expect(forbiddenBody.code).toBe(1009);
    expect(forbiddenBody.status).not.toBe(500);
  });

  it('404/10000 空间不存在 → 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'not found', code: 10000 }),
    );

    const result = await updateDocSpaceVocabularyTool.handler(
      { spaceId: 'sp-missing', docTypes: ['guide'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(404);
    expect(body.code).toBe(10000);
  });
});
