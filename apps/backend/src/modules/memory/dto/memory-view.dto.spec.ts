/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 投影读面（hument alpha.5 四读面）**请求 DTO 的边界校验**单测（铁律 #21 双层校验第一层）
 *
 * [代码职责]
 *   - 把"平台护栏 vs 引擎合同"的两套上限钉成可执行事实：每个上限都必须**恰好**在合同/护栏值
 *     之内通过、越一档拒绝（"边界"与"越界"是两条断言，只测一侧等于没测）
 *   - 把**请求域 ⊊ 响应域**这条唯一的不对称钉住：`any` 是响应回声专有值，请求必须拒
 *   - 三个 params DTO（路径参数）的长度/词表闸门——它们的**存在理由**见 dto/memory-view.dto.ts
 *     尾段（裸 `@Param` 上的装饰器在全局 ValidationPipe 下永不生效，故必须走 params DTO）
 *
 * [关键不变量]（本套件守这些）
 *   - **每个上限都有"为什么是它"**（memory.constants 注释）：`nodeLimit ≤ 200` 是**过滤成本护栏**
 *     （数字恰与引擎默认档相同，但语义是"平台的输入上限"）；`edgeLimit ≤ 600` 只是与节点默认档
 *     同档匹配。两者都**小于**合同上限（1000/3000）——客户端要更大页本批不支持。
 *   - **`any` 只属于响应**：请求侧传 `kind=any` 之类会被 `@IsIn` 挡下。两套域不可互相复用。
 *   - **`scope` 不在任何 DTO 里**：它由引擎层恒填 `actor_private`；客户端自带会被
 *     `forbidNonWhitelisted` 拒成 400（fail-closed，见 DTO 文件头）。本套件用
 *     `whitelist + forbidNonWhitelisted` 复现该行为。
 *   - **路径参数必须整组声明**：`forbidNonWhitelisted` 拒绝未声明的键——漏一个 = 该路由每个
 *     请求都 400（用例里用"三个参数齐 + 词表/长度"覆盖）。
 *
 * [关联代码]
 *   - ./memory-view.dto.ts — 被测 DTO（上限取值的 rationale 在 `../memory.constants.ts`）
 *   - ./recall.dto.spec.ts — 同款先例（class-validator 直测 + 边界二分）
 *   - ../memory-views.service.ts — 第二层（业务闸门：权限 / 引擎可用性 / 来源过滤）
 *
 * [修改检查]
 *   □ 改任何上限必须同步本套件的"边界通过 + 越一档拒绝"两条断言（只改实现不改编 = 门禁说谎）
 *   □ 新增过滤器枚举必须补"词表外值被拒"的断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ValidationPipe } from '@nestjs/common';
import {
  MemoryViewDetailParamsDto,
  MemoryViewHistoryParamsDto,
  MemoryViewRelationsParamsDto,
  MemoryViewRepresentationParamsDto,
  QueryMemoryViewGraphDto,
  QueryMemoryViewHistoryDto,
  QueryMemoryViewRelationAdvisoriesDto,
  QueryMemoryViewRelationsDto,
} from './memory-view.dto';
import {
  MEMORY_VIEW_CURSOR_MAX_LENGTH,
  MEMORY_VIEW_EDGE_LIMIT_MAX,
  MEMORY_VIEW_ENGINE_ID_MAX_LENGTH,
  MEMORY_VIEW_HISTORY_LIMIT_MAX,
  MEMORY_VIEW_NODE_LIMIT_MAX,
  MEMORY_VIEW_PREVIEW_SCALARS_MAX,
  MEMORY_VIEW_RELATION_LIMIT_MAX,
} from '../memory.constants';

/** 造一个 graph 查询 DTO（默认**全空** = 全走引擎默认档；其余字段的语义不在本套件范围内） */
function graphDto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(QueryMemoryViewGraphDto, { ...overrides });
}

/** 出错属性名集合（断言用；空集合 = 通过） */
async function failingProps(dto: object): Promise<string[]> {
  const errors = await validate(dto);
  return errors.map((error) => error.property).sort();
}

