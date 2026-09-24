import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ApiUsageStatsHourly } from '../../database/entities/api-usage-stats-hourly.entity';
import { ApiUsageQueryService } from './api-usage-query.service';
import { ApiUsageQueryDto } from './dto/api-usage-query.dto';
import {
  API_USAGE_DEFAULT_LIMIT,
  API_USAGE_DAY_MS,
  API_USAGE_MAX_SPAN_DAYS,
  API_USAGE_MCP_ROUTE_LIKE,
} from './usage-stats-query.constants';
import { USAGE_STATS_TOOL_ROUTE } from './usage-stats.constants';

/** 一次 createQueryBuilder 调用记录的 SQL 形状（供断言"生成了什么 SQL"） */
interface RecordedQuery {
  selections: Array<[string, string]>;
  conditions: Array<[string, Record<string, unknown> | undefined]>;
  joins: Array<[string, string, string]>;
  groupBy: string[];
  orderBy: Array<[string, string]>;
  limit?: number;
}

/**
 * 仓储 mock：每次 createQueryBuilder 返回一个记录调用的链式 builder。
 *
 * 调用顺序（service 固定三连）：[0] pass1 聚合 → [1] pass2 distinctActors（无键时省略）
 * → 末位 全表 MIN(bucket_start)。`rawMany` 按序消费（pass1 → pass2）。
 */
function createRepoMock(config: { rawMany?: unknown[][]; rawOne?: unknown } = {}) {
  const queries: RecordedQuery[] = [];
  const rawManyQueue = [...(config.rawMany ?? [])];
  const repo = {
    createQueryBuilder: jest.fn(() => {
      const record: RecordedQuery = {
        selections: [],
        conditions: [],
        joins: [],
        groupBy: [],
        orderBy: [],
      };
      queries.push(record);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qb: any = {
        select: (expr: string, alias: string) => {
          record.selections.push([expr, alias]);
          return qb;
        },
        addSelect: (expr: string, alias: string) => {
          record.selections.push([expr, alias]);
          return qb;
        },
        where: (sql: string, params?: Record<string, unknown>) => {
          record.conditions.push([sql, params]);
          return qb;
        },
        andWhere: (sql: string, params?: Record<string, unknown>) => {
          record.conditions.push([sql, params]);
          return qb;
        },
        leftJoin: (table: string, alias: string, on: string) => {
          record.joins.push([table, alias, on]);
          return qb;
        },
        groupBy: (expr: string) => {
          record.groupBy.push(expr);
          return qb;
        },
        orderBy: (expr: string, direction: string) => {
          record.orderBy.push([expr, direction]);
          return qb;
        },
        limit: (n: number) => {
          record.limit = n;
          return qb;
        },
        getRawMany: jest.fn(async () => rawManyQueue.shift() ?? []),
        getRawOne: jest.fn(async () => config.rawOne ?? null),
      };
      return qb;
    }),
  };
  return { repo: repo as unknown as Repository<ApiUsageStatsHourly>, queries };
}

/** 定位某条 where/andWhere 片段（不存在则抛，避免"没找到=没断言"的假绿） */
function findCondition(record: RecordedQuery, fragment: string) {
  const found = record.conditions.find(([sql]) => sql.includes(fragment));
  if (!found) throw new Error(`condition not found: ${fragment}`);
  return found;
}

