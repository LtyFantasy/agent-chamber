/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 调用频率统计的内存聚合与 flush 落库契约
 *
 * [代码职责]
 *   - 钉死 plan §4 批 1.6 清单：聚合键 / 安全阀坍缩（三字段同归 + TOOL 豁免）/
 *     flush SQL 形状 / swap 与失败合回 / 重入锁 / 关停超时护栏 / 上报行映射
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 口径专章
 *   - 依据: plan rocket-batwoman-booster-gold §3（flush SQL 定稿）、§2 D6/D10/D11、§6 测试契约
 *
 * [关键不变量]
 *   - 同维度行单调累加、不重复插行；失败 flush 的数据必须合回（不得静默丢窗口）
 *   - 溢出桶三字段同归；TOOL 行豁免坍缩
 *   - SQL 的 GROUP BY / ORDER BY / 9 列 conflict_target 三处不得被"优化"掉
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改动 flush 语义时同步改本文件的断言（测试即文档）
 * =============================================================================
 */
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  USAGE_STATS_INSERT_SQL,
  UsageStatsBufferService,
  UsageStatsHttpCall,
} from './usage-stats-buffer.service';
import {
  USAGE_FLUSH_DEFAULT_INTERVAL_MS,
  USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS,
  USAGE_STATS_MAX_KEYS,
  USAGE_STATS_OVERFLOW_ROUTE,
  USAGE_STATS_TOOL_ROUTE,
  USAGE_TOOL_NAME_MAX_LENGTH,
} from './usage-stats.constants';

/** flush SQL 的 12 个 jsonb 别名（行形状契约） */
const FLUSH_ROW_KEYS = ['a', 'at', 'b', 'cc', 'ch', 'lm', 'ls', 'm', 'rt', 'sc', 'sf', 'tn'];