describe('QueryMemoryViewGraphDto（graph 过滤 / 分页 / 游标）', () => {
  it('全空载荷通过（**平台不设默认值**：未传即不拼进 query，引擎默认档生效）', async () => {
    expect(await validate(graphDto())).toHaveLength(0);
  });

  it.each([
    ['nodeLimit', MEMORY_VIEW_NODE_LIMIT_MAX],
    ['edgeLimit', MEMORY_VIEW_EDGE_LIMIT_MAX],
    ['previewScalars', MEMORY_VIEW_PREVIEW_SCALARS_MAX],
  ])('%s 在上限**当档**通过（边界含端点）', async (field, max) => {
    expect(await validate(graphDto({ [field]: max }))).toHaveLength(0);
  });

  it.each([
    ['nodeLimit', MEMORY_VIEW_NODE_LIMIT_MAX],
    ['edgeLimit', MEMORY_VIEW_EDGE_LIMIT_MAX],
    ['previewScalars', MEMORY_VIEW_PREVIEW_SCALARS_MAX],
  ])('%s 越**一档**即拒（不是"越很多才拒"）', async (field, max) => {
    expect(await failingProps(graphDto({ [field]: max + 1 }))).toEqual([field]);
  });

  it.each([
    ['nodeLimit', MEMORY_VIEW_NODE_LIMIT_MAX],
    ['edgeLimit', MEMORY_VIEW_EDGE_LIMIT_MAX],
    ['previewScalars', MEMORY_VIEW_PREVIEW_SCALARS_MAX],
  ])('%s 下限 0 拒（分页大小 0 无意义，引擎合同同样是 minimum 1）', async (field) => {
    expect(await failingProps(graphDto({ [field]: 0 }))).toEqual([field]);
  });

  it('上限的两档都**小于**引擎合同上限（护栏/同档，不是合同的搬运）', () => {
    // 合同：node_limit ≤ 1000 / edge_limit ≤ 3000（见 hument-v1.yaml 的 MemoryViewNodeLimit）
    expect(MEMORY_VIEW_NODE_LIMIT_MAX).toBeLessThan(1000);
    expect(MEMORY_VIEW_EDGE_LIMIT_MAX).toBeLessThan(3000);
    // 数字来源：node 档 = 过滤成本护栏（恰与引擎默认档同值，但语义是平台输入上限）
    expect(MEMORY_VIEW_NODE_LIMIT_MAX).toBe(200);
    expect(MEMORY_VIEW_EDGE_LIMIT_MAX).toBe(600);
  });

  it('`@Type(() => Number)` 生效：数字串被转换后按数字判（"50" 过 / "201" 拒）', async () => {
    // 全局 ValidationPipe 带 transform:true，query 里的一切都是字符串——`@Type` 是这层的前提
    expect((graphDto({ nodeLimit: '50' }) as { nodeLimit: number }).nodeLimit).toBe(50);
    expect(await validate(graphDto({ nodeLimit: '50' }))).toHaveLength(0);
    expect(await failingProps(graphDto({ nodeLimit: '201' }))).toEqual(['nodeLimit']);
  });

  it('非整数拒（1.5 不落到引擎的 invalid_argument）', async () => {
    expect(await failingProps(graphDto({ nodeLimit: 1.5 }))).toEqual(['nodeLimit']);
  });

  it('游标长度：4096 当档通过 / 4097 拒（合同 cursor maxLength 4096）', async () => {
    expect(
      await validate(graphDto({ cursor: 'c'.repeat(MEMORY_VIEW_CURSOR_MAX_LENGTH) })),
    ).toHaveLength(0);
    expect(
      await failingProps(graphDto({ cursor: 'c'.repeat(MEMORY_VIEW_CURSOR_MAX_LENGTH + 1) })),
    ).toEqual(['cursor']);
    // 空串不是"没传"（`undefined` 才是），拒
    expect(await failingProps(graphDto({ cursor: '' }))).toEqual(['cursor']);
  });

  it('枚举词表外值全部拒（**含响应域专有的 `any`**）', async () => {
    // ⚠️ 本用例是"请求域 ⊊ 响应域"的守卫：graph 响应的 filters 回声每维多一个 `any`，
    //    但请求侧传 `any` 是非法的（引擎按非法枚举拒），平台必须在 DTO 先挡。
    expect(await failingProps(graphDto({ kind: 'any' }))).toEqual(['kind']);
    expect(await failingProps(graphDto({ status: 'any' }))).toEqual(['status']);
    expect(await failingProps(graphDto({ activeResolution: 'any' }))).toEqual(['activeResolution']);
    expect(await failingProps(graphDto({ availableResolution: 'any' }))).toEqual([
      'availableResolution',
    ]);
    expect(await failingProps(graphDto({ anchorState: 'any' }))).toEqual(['anchorState']);
    expect(await failingProps(graphDto({ relationType: 'any' }))).toEqual(['relationType']);

    // 域内但错位：`withdrawn` 是**账本行**状态，不在引擎记忆状态域里
    expect(await failingProps(graphDto({ status: 'withdrawn' }))).toEqual(['status']);
    // 分辨率只有 R0..R4
    expect(await failingProps(graphDto({ activeResolution: 'R5' }))).toEqual(['activeResolution']);
    // 关系边五类，`correction`（账本侧概念）不是引擎边类型
    expect(await failingProps(graphDto({ relationType: 'correction' }))).toEqual(['relationType']);
  });

  it('枚举词表内值全部通过（含全部五类边与四个状态）', async () => {
    for (const value of ['observation', 'episode', 'concept', 'belief', 'procedure']) {
      expect(await validate(graphDto({ kind: value }))).toHaveLength(0);
    }
    for (const value of ['active', 'superseded', 'archived']) {
      expect(await validate(graphDto({ status: value }))).toHaveLength(0);
    }
    for (const value of ['R0', 'R1', 'R2', 'R3', 'R4']) {
      expect(await validate(graphDto({ activeResolution: value }))).toHaveLength(0);
    }
    for (const value of ['none', 'fresh', 'stale', 'unknown', 'failed']) {
      expect(await validate(graphDto({ anchorState: value }))).toHaveLength(0);
    }
    for (const value of ['derived_from', 'supports', 'contradicts', 'supersedes', 'part_of']) {
      expect(await validate(graphDto({ relationType: value }))).toHaveLength(0);
    }
  });

  it('createdFrom/createdTo：单侧通过、合法区间通过、**from > to 拒**、非法日期串拒', async () => {
    expect(await validate(graphDto({ createdFrom: '2026-01-01T00:00:00Z' }))).toHaveLength(0);
    expect(await validate(graphDto({ createdTo: '2026-01-01T00:00:00Z' }))).toHaveLength(0);
    expect(
      await validate(
        graphDto({ createdFrom: '2026-01-01T00:00:00Z', createdTo: '2026-02-01T00:00:00Z' }),
      ),
    ).toHaveLength(0);
    // 跨字段顺序：两个都给了却不自洽 = 恒错输入（引擎必 400），在边界层先挡
    expect(
      await failingProps(
        graphDto({ createdFrom: '2026-02-01T00:00:00Z', createdTo: '2026-01-01T00:00:00Z' }),
      ),
    ).toEqual(['createdTo']);
    // 形态不符（非 RFC3339）
    expect(await failingProps(graphDto({ createdFrom: 'yesterday' }))).toEqual(['createdFrom']);
  });

  it('带时区偏移的 RFC3339 合法且顺序判据按**时间**（不是字符串字典序）', async () => {
    // `2026-01-01T00:00:00+08:00` = UTC 2025-12-31T16:00Z，早于 `2026-01-01T00:00:00Z`
    expect(
      await validate(
        graphDto({ createdFrom: '2026-01-01T00:00:00+08:00', createdTo: '2026-01-01T00:00:00Z' }),
      ),
    ).toHaveLength(0);
    // 反过来（字符串字典序会判它"合法"，实际是 from > to）
    expect(
      await failingProps(
        graphDto({ createdFrom: '2026-01-01T00:00:00Z', createdTo: '2026-01-01T00:00:00+08:00' }),
      ),
    ).toEqual(['createdTo']);
  });

  it('`scope` 等未声明键被 `forbidNonWhitelisted` 拒（与全局 ValidationPipe 同配置）', async () => {
    // 与 main.ts 的管道逐项同配置；DTO 类元类型 ⇒ 真被校验（对照见下方"裸串参数"用例）
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const params = { type: 'query' as const, metatype: QueryMemoryViewGraphDto, data: '' };

    await expect(pipe.transform({ nodeLimit: 50 }, params)).resolves.toBeDefined();
    await expect(pipe.transform({ scope: 'actor_private' }, params)).rejects.toThrow();
    // 未知键与 `scope` 同类：作用域不在调用方的选择面里（引擎层恒填 actor_private）
    await expect(pipe.transform({ mode: 'browse' }, params)).rejects.toThrow();
  });
});