/** 一条 pass1 聚合原始行（bigint/numeric 用 string 形态——pg 驱动的真实行为） */
function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    key: 'task',
    call_count: '12',
    latency_sum_ms: '3400',
    max_latency_ms: 900,
    error_count: '3',
    ...overrides,
  };
}

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('ApiUsageQueryService — 口径隔离（D8 核心）', () => {
  it('groupBy=tool 缺省锚定 invocation 行（route=mcp://tools/call），不受扇出影响', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    const [, scopeParams] = findCondition(queries[0], 's.route = :scopeInvocationRoute');
    expect(scopeParams).toEqual({ scopeInvocationRoute: USAGE_STATS_TOOL_ROUTE });
    // 工具口径只锚 route，不该再叠 channel 条件（叠了会与 4xx/5xx 扇出行语义打架）
    expect(queries[0].conditions.some(([sql]) => sql.includes('s.channel'))).toBe(false);
  });

  it('groupBy=tool + metric=rest_calls 取扇出 REST 行（channel=rest 且 tool_name 非空）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'tool', metric: 'rest_calls' } as ApiUsageQueryDto, NOW);

    const [, channelParams] = findCondition(queries[0], 's.channel = :scopeFanoutChannel');
    expect(channelParams).toEqual({ scopeFanoutChannel: 'rest' });
    expect(findCondition(queries[0], "s.tool_name <> ''")).toBeDefined();
    expect(queries[0].conditions.some(([sql]) => sql.includes(':scopeInvocationRoute'))).toBe(false);
  });

  it('groupBy=route 默认排除 mcp://% 伪路由', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'route' } as ApiUsageQueryDto, NOW);

    const [, params] = findCondition(queries[0], 's.route NOT LIKE :scopeMcpRouteLike');
    expect(params).toEqual({ scopeMcpRouteLike: API_USAGE_MCP_ROUTE_LIKE });
  });

  it('显式 route 参数覆盖默认排除（退化为精确等值，参数化绑定）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query(
      { groupBy: 'route', route: `${USAGE_STATS_TOOL_ROUTE}` } as ApiUsageQueryDto,
      NOW,
    );

    expect(queries[0].conditions.some(([sql]) => sql.includes('NOT LIKE'))).toBe(false);
    const [, params] = findCondition(queries[0], 's.route = :filterRoute');
    expect(params).toEqual({ filterRoute: USAGE_STATS_TOOL_ROUTE });
  });

  it('groupBy=actor 不设路由条件（invocation 行与扇出 REST 行求和）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'actor' } as ApiUsageQueryDto, NOW);

    const scopeLikeConditions = queries[0].conditions.filter(([sql]) =>
      sql.includes('s.route') || sql.includes('s.channel'),
    );
    expect(scopeLikeConditions).toHaveLength(0);
    expect(queries[0].groupBy).toEqual(['s.actor_id']);
  });
});