describe('UsageStatsBufferService', () => {
  let query: jest.Mock;
  let service: UsageStatsBufferService;

  const makeDataSource = (queryImpl?: jest.Mock): DataSource =>
    ({ query: queryImpl ?? query }) as unknown as DataSource;

  /** 造一次 REST 调用样本（维度可覆盖） */
  const httpCall = (overrides: Partial<UsageStatsHttpCall> = {}): UsageStatsHttpCall => ({
    bucketStart: new Date('2026-09-15T10:00:00.000Z'),
    channel: 'rest',
    mcpSurface: '',
    toolName: '',
    method: 'GET',
    route: '/api/v1/topics/:id',
    actorId: 'agent-1',
    actorType: 'agent',
    statusClass: '2xx',
    latencyMs: 10,
    ...overrides,
  });

  /** 取第 N 次 flush 实际发出的行数组 */
  const flushedRows = (callIndex = 0): Record<string, unknown>[] =>
    JSON.parse(query.mock.calls[callIndex][1][0] as string) as Record<string, unknown>[];

  beforeEach(() => {
    // Logger 噪音抑制（错误路径断言多，日志会淹没输出）
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    query = jest.fn().mockResolvedValue([]);
    service = new UsageStatsBufferService(makeDataSource());
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe('聚合键（同维度累加，不重复插行）', () => {
    it('同维度两次调用 → 1 个键、1 行、call_count=2、sum/max 分别累加', async () => {
      service.recordHttpCall(httpCall({ latencyMs: 10 }));
      service.recordHttpCall(httpCall({ latencyMs: 25 }));
      expect(service.bufferedKeyCount).toBe(1);

      const result = await service.flush();
      expect(result).toMatchObject({ rows: 1, skipped: false, failed: false });
      expect(flushedRows()[0]).toMatchObject({ cc: 2, ls: 35, lm: 25, rt: '/api/v1/topics/:id' });
    });

    it('任一维度不同即不同键（状态类 / 路由 / 耗时不影响键）', () => {
      service.recordHttpCall(httpCall());
      service.recordHttpCall(httpCall({ statusClass: '4xx' }));
      service.recordHttpCall(httpCall({ route: '/api/v1/tasks/:id' }));
      service.recordHttpCall(httpCall({ actorId: null, actorType: 'anonymous' }));
      expect(service.bufferedKeyCount).toBe(4);
    });

    it('actorId=null 的匿名维度同样聚合（NULLS NOT DISTINCT 的应用侧对应）', async () => {
      service.recordHttpCall(httpCall({ actorId: null, actorType: 'anonymous' }));
      service.recordHttpCall(httpCall({ actorId: null, actorType: 'anonymous' }));
      await service.flush();
      expect(flushedRows()).toHaveLength(1);
      expect(flushedRows()[0]).toMatchObject({ a: null, at: 'anonymous', cc: 2 });
    });

    it('UTC 小时桶不同 → 不同键（跨桶不累加）', () => {
      service.recordHttpCall(httpCall());
      service.recordHttpCall(httpCall({ bucketStart: new Date('2026-09-15T11:00:00.000Z') }));
      expect(service.bufferedKeyCount).toBe(2);
    });
  });

  describe('flush 语义（swap + 合回 + 重入锁）', () => {
    it('空 buffer 不触发 SQL', async () => {
      const result = await service.flush();
      expect(result).toMatchObject({ rows: 0, failed: false });
      expect(query).not.toHaveBeenCalled();
    });

    it('成功后 buffer 清空（swap 语义：成功才丢弃）', async () => {
      service.recordHttpCall(httpCall());
      await service.flush();
      expect(service.bufferedKeyCount).toBe(0);
    });

    it('失败把整批合回（计数不丢），下轮重试把累计值一次性写入', async () => {
      query.mockRejectedValueOnce(new Error('connection refused'));
      service.recordHttpCall(httpCall({ latencyMs: 5 }));

      const first = await service.flush();
      expect(first).toMatchObject({ rows: 0, failed: true });
      expect(service.bufferedKeyCount).toBe(1);

      // 失败窗口内又到了一次新调用 → 合回后累加应叠加而不是覆盖
      service.recordHttpCall(httpCall({ latencyMs: 7 }));
      const second = await service.flush();
      expect(second).toMatchObject({ rows: 1, failed: false });
      expect(flushedRows(1)[0]).toMatchObject({ cc: 2, ls: 12, lm: 7 });
    });

    it('重入锁：在途 flush 期间再次 flush 直接跳过（不排队）', async () => {
      let release: (value: unknown[]) => void = () => undefined;
      const pending = new Promise<unknown[]>((resolve) => {
        release = resolve;
      });
      query.mockReturnValueOnce(pending);
      service.recordHttpCall(httpCall());

      const inFlight = service.flush();
      const skipped = await service.flush();
      expect(skipped).toMatchObject({ skipped: true, rows: 0, failed: false });
      expect(query).toHaveBeenCalledTimes(1);

      release([]);
      await inFlight;
    });

    it('flush 永不抛：SQL 失败也不 reject（调用方无需 try/catch）', async () => {
      query.mockRejectedValueOnce(new Error('boom'));
      service.recordHttpCall(httpCall());
      await expect(service.flush()).resolves.toMatchObject({ failed: true });
    });
  });

  describe('关停路径', () => {
    it('等待在途 flush 落定后再跑终局 flush（与常规路径的"跳过"语义相反）', async () => {
      let release: (value: unknown[]) => void = () => undefined;
      const pending = new Promise<unknown[]>((resolve) => {
        release = resolve;
      });
      query.mockReturnValueOnce(pending).mockResolvedValueOnce([]);

      service.recordHttpCall(httpCall({ route: '/api/v1/first' }));
      const inFlight = service.flush();
      service.recordHttpCall(httpCall({ route: '/api/v1/second' }));

      const shutdown = service.onApplicationShutdown();
      release([]);
      await inFlight;
      await shutdown;

      // 两次 SQL：在途那次 + 终局那次（若关停走了"跳过"分支，第二次 SQL 不会发生）
      expect(query).toHaveBeenCalledTimes(2);
      expect(JSON.parse(query.mock.calls[1][1][0] as string)).toHaveLength(1);
      expect(service.bufferedKeyCount).toBe(0);
    });

    it('DB 无响应时 10s 超时即放弃（不拖住部署进程）', async () => {
      jest.useFakeTimers();
      const hangService = new UsageStatsBufferService(
        makeDataSource(jest.fn().mockReturnValue(new Promise(() => undefined))),
      );
      try {
        hangService.recordHttpCall(httpCall());
        let settled = false;
        const shutdown = hangService.onApplicationShutdown().then(() => {
          settled = true;
        });

        await jest.advanceTimersByTimeAsync(USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS);
        await shutdown;
        expect(settled).toBe(true);
      } finally {
        hangService.onModuleDestroy();
        jest.useRealTimers();
      }
    });

    it('onModuleDestroy 清理定时器后不再产生 flush（幂等清理由 clearInterval 保证）', () => {
      expect(() => {
        service.onModuleDestroy();
        service.onModuleDestroy();
      }).not.toThrow();
    });
  });

  describe('安全阀（D6：坍缩三字段同归 + TOOL 行豁免）', () => {
    const fillToLimit = (): void => {
      for (let i = 0; i < USAGE_STATS_MAX_KEYS; i += 1) {
        service.recordHttpCall(httpCall({ route: `/api/v1/bulk/${i}` }));
      }
    };

    it('达上限后新键整键坍缩为溢出桶（route + tool_name + mcp_surface 三字段同归）', async () => {
      fillToLimit();
      expect(service.bufferedKeyCount).toBe(USAGE_STATS_MAX_KEYS);

      service.recordHttpCall(
        httpCall({ route: '/api/v1/new/route', toolName: 'brand.new.tool', mcpSurface: 'mcp' }),
      );

      await service.flush();
      const rows = flushedRows();
      const overflow = rows.filter((row) => row.rt === USAGE_STATS_OVERFLOW_ROUTE);
      expect(overflow).toHaveLength(1);
      // 其余维度保留（method/actor/status_class），只坍缩三字段
      expect(overflow[0]).toMatchObject({
        tn: '',
        sf: 'unknown',
        m: 'GET',
        a: 'agent-1',
        at: 'agent',
        sc: '2xx',
      });
      // 原始新键未被写入（坍缩的意义就是不再增长基数）
      expect(rows.some((row) => row.rt === '/api/v1/new/route')).toBe(false);
    });

    it('已存在的键不受安全阀影响（照常累加）', async () => {
      fillToLimit();
      service.recordHttpCall(httpCall({ route: '/api/v1/bulk/0' }));
      await service.flush();
      const row = flushedRows().find((r) => r.rt === '/api/v1/bulk/0');
      expect(row).toMatchObject({ cc: 2 });
    });

    it('method=TOOL 的 invocation 行豁免坍缩（否则工具统计从 invocation 视野消失）', async () => {
      fillToLimit();
      service.recordInvocation({
        toolName: 'topic.create',
        surface: 'mcp',
        ok: true,
        latencyMs: 12,
      });

      await service.flush();
      const toolRows = flushedRows().filter((row) => row.m === 'TOOL');
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0]).toMatchObject({
        rt: USAGE_STATS_TOOL_ROUTE,
        tn: 'topic.create',
        sf: 'mcp',
        ch: 'mcp',
        sc: '2xx',
        cc: 1,
        ls: 12,
      });
    });
  });

  describe('上报行映射（D4b：recordInvocation）', () => {
    it('行形状钉死：channel=mcp / method=TOOL / route=mcp://tools/call', async () => {
      service.recordInvocation({
        toolName: 'board.list_tasks',
        surface: 'mcp-full',
        ok: true,
        latencyMs: 30,
        actorId: 'agent-9',
      });
      await service.flush();
      expect(flushedRows()[0]).toMatchObject({
        ch: 'mcp',
        m: 'TOOL',
        rt: USAGE_STATS_TOOL_ROUTE,
        tn: 'board.list_tasks',
        sf: 'mcp-full',
        a: 'agent-9',
        sc: '2xx',
      });
    });

    it.each([
      [true, 'system'],
      [false, 'agent'],
    ])('viaFallbackAuth=%p → actor_type=%p（system 的唯一生产者）', async (flag, expected) => {
      service.recordInvocation({
        toolName: 'topic.create',
        surface: 'mcp',
        ok: true,
        latencyMs: 1,
        viaFallbackAuth: flag,
      });
      await service.flush();
      expect(flushedRows()[0]).toMatchObject({ at: expected });
    });

    it('失败调用 → 5xx；actorId 缺省 NULL', async () => {
      service.recordInvocation({
        toolName: 'topic.create',
        surface: 'mcp',
        ok: false,
        latencyMs: 1,
      });
      await service.flush();
      expect(flushedRows()[0]).toMatchObject({ sc: '5xx', a: null });
    });

    it('非法 surface 归 unknown、超长 tool_name 截断、__invalid__ 哨兵保留', async () => {
      service.recordInvocation({
        toolName: '__invalid__',
        surface: 'Platform Full',
        ok: false,
        latencyMs: 0,
      });
      service.recordInvocation({
        toolName: 'b'.repeat(300),
        surface: 'mcp',
        ok: true,
        latencyMs: 0,
      });
      await service.flush();
      const rows = flushedRows();
      expect(rows.find((r) => r.tn === '__invalid__')).toMatchObject({ sf: 'unknown' });
      const long = rows.find((r) => typeof r.tn === 'string' && (r.tn as string).startsWith('bbb'));
      expect(long?.tn).toHaveLength(USAGE_TOOL_NAME_MAX_LENGTH);
    });

    it('负耗时归 0（入库前最后一道守卫，不抛）', async () => {
      service.recordInvocation({
        toolName: 'topic.create',
        surface: 'mcp',
        ok: true,
        latencyMs: -5,
      });
      await service.flush();
      expect(flushedRows()[0]).toMatchObject({ ls: 0, lm: 0 });
    });
  });

  describe('flush SQL 与行形状（plan §3 逐字契约）', () => {
    it('SQL 保留 jsonb_to_recordset / 批内去重 GROUP BY / 定序 ORDER BY / 全 9 列 conflict_target', () => {
      expect(USAGE_STATS_INSERT_SQL).toContain('jsonb_to_recordset($1::jsonb)');
      expect(USAGE_STATS_INSERT_SQL).toContain('GROUP BY b, ch, sf, tn, m, rt, a, at, sc');
      expect(USAGE_STATS_INSERT_SQL).toContain('ORDER BY b, ch, sf, tn, m, rt, a, at, sc');
      expect(USAGE_STATS_INSERT_SQL).toContain(
        'ON CONFLICT (bucket_start, channel, mcp_surface, tool_name, method, route, actor_id, actor_type, status_class)',
      );
      expect(USAGE_STATS_INSERT_SQL).toContain(
        'GREATEST(api_usage_stats_hourly.latency_max_ms, EXCLUDED.latency_max_ms)',
      );
      // 两处行内注释是"为什么"的载体，改动时能被看见
      expect(USAGE_STATS_INSERT_SQL).toContain('批内去重');
      expect(USAGE_STATS_INSERT_SQL).toContain('定序防并发死锁');
    });

    it('SQL 以参数化方式调用（行数组走 $1，不拼字符串）', async () => {
      service.recordHttpCall(httpCall());
      await service.flush();
      expect(query).toHaveBeenCalledWith(USAGE_STATS_INSERT_SQL, [expect.any(String)]);
    });

    it('行字段与 SQL 别名一一对应（12 列）', async () => {
      service.recordHttpCall(httpCall());
      await service.flush();
      expect(Object.keys(flushedRows()[0]).sort()).toEqual(FLUSH_ROW_KEYS);
    });

    it('bucket_start 以 ISO 字符串进入 jsonb（timestamptz 强转依赖它）', async () => {
      service.recordHttpCall(httpCall({ bucketStart: new Date('2026-09-15T10:00:00.000Z') }));
      await service.flush();
      expect(flushedRows()[0].b).toBe('2026-09-15T10:00:00.000Z');
    });
  });

  describe('flush 间隔注入（D10）', () => {
    const withEnv = (value: string | undefined): UsageStatsBufferService => {
      const previous = process.env.USAGE_FLUSH_INTERVAL_MS;
      try {
        process.env.USAGE_FLUSH_INTERVAL_MS = value;
        return new UsageStatsBufferService(makeDataSource());
      } finally {
        process.env.USAGE_FLUSH_INTERVAL_MS = previous;
      }
    };

    it('合法值生效', () => {
      const injected = withEnv('1500');
      expect(injected.flushIntervalMs).toBe(1500);
      injected.onModuleDestroy();
    });

    it('非法值回落缺省 60000', () => {
      const injected = withEnv('0');
      expect(injected.flushIntervalMs).toBe(USAGE_FLUSH_DEFAULT_INTERVAL_MS);
      injected.onModuleDestroy();
    });
  });
});