describe('QueryMemoryViewRelationsDto / QueryMemoryViewHistoryDto', () => {
  it('relationLimit：128 当档通过 / 129 拒；relationCursor：4096 通过 / 4097 拒', async () => {
    const ok = plainToInstance(QueryMemoryViewRelationsDto, {
      relationLimit: MEMORY_VIEW_RELATION_LIMIT_MAX,
      relationCursor: 'c'.repeat(MEMORY_VIEW_CURSOR_MAX_LENGTH),
    });
    expect(await validate(ok)).toHaveLength(0);

    expect(
      await failingProps(
        plainToInstance(QueryMemoryViewRelationsDto, {
          relationLimit: MEMORY_VIEW_RELATION_LIMIT_MAX + 1,
        }),
      ),
    ).toEqual(['relationLimit']);
    expect(
      await failingProps(
        plainToInstance(QueryMemoryViewRelationsDto, {
          relationCursor: 'c'.repeat(MEMORY_VIEW_CURSOR_MAX_LENGTH + 1),
        }),
      ),
    ).toEqual(['relationCursor']);
  });

  it('historyLimit：100 当档通过 / 101 拒；cursor 同 graph 的长度闸门', async () => {
    expect(
      await validate(
        plainToInstance(QueryMemoryViewHistoryDto, {
          historyLimit: MEMORY_VIEW_HISTORY_LIMIT_MAX,
          cursor: 'c'.repeat(MEMORY_VIEW_CURSOR_MAX_LENGTH),
        }),
      ),
    ).toHaveLength(0);

    expect(
      await failingProps(
        plainToInstance(QueryMemoryViewHistoryDto, {
          historyLimit: MEMORY_VIEW_HISTORY_LIMIT_MAX + 1,
        }),
      ),
    ).toEqual(['historyLimit']);
    expect(
      await failingProps(plainToInstance(QueryMemoryViewHistoryDto, { historyLimit: 0 })),
    ).toEqual(['historyLimit']);
  });
});