describe('ApiUsageQueryService — 互斥与窗口边界（一律 400，不静默忽略）', () => {
  it('metric 与 groupBy≠tool 同传 → 400，且不执行任何查询', async () => {
    const { repo, queries } = createRepoMock();
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query({ groupBy: 'route', metric: 'invocations' } as ApiUsageQueryDto, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queries).toHaveLength(0);
  });

  it('metric 与 groupBy=actor 同传 → 400', async () => {
    const { repo } = createRepoMock();
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query({ groupBy: 'actor', metric: 'rest_calls' } as ApiUsageQueryDto, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('metric=invocations（含缺省）与显式 route 同传 → 400（仅工具口径内）', async () => {
    const { repo } = createRepoMock();
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query({ groupBy: 'tool', route: '/api/v1/tasks' } as ApiUsageQueryDto, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.query(
        { groupBy: 'tool', metric: 'invocations', route: '/api/v1/tasks' } as ApiUsageQueryDto,
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('非工具口径下 route 过滤照常放行（否则 groupBy=route 的显式覆盖将永远不可达）', async () => {
    const { repo } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query({ groupBy: 'route', route: '/api/v1/tasks' } as ApiUsageQueryDto, NOW),
    ).resolves.toBeDefined();
    await expect(
      service.query({ groupBy: 'actor', route: '/api/v1/tasks' } as ApiUsageQueryDto, NOW),
    ).resolves.toBeDefined();
  });

  it('metric=rest_calls 与显式 route 允许同传（互斥只针对 invocation 口径）', async () => {
    const { repo } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query(
        { groupBy: 'tool', metric: 'rest_calls', route: '/api/v1/tasks' } as ApiUsageQueryDto,
        NOW,
      ),
    ).resolves.toBeDefined();
  });

  it('跨度 >90 天 → 400，文案可操作（含"请分段查询"与 SQL 配方指引）', async () => {
    const { repo } = createRepoMock();
    const service = new ApiUsageQueryService(repo);
    const to = NOW;
    const from = new Date(to.getTime() - (API_USAGE_MAX_SPAN_DAYS + 10) * API_USAGE_DAY_MS);

    await expect(
      service.query(
        { groupBy: 'route', from: from.toISOString(), to: to.toISOString() } as ApiUsageQueryDto,
        NOW,
      ),
    ).rejects.toThrow(/请分段查询/);
    await expect(
      service.query(
        { groupBy: 'route', from: from.toISOString(), to: to.toISOString() } as ApiUsageQueryDto,
        NOW,
      ),
    ).rejects.toThrow(/SQL 配方/);
  });

  it('恰好 90 天跨度放行（边界含等于）', async () => {
    const { repo } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);
    const to = NOW;
    const from = new Date(to.getTime() - API_USAGE_MAX_SPAN_DAYS * API_USAGE_DAY_MS);

    await expect(
      service.query(
        { groupBy: 'route', from: from.toISOString(), to: to.toISOString() } as ApiUsageQueryDto,
        NOW,
      ),
    ).resolves.toBeDefined();
  });

  it('to < from → 400（静默返回空集会被读成"零使用"的假结论）', async () => {
    const { repo } = createRepoMock();
    const service = new ApiUsageQueryService(repo);

    await expect(
      service.query(
        { groupBy: 'route', from: NOW.toISOString(), to: '2020-01-01T00:00:00.000Z' } as ApiUsageQueryDto,
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ApiUsageQueryService — 窗口与排序', () => {
  it('默认窗口 = 最近 7 天（to=now，from=now−7d），且为半开区间', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    const response = await service.query({ groupBy: 'route' } as ApiUsageQueryDto, NOW);

    expect(response.meta.windowTo).toBe(NOW.toISOString());
    expect(response.meta.windowFrom).toBe(
      new Date(NOW.getTime() - 7 * API_USAGE_DAY_MS).toISOString(),
    );
    const [, windowParams] = findCondition(queries[0], 's.bucket_start >= :windowFrom');
    expect(windowParams).toEqual({ windowFrom: new Date(NOW.getTime() - 7 * API_USAGE_DAY_MS) });
    // 终点开区间：含终点会把尚未走完的当前小时桶算进来
    expect(findCondition(queries[0], 's.bucket_start < :windowTo')).toBeDefined();
  });

  it('默认 limit=20 / sortBy=callCount desc', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'route' } as ApiUsageQueryDto, NOW);

    expect(queries[0].limit).toBe(API_USAGE_DEFAULT_LIMIT);
    expect(queries[0].orderBy[0]).toEqual(['COALESCE(SUM(s.call_count), 0)', 'DESC']);
  });

  it('limit / order 透传到 SQL', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'tool', limit: 5, order: 'asc' } as ApiUsageQueryDto, NOW);

    expect(queries[0].limit).toBe(5);
    expect(queries[0].orderBy[0][1]).toBe('ASC');
  });

  it('sortBy=avgLatencyMs 的排序表达式带 ::numeric（bigint/int 是整数除法，不转会截断）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'route', sortBy: 'avgLatencyMs' } as ApiUsageQueryDto, NOW);

    expect(queries[0].orderBy[0][0]).toContain('::numeric');
    expect(queries[0].orderBy[0][0]).toContain('SUM(s.latency_sum_ms)');
  });

  it('sortBy=errorRate 的排序表达式按 4xx/5xx 计数计算', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'route', sortBy: 'errorRate' } as ApiUsageQueryDto, NOW);

    expect(queries[0].orderBy[0][0]).toContain("'4xx', '5xx'");
  });
});

