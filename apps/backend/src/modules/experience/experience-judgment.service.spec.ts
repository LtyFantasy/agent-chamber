/**
 * ExperienceJudgmentService 单测（第二期批 3 / plan §3.5 写入纪律 + §4 消费面）。
 *
 * 设计意图：这一层是"**日志是事实、快照是缓存**"这条不变量的守门人。四条最容易静默失效的
 * 规则在这里逐条钉死：
 * ① provider=none 短路（不调用/不写日志/不占额度）vs 被限流（写 skipped 占位行且计入额度）；
 * ② 快照写必须**同事务 + 版本守卫**（在途被再改 ⇒ 丢弃快照但保住日志行）；
 * ③ 失败分支：update 模式**必须**把快照置 NULL（旧快照描述旧内容），create 模式天然 NULL；
 * ④ 日志载荷纪律：16KB 硬顶（截断 + truncated 标记）与密钥 redaction（stateRedacted 标记）。
 */
import { ForbiddenException } from '@nestjs/common';
import {
  ActorType,
  ErrorCode,
  EXPERIENCE_JUDGMENT_SKIPPED_REASON,
  UserRole,
} from '@agent-chamber/shared';
import {
  EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES,
  EXPERIENCE_JUDGMENT_RATE_WINDOW_MS,
} from './experience.constants';
import { ExperienceJudgmentService, redactRequestState } from './experience-judgment.service';
import {
  capJsonbPayload,
  countReturnedRows,
  judgmentActorKey,
  truncateUtf8,
} from '../judgment/judgment-payload';
import { JudgmentQuotaService } from '../judgment/judgment-quota.service';
import type { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import type { JudgmentConfig } from '../../config/judgment.config';
import type {
  ExperienceCheckInput,
  JudgmentOutcome,
  JudgmentProvider,
} from './judgment/judgment-provider.interface';

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
/**
 * 版本守卫基准的**库内原文**形态（PG text form，微秒精度）。
 *
 * 刻意用带微秒的字符串：JS Date 只有毫秒，用它做 SQL 等值比较永不命中（真实缺陷，见
 * experience-judgment.service.ts 的 `expectedUpdatedAtText` 注释）。
 */
const UPDATED_AT_TEXT = '2026-09-22 09:39:46.247612+00';

const INPUT: ExperienceCheckInput = {
  title: 't',
  summary: 's',
  content: 'c',
  signals: [],
  domains: [],
  env: {},
  intent: 'repair',
  duplicateCandidates: [],
  availableDomains: [],
};

describe('ExperienceJudgmentService', () => {
  let service: ExperienceJudgmentService;
  let logRepo: { save: jest.Mock; insert: jest.Mock; createQueryBuilder: jest.Mock };
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let provider: { name: string; enabled: boolean; run: jest.Mock };
  let members: { resolveMemberRole: jest.Mock };
  /** 写入者名字解析 mock（v1.81.0：listJudgments 补 actorName） */
  let actorProfiles: { resolveProfiles: jest.Mock };
  /** 事务内 `manager.query` 的返回值（模拟版本守卫命中/未命中） */
  let snapshotRows: unknown;

  const actor: UnifiedActor = {
    id: ACTOR_ID,
    type: ActorType.AGENT,
    name: 'agent',
    ownerId: '33333333-3333-4333-8333-333333333333',
  } as UnifiedActor;
  const adminActor: UnifiedActor = {
    id: ACTOR_ID,
    type: ActorType.HUMAN,
    role: UserRole.ADMIN,
  } as UnifiedActor;

  /** 成功判定结果（供各用例复用；形状 = 内核 `JudgmentOutcome`：`meta` 观测 + `value` 产物） */
  function okOutcome(overrides: Partial<JudgmentOutcome> = {}): JudgmentOutcome {
    return {
      status: 'ok',
      meta: {
        provider: 'jev',
        model: 'jev-latest',
        judgedAt: '2026-09-22T10:00:01.000Z',
        rubricVersion: 'v2',
      },
      value: {
        completeness: { level: 'partial', confidence: 0.7 },
        reusability: null,
        signalQuality: null,
        duplicate: null,
        intentSuggestion: null,
        domainSuggestion: null,
        admissionSuggestion: null,
      },
      request: { questions: {}, state: { content: 'c' } },
      response: { normalized: {}, raw: { model: 'jev-latest' } },
      latencyMs: 1200,
      ...overrides,
    } as JudgmentOutcome;
  }

  beforeEach(() => {
    logRepo = {
      save: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    manager = {
      query: jest.fn().mockImplementation(async () => snapshotRows),
      getRepository: jest.fn(() => logRepo),
    };
    snapshotRows = [{ id: ENTRY_ID }]; // 默认：版本守卫命中（返回一行）
    provider = { name: 'jev', enabled: true, run: jest.fn() };
    members = { resolveMemberRole: jest.fn().mockResolvedValue(null) };
    // 写入者名字解析（v1.81.0）：listJudgments 用它给 actorId 补 actorName
    actorProfiles = {
      resolveProfiles: jest.fn(async () => new Map([['u1', { name: 'coder' }]])),
    };

    service = new ExperienceJudgmentService(
      logRepo as never,
      {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
      } as never,
      provider as unknown as JudgmentProvider,
      new JudgmentQuotaService(judgmentConfigOf()),
      members as never,
      actorProfiles as never,
    );
  });

  /**
   * 判别成本闸配置（三级缺省：actor 3 / 全局 240 / 能力 120）。
   *
   * 定向触发某一级闸的用例用 `serviceWith({...})` 只改那一级；其余两级保持宽裕——否则会先被
   * 别的闸拦下（capability 缺省 120 < global 缺省 240："只抬 global" 是最容易踩的组合）。
   */
  function judgmentConfigOf(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
    return {
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: 'k',
      typesafeModel: 'jev-latest',
      timeoutMs: 8000,
      rateLimitPerHour: 3,
      globalRateLimitPerHour: 240,
      capabilityRateLimitPerHour: 120,
      // 能力白名单：本套件只测 record_check（恒不受管辖）⇒ 空集即缺省形态
      capabilities: [],
      warnings: [],
      ...overrides,
    };
  }

  /**
   * 用给定配置另起一个服务实例（定向触发某一级闸；与主实例共享同一批 mock）。
   *
   * ⚠️ 配额服务**按调用新建**：三级闸的窗口是进程内内存，复用实例会让"先打满额度"的用例
   * 互相污染（每个实例一份新窗口 = 每个用例的额度起点确定）。
   */
  /**
   * 最近一次 `serviceWith` 构造的**配额服务**（三级闸的桶与 skip 记账都搬进了它）。
   *
   * 为什么由 spec 持有它：桶是进程内内存私有字段，断言"被拒尝试未入账"只能读桶；服务不再自持
   * 桶（上移内核），故断言对象同步换成配额服务实例。
   */
  let lastQuota: JudgmentQuotaService;

  function serviceWith(overrides: Partial<JudgmentConfig>): ExperienceJudgmentService {
    const quota = new JudgmentQuotaService(judgmentConfigOf(overrides));
    lastQuota = quota;
    return new ExperienceJudgmentService(
      logRepo as never,
      {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
      } as never,
      provider as unknown as JudgmentProvider,
      quota,
      members as never,
      actorProfiles as never,
    );
  }

  afterEach(() => jest.clearAllMocks());

  /** 取当前（被替换前的）transaction 实现，供"临时替换后复原"的用例使用 */
  const dataSourceTransaction = (): jest.Mock =>
    (service as unknown as { dataSource: { transaction: jest.Mock } }).dataSource.transaction;

  /** 取事务内日志行的写入参数 */
  function savedLogRow(): Record<string, unknown> {
    expect(logRepo.save).toHaveBeenCalledTimes(1);
    return logRepo.save.mock.calls[0][0] as Record<string, unknown>;
  }

  /** 取事务内针对条目的裸 SQL 调用（快照写/清空） */
  function snapshotSqlCalls(): { sql: string; params: unknown[] }[] {
    return (manager.query as jest.Mock).mock.calls
      .map(([sql, params]) => ({ sql: String(sql), params: (params ?? []) as unknown[] }))
      .filter((c) => c.sql.includes('experience_entries'));
  }

  describe('provider=none 短路', () => {
    it('不调用 provider、不写日志、不占额度', async () => {
      provider.enabled = false;
      const result = await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      expect(result).toBeNull();
      expect(provider.run).not.toHaveBeenCalled();
      expect(logRepo.save).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe('限流 skipped（计入额度 + 占位行）', () => {
    it('超限 → 写 skipped 占位行（request 占位 / response null / latency null）且不调 provider', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const call = () =>
        service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });

      // 额度 = 3：前三次允许（真调用），第四次起被跳过
      for (let i = 0; i < 3; i += 1) await call();
      expect(provider.run).toHaveBeenCalledTimes(3);
      logRepo.save.mockClear();

      const fourth = await call();
      expect(fourth).toBeNull();
      expect(provider.run).toHaveBeenCalledTimes(3); // 未再调用
      expect(savedLogRow()).toMatchObject({
        experienceId: ENTRY_ID,
        provider: 'jev',
        status: 'skipped',
        actorType: ActorType.AGENT,
        actorId: ACTOR_ID,
        // 本用例只有 **actor 级**被改小（全局/能力保持宽裕）⇒ reason 恒为 actor 级契约值
        request: { skipped: true, reason: EXPERIENCE_JUDGMENT_SKIPPED_REASON.ACTOR_RATE_LIMITED },
        response: null,
        latencyMs: null,
      });

      // skipped 也计入额度 ⇒ 下一次同样被跳过（不许当免费通道）；但**每闸级别 + actor
      // 只写一条占位行**：后续同类超限只 warn，不再落行
      logRepo.save.mockClear();
      const fifth = await call();
      expect(fifth).toBeNull();
      expect(provider.run).toHaveBeenCalledTimes(3);
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('P2-1：update 模式超限 → 与 error/timeout 同构——**清快照**（带版本守卫）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const call = (mode: 'create' | 'update') =>
        service.evaluateAndPersist({
          mode,
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });

      // 先把额度用满（3 次 ok；每次都会写快照，故清掉调用记录）
      for (let i = 0; i < 3; i += 1) await call('create');
      (manager.query as jest.Mock).mockClear();

      await call('update');

      const calls = snapshotSqlCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('SET judgment = NULL');
      expect(calls[0].sql).toContain('id = $1::uuid AND updated_at = $2::timestamptz');
      expect(calls[0].params[1]).toBe(UPDATED_AT_TEXT);
    });

    it('P2-1：create 模式超限 → **不写快照**（新条目天然 NULL，不做多余写）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      for (let i = 0; i < 3; i += 1) {
        await service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });
      }
      (manager.query as jest.Mock).mockClear();

      await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });
      expect(snapshotSqlCalls()).toHaveLength(0);
    });

    it('P2-5：同窗口内第二次超限 → **不再写行**（每「闸级别 + actor」至多一条）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const call = () =>
        service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });
      for (let i = 0; i < 3; i += 1) await call();

      logRepo.save.mockClear();
      await call(); // 首次超限 → 写一行
      expect(logRepo.save).toHaveBeenCalledTimes(1);
      await call(); // 再次超限 → 只 warn
      await call();
      expect(logRepo.save).toHaveBeenCalledTimes(1); // 行数有界（不随请求数增长）
    });

    it('P2-5：无 actor（null）→ 走兜底桶 system:unknown，**照常限流**（不静默放行）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const callAsNull = () =>
        service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor: null,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });
      // 额度 = 3：前三次真调用，第四次被限流（若 null actor 绕过限流，这里会永远不被跳）
      for (let i = 0; i < 3; i += 1) await callAsNull();
      logRepo.save.mockClear();
      expect(await callAsNull()).toBeNull();
      expect(provider.run).toHaveBeenCalledTimes(3);
      expect(savedLogRow()).toMatchObject({ status: 'skipped', actorType: null, actorId: null });
    });

    it('额度按 actor 独立（不同 actor 各自计数）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const other: UnifiedActor = {
        ...actor,
        id: '44444444-4444-4444-8444-444444444444',
      } as UnifiedActor;
      for (let i = 0; i < 3; i += 1) {
        await service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        });
      }
      const otherResult = await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor: other,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });
      expect(otherResult).not.toBeNull();
    });
  });

  describe('成功：单事务 {日志行 + 版本守卫快照}', () => {
    it('日志行字段齐备 + 快照 UPDATE 带版本守卫 + 返回快照', async () => {
      provider.run.mockResolvedValue(okOutcome());

      const result = await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      expect(result).toMatchObject({ provider: 'jev', model: 'jev-latest' });
      expect(savedLogRow()).toMatchObject({
        experienceId: ENTRY_ID,
        // 词表单源（shared）：本阶段唯一值
        operation: 'record_check',
        provider: 'jev',
        model: 'jev-latest',
        status: 'ok',
        actorType: ActorType.AGENT,
        actorId: ACTOR_ID,
        latencyMs: 1200,
      });

      const calls = snapshotSqlCalls();
      expect(calls).toHaveLength(1);
      // 裸 SQL 定向 UPDATE：只 SET judgment（**不碰 updated_at**）+ 版本守卫
      expect(calls[0].sql).toContain('SET judgment = $1::jsonb');
      // SET 子句（WHERE 之前）不得出现 updated_at —— 它是乐观锁 token，后台判定不许改
      expect(calls[0].sql.split('WHERE')[0]).not.toContain('updated_at');
      expect(calls[0].sql).toContain('id = $2::uuid AND updated_at = $3::timestamptz');
      expect(calls[0].params[1]).toBe(ENTRY_ID);
      expect(calls[0].params[2]).toBe(UPDATED_AT_TEXT);
    });

    it('版本守卫不匹配（在途被再改）→ 丢弃快照（返回 null）但**日志行仍在**', async () => {
      provider.run.mockResolvedValue(okOutcome());
      snapshotRows = []; // rowCount = 0

      const result = await service.evaluateAndPersist({
        mode: 'update',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      expect(result).toBeNull();
      expect(savedLogRow()).toMatchObject({ status: 'ok' }); // 日志是事实源，照写
      expect(snapshotSqlCalls()).toHaveLength(1); // 尝试过一次（被守卫挡回）
    });
  });

  describe('失败：update 置 NULL / create 不置', () => {
    it('update 模式失败 → 同事务写日志 + 版本守卫清快照', async () => {
      provider.run.mockResolvedValue({
        status: 'timeout',
        request: { questions: {}, state: {} },
        response: { error: 'timeout' },
        latencyMs: 8000,
      });

      const result = await service.evaluateAndPersist({
        mode: 'update',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      expect(result).toBeNull();
      expect(savedLogRow()).toMatchObject({ status: 'timeout', model: null, latencyMs: 8000 });
      const calls = snapshotSqlCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('SET judgment = NULL');
      expect(calls[0].sql).toContain('updated_at = $2::timestamptz');
    });

    it('create 模式失败 → 只写日志（新条目快照天然 NULL，不做多余写）', async () => {
      provider.run.mockResolvedValue({
        status: 'error',
        request: {},
        response: { error: 'boom' },
        latencyMs: 5,
      });

      await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      expect(savedLogRow()).toMatchObject({ status: 'error' });
      expect(snapshotSqlCalls()).toHaveLength(0);
    });
  });

  describe('日志载荷纪律', () => {
    it('request 超 16KB → 截断 + truncated 标记（不静默）', async () => {
      provider.run.mockResolvedValue(
        okOutcome({
          request: { questions: {}, state: { content: 'x'.repeat(20_000) } },
        }),
      );

      await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      const row = savedLogRow() as { request: Record<string, unknown> };
      expect(row.request.truncated).toBe(true);
      expect(typeof row.request.json).toBe('string');
      expect(String(row.request.json).length).toBeLessThanOrEqual(
        EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES,
      );
    });

    it('PEM 私钥块**整块**掩码（头到 END；只掩头会留下 base64 私钥体）', () => {
      const payload = {
        state: {
          content:
            '## Fix\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n' +
            'AAAABHNzaC1yc2EAAAADAQABAAABgQ\n-----END OPENSSH PRIVATE KEY-----\n',
        },
      };
      const redacted = redactRequestState(payload);
      const serialized = JSON.stringify(redacted);
      expect(redacted.stateRedacted).toBe(true);
      expect(serialized).not.toContain('b3BlbnNzaC1rZXktdjE');
      expect(serialized).toContain('[redacted]');
      // 块前的内容保留（掩码只吃密钥块，不吞整段正文）
      expect(serialized).toContain('## Fix');
    });

    it('redaction 消费**整个值**（踩坑实证：前缀掩码会漏下大半密钥）', () => {
      const redacted = redactRequestState({
        state: { content: 'DSN password=hunter2 and key=ask_abcdef123456' },
      });
      const serialized = JSON.stringify(redacted);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('abcdef123456');
      expect(serialized).toContain('[redacted]');
    });

    it('apikey_ 族（长形态）整值掩码：输出**不残留假值任何连续片段**', () => {
      // 假值**全合成**（仓库密钥纪律 NIT-1）：只借用公开前缀形态，后缀与真实 Key 无关。
      // 断言标记取自假值**内部**（跨重复边界 'b2c3A1'），比只查前缀更难蒙混。
      const fakeKey = 'apikey_' + 'A1b2c3'.repeat(18);
      const redacted = redactRequestState({
        state: {
          content: `curl -H "Authorization: Bearer ${fakeKey}" https://api.typesafe.ai/v1/systemone`,
        },
      });
      const serialized = JSON.stringify(redacted);

      expect(redacted.stateRedacted).toBe(true);
      expect(serialized).not.toContain(fakeKey);
      expect(serialized).not.toContain('A1b2c3');
      expect(serialized).not.toContain('b2c3A1');
      // 掩码只吃密钥本身，不吞掉整段正文（否则日志失去语料价值）
      expect(serialized).toContain('Authorization: Bearer');
      expect(serialized).toContain('[redacted]');
    });

    it('密钥命中 → 掩码 + stateRedacted 标记（纵深防御；错误体/密钥不落库）', async () => {
      provider.run.mockResolvedValue(
        okOutcome({
          request: {
            questions: {},
            state: { content: 'DSN: password=hunter2', title: 'ok', signals: ['ask_deadbeef'] },
          },
        }),
      );

      await service.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

      const row = savedLogRow() as { request: Record<string, unknown> };
      expect(row.request.stateRedacted).toBe(true);
      const serialized = JSON.stringify(row.request);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('ask_deadbeef');
      expect(serialized).toContain('[redacted]');
    });
  });

  describe('判断日志查询（判权 + 过滤 + 全序分页）', () => {
    /** 链式 queryBuilder mock */
    function installQb(opts: { count?: number; rows?: ExperienceJudgmentRecord[] } = {}) {
      const qb: Record<string, jest.Mock> = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(opts.count ?? 0),
        getMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      };
      logRepo.createQueryBuilder = jest.fn(() => qb);
      return qb;
    }

    it('无治理角色 → 403/13004（message 指向成员清单）', async () => {
      installQb();
      const err = (await service
        .listJudgments({}, { id: ACTOR_ID, type: ActorType.AGENT } as UnifiedActor)
        .catch((e: unknown) => e)) as ForbiddenException;
      expect(err).toBeInstanceOf(ForbiddenException);
      const payload = err.getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);
      expect(payload.message).toContain('GET /experiences/members');
      expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('无身份 → 403/13004（零仓储访问）', async () => {
      installQb();
      await expect(service.listJudgments({}, null)).rejects.toBeInstanceOf(ForbiddenException);
      expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('空间成员 → 放行（resolveMemberRole 命中即通过）', async () => {
      members.resolveMemberRole.mockResolvedValue('reviewer');
      const qb = installQb({ count: 1 });
      const res = await service.listJudgments({ page: 2, pageSize: 10 }, {
        id: ACTOR_ID,
        type: ActorType.AGENT,
      } as UnifiedActor);
      expect(res).toMatchObject({ total: 1, page: 2, pageSize: 10 });
      // 全序 + 分页（同刻多行也不会漏/重）
      expect(qb.orderBy).toHaveBeenCalledWith('j.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('j.id', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('admin → 放行（不查成员表）', async () => {
      const qb = installQb({ count: 0 });
      await service.listJudgments({}, adminActor);
      expect(members.resolveMemberRole).not.toHaveBeenCalled();
      expect(qb.getMany).toHaveBeenCalled();
    });

    it('过滤参数逐一挂谓词（operation/status/experienceId/from/to）', async () => {
      const qb = installQb({ count: 0 });
      await service.listJudgments(
        {
          operation: 'record_check',
          status: 'error',
          experienceId: ENTRY_ID,
          from: '2026-09-01T00:00:00+08:00',
          to: '2026-09-30T23:59:59+08:00',
        },
        adminActor,
      );
      const clauses = (qb.andWhere as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(clauses.some((c) => c.includes('j.operation ='))).toBe(true);
      expect(clauses.some((c) => c.includes('j.status ='))).toBe(true);
      expect(clauses.some((c) => c.includes('j.experience_id ='))).toBe(true);
      expect(clauses.some((c) => c.includes('j.created_at >='))).toBe(true);
      expect(clauses.some((c) => c.includes('j.created_at <='))).toBe(true);
    });

    it('无过滤时不挂任何谓词（全量导出）', async () => {
      const qb = installQb({ count: 0 });
      await service.listJudgments({}, adminActor);
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('缺省分页 = 20 条/页', async () => {
      const qb = installQb({ count: 0 });
      const res = await service.listJudgments({}, adminActor);
      expect(res.pageSize).toBe(20);
      expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('actorName：本页 actorId 去重后**一次**批量解析补名（禁 N+1）', async () => {
      const row = (id: string, actorId: string | null): ExperienceJudgmentRecord =>
        ({
          id,
          experienceId: ENTRY_ID,
          operation: 'record_check',
          provider: 'jev',
          model: null,
          status: 'ok',
          actorType: actorId ? ActorType.AGENT : null,
          actorId,
          latencyMs: 1,
          request: {},
          response: null,
          createdAt: new Date(),
        }) as ExperienceJudgmentRecord;
      installQb({ count: 3, rows: [row('j1', 'u1'), row('j2', 'u1'), row('j3', 'u2')] });

      const res = await service.listJudgments({}, adminActor);

      // 两个不同 actorId → 一次调用（三行不放大成三次）
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith(['u1', 'u2']);
      expect(res.items[0].actorName).toBe('coder');
      expect(res.items[0].actorId).toBe('u1');
    });

    it('actorName：actorId 为 null → 恒 null 且**不进解析集合**（system:unknown 不是真 actor）', async () => {
      const row = {
        id: 'j1',
        experienceId: ENTRY_ID,
        operation: 'record_check',
        provider: 'jev',
        model: null,
        status: 'skipped',
        actorType: null,
        actorId: null,
        latencyMs: null,
        request: { skipped: true },
        response: null,
        createdAt: new Date(),
      } as unknown as ExperienceJudgmentRecord;
      installQb({ count: 1, rows: [row] });

      const res = await service.listJudgments({}, adminActor);

      expect(res.items[0].actorName).toBeNull();
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith([]);
    });
  });

  describe('fail-open 闭合与体积纪律（P2-3 / P2-4）', () => {
    it('P2-3：落库事务抛错 → 返回 null，**不向上传播**（且 warn 不含异常 message）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const boom = Object.assign(new Error('relation "experience_judgments" does not exist'), {
        name: 'QueryFailedError',
        code: '42P01',
      });
      const svc = service as unknown as { dataSource: { transaction: jest.Mock } };
      const originalTransaction = dataSourceTransaction();
      svc.dataSource.transaction = jest.fn().mockRejectedValue(boom);
      const warnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      );
      warnSpy.mockImplementation(() => undefined);

      await expect(
        service.evaluateAndPersist({
          mode: 'create',
          entryId: ENTRY_ID,
          actor,
          input: INPUT,
          expectedUpdatedAtText: UPDATED_AT_TEXT,
        }),
      ).resolves.toBeNull();

      // warn 只带分类标签（类名/错误码），不带 message（SQL 片段/取值不进日志）
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('QueryFailedError/42P01');
      expect(warned).not.toContain('does not exist');
      warnSpy.mockRestore();
      svc.dataSource.transaction = originalTransaction;
    });

    it('P2-4：CJK 多字节载荷 → **按字节**截断到上限内（并保留 stateRedacted 标记）', () => {
      // 每个 CJK 字符 3 字节：字符数远小于字节数（旧实现按字符 slice 会漏 ~2/3）
      const payload = {
        stateRedacted: true,
        state: { content: '密钥'.repeat(9000) },
      };
      const capped = capJsonbPayload(payload, 16384);
      expect(capped.truncated).toBe(true);
      expect(capped.stateRedacted).toBe(true); // 标记不能被截断吞掉
      const storedBytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
      expect(storedBytes).toBeLessThanOrEqual(16384);
      expect(capped.originalBytes).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
      // 截断处必须是合法 UTF-8（不产生替换字符 / 半个字符）
      expect(String(capped.json)).not.toContain('\uFFFD');
      expect(() => Buffer.from(String(capped.json), 'utf8').toString('utf8')).not.toThrow();
    });

    it('P2-4：未超限时**原样返回**（不包装、不添加标记）', () => {
      const payload = { stateRedacted: true, state: { content: '短' } };
      expect(capJsonbPayload(payload, 16384)).toBe(payload);
    });

    it('P2-5 / 工具函数：judgmentActorKey 对 null actor 返回兜底桶', () => {
      expect(judgmentActorKey(actor)).toBe(`${ActorType.AGENT}:${ACTOR_ID}`);
      expect(judgmentActorKey(null)).toBe('system:unknown');
    });
  });

  describe('模块级纯函数', () => {
    it('countReturnedRows 兼容两种驱动返回形状', () => {
      expect(countReturnedRows([[{ id: 'a' }], 1])).toBe(1);
      expect(countReturnedRows([{ id: 'a' }])).toBe(1);
      expect(countReturnedRows([[], 0])).toBe(0);
      expect(countReturnedRows(undefined)).toBe(0);
    });

    it('capJsonbPayload 未超限原样返回（不包装）', () => {
      const payload = { a: 1 };
      expect(capJsonbPayload(payload)).toBe(payload);
    });

    it('redactRequestState 无命中时原样返回（不添加 stateRedacted 键）', () => {
      const payload = { state: { content: 'clean text' } };
      expect(redactRequestState(payload)).toEqual(payload);
      expect(redactRequestState(payload).stateRedacted).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 三级成本闸（v1.85.0 批 1）：全局 → 能力 → actor
  // ══════════════════════════════════════════════════════════════════════════

  describe('三级成本闸', () => {
    /** 发起一次判定（可指定 actor，用于"双 actor 合撞全局闸"） */
    const callWith = (
      svc: ExperienceJudgmentService,
      target: UnifiedActor = actor,
    ): Promise<unknown> =>
      svc.evaluateAndPersist({
        mode: 'create',
        entryId: ENTRY_ID,
        actor: target,
        input: INPUT,
        expectedUpdatedAtText: UPDATED_AT_TEXT,
      });

    it('**全局闸**超限 → 不调 provider + skipped reason=global_rate_limit（跨 actor 计数）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const svc = serviceWith({
        globalRateLimitPerHour: 1,
        capabilityRateLimitPerHour: 100,
        rateLimitPerHour: 100, // 两个 actor 各自额度都宽裕
      });

      expect(await callWith(svc)).toMatchObject({ model: 'jev-latest' }); // 全局额度 1：首次放行
      logRepo.save.mockClear();

      // 换一个 actor（自己额度充足）仍被拦 ⇒ 证明全局闸**跨 actor**，不是"每人一个桶"
      const other: UnifiedActor = {
        ...actor,
        id: '44444444-4444-4444-8444-444444444444',
      } as UnifiedActor;
      expect(await callWith(svc, other)).toBeNull();
      expect(provider.run).toHaveBeenCalledTimes(1); // 未再调用
      expect(savedLogRow()).toMatchObject({
        status: 'skipped',
        request: { skipped: true, reason: 'global_rate_limit' },
        response: null,
        latencyMs: null,
      });
    });

    it('**能力子额度**超限 → skipped reason=capability_rate_limit（全局宽裕时单独生效）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const svc = serviceWith({
        globalRateLimitPerHour: 100,
        capabilityRateLimitPerHour: 1,
        rateLimitPerHour: 100,
      });

      expect(await callWith(svc)).not.toBeNull();
      logRepo.save.mockClear();

      expect(await callWith(svc)).toBeNull();
      expect(provider.run).toHaveBeenCalledTimes(1);
      expect(savedLogRow()).toMatchObject({
        status: 'skipped',
        request: { skipped: true, reason: 'capability_rate_limit' },
      });
    });

    it('占位行按「闸级别 + actor」各一条：三级别互不挤占，同级重复超限不再落行', async () => {
      provider.run.mockResolvedValue(okOutcome());
      // 全局 2 / 能力 100 / actor 1 ⇒ 依次造出 actor 级与全局级超限
      const svc = serviceWith({
        globalRateLimitPerHour: 2,
        capabilityRateLimitPerHour: 100,
        rateLimitPerHour: 1,
      });

      expect(await callWith(svc)).not.toBeNull(); // ① 真调用（全局 1/2、actor 1/1）
      logRepo.save.mockClear();

      // ② actor 级超限（全局 2/2 仍在额度内）⇒ actor 级占位行
      expect(await callWith(svc)).toBeNull();
      expect(savedLogRow()).toMatchObject({
        request: { skipped: true, reason: 'judgment_rate_limited' },
      });
      logRepo.save.mockClear();

      // ③ 全局超限 ⇒ **另起一条**全局级占位行。同时证明**执行序是全局先跑**：此刻 actor 级也已
      // 饱和，但报告的是 global（若键只按 actor，这一步还会被"本窗口已记过"挡掉、不落行）
      expect(await callWith(svc)).toBeNull();
      expect(savedLogRow()).toMatchObject({
        request: { skipped: true, reason: 'global_rate_limit' },
      });
      logRepo.save.mockClear();

      // ④ 再一次撞同一级 ⇒ 不再落行（行写入有界：≤3 条/窗口/actor）
      expect(await callWith(svc)).toBeNull();
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('全局闸超限时**不消耗** actor/能力额度（先严后宽：被全局挡下的请求不烧用户额度）', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const svc = serviceWith({
        globalRateLimitPerHour: 1,
        capabilityRateLimitPerHour: 100,
        rateLimitPerHour: 1,
      });

      expect(await callWith(svc)).not.toBeNull(); // 全局 1/1 用满
      // 此后全局闸先拦：actor/能力桶不应再被压入（否则"全局恢复后用户额度已被烧光"）
      expect(await callWith(svc)).toBeNull();
      expect(await callWith(svc)).toBeNull();

      // 桶键 = `能力:actorKey`（额度键 `(level, capability, actorKey)` 的 actor 维实现）
      const actorHits = (
        lastQuota as unknown as { actorQuota: Map<string, number[]> }
      ).actorQuota.get(`record_check:${ActorType.AGENT}:${ACTOR_ID}`);
      expect(actorHits).toHaveLength(1); // 只有首次那次真调用

      const capabilityHits = (
        lastQuota as unknown as { capabilityQuota: Map<string, number[]> }
      ).capabilityQuota.get('record_check');
      expect(capabilityHits).toHaveLength(1); // 中间级同规：能力桶同样只留放行那次

      const globalHits = (
        lastQuota as unknown as { globalQuota: Map<string, number[]> }
      ).globalQuota.get('global');
      // 共享桶**只计放行**（终审 F1）：全局 1/1 用满后，两次被拒尝试不再入账 ⇒ 桶不会被刷满、
      // 窗口滑过即恢复（旧语义下这里是 3，额度被拒绝尝试钉住）
      expect(globalHits).toHaveLength(1);
    });

    it('共享桶只计放行（F1）：单 actor 连续刷 capability 闸**不占住桶**——窗口滑过后他人立即可用', async () => {
      provider.run.mockResolvedValue(okOutcome());
      const svc = serviceWith({
        globalRateLimitPerHour: 100,
        capabilityRateLimitPerHour: 1,
        rateLimitPerHour: 100,
      });

      expect(await callWith(svc)).not.toBeNull(); // 唯一一次放行
      for (let i = 0; i < 5; i += 1) {
        expect(await callWith(svc)).toBeNull(); // 连续刷：每次都被 capability 闸拦下
      }

      const capabilityHits = (
        lastQuota as unknown as { capabilityQuota: Map<string, number[]> }
      ).capabilityQuota.get('record_check');
      // 关键断言：5 次被拒尝试**一次都没入账** ⇒ 桶内只有那次放行（旧语义下是 6 ⇒ 桶被顶满、
      // 谁都用不了：单 actor 靠刷就能把共享额度永久钉住）
      expect(capabilityHits).toHaveLength(1);

      // 窗口滑过（把桶内那次放行挪出窗口）⇒ 另一个 actor **立即可用**，无需等自己被刷满的一小时
      const quotaView = lastQuota as unknown as { capabilityQuota: Map<string, number[]> };
      quotaView.capabilityQuota.set('record_check', [
        Date.now() - EXPERIENCE_JUDGMENT_RATE_WINDOW_MS - 1,
      ]);
      const other: UnifiedActor = {
        ...actor,
        id: '55555555-5555-4555-8555-555555555555',
      } as UnifiedActor;
      expect(await callWith(svc, other)).not.toBeNull();
    });
  });
});