describe('路径参数 DTO（三个单记忆端点）', () => {
  const UUID = '44444444-4444-4444-8444-444444444444';

  it.each([
    ['MemoryViewDetailParamsDto', MemoryViewDetailParamsDto, { engineMemoryId: 'mem-1' }],
    [
      'MemoryViewHistoryParamsDto',
      MemoryViewHistoryParamsDto,
      { engineMemoryId: 'mem-1', resolution: 'R2' },
    ],
    [
      'MemoryViewRepresentationParamsDto',
      MemoryViewRepresentationParamsDto,
      { engineMemoryId: 'mem-1', representationId: 'repr-1' },
    ],
  ])('%s：`:id` 非 UUID 拒（等价 ParseUUIDPipe 的 400）', async (_label, Dto, rest) => {
    // 除 id 外**该路由的全部路径参数**都要给齐：`failingProps` 断言的是"恰好只有 id 报错"
    // ——漏给一个合法参数会把它自己也变成报错项，用例就会以"断言写错"的方式红（而非误报实现错）
    expect(await failingProps(plainToInstance(Dto, { id: 'not-a-uuid', ...rest }))).toEqual(['id']);
  });

  it('`engineMemoryId` 长度闸门：1..128 通过，空串与 129 拒（合同 maxLength 128）', async () => {
    const atLimit = plainToInstance(MemoryViewDetailParamsDto, {
      id: UUID,
      engineMemoryId: 'm'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH),
    });
    expect(await validate(atLimit)).toHaveLength(0);

    expect(
      await failingProps(
        plainToInstance(MemoryViewDetailParamsDto, {
          id: UUID,
          engineMemoryId: 'm'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH + 1),
        }),
      ),
    ).toEqual(['engineMemoryId']);
    expect(
      await failingProps(
        plainToInstance(MemoryViewDetailParamsDto, { id: UUID, engineMemoryId: '' }),
      ),
    ).toEqual(['engineMemoryId']);
  });

  it('`representationId` 同样有长度闸门（129 拒）；history 的 `resolution` 词表外拒', async () => {
    expect(
      await failingProps(
        plainToInstance(MemoryViewRepresentationParamsDto, {
          id: UUID,
          engineMemoryId: 'mem-1',
          representationId: 'r'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH + 1),
        }),
      ),
    ).toEqual(['representationId']);
    expect(
      await validate(
        plainToInstance(MemoryViewRepresentationParamsDto, {
          id: UUID,
          engineMemoryId: 'mem-1',
          representationId: 'r'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH),
        }),
      ),
    ).toHaveLength(0);

    expect(
      await failingProps(
        plainToInstance(MemoryViewHistoryParamsDto, {
          id: UUID,
          engineMemoryId: 'mem-1',
          resolution: 'R9',
        }),
      ),
    ).toEqual(['resolution']);
    expect(
      await validate(
        plainToInstance(MemoryViewHistoryParamsDto, {
          id: UUID,
          engineMemoryId: 'mem-1',
          resolution: 'R2',
        }),
      ),
    ).toHaveLength(0);
  });

  it('**裸字符串参数上的装饰器不生效**（本套件改用 params DTO 的实测依据）', async () => {
    // 全局 ValidationPipe 的 `toValidate` 对**标量元类型**（String/Number/…）直接短路：
    // 同一份 pipe 对 String 元类型**原样放行**（哪怕值有 200 字符、远超任何 @Length 闸门），
    // 而对类元类型会校验并抛错。故 `@Length` 写在裸 `@Param('engineMemoryId') x: string` 上
    // 是一段永不生效的死代码 —— 三个单记忆端点的路径参数因此统一走 params DTO。
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const overlong = 'm'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH + 72);

    const asPrimitive = await pipe.transform(overlong, {
      type: 'param',
      metatype: String,
      data: 'engineMemoryId',
    });
    expect(asPrimitive).toBe(overlong); // 未被校验

    await expect(
      pipe.transform(
        { id: UUID, engineMemoryId: overlong },
        { type: 'param', metatype: MemoryViewDetailParamsDto, data: '' },
      ),
    ).rejects.toThrow(); // 类元类型 ⇒ 真被校验
  });
});