describe('ApiUsageQueryService — 聚合输出', () => {
  it('bigint/numeric 出口一律 Number()（pg 驱动把 int8/numeric 读成 string）', async () => {
    const { repo } = createRepoMock({ rawMany: [[aggregateRow()]] });
    const service = new ApiUsageQueryService(repo);

    const { items } = await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    expect(items[0].callCount).toBe(12);
    expect(typeof items[0].callCount).toBe('number');
    // 3400 / 12 → 283.33… 四舍五入
    expect(items[0].avgLatencyMs).toBe(283);
    expect(items[0].maxLatencyMs).toBe(900);
    expect(items[0].errorRate).toBe(0.25);
    expect(items[0].key).toBe('task');
  });

  it('空结果不报错：callCount=0 时 avg/errorRate 归 0（不做除零）', async () => {
    const { repo } = createRepoMock({
      rawMany: [[aggregateRow({ call_count: '0', latency_sum_ms: '0', error_count: '0' })]],
    });
    const service = new ApiUsageQueryService(repo);

    const { items } = await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    expect(items[0].callCount).toBe(0);
    expect(items[0].avgLatencyMs).toBe(0);
    expect(items[0].errorRate).toBe(0);
  });

  it('distinctActors 只对 pass1 返回的 top-N 键做二次查询（IN 参数化）', async () => {
    const { repo, queries } = createRepoMock({
      rawMany: [
        [aggregateRow({ key: 'task' }), aggregateRow({ key: 'board', call_count: '3' })],
        [{ key: 'task', distinct_actors: '4' }],
      ],
    });
    const service = new ApiUsageQueryService(repo);

    const { items } = await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    expect(items[0].distinctActors).toBe(4);
    // 未出现在 pass2 结果里的键 → 0（不是 NaN/undefined）
    expect(items[1].distinctActors).toBe(0);
    const [, pass2Params] = findCondition(queries[1], 'IN (:...keys)');
    expect(pass2Params).toEqual({ keys: ['task', 'board'] });
    expect(queries[1].groupBy).toEqual(['s.tool_name']);
  });

  it('pass2 与 pass1 共用同一套过滤（口径不漂移），且不带 limit', async () => {
    const { repo, queries } = createRepoMock({
      rawMany: [[aggregateRow()], [{ key: 'task', distinct_actors: '1' }]],
    });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'tool', channel: 'mcp' } as ApiUsageQueryDto, NOW);

    const pass1Sql = queries[0].conditions.map(([sql]) => sql);
    const pass2Sql = queries[1].conditions.map(([sql]) => sql).filter((sql) => !sql.includes('IN (:...keys)'));
    expect(pass2Sql).toEqual(pass1Sql);
    expect(queries[1].limit).toBeUndefined();
  });

  it('pass1 无行时不执行 pass2（省掉必然为空的查询）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    const { items } = await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    expect(items).toHaveLength(0);
    // 只剩 pass1 + 全表 MIN 两次 createQueryBuilder
    expect(queries).toHaveLength(2);
    expect(queries[1].selections[0][1]).toBe('earliest');
  });

  it('groupBy=actor 回显 actorName/actorType；匿名行（actor_id NULL）→ anonymous 且 distinctActors=0', async () => {
    const { repo } = createRepoMock({
      rawMany: [
        [
          aggregateRow({ key: '11111111-1111-4111-8111-111111111111', actor_name: 'kimi-1', actor_type: 'agent' }),
          aggregateRow({ key: null, actor_name: 'anonymous', actor_type: 'anonymous', call_count: '9' }),
        ],
      ],
    });
    const service = new ApiUsageQueryService(repo);

    const { items } = await service.query({ groupBy: 'actor' } as ApiUsageQueryDto, NOW);

    expect(items[0]).toMatchObject({ actorName: 'kimi-1', actorType: 'agent' });
    expect(items[1]).toMatchObject({ key: null, actorName: 'anonymous', actorType: 'anonymous', distinctActors: 0 });
  });

  it('groupBy=actor 的 LEFT JOIN 命中 actors，且显示名走聚合（不赌 PG 函数依赖推断）', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[aggregateRow({ key: null })]] });
    const service = new ApiUsageQueryService(repo);

    await service.query({ groupBy: 'actor' } as ApiUsageQueryDto, NOW);

    expect(queries[0].joins).toContainEqual(['actors', 'ac', 'ac.id = s.actor_id']);
    const actorNameSelect = queries[0].selections.find(([, alias]) => alias === 'actor_name');
    expect(actorNameSelect?.[0]).toContain('MAX(ac.display_name)');
    expect(actorNameSelect?.[0]).toContain('deleted actor');
  });

  it('meta 回显：窗口 + 全表最早桶 + 覆盖天数 + 生效口径', async () => {
    const earliest = new Date('2026-08-01T00:00:00.000Z');
    const { repo, queries } = createRepoMock({ rawMany: [[]], rawOne: { earliest } });
    const service = new ApiUsageQueryService(repo);

    const { meta } = await service.query({ groupBy: 'tool' } as ApiUsageQueryDto, NOW);

    expect(meta.windowFrom).toBe(new Date(NOW.getTime() - 7 * API_USAGE_DAY_MS).toISOString());
    expect(meta.windowTo).toBe(NOW.toISOString());
    expect(meta.earliestBucketStart).toBe(earliest.toISOString());
    // (2026-09-15T12:00 − 2026-08-01T00:00) = 45.5 天
    expect(meta.dataCoverageDays).toBe(45.5);
    expect(meta.groupBy).toBe('tool');
    expect(meta.metric).toBe('invocations');
    // 覆盖度查询是**全表** MIN，不带窗口条件
    const minQuery = queries[queries.length - 1];
    expect(minQuery.selections[0][0]).toBe('MIN(s.bucket_start)');
    expect(minQuery.conditions).toHaveLength(0);
  });

  it('groupBy≠tool 时 meta.metric 回显 null（该参数不适用，回显会误导读法）', async () => {
    const { repo } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);

    const { meta } = await service.query({ groupBy: 'route' } as ApiUsageQueryDto, NOW);

    expect(meta.metric).toBeNull();
  });

  it('空表时 meta 覆盖度为 null（0 会被读成"有数据但覆盖 0 天"）', async () => {
    const { repo } = createRepoMock({ rawMany: [[]], rawOne: { earliest: null } });
    const service = new ApiUsageQueryService(repo);

    const { meta } = await service.query({ groupBy: 'route' } as ApiUsageQueryDto, NOW);

    expect(meta.earliestBucketStart).toBeNull();
    expect(meta.dataCoverageDays).toBeNull();
  });
});

describe('ApiUsageQueryService — 过滤参数一律参数化绑定', () => {
  it('七个过滤值全部作为具名参数绑定，SQL 片段里不出现原始值', async () => {
    const { repo, queries } = createRepoMock({ rawMany: [[]] });
    const service = new ApiUsageQueryService(repo);
    const filters = {
      channel: 'mcp',
      surface: 'mcp',
      actorType: 'agent',
      actorId: '11111111-1111-4111-8111-111111111111',
      tool: 'task',
      method: 'TOOL',
    };

    await service.query({ groupBy: 'tool', ...filters } as ApiUsageQueryDto, NOW);

    const expected: Record<string, string> = {
      ':filterChannel': 'mcp',
      ':filterSurface': 'mcp',
      ':filterActorType': 'agent',
      ':filterActorId': filters.actorId,
      ':filterTool': 'task',
      ':filterMethod': 'TOOL',
    };
    for (const [placeholder, value] of Object.entries(expected)) {
      const found = queries[0].conditions.find(([sql]) => sql.includes(placeholder));
      expect(found).toBeDefined();
      expect(Object.values(found?.[1] ?? {})).toContain(value);
    }
    // 反向断言：SQL 文本里不得出现过滤值字面量（防未来有人改成字符串拼接）
    const sqlText = queries[0].conditions.map(([sql]) => sql).join(' | ');
    expect(sqlText).not.toContain(filters.actorId);
    expect(sqlText).not.toContain('agent');
  });
});