describe('relations 端点（关系建议）：空 query DTO + 路径参数', () => {
  /** 本 describe 内的项目 UUID（上一个 describe 的同名常量是块级作用域，不能跨块复用） */
  const UUID = '44444444-4444-4444-8444-444444444444';

  it('`MemoryViewRelationsParamsDto`：`id` 必须是 UUID、`engineMemoryId` 有长度闸门（与其余单记忆端点同档）', async () => {
    expect(
      await validate(
        plainToInstance(MemoryViewRelationsParamsDto, { id: UUID, engineMemoryId: 'mem-1' }),
      ),
    ).toHaveLength(0);

    expect(
      await failingProps(
        plainToInstance(MemoryViewRelationsParamsDto, { id: 'not-a-uuid', engineMemoryId: 'mem-1' }),
      ),
    ).toEqual(['id']);

    const tooLong = 'm'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH + 1);
    // 129 拒 / 128 通过（**不是** UUID：引擎侧 memory id 形如 `mem_xxx`）
    expect(
      await failingProps(
        plainToInstance(MemoryViewRelationsParamsDto, { id: UUID, engineMemoryId: tooLong }),
      ),
    ).toEqual(['engineMemoryId']);
    expect(
      await validate(
        plainToInstance(MemoryViewRelationsParamsDto, {
          id: UUID,
          engineMemoryId: 'm'.repeat(MEMORY_VIEW_ENGINE_ID_MAX_LENGTH),
        }),
      ),
    ).toHaveLength(0);
  });

  it('`QueryMemoryViewRelationAdvisoriesDto` 是**空类**：任何 query 键（含 `scope`）都被 `forbidNonWhitelisted` 拒', async () => {
    // 与 main.ts 的管道逐项同配置（`forbidUnknownValues` 由 @nestjs/common 的 ValidationPipe
    // 缺省置 false，故空类**不会**因为"没有校验元数据"而被短路成 unknownValue 错误）
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const params = {
      type: 'query' as const,
      metatype: QueryMemoryViewRelationAdvisoriesDto,
      data: '',
    };

    // 无 query ⇒ 通过（本端点**真的**没有查询参数）
    await expect(pipe.transform({}, params)).resolves.toBeDefined();
    // ⚠️ 契约上 `scope` 由平台从注册表派生、恒 actor_private ⇒ 调用方自带即 400（fail-closed）
    await expect(pipe.transform({ scope: 'actor_private' }, params)).rejects.toThrow();
    // 其余读面族的 query 参数（detail 的 relationLimit / graph 的 nodeLimit）在这里**不存在**
    await expect(pipe.transform({ relationLimit: '5' }, params)).rejects.toThrow();
    await expect(pipe.transform({ nodeLimit: '5' }, params)).rejects.toThrow();
    await expect(pipe.transform({ cursor: 'abc' }, params)).rejects.toThrow();
  });
});
