import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ActorType, ErrorCode, UserRole, type ExperienceEnv } from '@agent-chamber/shared';
import { ExperienceService } from './experience.service';
import * as svc from './experience.service';
import { ExperienceEntry } from '../../database/entities/experience-entry.entity';
import { ExperienceFeedback } from '../../database/entities/experience-feedback.entity';
import {
  EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW,
  EXPERIENCE_DUPLICATE_TITLE_SIMILARITY,
  EXPERIENCE_SCORE_FLOOR,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
} from './experience.constants';
import type { CreateExperienceDto, QueryExperienceDto, UpdateExperienceDto } from './dto';
import type { UnifiedActor } from '../../common/types/actor.types';

/**
 * ExperienceService 单测（plan §7 后端单测清单）。
 *
 * 覆盖：归一化 / 分层排序 / 限流窗口 / 密钥闸门 / 疑似重复 / quality 回落 / owner 代理 /
 * 乐观锁 / outcome 改判三列联动 / baseQuery 豁免语义 / 零命中埋点门槛 / 疑似重复阈值。
 *
 * 分工说明：**SQL 形状与索引命中**（`&&` overlap、`->>` 谓词、indexdef）由真 PG e2e 负责
 * （铁律 #23：mock 测不出 ORM 的 SQL 生成）；本文件只断言"service 把哪些谓词/排序挂上去了"
 * 与"策略分支的走向"。
 */
/** 测试用固定 UUID（模块级：describe 外部的脚手架函数也要用） */
const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
/** "别人的条目"的创建者：与任何测试 actor 都不同，用于越权路径 */
const STRANGER_UUID = '33333333-3333-4333-8333-333333333333';
/**
 * 写事务返回的 `updated_at::text`（版本守卫基准；微秒精度）。
 *
 * 刻意带微秒：JS Date 只有毫秒，用它做 SQL 等值比较永不命中（真实缺陷，见判别服务的
 * `expectedUpdatedAtText` 注释）——故 spec 也按库内原文形态断言。
 */
const UPDATED_AT_TEXT = '2026-09-22 10:00:00.123456+00';

/** baseQuery 生成的 SQL 片段（mock 用；含软删谓词，便于断言"谓词复用"） */
const BASE_SQL_SNIPPET = 'SELECT e.* FROM experience_entries e WHERE e.deleted_at IS NULL';

describe('ExperienceService', () => {
  const humanActor: UnifiedActor = {
    id: UUID,
    type: ActorType.HUMAN,
    name: 'admin',
  } as UnifiedActor;
  const adminActor: UnifiedActor = {
    id: UUID,
    type: ActorType.HUMAN,
    name: 'admin',
    role: UserRole.ADMIN,
  } as UnifiedActor;
  const agentActor: UnifiedActor = {
    id: OTHER_UUID,
    type: ActorType.AGENT,
    name: 'coder',
  } as UnifiedActor;

  let service: ExperienceService;
  let entryRepo: ReturnType<typeof makeRepo>;
  let feedbackRepo: ReturnType<typeof makeRepo>;
  let searchEventRepo: ReturnType<typeof makeRepo>;
  let idempotencyRepo: ReturnType<typeof makeRepo>;
  /**
   * EntityManager mock（字段类型显式写 jest.Mock：`makeManager()` 的返回类型会把
   * `getRepository` 钉成零参签名，导致"按实体分派"的赋值过不了类型检查）
   */
  let manager: {
    query: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    getRepository: jest.Mock;
  };
  let managerRepo: ReturnType<typeof makeRepo>;
  /** 事务内的 ExperienceEntry 仓储（update 的行锁读取点） */
  let entryTxRepo: { createQueryBuilder: jest.Mock };
  /** 行锁读取将返回的实体（null = 条目不存在） */
  let lockedEntry: ExperienceEntry | null;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let auditService: { log: jest.Mock };
  let ownerProxy: { isOwnerProxy: jest.Mock; getOwnedAgentIds: jest.Mock };
  /**
   * 归属人档案 mock（v1.81.0；与生产 `ActorProfileService` 同语义）。
   *
   * 契约要点（照 ActorProfileService R12）：**真孤儿（不在 profileRows 里）不进返回 Map**
   * ——spec 靠这一点断言"孤儿 → createdByName null 且不造兜底词"。
   */
  let profileRows: Map<
    string,
    {
      type: ActorType;
      name: string;
      avatarUrl: string | null;
      description: string | null;
      deletedAt: Date | null;
    }
  >;
  let actorProfiles: { resolveProfiles: jest.Mock };
  /**
   * 成员/终审资格服务 mock（第二期批 2）。
   *
   * 分工：**角色判定的真实逻辑在 `experience-member.service.spec.ts` 里逐态测**（那是它
   * 自己的单测）；本文件只断言 ExperienceService **正确委派**（传对了条目/身份）与
   * "判定结果如何影响响应"（viewer 字段、suppression）。
   *
   * 缺省返回：`evaluateReviewPermission` → 不可审（读路径默认按"普通读者"投影）；
   * `assertReviewIdentity` / `assertCanReview` → 不抛（终审路径按"有资格"放行）。
   */
  let members: {
    resolveMemberRole: jest.Mock;
    evaluateReviewPermission: jest.Mock;
    assertReviewIdentity: jest.Mock;
    assertCanReview: jest.Mock;
  };
  /**
   * 判别服务 mock（第二期批 3）。
   *
   * 分工：判定接线/版本守卫/落库纪律在 `experience-judgment.service.spec.ts` 里逐条测；
   * 本文件只断言 **ExperienceService 正确委派**（传对 mode/entryId/version 基准）与
   * "判定结果如何进响应"（judgment 键、幂等回填、失败置 null）。
   */
  let judgments: { evaluateAndPersist: jest.Mock };
  /**
   * 本次用例里 entryRepo.createQueryBuilder 产出的**全部** builder（按创建顺序）。
   *
   * 为什么不能只留"最后一个"：`search()` 在返回前还会为 availableDomains 词表再建一个
   * builder（facets 同理，最后还会为 suspectCount 建一个）——只记最后一个会断言到错误的
   * 对象上。约定：`mainQb()` = 列表/主查询（第一个），`newestQb()` = 最后一个。
   */
  let createdQbs: ReturnType<typeof makeQueryBuilder>[] = [];

  /** 装配 createQueryBuilder 返回值（并重置 createdQbs） */
  function installQueryBuilders(opts: Parameters<typeof makeQueryBuilder>[0] = {}): void {
    createdQbs = [];
    entryRepo.createQueryBuilder = jest.fn(() => {
      const qb = makeQueryBuilder(opts);
      createdQbs.push(qb);
      return qb;
    });
  }

  /** 列表/主查询的 builder（第一个被创建的） */
  const mainQb = () => createdQbs[0];
  /** 最后一个被创建的 builder（facets 的 suspectCount 等收尾查询） */
  const newestQb = () => createdQbs[createdQbs.length - 1];

  beforeEach(() => {
    entryRepo = makeRepo();
    feedbackRepo = makeRepo();
    searchEventRepo = makeRepo();
    idempotencyRepo = makeRepo();
    manager = makeManager() as never;
    managerRepo = makeRepo();
    entryTxRepo = makeEntryTxRepo(() => lockedEntry);
    lockedEntry = null;
    dataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
      query: jest.fn().mockResolvedValue([{ domain: 'devops', count: 1 }]),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    ownerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
      getOwnedAgentIds: jest.fn().mockResolvedValue([]),
    };
    // 归属人档案（v1.81.0）：默认两位都"活着"，用例可自行增删行以造软删/孤儿
    profileRows = new Map([
      [
        UUID,
        {
          type: ActorType.HUMAN,
          name: 'admin',
          avatarUrl: null,
          description: null,
          deletedAt: null,
        },
      ],
      [
        OTHER_UUID,
        {
          type: ActorType.AGENT,
          name: 'coder',
          avatarUrl: null,
          description: null,
          deletedAt: null,
        },
      ],
    ]);
    actorProfiles = {
      // 与生产同语义：真孤儿（无 actors 行）不写进返回 Map
      resolveProfiles: jest.fn(async (ids: string[]) => {
        const map = new Map<string, unknown>();
        for (const id of [...new Set(ids)].filter(Boolean)) {
          const row = profileRows.get(id);
          if (row) map.set(id, row);
        }
        return map;
      }),
    };
    members = {
      resolveMemberRole: jest.fn().mockResolvedValue(null),
      evaluateReviewPermission: jest.fn().mockResolvedValue({ canReview: false }),
      assertReviewIdentity: jest.fn(),
      assertCanReview: jest.fn().mockResolvedValue(undefined),
    };
    judgments = { evaluateAndPersist: jest.fn().mockResolvedValue(null) };
    installQueryBuilders();
    // manager.getRepository 按实体分派：Feedback 路径用 feedbackRepo（断言面），其余（幂等
    // 记录）用 managerRepo——两条路径的仓储 mock 分离，断言互不串味
    manager.getRepository = jest.fn((cls: unknown) => {
      if (cls === ExperienceFeedback) return feedbackRepo;
      if (cls === ExperienceEntry) return entryTxRepo;
      return managerRepo;
    });

    service = new ExperienceService(
      entryRepo as never,
      feedbackRepo as never,
      searchEventRepo as never,
      idempotencyRepo as never,
      dataSource as never,
      auditService as never,
      ownerProxy as never,
      members as never,
      // v1.81.0：归属人档案解析（投影层补名）——构造参数顺序与生产同形（在 members 之后、judgments 之前）
      actorProfiles as never,
      judgments as never,
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // 归一化（写侧强制）
  // ══════════════════════════════════════════════════════════════════

  describe('归一化', () => {
    it('signals/domains：trim + lowercase + 去重（保序）', () => {
      expect(
        svc.normalizeElements(['  ECONNREFUSED ', 'econnrefused', 'Port-Unreachable']),
      ).toEqual(['econnrefused', 'port-unreachable']);
    });

    it('归一化丢弃空白元素', () => {
      expect(svc.normalizeElements(['  ', 'a'])).toEqual(['a']);
    });

    it('env：只保留白名单键 + trim/lowercase + 丢弃空值', () => {
      const env = svc.normalizeEnv({
        os: '  WSL2 ',
        tool: 'Docker',
        version: '24.0.7',
        runtime: '   ',
      } as ExperienceEnv);
      expect(env).toEqual({ os: 'wsl2', tool: 'docker', version: '24.0.7' });
      expect(Object.keys(env)).not.toContain('runtime');
    });

    it('env undefined → 空对象（不写 null）', () => {
      expect(svc.normalizeEnv(undefined)).toEqual({});
    });

    it('写入时归一化生效：create 落库的 signals/domains/env 已是小写形态', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(null);
      await service.create(
        {
          title: 'T',
          summary: 'S',
          content: 'How verified: x',
          intent: 'repair',
          signals: ['ECONNREFUSED'],
          domains: ['DevOps'],
          env: { os: 'WSL2' },
        } as CreateExperienceDto,
        humanActor,
      );

      const saved = (manager.save as jest.Mock).mock.calls[0][0] as ExperienceEntry;
      expect(saved.signals).toEqual(['econnrefused']);
      expect(saved.domains).toEqual(['devops']);
      expect(saved.env).toEqual({ os: 'wsl2' });
      expect(saved.quality).toBe('unverified');
      expect(saved.createdById).toBe(UUID);
      expect(saved.createdByType).toBe(ActorType.HUMAN);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 密钥闸门
  // ══════════════════════════════════════════════════════════════════

  describe('密钥闸门（写入面）', () => {
    /**
     * 正例矩阵（plan v1.2 §7；**必须命中**）——spec 的用例表来源 = experience.constants.ts
     * 的 EXPERIENCE_SECRET_PATTERNS 注释（两处改动必须同步，铁律 #26 文档联动同规）。
     *
     * 私钥一栏刻意逐个列 PEM 变体：旧写法 `/begin private key/i` 只认 `BEGIN PRIVATE KEY`
     * 字面量，RSA/EC/OPENSSH/ENCRYPTED 等标准变体（任务 02f47bc1 的盲区）全部放行。
     */
    const cases: [string, string][] = [
      ['ask_ 平台 API Key', 'token=ask_abcdef123456'],
      ['apikey_ TypeSafe 官方云 key', 'TYPESAFE_API_KEY=apikey_abcdef123456'],
      ['sk- OpenAI 族', 'OPENAI_API_KEY=sk-abc123'],
      ['password= 连接串（大小写不敏感）', 'postgres://u:PASSWORD=hunter2@h/db'],
      ['PEM 私钥头（无算法前缀）', '-----BEGIN PRIVATE KEY-----'],
      ['PEM RSA 私钥头', '-----BEGIN RSA PRIVATE KEY-----'],
      ['PEM EC 私钥头', '-----BEGIN EC PRIVATE KEY-----'],
      ['PEM DSA 私钥头', '-----BEGIN DSA PRIVATE KEY-----'],
      ['PEM ECDSA 私钥头', '-----BEGIN ECDSA PRIVATE KEY-----'],
      ['PEM OpenSSH 私钥头', '-----BEGIN OPENSSH PRIVATE KEY-----'],
      ['PEM 加密私钥头', '-----BEGIN ENCRYPTED PRIVATE KEY-----'],
      ['PEM SSH2 加密私钥头', '-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----'],
      ['PGP 私钥块头', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
      ['PQC（ML-DSA）私钥头', '-----BEGIN ML-DSA-87 PRIVATE KEY-----'],
      ['私钥头（**无破折号**形态：粘自文档/日志）', 'BEGIN RSA PRIVATE KEY'],
      ['私钥头（两条破折号形态）', '--BEGIN OPENSSH PRIVATE KEY'],
      ['age 私钥文件', 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'],
      ['PuTTY 私钥文件头', 'PuTTY-User-Key-File-3: ssh-rsa'],
    ];

    it.each(cases)('命中 %s → 400 拒绝录入', async (_label, content) => {
      await expect(
        service.create(
          {
            title: 'T',
            summary: 'S',
            content,
            intent: 'repair',
            signals: ['x'],
          } as CreateExperienceDto,
          humanActor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * 负例矩阵（**必须放行**）——防"闭类写太宽把正常文本打成 400"。
     *
     * 三句散文是 v1.1 的 `/i` 闭类写法（`/begin\s+(\w+\s+)*private key/i`）实测误伤的原样
     * 复现；`BEGIN PUBLIC KEY` 是"含 BEGIN 与 KEY 但是公钥"的最近邻反例。
     */
    const negatives: [string, string][] = [
      ['公钥 PEM 头（不是秘密）', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...'],
      [
        '散文：begin by generating a private key pair',
        'Begin by generating a private key pair, then export it.',
      ],
      ['散文：begin the private key rotation', 'We begin the private key rotation every 90 days.'],
      [
        '散文：begin with a private key file',
        'Begin with a private key file and run ssh-keygen -y.',
      ],
      ['普通内容（无任何凭据形态）', '## Fix\nRestart the container and re-run the migration.'],
    ];

    it.each(negatives)('放行 %s（不误伤）', async (_label, content) => {
      await expect(
        service.create(
          {
            title: 'T',
            summary: 'S',
            content,
            intent: 'repair',
            signals: [`neg-${Math.random().toString(36).slice(2)}`],
          } as CreateExperienceDto,
          humanActor,
        ),
      ).resolves.toBeDefined();
    });

    it('编辑通道（PATCH 合并值）同矩阵：正例拦下', () => {
      for (const [, content] of cases) {
        expect(() =>
          svc.assertNoSecretPatternsMerged(
            { content },
            {
              title: 'T',
              summary: 'S',
              content,
              signals: [],
              domains: [],
              sourceProject: null,
              env: {},
            },
          ),
        ).toThrow(BadRequestException);
      }
    });

    it('编辑通道（PATCH 合并值）同矩阵：负例放行', () => {
      for (const [, content] of negatives) {
        expect(() =>
          svc.assertNoSecretPatternsMerged(
            { content },
            {
              title: 'T',
              summary: 'S',
              content,
              signals: [],
              domains: [],
              sourceProject: null,
              env: {},
            },
          ),
        ).not.toThrow();
      }
    });

    it('编辑通道：未触碰受闸字段时**不跑**闸门（历史遗留文本不阻断纯元数据编辑）', () => {
      expect(() =>
        svc.assertNoSecretPatternsMerged(
          // 空 DTO = 未触碰任何受闸字段（touchesSecretGatedField 为 false）
          {
            /**/
          },
          {
            title: 'T',
            summary: 'S',
            // 库里本来就有的旧文本（含 password=）不应因一次元数据编辑被拦
            content: 'legacy password=abc',
            signals: [],
            domains: [],
            sourceProject: null,
            env: {},
          },
        ),
      ).not.toThrow();
    });

    it('命中信号在 signals/env 值里同样被拦（不止正文）', async () => {
      await expect(
        service.create(
          {
            title: 'T',
            summary: 'S',
            content: 'How verified: x',
            intent: 'repair',
            signals: ['ask_deadbeef'],
          } as CreateExperienceDto,
          humanActor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(
          {
            title: 'T',
            summary: 'S',
            content: 'How verified: x',
            intent: 'repair',
            signals: ['x'],
            env: { tool: 'password=abc' },
          } as CreateExperienceDto,
          humanActor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 文案**不回显命中内容**（否则 400 本身成了密钥回显通道）', () => {
      const secret = 'ask_supersecretvalue';
      let message = '';
      try {
        svc.assertNoSecretPatterns({
          title: 'T',
          summary: 'S',
          content: `key=${secret}`,
          signals: ['x'],
        });
      } catch (err) {
        message = (err as BadRequestException).getResponse() as unknown as string;
        message = JSON.stringify((err as BadRequestException).getResponse());
      }
      expect(message).toContain('credential');
      expect(message).not.toContain('supersecretvalue');
    });

    it('闸门在**限流之前**：命中密钥的请求不消耗配额', async () => {
      const dto = {
        title: 'T',
        summary: 'S',
        content: 'password=abc',
        intent: 'repair',
        signals: ['x'],
      } as CreateExperienceDto;
      await expect(service.create(dto, humanActor)).rejects.toBeInstanceOf(BadRequestException);
      // 配额未被消耗：随后 30 次合法录入应当仍然全部通过
      for (let i = 0; i < EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW; i += 1) {
        await service.create(
          {
            title: 'T',
            summary: 'S',
            content: 'How verified: ok',
            intent: 'repair',
            signals: ['x'],
          } as CreateExperienceDto,
          humanActor,
        );
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 过期边界 / 疑似重复 / 缺节告警
  // ══════════════════════════════════════════════════════════════════

  it('expiresAt 必须是未来时刻 → 过去 400', async () => {
    await expect(
      service.create(
        {
          title: 'T',
          summary: 'S',
          content: 'How verified: x',
          intent: 'repair',
          signals: ['x'],
          expiresAt: '2020-01-01T00:00:00.000Z',
        } as CreateExperienceDto,
        humanActor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('m3：title/summary 纯空白（过 DTO @Length 但 trim 后为空）→ 400', async () => {
    for (const patch of [{ title: '   ' }, { summary: '\t\n ' }]) {
      const err = await service
        .create({ ...baseCreate(), ...patch } as CreateExperienceDto, humanActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      const payload = (err as BadRequestException).getResponse() as {
        code: number;
        message: string;
      };
      expect(payload.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(payload.message).toContain('must not be blank');
    }
    // 不落库：空标题/空摘要不该出现在库里
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('缺「验证方式」节 → 返回 warnings 但**不拒绝写入**', async () => {
    const result = await service.create(
      {
        title: 'T',
        summary: 'S',
        content: '## Symptom\nonly a symptom',
        intent: 'repair',
        signals: ['x'],
      } as CreateExperienceDto,
      humanActor,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('How verified');
    expect(result.quality).toBe('unverified');
  });

  it('含「验证方式」节 → 无 warnings', async () => {
    const result = await service.create(
      {
        title: 'T',
        summary: 'S',
        content: '## How verified\nran the repro twice',
        intent: 'repair',
        signals: ['x'],
      } as CreateExperienceDto,
      humanActor,
    );
    expect(result.warnings).toBeUndefined();
  });

  it('疑似重复阈值：signals 交集 ≥1 或 title similarity > 0.5，两条路径各自透出可解释字段', async () => {
    installQueryBuilders({
      rawMany: [
        {
          id: 'dup-1',
          title: 'WSL2 port unreachable',
          quality: 'verified',
          signals: ['econnrefused', 'port-unreachable'],
          title_similarity: '0.9',
        },
        {
          id: 'dup-2',
          title: 'Another entry',
          quality: 'unverified',
          signals: ['unrelated'],
          title_similarity: String(EXPERIENCE_DUPLICATE_TITLE_SIMILARITY),
        },
      ],
    });

    const result = await service.create(
      {
        title: 'WSL2 port unreachable',
        summary: 'S',
        content: 'How verified: x',
        intent: 'repair',
        signals: ['econnrefused'],
      } as CreateExperienceDto,
      humanActor,
    );

    expect(result.possibleDuplicates).toHaveLength(2);
    // shared `ExperienceDuplicateCandidate` 的 id/title/quality 是**必填**——B1 曾因
    // raw-key 形状失真让三者全为 undefined（响应退化成 [{}]），故逐个断言在场
    expect(result.possibleDuplicates?.[0]).toMatchObject({
      id: 'dup-1',
      title: 'WSL2 port unreachable',
      quality: 'verified',
      signalsMatched: ['econnrefused'],
    });
    expect(result.possibleDuplicates?.[0].titleSimilarity).toBeCloseTo(0.9);
    // 相似度恰好等于阈值（不 > 阈值）→ 不透出 titleSimilarity，但仍因 signals 路径可选？
    // dup-2 的 signals 不相交且相似度不 > 阈值 ⇒ 两个可解释字段都不透出
    expect(result.possibleDuplicates?.[1].signalsMatched).toBeUndefined();
    expect(result.possibleDuplicates?.[1].titleSimilarity).toBeUndefined();
  });

  it('疑似重复的候选查询用 `&&` overlap + trgm 阈值（**禁 `= ANY`**）', async () => {
    installQueryBuilders({ rawMany: [] });
    await service.create(
      {
        title: 'T',
        summary: 'S',
        content: 'How verified: x',
        intent: 'repair',
        signals: ['a'],
      } as CreateExperienceDto,
      humanActor,
    );
    const qb = mainQb();
    const whereClause = (qb.andWhere as jest.Mock).mock.calls.map((c) => String(c[0])).join(' | ');
    expect(whereClause).toContain('&&');
    expect(whereClause).not.toContain('= ANY');
    expect((qb.setParameters as jest.Mock).mock.calls[0][0].threshold).toBe(
      EXPERIENCE_DUPLICATE_TITLE_SIMILARITY,
    );
  });

  it('B1 回归钉：候选查询的每个实体列都**显式取别名**（数组形态 select 会让 raw key 变 e_id）', async () => {
    installQueryBuilders({ rawMany: [] });
    await service.create(
      {
        title: 'T',
        summary: 'S',
        content: 'How verified: x',
        intent: 'repair',
        signals: ['a'],
      } as CreateExperienceDto,
      humanActor,
    );

    const qb = mainQb();
    const selectCalls = [
      ...(qb.select as jest.Mock).mock.calls,
      ...(qb.addSelect as jest.Mock).mock.calls,
    ];
    // 实体列（非 similarity 表达式）必须以 (expr, alias) 两参形式出现
    const entitySelects = selectCalls.filter(
      (call) => String(call[0]).startsWith('e.') && !String(call[0]).includes('similarity'),
    );
    expect(entitySelects.map((call) => call[1])).toEqual(
      expect.arrayContaining(['id', 'title', 'quality', 'signals']),
    );
    // 且不得出现数组形态（无别名 ⇒ raw key 是 e_<col>，读 row.id 静默 undefined）
    expect(selectCalls.some((call) => Array.isArray(call[0]))).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════
  // 幂等
  // ══════════════════════════════════════════════════════════════════

  describe('录入幂等（复用 common helper，不内联分叉）', () => {
    it('同 key 同 payload 重放 → 返回首次快照 + idempotentReplay，零二次写入', async () => {
      const snapshot = { id: 'first-id', quality: 'unverified' };
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'experience',
        requestHash: expectedHash(snapshotPayload()),
        responseSnapshot: snapshot,
        clientRequestId: 'k',
      });

      const result = await service.create(
        { ...baseCreate(), clientRequestId: 'k' } as CreateExperienceDto,
        humanActor,
      );

      expect(result).toMatchObject({ id: 'first-id', idempotentReplay: true });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('同 key 不同 payload → 409 / 9002（防静默吞写）', async () => {
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'experience',
        requestHash: 'a-different-hash',
        responseSnapshot: { id: 'first-id' },
      });
      await expect(
        service.create(
          { ...baseCreate(), clientRequestId: 'k' } as CreateExperienceDto,
          humanActor,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('无 clientRequestId → 不做幂等登记（零开销旁路）', async () => {
      await service.create(baseCreate(), humanActor);
      expect(idempotencyRepo.findOne).not.toHaveBeenCalled();
      expect(idempotencyRepo.save).not.toHaveBeenCalled();
    });

    it('有 key 时幂等记录与业务写**同事务**（insertIdempotencyInTx 落在 manager 上）', async () => {
      await service.create(
        { ...baseCreate(), clientRequestId: 'k' } as CreateExperienceDto,
        humanActor,
      );

      // 业务条目经 manager.save 落库；幂等记录经 manager.getRepository(IdempotencyRecord)
      // 落库——两者都走同一个 EntityManager ⇒ 与业务写同事务（业务回滚则记录消失）
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.getRepository).toHaveBeenCalledWith(expect.anything());
      const businessRow = (manager.save as jest.Mock).mock.calls[0][0] as ExperienceEntry;
      expect(businessRow.title).toBe('T');

      const idemRow = (managerRepo.save as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(idemRow.entityType).toBe('experience');
      expect(idemRow.clientRequestId).toBe('k');
      expect(idemRow.requestHash).toHaveLength(64);
      // 快照里必须带真实 id（重放要能返回首次结果）
      expect((idemRow.responseSnapshot as { id: string }).id).toBe(UUID);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 限流窗口
  // ══════════════════════════════════════════════════════════════════

  describe('录入限流（按 actor，进程内滑动窗口）', () => {
    it(`单窗口内第 ${EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW + 1} 次 → 429（ErrorCode.RATE_LIMITED）`, async () => {
      for (let i = 0; i < EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW; i += 1) {
        await service.create(baseCreate(), humanActor);
      }
      const err = await service.create(baseCreate(), humanActor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
      const payload = (err as HttpException).getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.RATE_LIMITED);
      expect(payload.message).toContain('Retry in about');
    });

    it('限流按 actor 分桶：另一个 actor 不受影响', async () => {
      for (let i = 0; i < EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW; i += 1) {
        await service.create(baseCreate(), humanActor);
      }
      await expect(service.create(baseCreate(), agentActor)).resolves.toBeDefined();
    });

    it('窗口滑动：窗口外的时间戳被剔除（时间推进后可再录）', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const base = Date.now();
      for (let i = 0; i < EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW; i += 1) {
        nowSpy.mockReturnValue(base + i);
        await service.create(baseCreate(), humanActor);
      }
      nowSpy.mockReturnValue(base + 1);
      await expect(service.create(baseCreate(), humanActor)).rejects.toBeInstanceOf(HttpException);
      // 推进 1 小时 + 1s：早先的时间戳全部滑出窗口
      nowSpy.mockReturnValue(base + 60 * 60 * 1000 + 5000);
      await expect(service.create(baseCreate(), humanActor)).resolves.toBeDefined();
      nowSpy.mockRestore();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // baseQuery 收口：软删 + 过期 + suspect 豁免
  // ══════════════════════════════════════════════════════════════════

  describe('baseQuery 收口（列表/分面/词表口径唯一）', () => {
    it('缺省：软删 + 过期 + suspect 三重排除', async () => {
      await service.search({} as QueryExperienceDto, agentActor);
      const clauses = predicates(mainQb());
      expect(clauses.some((c) => c.includes('deleted_at IS NULL'))).toBe(true);
      expect(clauses.some((c) => c.includes('expires_at'))).toBe(true);
      expect(clauses.some((c) => c.includes('quality <>'))).toBe(true);
    });

    it('includeExpired=true → 放开过期排除（其余两重保留）', async () => {
      await service.search({ includeExpired: true } as QueryExperienceDto, agentActor);
      const clauses = predicates(mainQb());
      expect(clauses.some((c) => c.includes('expires_at'))).toBe(false);
      expect(clauses.some((c) => c.includes('quality <>'))).toBe(true);
    });

    it('显式 quality=suspect → 放开 suspect 排除（复核出口，任何调用方可用）', async () => {
      await service.search({ quality: 'suspect' } as QueryExperienceDto, agentActor);
      const clauses = predicates(mainQb());
      expect(clauses.some((c) => c.includes('quality <>'))).toBe(false);
      expect(clauses.some((c) => c.includes('e.quality = :quality'))).toBe(true);
    });

    it('includeSuspect 无角色 → 403/13004（显式拒绝而非静默忽略）', async () => {
      const err = await service
        .search({ includeSuspect: true } as QueryExperienceDto, agentActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(((err as ForbiddenException).getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
    });

    it('includeSuspect 空间成员（reviewer）→ 放开 suspect 排除（第二期放宽）', async () => {
      members.resolveMemberRole.mockResolvedValue('reviewer');
      await service.search({ includeSuspect: true } as QueryExperienceDto, agentActor);
      expect(predicates(mainQb()).some((c) => c.includes('quality <>'))).toBe(false);
    });

    it('includeSuspect owner → 放开 suspect 排除（第二期放宽）', async () => {
      members.resolveMemberRole.mockResolvedValue('owner');
      await service.search({ includeSuspect: true } as QueryExperienceDto, agentActor);
      expect(predicates(mainQb()).some((c) => c.includes('quality <>'))).toBe(false);
    });

    it('includeSuspect admin → 放开 suspect 排除', async () => {
      await service.search({ includeSuspect: true } as QueryExperienceDto, adminActor);
      expect(predicates(mainQb()).some((c) => c.includes('quality <>'))).toBe(false);
    });

    it('短路纪律：不带 includeSuspect 的普通列表**零成员查询**（plan §2.3）', async () => {
      await service.search({} as QueryExperienceDto, agentActor);
      expect(members.resolveMemberRole).not.toHaveBeenCalled();
    });

    it('facets 的 includeSuspect 同样受角色判权（无角色 → 403/13004）', async () => {
      await expect(
        service.facets({ includeSuspect: true } as QueryExperienceDto, agentActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('facets 例外：viewerIsReviewer 与 suspectCount 都按成员角色透出（每次必解析）', async () => {
      members.resolveMemberRole.mockResolvedValue('reviewer');
      const asReviewer = await service.facets({} as QueryExperienceDto, agentActor);
      expect(asReviewer.viewerIsReviewer).toBe(true);
      expect(members.resolveMemberRole).toHaveBeenCalledWith(agentActor.id);

      members.resolveMemberRole.mockResolvedValue(null);
      const asOutsider = await service.facets({} as QueryExperienceDto, agentActor);
      expect(asOutsider.viewerIsReviewer).toBe(false);
      // 非 reviewer 不给 suspectCount（可选披露面，不是报错）
      expect(asOutsider.suspectCount).toBeUndefined();
    });

    it('facets 对 admin 天然 viewerIsReviewer=true（plan §2.3：facets 每次必解析角色，admin 亦然）', async () => {
      const asAdmin = await service.facets({} as QueryExperienceDto, adminActor);
      expect(asAdmin.viewerIsReviewer).toBe(true);
      expect(members.resolveMemberRole).toHaveBeenCalledWith(adminActor.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 过滤谓词形状 / 分层排序
  // ══════════════════════════════════════════════════════════════════

  describe('过滤谓词与排序（SQL 形状；真 PG 命中由 e2e 证）', () => {
    it('signals/domains 用 `&&` overlap 且值被归一化（大小写不敏感查询）', async () => {
      await service.search(
        { signals: ['ECONNREFUSED'], domains: ['DevOps'] } as QueryExperienceDto,
        agentActor,
      );
      const clauses = predicates(mainQb());
      expect(clauses.some((c) => c.includes('signals &&'))).toBe(true);
      expect(clauses.some((c) => c.includes('domains &&'))).toBe(true);
      expect(clauses.join(' ')).not.toContain('= ANY');
      expect(param(mainQb(), 'signals')).toEqual(['econnrefused']);
      expect(param(mainQb(), 'domains')).toEqual(['devops']);
    });

    it('env 四键用 `->>` 精确相等 + 值归一化；四参数之间是 AND', async () => {
      await service.search(
        {
          envOs: 'WSL2',
          envTool: 'Docker',
          envVersion: '24.0.7',
          envRuntime: 'Node-20',
        } as QueryExperienceDto,
        agentActor,
      );
      const clauses = predicates(mainQb()).join(' ');
      expect(clauses).toContain("env->>'os' = :envOs");
      expect(clauses).toContain("env->>'tool' = :envTool");
      expect(clauses).toContain("env->>'version' = :envVersion");
      expect(clauses).toContain("env->>'runtime' = :envRuntime");
      expect(param(mainQb(), 'envOs')).toBe('wsl2');
      expect(param(mainQb(), 'envRuntime')).toBe('node-20');
    });

    it('有 q：融合分既进 WHERE（≥ floor 显式过滤）又进 ORDER BY + SELECT（透出 score）', async () => {
      await service.search({ q: 'port unreachable' } as QueryExperienceDto, agentActor);
      const clauses = predicates(mainQb()).join(' ');
      expect(clauses).toContain('plainto_tsquery');
      expect(clauses).toContain('similarity(e.content');
      expect(clauses).toContain('similarity(e.title');
      expect(param(mainQb(), 'scoreFloor')).toBe(EXPERIENCE_SCORE_FLOOR);
      // ORDER BY：融合分接管排序（verified 层优先 → 融合分 → 去重命中 → 新鲜度 → id）
      const orderKeys = (mainQb().addOrderBy as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(orderKeys.join(' ')).toContain('ts_rank');
      expect(orderKeys).toContain('e.distinct_helped_count');
      expect(orderKeys).toContain('e.updated_at');
      expect(orderKeys).toContain('e.id');
      expect(mainQb().addSelect).toHaveBeenCalled();
    });

    it('q 与过滤参数是 AND（q 不覆盖 signals 过滤）', async () => {
      await service.search({ q: 'x', signals: ['a'] } as QueryExperienceDto, agentActor);
      const clauses = predicates(mainQb());
      expect(clauses.some((c) => c.includes('signals &&'))).toBe(true);
      expect(clauses.some((c) => c.includes('scoreFloor'))).toBe(true);
    });

    it('纯空白 q 视为未传（不喂空 tsquery，避免"零命中看起来像 bug"）', async () => {
      await service.search({ q: '   ' } as QueryExperienceDto, agentActor);
      expect(predicates(mainQb()).join(' ')).not.toContain('scoreFloor');
    });

    it('无 q + most_used：verified 层 → distinct_helped_count → updated_at → id', async () => {
      await service.search({ sort: 'most_used' } as QueryExperienceDto, agentActor);
      const orderKeys = (mainQb().addOrderBy as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect((mainQb().orderBy as jest.Mock).mock.calls[0][0]).toContain("quality = 'verified'");
      expect(orderKeys).toEqual(['e.distinct_helped_count', 'e.updated_at', 'e.id']);
    });

    it('无 q + recent（缺省）：updated_at DESC → id（分页全序，稳定不漂移）', async () => {
      await service.search({} as QueryExperienceDto, agentActor);
      expect((mainQb().orderBy as jest.Mock).mock.calls[0]).toEqual(['e.updated_at', 'DESC']);
      expect((mainQb().addOrderBy as jest.Mock).mock.calls[0]).toEqual(['e.id', 'ASC']);
    });

    it('ORDER BY 不含任何用户输入拼接（排序键全是白名单常量）', async () => {
      await service.search({ sort: 'most_used' } as QueryExperienceDto, agentActor);
      const all = [
        ...(mainQb().orderBy as jest.Mock).mock.calls.flat(),
        ...(mainQb().addOrderBy as jest.Mock).mock.calls.flat(),
      ].map(String);
      expect(all.some((s) => s.includes('most_used'))).toBe(false);
      expect(all.some((s) => s.includes('recent'))).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 零命中埋点
  // ══════════════════════════════════════════════════════════════════

  describe('零命中埋点（fail-open + 只记真检索）', () => {
    it('零结果 → 成功信封 + hint + 落一行 had_results=false', async () => {
      const result = await service.search(
        { q: 'nothing matches' } as QueryExperienceDto,
        agentActor,
      );
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(result.hint).toContain('No prior experience matched');
      expect(result.hint).toContain('record_experience');
      expect(searchEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ hadResults: false }),
      );
    });

    it('有结果 → had_results=true（两个口径都落，否则零命中率恒等于 1）', async () => {
      installQueryBuilders({ count: 3, entities: [makeEntry()] });
      await service.search({ signals: ['a'] } as QueryExperienceDto, agentActor);
      expect(searchEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ hadResults: true }),
      );
    });

    it('裸浏览（无 q 无过滤）不记（不是检索，否则分母灌水）', async () => {
      await service.search({} as QueryExperienceDto, agentActor);
      expect(searchEventRepo.insert).not.toHaveBeenCalled();
    });

    it('第 2 页不重复记（同一检索翻页不该重复计数）', async () => {
      await service.search({ q: 'x', page: 2 } as QueryExperienceDto, agentActor);
      expect(searchEventRepo.insert).not.toHaveBeenCalled();
    });

    it('埋点写失败 fail-open：检索照常返回（观测绝不阻断业务）', async () => {
      searchEventRepo.insert = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(
        service.search({ q: 'x' } as QueryExperienceDto, agentActor),
      ).resolves.toMatchObject({
        total: 0,
      });
    });

    it('指纹稳定：同一组过滤条件恒得同一 hash；排序/分页不影响', () => {
      const a = svc.fingerprintFilters({
        q: 'x',
        includeExpired: false,
        includeSuspect: false,
        sort: 'recent',
      });
      const b = svc.fingerprintFilters({
        q: 'x',
        includeExpired: false,
        includeSuspect: false,
        sort: 'most_used',
      });
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
      expect(
        svc.fingerprintFilters({ q: 'y', includeExpired: false, includeSuspect: false }),
      ).not.toBe(a);
    });

    it('指纹不含原文：q 的明文不出现在 hash 输入里（观测表不做第二个泄漏面）', () => {
      const hash = svc.fingerprintFilters({
        q: 'password=abc',
        includeExpired: false,
        includeSuspect: false,
      });
      expect(hash).not.toContain('password');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 响应投影
  // ══════════════════════════════════════════════════════════════════

  describe('响应投影', () => {
    it('列表项含 expiresAt / signalsMatched / 不含量 content', async () => {
      installQueryBuilders({ count: 1, entities: [makeEntry({ signals: ['a', 'b'] })] });
      const result = await service.search({ signals: ['a'] } as QueryExperienceDto, agentActor);
      expect(result.items[0].signalsMatched).toEqual(['a']);
      expect(result.items[0].expiresAt).toBeNull();
      expect(result.items[0]).not.toHaveProperty('content');
      expect(result.appliedFilters).toMatchObject({ signals: ['a'], includeExpired: false });
    });

    it('过期条目的 expired 派生标记为 true（includeExpired=true 时才会出现）', async () => {
      const past = new Date(Date.now() - 86_400_000);
      installQueryBuilders({ count: 1, entities: [makeEntry({ expiresAt: past })] });
      const result = await service.search(
        { includeExpired: true } as QueryExperienceDto,
        agentActor,
      );
      expect(result.items[0].expired).toBe(true);
    });

    it('有 q 时 appliedFilters 不回声 sort（排序由融合分接管，回显一个未生效的值会误导）', async () => {
      const result = await service.search(
        { q: 'x', sort: 'most_used' } as QueryExperienceDto,
        agentActor,
      );
      expect(result.appliedFilters?.sort).toBeUndefined();
      expect(result.appliedFilters?.q).toBe('x');
    });

    it('无 q 时 appliedFilters 回声 sort', async () => {
      const result = await service.search({ sort: 'most_used' } as QueryExperienceDto, agentActor);
      expect(result.appliedFilters?.sort).toBe('most_used');
    });

    it('score 在带 q 时透出（getRawAndEntities 的 raw 列映射）', async () => {
      installQueryBuilders({ count: 1, entities: [makeEntry()], rawScores: [0.42] });
      const result = await service.search({ q: 'x' } as QueryExperienceDto, agentActor);
      expect(result.items[0].score).toBeCloseTo(0.42);
    });

    it('availableDomains 词表回显（按频次降序，走同一 baseQuery 子查询）', async () => {
      dataSource.query = jest.fn().mockResolvedValue([
        { domain: 'devops', count: 3 },
        { domain: 'docker', count: 1 },
      ]);
      const result = await service.search({} as QueryExperienceDto, agentActor);
      expect(result.availableDomains).toEqual(['devops', 'docker']);
      // 谓词复用：外包 SQL 里嵌入了 baseQuery 的 SQL 片段 + 承接参数编号
      const [sql] = dataSource.query.mock.calls[0];
      expect(String(sql)).toContain('unnest(base.domains)');
      expect(String(sql)).toContain('deleted_at IS NULL');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 分面
  // ══════════════════════════════════════════════════════════════════

  describe('分面（键全量零填充 + admin 单列 suspectCount）', () => {
    it('byIntent/byQuality 键全量：未命中的取值为 0', async () => {
      installQueryBuilders({ rawMany: [{ key: 'repair', count: '2' }] });
      const result = await service.facets({} as QueryExperienceDto, agentActor);
      expect(Object.keys(result.byIntent)).toEqual([
        'pitfall',
        'repair',
        'howto',
        'optimize',
        'decision',
      ]);
      expect(result.byIntent.repair).toBe(2);
      expect(result.byIntent.pitfall).toBe(0);
      expect(Object.keys(result.byQuality)).toEqual(['unverified', 'verified', 'suspect']);
      expect(result.byQuality.verified).toBe(0);
      expect(result.total).toBe(2);
    });

    it('非 admin 不透出 suspectCount 键（可选披露面，不是权限动作）', async () => {
      const result = await service.facets({} as QueryExperienceDto, agentActor);
      expect(result).not.toHaveProperty('suspectCount');
    });

    it('admin 透出 suspectCount（复核队列规模；在放开 suspect 排除的口径上数）', async () => {
      installQueryBuilders({ count: 4 });
      const result = await service.facets({} as QueryExperienceDto, adminActor);
      expect(result.suspectCount).toBe(4);
      // suspectCount 用的 builder 是 facets 里**最后**建的那个（前三个分别是 byIntent/
      // byQuality/availableDomains），且必须在放开 suspect 排除的口径上再叠 quality='suspect'
      expect(predicates(newestQb()).some((c) => c.includes('e.quality = :suspectQuality'))).toBe(
        true,
      );
      expect(predicates(newestQb()).some((c) => c.includes('quality <>'))).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 详情 / 404
  // ══════════════════════════════════════════════════════════════════

  describe('详情（只过滤软删 + 第二期 viewer/suppression）', () => {
    it('找不到 → 404/13000，message 指引「勿重试同 id，回 search」', async () => {
      installQueryBuilders({ entity: null });
      const err = await service.findOne(UUID, adminActor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      const payload = (err as NotFoundException).getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.EXPERIENCE_NOT_FOUND);
      expect(payload.message).toContain('Do NOT retry the same id');
      expect(payload.message).toContain('search');
    });

    it('suspect / 已过期条目照常可见并带标记（复核/申诉动线）', async () => {
      const past = new Date(Date.now() - 86_400_000);
      installQueryBuilders({ entity: makeEntry({ quality: 'suspect', expiresAt: past }) });
      const detail = await service.findOne(UUID, adminActor);
      expect(detail.quality).toBe('suspect');
      expect(detail.expired).toBe(true);
      expect(detail.content).toBeDefined();
    });

    it('详情读路径显式 addSelect judgment 列（select:false 的 jsonb 缓存列）', async () => {
      installQueryBuilders({ entity: makeEntry() });
      await service.findOne(UUID, agentActor);
      expect(mainQb().addSelect).toHaveBeenCalledWith('e.judgment');
    });

    it('viewer 字段取自成员服务（服务端单源，service 不自行判定）', async () => {
      installQueryBuilders({ entity: makeEntry() });
      members.evaluateReviewPermission.mockResolvedValue({ canReview: false });
      const detail = await service.findOne(UUID, agentActor);
      expect(detail.viewerCanReview).toBe(false);
      // v1.81.0：`viewerReviewBlockReason` 已停发——字段从类型中删除，故断言"响应对象里
      // **没有这个键**"（防后来人再补一个恒 null 的兼容字段，那会让旧消费方按旧语义分支）
      expect('viewerReviewBlockReason' in detail).toBe(false);
    });

    it('防锚定 suppression：可审 + 非 verified → judgment=null 且 judgmentSuppressed=true', async () => {
      // 条目库里其实有一份快照（entry.judgment）
      installQueryBuilders({
        entity: makeEntry({
          quality: 'unverified',
          judgment: { provider: 'jev', model: 'm', judgedAt: 'x' } as never,
        }),
      });
      members.evaluateReviewPermission.mockResolvedValue({ canReview: true });
      const detail = await service.findOne(UUID, agentActor);
      expect(detail.judgment).toBeNull();
      expect(detail.judgmentSuppressed).toBe(true);
    });

    it('终审后（quality=verified）恢复可见：可审也不再 suppression', async () => {
      const snapshot = { provider: 'jev', model: 'm', judgedAt: 'x' } as never;
      installQueryBuilders({ entity: makeEntry({ quality: 'verified', judgment: snapshot }) });
      members.evaluateReviewPermission.mockResolvedValue({ canReview: true });
      const detail = await service.findOne(UUID, agentActor);
      expect(detail.judgment).toEqual(snapshot);
      expect(detail.judgmentSuppressed).toBe(false);
    });

    it('不可审的读者（无终审角色）看到未脱敏快照——他们是 observe 期数据消费者', async () => {
      const snapshot = { provider: 'jev', model: 'm', judgedAt: 'x' } as never;
      installQueryBuilders({ entity: makeEntry({ quality: 'unverified', judgment: snapshot }) });
      const detail = await service.findOne(UUID, agentActor);
      expect(detail.viewerCanReview).toBe(false);
      expect(detail.judgment).toEqual(snapshot);
      expect(detail.judgmentSuppressed).toBe(false);
    });

    it('summary 投影带 createdById/createdByType + 名字三件套（v1.81.0）', async () => {
      installQueryBuilders({ entity: makeEntry() });
      const detail = await service.findOne(UUID, agentActor);
      expect(detail.createdById).toBeDefined();
      expect(detail.createdByType).toBeDefined();
      // 展示维度（查询维度是上面的 id；展示维度必须换名，不能上屏裸 UUID）
      expect(detail.createdByName).toBe('coder');
      expect(detail.createdByAvatarUrl).toBeNull();
      expect(detail.createdByDeletedAt).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 反馈：三列联动 / 改判 / 过期 / 幂等
  // ══════════════════════════════════════════════════════════════════

  describe('反馈（plan §1.2 不变量）', () => {
    /** 装配 manager.query 的三段返回（行锁 / 计数 UPDATE / 其他） */
    function primeFeedback(params: {
      locked?: Partial<Record<string, unknown>> | null;
      counts?: [number, number, number];
    }): void {
      const lockedRow =
        params.locked === null
          ? []
          : [
              {
                id: UUID,
                expires_at: null,
                helped_count: 0,
                not_helpful_count: 0,
                distinct_helped_count: 0,
                ...(params.locked ?? {}),
              },
            ];
      const [h, n, d] = params.counts ?? [0, 0, 0];
      (manager.query as jest.Mock).mockImplementation((sql: string) => {
        if (String(sql).includes('FOR UPDATE')) return Promise.resolve(lockedRow);
        if (String(sql).includes('UPDATE experience_entries')) {
          // 形状必须是 **TypeORM 对 UPDATE 的真实返回**：`[rows, affectedCount]`
          // （e2e 实证；写成 INSERT 的纯 rows 会让"解包漏了"这种 bug 在单测里漏网）
          return Promise.resolve([
            [{ helped_count: h, not_helpful_count: n, distinct_helped_count: d }],
            1,
          ]);
        }
        return Promise.resolve([]);
      });
    }

    it('新增 helped → helped+1 & distinct+1（单语句带 ±1 增量 + RETURNING）', async () => {
      primeFeedback({ counts: [1, 0, 1] });
      feedbackRepo.findOne = jest.fn().mockResolvedValue(null);

      const result = await service.recordFeedback(
        UUID,
        { outcome: 'helped', clientRequestId: 'fb-1' },
        agentActor,
      );

      expect(result).toMatchObject({ helpedCount: 1, notHelpfulCount: 0, distinctHelpedCount: 1 });
      const updateSql = (manager.query as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes('UPDATE experience_entries'))!;
      expect(updateSql).toContain('helped_count = helped_count + $2');
      expect(updateSql).toContain('deleted_at IS NULL');
      expect(updateSql).toContain('RETURNING');
      // 禁 repository.increment()：整条路径不得出现仓储自增（会顶 updated_at）
      expect((feedbackRepo as unknown as Record<string, unknown>).increment).toBeUndefined();
      const updateParams = (manager.query as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('UPDATE experience_entries'),
      )![1] as number[];
      expect(updateParams).toEqual([UUID, 1, 0, 1, true]);
    });

    it('新增 not_helpful → not_helpful+1（helped/distinct 不动）', async () => {
      primeFeedback({ counts: [0, 1, 0] });
      feedbackRepo.findOne = jest.fn().mockResolvedValue(null);
      await service.recordFeedback(
        UUID,
        { outcome: 'not_helpful', clientRequestId: 'fb-1' },
        agentActor,
      );
      const params = (manager.query as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('UPDATE experience_entries'),
      )![1] as number[];
      expect(params).toEqual([UUID, 0, 1, 0, false]);
    });

    it('改判 helped → not_helpful：三列 ±1 显式迁移（−1/+1/−1）', async () => {
      primeFeedback({ counts: [0, 1, 0] });
      feedbackRepo.findOne = jest
        .fn()
        // 第一次 = 幂等键预检（未命中）→ null；第二次 = 去重仲裁行（已有 helped）
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'row-1', outcome: 'helped', experienceId: UUID });

      const result = await service.recordFeedback(
        UUID,
        { outcome: 'not_helpful', clientRequestId: 'fb-2' },
        agentActor,
      );

      expect(result.alreadyRecorded).toBe(true);
      const params = (manager.query as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('UPDATE experience_entries'),
      )![1] as number[];
      expect(params).toEqual([UUID, -1, 1, -1, false]);
      // 反馈行的 outcome **与 clientRequestId 一起**被改判（同一行、不新插）——M1 评审修订：
      // key 随最新判决走，否则新 key 永不落库，它的重放拿不到 idempotentReplay、
      // 换 outcome 再发也不会 409（静默二次改判）、且可被用到别的条目上（键空间失守）
      expect(feedbackRepo.update).toHaveBeenCalledWith(
        { id: 'row-1' },
        { outcome: 'not_helpful', clientRequestId: 'fb-2' },
      );
      expect(feedbackRepo.insert).not.toHaveBeenCalled();
    });

    it('改判 not_helpful → helped：+1/−1/+1 且推进 last_helped_at', async () => {
      primeFeedback({ counts: [1, 0, 1] });
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'row-1', outcome: 'not_helpful', experienceId: UUID });
      await service.recordFeedback(
        UUID,
        { outcome: 'helped', clientRequestId: 'fb-3' },
        agentActor,
      );
      const params = (manager.query as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('UPDATE experience_entries'),
      )![1] as number[];
      expect(params).toEqual([UUID, 1, -1, 1, true]);
    });

    it('重复同一 outcome → 零增量（幂等，不重复累加）', async () => {
      primeFeedback({ counts: [1, 0, 1] });
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'row-1', outcome: 'helped', experienceId: UUID });
      const result = await service.recordFeedback(
        UUID,
        { outcome: 'helped', clientRequestId: 'fb-4' },
        agentActor,
      );
      expect(result.alreadyRecorded).toBe(true);
      const params = (manager.query as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('UPDATE experience_entries'),
      )![1] as number[];
      expect(params).toEqual([UUID, 0, 0, 0, false]);
      // 计数零增量，但 **key 仍要落到最新判决上**（M1）：本请求带的是新 key（同 key 同
      // outcome 会在更早的幂等预检处直接重放，走不到这里）
      expect(feedbackRepo.update).toHaveBeenCalledWith(
        { id: 'row-1' },
        { outcome: 'helped', clientRequestId: 'fb-4' },
      );
    });

    it('M1：改判后的新 key 重发同 outcome → idempotentReplay（零计数、零行写入）', async () => {
      primeFeedback({ locked: { helped_count: 1, distinct_helped_count: 1 } });
      // 幂等预检命中"上一次改判用的 key"（说明它已落库）
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'row-1',
          outcome: 'not_helpful',
          experienceId: UUID,
          clientRequestId: 'fb-2',
        });

      const result = await service.recordFeedback(
        UUID,
        { outcome: 'not_helpful', clientRequestId: 'fb-2' },
        agentActor,
      );

      expect(result).toMatchObject({
        alreadyRecorded: true,
        idempotentReplay: true,
        helpedCount: 1,
        distinctHelpedCount: 1,
      });
      expect(feedbackRepo.update).not.toHaveBeenCalled();
      expect(feedbackRepo.insert).not.toHaveBeenCalled();
    });

    it('M1：改判后的新 key 换 outcome 再发 → 409/9002（不得静默二次改判）', async () => {
      primeFeedback({});
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'row-1',
          outcome: 'not_helpful',
          experienceId: UUID,
          clientRequestId: 'fb-2',
        });
      const err = await service
        .recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-2' }, agentActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(((err as ConflictException).getResponse() as { code: number }).code).toBe(
        ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      );
    });

    it('M1：改判后的新 key 用于**另一条目** → 409/9002（键空间不因改判失守）', async () => {
      primeFeedback({});
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({ id: 'row-1', outcome: 'helped', experienceId: OTHER_UUID });
      await expect(
        service.recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-2' }, agentActor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('同 key 同 payload → idempotentReplay（零计数写入、零反馈行写入）', async () => {
      primeFeedback({ locked: { helped_count: 1, distinct_helped_count: 1 } });
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'row-1',
          outcome: 'helped',
          experienceId: UUID,
          clientRequestId: 'fb-5',
        });

      const result = await service.recordFeedback(
        UUID,
        { outcome: 'helped', clientRequestId: 'fb-5' },
        agentActor,
      );

      expect(result).toMatchObject({
        idempotentReplay: true,
        alreadyRecorded: true,
        helpedCount: 1,
      });
      expect(manager.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE experience_entries'),
        expect.anything(),
      );
    });

    it('同 key 不同 outcome → 409/9002（勿重试；改判要换新 key）', async () => {
      primeFeedback({});
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'row-1',
          outcome: 'helped',
          experienceId: UUID,
          clientRequestId: 'fb-6',
        });
      const err = await service
        .recordFeedback(UUID, { outcome: 'not_helpful', clientRequestId: 'fb-6' }, agentActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(((err as ConflictException).getResponse() as { code: number }).code).toBe(
        ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      );
    });

    it('同 key 打到**不同条目** → 409/9002（键空间不可跨条目复用）', async () => {
      primeFeedback({});
      feedbackRepo.findOne = jest
        .fn()
        .mockResolvedValueOnce({ id: 'row-1', outcome: 'helped', experienceId: OTHER_UUID });
      await expect(
        service.recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-7' }, agentActor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('过期条目 → 409 拒绝反馈（文案指引"搜更新的条目"、勿重试）', async () => {
      primeFeedback({ locked: { expires_at: new Date(Date.now() - 1000) } });
      const err = await service
        .recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-8' }, agentActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      const payload = (err as ConflictException).getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.RESOURCE_CONFLICT);
      expect(payload.message).toContain('Do NOT retry');
    });

    it('条目不存在/已软删（行锁空）→ 404/13000', async () => {
      primeFeedback({ locked: null });
      const err = await service
        .recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-9' }, agentActor)
        .catch((e: unknown) => e);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: ErrorCode.EXPERIENCE_NOT_FOUND,
      });
    });

    it('并发同键撞 uq_experience_feedback_actor_key → 转 409/9002（不冒 500）', async () => {
      primeFeedback({});
      feedbackRepo.findOne = jest.fn().mockResolvedValue(null);
      feedbackRepo.insert = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('dup'), {
            code: '23505',
            constraint: 'uq_experience_feedback_actor_key',
          }),
        );
      await expect(
        service.recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-10' }, agentActor),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('计数 UPDATE rowCount=0 → 13000（而非静默返回成功）', async () => {
      (manager.query as jest.Mock).mockImplementation((sql: string) => {
        if (String(sql).includes('FOR UPDATE')) {
          return Promise.resolve([
            {
              id: UUID,
              expires_at: null,
              helped_count: 0,
              not_helpful_count: 0,
              distinct_helped_count: 0,
            },
          ]);
        }
        if (String(sql).includes('UPDATE experience_entries')) return Promise.resolve([[], 0]);
        return Promise.resolve([]);
      });
      feedbackRepo.findOne = jest.fn().mockResolvedValue(null);
      await expect(
        service.recordFeedback(UUID, { outcome: 'helped', clientRequestId: 'fb-11' }, agentActor),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('反馈不更新 updated_at（否则 sort=recent 会被反馈刷屏）', async () => {
      primeFeedback({ counts: [1, 0, 1] });
      feedbackRepo.findOne = jest.fn().mockResolvedValue(null);
      await service.recordFeedback(
        UUID,
        { outcome: 'helped', clientRequestId: 'fb-12' },
        agentActor,
      );
      const updateSql = (manager.query as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes('UPDATE experience_entries'))!;
      expect(updateSql).not.toContain('updated_at');
    });
  });

  describe('feedbackDelta（纯函数状态机）', () => {
    it.each([
      [
        undefined,
        'helped',
        { helped: 1, notHelpful: 0, distinctHelped: 1, touchLastHelpedAt: true },
      ],
      [
        undefined,
        'not_helpful',
        { helped: 0, notHelpful: 1, distinctHelped: 0, touchLastHelpedAt: false },
      ],
      [
        'helped',
        'helped',
        { helped: 0, notHelpful: 0, distinctHelped: 0, touchLastHelpedAt: false },
      ],
      [
        'not_helpful',
        'not_helpful',
        { helped: 0, notHelpful: 0, distinctHelped: 0, touchLastHelpedAt: false },
      ],
      [
        'helped',
        'not_helpful',
        { helped: -1, notHelpful: 1, distinctHelped: -1, touchLastHelpedAt: false },
      ],
      [
        'not_helpful',
        'helped',
        { helped: 1, notHelpful: -1, distinctHelped: 1, touchLastHelpedAt: true },
      ],
    ] as const)('%s → %s', (prev, next, expected) => {
      expect(svc.feedbackDelta(prev, next)).toEqual(expected);
    });
  });

  describe('B1：显式 null 的两层防御（DTO @ValidateIf + service 守卫）', () => {
    it('assertNoNullNonNullableFields：七个非清空字段任一为 null → 400，文案指引"省略该键"', () => {
      for (const field of ['title', 'summary', 'content', 'intent', 'signals', 'domains', 'env']) {
        const err = captureBadRequest(() => svc.assertNoNullNonNullableFields({ [field]: null }));
        expect(err).toBeDefined();
        const payload = err!.getResponse() as { code: number; message: string };
        expect(payload.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(payload.message).toContain(field);
        expect(payload.message).toContain('sourceProject');
        expect(payload.message).toContain('OMIT');
      }
    });

    it('assertNoNullNonNullableFields：两个可空字段 + 缺席字段一律放行', () => {
      expect(() =>
        svc.assertNoNullNonNullableFields({
          sourceProject: null,
          expiresAt: null,
          intent: 'howto',
        }),
      ).not.toThrow();
      expect(() => svc.assertNoNullNonNullableFields({})).not.toThrow();
    });

    it('assertNonBlank 对非字符串（含 null）→ 400 而非 TypeError→500', () => {
      const err = captureBadRequest(() => svc.assertNonBlank(null, 'title'));
      expect(err).toBeDefined();
      expect((err!.getResponse() as { message: string }).message).toContain('must be a string');
      // 正常字符串仍返回 trim 后的值
      expect(svc.assertNonBlank('  ok  ', 'title')).toBe('ok');
    });

    it('normalizeElements 对非数组（含 null）→ 返回空数组而非 not iterable 崩溃', () => {
      expect(svc.normalizeElements(null)).toEqual([]);
      expect(svc.normalizeElements(undefined)).toEqual([]);
      expect(svc.normalizeElements('a,b' as never)).toEqual([]);
    });

    it('update() 入口的守卫真实生效：PATCH title=null → 400（**不是 500**）', async () => {
      const entry = makeEntry({ createdById: STRANGER_UUID });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      lockedEntry = entry;

      const err = await service
        .update(
          UUID,
          {
            expectedUpdatedAt: '2026-09-01T00:00:00.000Z',
            title: null,
          } as unknown as UpdateExperienceDto,
          adminActor,
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getStatus()).toBe(400);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('normalizeUpdateReturning（TypeORM UPDATE 返回形状解包）', () => {
    it('解包 `[rows, affected]`（UPDATE 的真实形状）', () => {
      expect(svc.normalizeUpdateReturning([[{ id: 'a' }], 1])).toEqual([{ id: 'a' }]);
    });

    it('兼容纯 rows 形态（INSERT 风格 / 未来版本变化）', () => {
      expect(svc.normalizeUpdateReturning([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    });

    it('零影响行数 → 空数组（`[[], 0].length === 2` 不该被当成"有行"）', () => {
      expect(svc.normalizeUpdateReturning([[], 0])).toEqual([]);
    });

    it('非数组输入 → 空数组（防御性）', () => {
      expect(svc.normalizeUpdateReturning(undefined)).toEqual([]);
      expect(svc.normalizeUpdateReturning({ rows: [] })).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 编辑：作者判定 / 乐观锁 / quality 回落
  // ══════════════════════════════════════════════════════════════════

  describe('编辑（作者判定 / 乐观锁 / 内容改写回落）', () => {
    function primeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
      const entry = makeEntry({
        createdById: STRANGER_UUID,
        verifiedBy: UUID,
        verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        quality: 'verified',
        updatedAt: new Date('2026-09-21T10:00:00.000Z'),
        ...overrides,
      });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      // update 走事务内 FOR UPDATE 行锁读取（M3 评审修订），故同时 prime 锁内返回值
      lockedEntry = entry;
      return entry;
    }

    const lockDto = (overrides: Partial<UpdateExperienceDto> = {}): UpdateExperienceDto =>
      ({ expectedUpdatedAt: '2026-09-21T10:00:00.000Z', ...overrides }) as UpdateExperienceDto;

    it('M3：update 在**事务内**以 FOR UPDATE 行锁读取（乐观锁不再是 TOCTOU）', async () => {
      primeEntry();
      await service.update(UUID, lockDto({ summary: 'x' }), adminActor);

      // 行锁读取必须发生在事务里的 EntityManager 上，且显式 pessimistic_write
      expect(dataSource.transaction).toHaveBeenCalled();
      const qb = entryTxRepo.createQueryBuilder.mock.results[0].value as Record<string, jest.Mock>;
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      // 事务外 findOne 不再参与 update（否则"比 token"与"写"之间仍有窗口）
      expect(entryRepo.findOne).not.toHaveBeenCalled();
    });

    it('M2：PATCH 走与 create 同口径的密钥闸门 → 400 且不回显密钥', async () => {
      primeEntry();
      const secret = 'password=hunter2';
      const err = await service
        .update(UUID, lockDto({ content: `## Fix\n${secret}` }), adminActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      const payload = (err as BadRequestException).getResponse() as {
        code: number;
        message: string;
      };
      expect(payload.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(payload.message).toContain('credential');
      expect(JSON.stringify(payload)).not.toContain('hunter2');
      // 闸门在落库之前拦截（不产生任何写入）——update 的写入路径是**事务内的 manager.save**
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('M2：密钥藏在 signals/domains/env/sourceProject 里同样被拦（与 create 覆盖一致）', async () => {
      for (const patch of [
        { signals: ['sk-abc123xyz'] },
        { domains: ['ask_deadbeef'] },
        { env: { tool: 'password=x' } },
        { sourceProject: 'sk-abc123xyz' },
      ]) {
        primeEntry();
        await expect(
          service.update(UUID, lockDto(patch as Partial<UpdateExperienceDto>), adminActor),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('M2：纯元数据编辑（intent/expiresAt）不跑闸门（历史遗留文本不阻断无关编辑）', async () => {
      // 条目里预置一段"像密钥"的文本（模拟闸门上线前录入的存量数据）
      const entry = primeEntry({ content: 'legacy password=old' });
      await expect(
        service.update(UUID, lockDto({ intent: 'howto' }), adminActor),
      ).resolves.toBeDefined();
      expect(entry.intent).toBe('howto');
    });

    it('m3：PATCH 把 title/summary 改成纯空白 → 400（不落库空标题）', async () => {
      primeEntry();
      const err = await service
        .update(UUID, lockDto({ title: '   ' }), adminActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
      const err2 = await service
        .update(UUID, lockDto({ summary: '\n' }), adminActor)
        .catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(BadRequestException);
    });

    it('乐观锁：expectedUpdatedAt 与库中不符 → 409（正确动作=重读后重试）', async () => {
      primeEntry();
      const err = await service
        .update(UUID, lockDto({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }), adminActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      const payload = (err as ConflictException).getResponse() as { code: number; message: string };
      expect(payload.code).toBe(ErrorCode.RESOURCE_CONFLICT);
      expect(payload.message).toContain('Re-read');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('改 content → quality 回落 unverified + 清 verified_by/at（徽章洗白防线）', async () => {
      const entry = primeEntry();
      await service.update(UUID, lockDto({ content: 'new body with How verified' }), adminActor);
      expect(entry.quality).toBe('unverified');
      expect(entry.verifiedBy).toBeNull();
      expect(entry.verifiedAt).toBeNull();
    });

    it('改 title / summary / signals 同样触发回落', async () => {
      for (const patch of [
        { title: '新标题' },
        { summary: '新摘要' },
        { signals: ['new-signal'] },
      ]) {
        const entry = primeEntry();
        (entryRepo.save as jest.Mock).mockClear();
        await service.update(UUID, lockDto(patch as Partial<UpdateExperienceDto>), adminActor);
        expect(entry.quality).toBe('unverified');
      }
    });

    it('只改元数据（intent/domains/env/expiresAt/sourceProject）→ quality 保持 verified', async () => {
      const entry = primeEntry();
      await service.update(
        UUID,
        lockDto({
          intent: 'howto',
          domains: ['devops'],
          env: { os: 'wsl2' },
          expiresAt: null,
          sourceProject: 'x',
        }),
        adminActor,
      );
      expect(entry.quality).toBe('verified');
      expect(entry.verifiedBy).toBe(UUID);
      expect(entry.expiresAt).toBeNull();
    });

    it('归一化后等价的 signals 改动不算"改了内容"（[A] vs [a] 不触发回落）', async () => {
      const entry = primeEntry({ signals: ['a'] });
      await service.update(UUID, lockDto({ signals: ['  A '] }), adminActor);
      expect(entry.quality).toBe('verified');
    });

    // ─── 第二期：suspect 粘性（治理修订，plan §0）────────────────────

    it('suspect 粘性：改 content 不回落（被审人不得用编辑单方面撤销终审判定）', async () => {
      const entry = primeEntry({ quality: 'suspect' });
      await service.update(UUID, lockDto({ content: 'rewritten suspect body' }), adminActor);
      expect(entry.quality).toBe('suspect');
      // 终审留痕同样保留（两列语义 = "最近一次终审"，不是"通过时刻"）
      expect(entry.verifiedBy).toBe(UUID);
    });

    it('suspect 粘性：改 title / summary / signals 同样不回落', async () => {
      for (const patch of [
        { title: '新标题' },
        { summary: '新摘要' },
        { signals: ['new-signal'] },
      ]) {
        const entry = primeEntry({ quality: 'suspect' });
        await service.update(UUID, lockDto(patch as Partial<UpdateExperienceDto>), adminActor);
        expect(entry.quality).toBe('suspect');
      }
    });

    it('unverified 条目改内容仍是 unverified（回落只对 verified 有感）', async () => {
      const entry = primeEntry({ quality: 'unverified' });
      await service.update(UUID, lockDto({ content: 'another body' }), adminActor);
      expect(entry.quality).toBe('unverified');
    });

    it('显式 null 清空 expiresAt / sourceProject（缺席=保留，null=采用）', async () => {
      const entry = primeEntry({
        expiresAt: new Date('2026-12-31T00:00:00.000Z'),
        sourceProject: 'old',
      });
      await service.update(UUID, lockDto({ expiresAt: null, sourceProject: null }), adminActor);
      expect(entry.expiresAt).toBeNull();
      expect(entry.sourceProject).toBeNull();
    });

    it('PATCH 的 expiresAt 也必须是未来（过去 → 400）', async () => {
      primeEntry();
      await expect(
        service.update(UUID, lockDto({ expiresAt: '2020-01-01T00:00:00.000Z' }), adminActor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('非作者非 admin → 403/13001 + 越权尝试审计插桩', async () => {
      primeEntry();
      const err = await service
        .update(UUID, lockDto({ content: 'x' }), agentActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(((err as ForbiddenException).getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_FORBIDDEN,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'experience',
          entityId: UUID,
          actorId: OTHER_UUID,
          newData: expect.objectContaining({ denied: true, attempt: 'update' }),
        }),
      );
    });

    it('creator 自己（非 admin）可改', async () => {
      primeEntry({ createdById: agentActor.id, quality: 'unverified' });
      await expect(
        service.update(UUID, lockDto({ intent: 'howto' }), agentActor),
      ).resolves.toBeDefined();
    });

    it('owner 代理（人类 owner 拥有创建该条目的 agent）可改', async () => {
      primeEntry();
      ownerProxy.isOwnerProxy = jest.fn().mockResolvedValue(true);
      await expect(
        service.update(UUID, lockDto({ intent: 'howto' }), humanActor),
      ).resolves.toBeDefined();
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith(STRANGER_UUID, humanActor);
    });

    it('作者判定短路：admin 不触发 owner 代理查询（性能短路纪律）', async () => {
      primeEntry();
      await service.update(UUID, lockDto({ intent: 'howto' }), adminActor);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('直接 creator 也不触发 owner 代理查询', async () => {
      primeEntry({ createdById: agentActor.id, quality: 'unverified' });
      await service.update(UUID, lockDto({ intent: 'howto' }), agentActor);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('audit 载荷只带字段名/质量变化，**不含正文**', async () => {
      primeEntry();
      await service.update(UUID, lockDto({ content: 'TOP SECRET BODY' }), adminActor);
      const payload = auditService.log.mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain('TOP SECRET BODY');
      expect(payload.newData).toMatchObject({ contentRewritten: true, contentChanged: true });
    });

    it('找不到条目 → 404（先判存在再判作者）', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(null);
      await expect(service.update(UUID, lockDto(), adminActor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 判别接线（第二期批 3：create/update 委派 + 幂等重放回填）
  //
  // 分工：判定的传输/落库纪律在 experience-judgment.service.spec.ts 里测；这里只断言
  // **ExperienceService 把什么委派出去**（mode/entryId/版本基准/判定输入）以及判定结果
  // 如何进响应（judgment 键、幂等重放从快照回填、失败为 null）。
  // ══════════════════════════════════════════════════════════════════

  describe('判别接线（create / update）', () => {
    /**
     * 局部 prime（update 路径的行锁读取点）。
     *
     * 为什么不复用 update describe 里的同名 helper：那些是**块内函数**，作用域不外泄；
     * 本块自带一份，形状与它逐字一致（createdById=STRANGER + admin 调用 ⇒ 走 admin 判权分支）。
     */
    function primeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
      const entry = makeEntry({
        createdById: STRANGER_UUID,
        quality: 'verified',
        updatedAt: new Date('2026-09-21T10:00:00.000Z'),
        ...overrides,
      });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      lockedEntry = entry;
      return entry;
    }

    const lockDto = (overrides: Partial<UpdateExperienceDto> = {}): UpdateExperienceDto =>
      ({ expectedUpdatedAt: '2026-09-21T10:00:00.000Z', ...overrides }) as UpdateExperienceDto;

    const judgment = {
      provider: 'jev',
      model: 'jev-latest',
      judgedAt: '2026-09-22T10:00:01.000Z',
      completeness: { level: 'partial', confidence: 0.7 },
      reusability: null,
      signalQuality: null,
      duplicate: null,
      intentSuggestion: null,
      domainSuggestion: null,
    };

    it('create：判定在写事务之后执行，响应带 judgment，版本基准 = 插入后的 updatedAt', async () => {
      judgments.evaluateAndPersist.mockResolvedValue(judgment);

      const result = await service.create(baseCreate(), humanActor);

      expect(result.id).toBe(UUID);
      expect(result.judgment).toEqual(judgment);
      // 判定在事务之外（事务只包业务写 + 幂等记录）
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(judgments.evaluateAndPersist).toHaveBeenCalledTimes(1);
      const params = judgments.evaluateAndPersist.mock.calls[0][0] as Record<string, unknown>;
      expect(params.mode).toBe('create');
      expect(params.entryId).toBe(UUID);
      expect(params.actor).toBe(humanActor);
      expect(params.expectedUpdatedAtText).toBe('2026-09-22 10:00:00.123456+00');
      // 判定输入 = 归一化后的条目内容（signals 已 lowercase）+ 当次词表快照
      const input = params.input as Record<string, unknown>;
      expect(input.title).toBe('T');
      expect(input.signals).toEqual(['x']);
      expect(input.intent).toBe('repair');
      expect(Array.isArray(input.availableDomains)).toBe(true);
    });

    it('create：判定失败（null）不影响录入成功，响应 judgment=null', async () => {
      judgments.evaluateAndPersist.mockResolvedValue(null);

      const result = await service.create(baseCreate(), humanActor);
      expect(result.id).toBe(UUID);
      expect(result.judgment).toBeNull();
    });

    it('create 幂等重放：**不重判**，从快照列回填 judgment', async () => {
      const snapshot = { id: UUID, quality: 'unverified' };
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'experience',
        requestHash: expectedHash(snapshotPayload()),
        responseSnapshot: snapshot,
        clientRequestId: 'k',
      });
      installQueryBuilders({ entity: makeEntry({ judgment: judgment as never }) });

      const result = await service.create(
        { ...baseCreate(), clientRequestId: 'k' } as CreateExperienceDto,
        humanActor,
      );

      expect(result).toMatchObject({ id: UUID, idempotentReplay: true });
      expect(result.judgment).toEqual(judgment);
      expect(judgments.evaluateAndPersist).not.toHaveBeenCalled();
      // 回填走 entries.judgment（select:false 列必须显式 addSelect）
      expect(mainQb().addSelect).toHaveBeenCalledWith('e.judgment');
    });

    it('create 幂等重放且条目已不存在 → judgment=null（不炸）', async () => {
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'experience',
        requestHash: expectedHash(snapshotPayload()),
        responseSnapshot: { id: UUID, quality: 'unverified' },
        clientRequestId: 'k',
      });
      installQueryBuilders({ entity: null });

      const result = await service.create(
        { ...baseCreate(), clientRequestId: 'k' } as CreateExperienceDto,
        humanActor,
      );
      expect(result.judgment).toBeNull();
    });

    it('update：内容改写触发重判（mode=update + 版本基准 = 事务后的 updatedAt），响应取新值', async () => {
      const entry = primeEntry();
      judgments.evaluateAndPersist.mockResolvedValue(judgment);

      const detail = await service.update(UUID, lockDto({ content: 'new body' }), adminActor);

      expect(judgments.evaluateAndPersist).toHaveBeenCalledTimes(1);
      const params = judgments.evaluateAndPersist.mock.calls[0][0] as Record<string, unknown>;
      expect(params.mode).toBe('update');
      expect(params.entryId).toBe(UUID);
      expect(params.expectedUpdatedAtText).toBe(UPDATED_AT_TEXT);
      expect(detail.judgment).toEqual(judgment);
    });

    it('update：纯元数据编辑**不重判**，响应 = 既有快照', async () => {
      primeEntry({ judgment: judgment as never });

      const detail = await service.update(UUID, lockDto({ intent: 'howto' }), adminActor);

      expect(judgments.evaluateAndPersist).not.toHaveBeenCalled();
      expect(detail.judgment).toEqual(judgment);
    });

    it('update：重判失败 → 响应 judgment=null（库内快照由判别服务置 NULL）', async () => {
      const entry = primeEntry({ judgment: judgment as never });
      judgments.evaluateAndPersist.mockResolvedValue(null);

      const detail = await service.update(UUID, lockDto({ content: 'rewritten' }), adminActor);
      expect(detail.judgment).toBeNull();
      expect(entry.content).toBe('rewritten');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 终审 / 软删
  // ══════════════════════════════════════════════════════════════════

  describe('质量终审（角色判权委派 + 双向门 + audit old→new+reason）', () => {
    it('身份守卫在最前：actor 缺失 → assertReviewIdentity 抛错，且不查条目', async () => {
      members.assertReviewIdentity.mockImplementation(() => {
        throw new ForbiddenException({ code: ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN });
      });
      await expect(
        service.reviewQuality(UUID, { quality: 'verified', reason: 'r' }, null as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(entryRepo.findOne).not.toHaveBeenCalled();
    });

    it('资格判定委派给成员服务（传真实条目 + 身份；service 不复制角色判定逻辑）', async () => {
      const entry = makeEntry({ quality: 'unverified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      await service.reviewQuality(UUID, { quality: 'verified', reason: 'r' }, adminActor);
      expect(members.assertCanReview).toHaveBeenCalledWith(entry, adminActor);
    });

    it('资格判定拒绝（13004 缺角色）原样透出，且**不写库**', async () => {
      const entry = makeEntry({ quality: 'unverified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      members.assertCanReview.mockRejectedValue(
        new ForbiddenException({ code: ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN }),
      );
      const err = await service
        .reviewQuality(UUID, { quality: 'verified', reason: 'r' }, adminActor)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(((err as ForbiddenException).getResponse() as { code: number }).code).toBe(
        ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
      );
      expect(entryRepo.save).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('终审响应带 verifiedByName（v1.81.0：调用方不必再发一次详情请求）', async () => {
      const entry = makeEntry({ quality: 'unverified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      const result = await service.reviewQuality(
        UUID,
        { quality: 'verified', reason: 'r' },
        agentActor,
      );
      expect(result.verifiedByName).toBe('coder');
    });

    it('空间 reviewer 终审 verified → 写 verified_by/at（不再要求人类身份）', async () => {
      const entry = makeEntry({ quality: 'unverified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      const result = await service.reviewQuality(
        UUID,
        { quality: 'verified', reason: 'r' },
        agentActor,
      );
      expect(result).toMatchObject({
        id: entry.id,
        quality: 'verified',
        verifiedBy: agentActor.id,
      });
    });

    it('admin 终审 verified → 写 verified_by/at + audit old→new+reason', async () => {
      const entry = makeEntry({ quality: 'unverified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);

      const result = await service.reviewQuality(
        UUID,
        { quality: 'verified', reason: '复现通过' },
        adminActor,
      );

      expect(result).toMatchObject({ id: entry.id, quality: 'verified', verifiedBy: UUID });
      expect(entry.verifiedAt).toBeInstanceOf(Date);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'experience',
          oldData: { quality: 'unverified' },
          newData: { quality: 'verified', reason: '复现通过' },
        }),
      );
    });

    it('双向门：verified → suspect 可改回', async () => {
      const entry = makeEntry({ quality: 'verified' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);
      const result = await service.reviewQuality(
        UUID,
        { quality: 'suspect', reason: '无法复现' },
        adminActor,
      );
      expect(result.quality).toBe('suspect');
      expect(auditService.log.mock.calls[0][0].oldData).toEqual({ quality: 'verified' });
    });

    it('条目不存在 → 404', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(null);
      await expect(
        service.reviewQuality(UUID, { quality: 'verified', reason: 'r' }, adminActor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('软删', () => {
    it('作者可删 → softDelete + audit DELETE（只留最小快照，不含正文）', async () => {
      const entry = makeEntry({ createdById: agentActor.id, content: 'SECRET BODY' });
      entryRepo.findOne = jest.fn().mockResolvedValue(entry);

      await service.remove(UUID, agentActor);

      expect(entryRepo.softDelete).toHaveBeenCalledWith(UUID);
      const payload = auditService.log.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toMatchObject({
        entityType: 'experience',
        entityId: UUID,
        actorId: agentActor.id,
      });
      expect(JSON.stringify(payload)).not.toContain('SECRET BODY');
      expect(payload.newData).toMatchObject({ softDeleted: true });
    });

    it('非作者 → 403/13001 + 越权尝试插桩（attempt=delete）', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(makeEntry({ createdById: OTHER_UUID }));
      await expect(service.remove(UUID, humanActor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          newData: expect.objectContaining({ denied: true, attempt: 'delete' }),
        }),
      );
      expect(entryRepo.softDelete).not.toHaveBeenCalled();
    });

    it('admin 可删任意条目（不触发 owner 代理查询）', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(makeEntry({ createdById: OTHER_UUID }));
      await service.remove(UUID, adminActor);
      expect(entryRepo.softDelete).toHaveBeenCalledWith(UUID);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('找不到（含已软删）→ 404', async () => {
      entryRepo.findOne = jest.fn().mockResolvedValue(null);
      await expect(service.remove(UUID, adminActor)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // v1.81.0：归属人名字解析 / 按录入者过滤 / byCreator 分面
  // ══════════════════════════════════════════════════════════════════

  describe('归属人名字（投影层解析，N+1 防线）', () => {
    it('findOne：creator + verifier 一并换名，且**页内一次批量**（不是逐字段各查一次）', async () => {
      installQueryBuilders({
        entity: makeEntry({ createdById: OTHER_UUID, verifiedBy: UUID, quality: 'verified' }),
      });
      const detail = await service.findOne(UUID, agentActor);

      expect(detail.createdByName).toBe('coder');
      expect(detail.verifiedByName).toBe('admin');
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith([OTHER_UUID, UUID]);
    });

    it('软删 actor：名字**仍在** + deletedAt 非空（永远渲染名字，不回退裸 UUID）', async () => {
      profileRows.set(OTHER_UUID, {
        type: ActorType.AGENT,
        name: 'coder',
        avatarUrl: 'https://example.com/a.png',
        description: null,
        deletedAt: new Date('2026-09-20T00:00:00.000Z'),
      });
      installQueryBuilders({ entity: makeEntry() });
      const detail = await service.findOne(UUID, agentActor);

      expect(detail.createdByName).toBe('coder');
      expect(detail.createdByDeletedAt).toBe('2026-09-20T00:00:00.000Z');
      expect(detail.createdByAvatarUrl).toBe('https://example.com/a.png');
    });

    it('真孤儿（actors 行已硬删）：name 为 null，且**不造兜底词**', async () => {
      profileRows.delete(OTHER_UUID);
      installQueryBuilders({ entity: makeEntry() });
      const detail = await service.findOne(UUID, agentActor);

      expect(detail.createdByName).toBeNull();
      expect(detail.createdByDeletedAt).toBeNull();
    });

    it('未终审：verifiedBy 为 null **不进解析集合**（不把 null 塞进 IN 列表）', async () => {
      installQueryBuilders({ entity: makeEntry({ verifiedBy: null }) });
      const detail = await service.findOne(UUID, agentActor);

      expect(actorProfiles.resolveProfiles).toHaveBeenCalledWith([OTHER_UUID]);
      expect(detail.verifiedByName).toBeNull();
      expect(detail.verifiedByDeletedAt).toBeNull();
    });

    it('列表：同页 creator ∪ verifier 去重后一次解析，逐条投影都带名', async () => {
      installQueryBuilders({
        entities: [makeEntry({ createdById: OTHER_UUID, verifiedBy: UUID, quality: 'verified' })],
      });
      const res = await service.search({} as QueryExperienceDto, agentActor);

      expect(res.items[0].createdByName).toBe('coder');
      expect(res.items[0].verifiedByName).toBe('admin');
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
    });

    it('PATCH 响应与详情同形**含名字**（漏解析 = 同形不变量当场破裂）', async () => {
      lockedEntry = makeEntry({
        createdById: agentActor.id,
        verifiedBy: UUID,
        quality: 'verified',
      });
      const detail = await service.update(
        UUID,
        { expectedUpdatedAt: '2026-09-01T00:00:00.000Z', intent: 'howto' } as UpdateExperienceDto,
        agentActor,
      );

      expect(detail.createdByName).toBe('coder');
      expect(detail.verifiedByName).toBe('admin');
    });
  });

  describe('按录入者过滤（?createdById）', () => {
    it('挂精确相等谓词 + appliedFilters 回显 + 计入真检索埋点', async () => {
      installQueryBuilders({ entities: [makeEntry()] });
      const res = await service.search(
        { createdById: STRANGER_UUID } as QueryExperienceDto,
        agentActor,
      );

      expect(mainQb().andWhere).toHaveBeenCalledWith('e.created_by_id = :createdById');
      expect(param(mainQb(), 'createdById')).toBe(STRANGER_UUID);
      expect(res.appliedFilters?.createdById).toBe(STRANGER_UUID);
      // createdById 是**真过滤条件**：必须计入埋点门槛（漏计 = 该维度零命中率永不入观测）
      expect(searchEventRepo.insert).toHaveBeenCalled();
    });

    it('未传 → 既不挂谓词也不回显（裸浏览不记埋点）', async () => {
      installQueryBuilders({ entities: [makeEntry()] });
      const res = await service.search({} as QueryExperienceDto, agentActor);

      expect(res.appliedFilters).not.toHaveProperty('createdById');
      expect(predicates(mainQb())).not.toContain('e.created_by_id = :createdById');
      expect(searchEventRepo.insert).not.toHaveBeenCalled();
    });

    it('指纹与门槛含 createdById：不同录入者 → 不同指纹（四周期复查的分组口径）', () => {
      const base = { includeExpired: false, includeSuspect: false };
      expect(svc.isActualSearch({ ...base, createdById: UUID })).toBe(true);
      expect(svc.fingerprintFilters({ ...base, createdById: UUID })).not.toBe(
        svc.fingerprintFilters({ ...base, createdById: OTHER_UUID }),
      );
    });
  });

  describe('byCreator 分面（开放维度：top-N + 截断标记）', () => {
    it('超上限 → 截到 20 条且置 byCreatorTruncated=true（多取一条当探针）', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({
        createdById: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        createdByType: 'agent',
        count: String(21 - i),
      }));
      rows[0].createdById = OTHER_UUID;
      installQueryBuilders({ entity: makeEntry(), rawMany: rows });

      const res = await service.facets({} as QueryExperienceDto, adminActor);

      expect(res.byCreator).toHaveLength(20);
      expect(res.byCreatorTruncated).toBe(true);
      expect(res.byCreator?.[0]).toEqual({
        createdById: OTHER_UUID,
        createdByType: 'agent',
        createdByName: 'coder',
        createdByDeletedAt: null,
        count: 21,
      });
      // top-N 内一次批量解析（禁 N+1）
      expect(actorProfiles.resolveProfiles).toHaveBeenCalledTimes(1);
    });

    it('未超上限 → byCreatorTruncated=false（不得误报截断）', async () => {
      installQueryBuilders({
        entity: makeEntry(),
        rawMany: [{ createdById: OTHER_UUID, createdByType: 'agent', count: '3' }],
      });
      const res = await service.facets({} as QueryExperienceDto, adminActor);

      expect(res.byCreatorTruncated).toBe(false);
      expect(res.byCreator).toHaveLength(1);
    });

    it('孤儿录入者 → name 为 null（消费方显示 id 前 8 位，服务端不造兜底词）', async () => {
      profileRows.delete(STRANGER_UUID);
      installQueryBuilders({
        entity: makeEntry(),
        rawMany: [{ createdById: STRANGER_UUID, createdByType: 'human', count: '1' }],
      });
      const res = await service.facets({} as QueryExperienceDto, adminActor);

      expect(res.byCreator?.[0].createdByName).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 测试脚手架
// ═══════════════════════════════════════════════════════════════════════════

/** 最小合法录入载荷（含"验证方式"节，避免 warnings 干扰断言） */
function baseCreate(): CreateExperienceDto {
  return {
    title: 'T',
    summary: 'S',
    content: '## How verified\nok',
    intent: 'repair',
    signals: ['x'],
  } as CreateExperienceDto;
}

/** create() 的幂等指纹输入（与 service 内构造顺序逐字一致） */
function snapshotPayload(): Record<string, unknown> {
  return {
    title: 'T',
    summary: 'S',
    content: '## How verified\nok',
    intent: 'repair',
    signals: ['x'],
    domains: [],
    env: {},
    sourceProject: null,
    expiresAt: null,
  };
}

/** 复算幂等指纹（service 用 createHash('sha256')，此处独立算出同值） */
function expectedHash(payload: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = jest.requireActual<typeof import('crypto')>('crypto');
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** 构造实体（默认值对齐 entity 缺省，便于断言派生字段） */
function makeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
  const entry = new ExperienceEntry();
  Object.assign(entry, {
    id: UUID,
    title: 'WSL2 port unreachable',
    summary: 'S',
    content: '## How verified\nok',
    intent: 'repair',
    signals: ['a'],
    env: {},
    domains: [],
    quality: 'unverified',
    helpedCount: 0,
    notHelpfulCount: 0,
    distinctHelpedCount: 0,
    lastHelpedAt: null,
    createdByType: ActorType.AGENT,
    createdById: OTHER_UUID,
    sourceProject: null,
    verifiedBy: null,
    verifiedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });
  return entry;
}

/** 仓储 mock（只实现本服务真正消费的方法） */
function makeRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    create: jest.fn((entity: unknown) => entity),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: UUID }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
}

/** EntityManager mock：transaction 回调的执行体（反馈路径与录入路径共用） */
function makeManager() {
  return {
    // 事务内裸 SQL：写路径会 `SELECT updated_at::text`（版本守卫基准，微秒精度）；
    // 其余查询（如幂等/计数）返回空数组即可
    query: jest.fn((sql: string) =>
      Promise.resolve(
        String(sql).includes('updated_at') ? [{ updated_at: '2026-09-22 10:00:00.123456+00' }] : [],
      ),
    ),
    create: jest.fn((_cls: unknown, plain: unknown) => plain),
    // 模拟"数据库分配主键 + 时间戳"：业务条目入库后才拿到 id（幂等快照必须带真实 id），
    // updatedAt 由 DB 写入（判定的版本守卫基准取它，见 create/update 接线）
    save: jest.fn((entity: { id?: string; title?: string; updatedAt?: Date }) => {
      if (entity && entity.title !== undefined && !entity.id) entity.id = UUID;
      if (entity && entity.updatedAt === undefined)
        entity.updatedAt = new Date('2026-09-22T10:00:00Z');
      return Promise.resolve(entity);
    }),
    getRepository: jest.fn(() => makeRepo()),
  };
}

/**
 * 事务内 ExperienceEntry 仓储 mock（update 的行锁读取点）。
 *
 * 形状对齐 service 的实现：`createQueryBuilder('e').setLock('pessimistic_write')
 * .where(...).getOne()` —— 必须支持 setLock 且 getOne 返回被 prime 的实体。
 */
function makeEntryTxRepo(resolve: () => ExperienceEntry | null) {
  return {
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        // update 的行锁读取会 addSelect('e.judgment')（select:false 的缓存列）
        addSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => Promise.resolve(resolve())),
      };
      return qb;
    }),
  };
}

/** queryBuilder mock（链式方法全返回 this；读方法返回可控数据） */
function makeQueryBuilder(
  opts: {
    count?: number;
    entities?: ExperienceEntry[];
    /** `.getOne()` 的返回值（详情/行锁读取；缺省 null） */
    entity?: ExperienceEntry | null;
    rawMany?: Record<string, unknown>[];
    rawScores?: number[];
  } = {},
) {
  const entities = opts.entities ?? [];
  const qb: Record<string, jest.Mock> = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    // byCreator 分面按 (created_by_id, created_by_type) 两列分组（v1.81.0）
    addGroupBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(opts.count ?? 0),
    getOne: jest.fn().mockResolvedValue(opts.entity ?? null),
    getMany: jest.fn().mockResolvedValue(entities),
    getRawAndEntities: jest.fn().mockResolvedValue({
      entities,
      raw: entities.map((_, i) => ({ experience_score: opts.rawScores?.[i] ?? 0.5 })),
    }),
    getRawMany: jest.fn().mockResolvedValue(opts.rawMany ?? []),
    getQueryAndParameters: jest.fn().mockReturnValue([BASE_SQL_SNIPPET, [] as unknown[]]),
  };
  qb.clone = jest.fn(() => qb);
  return qb;
}

/** 捕获断言函数抛出的 BadRequestException（未抛 → undefined） */
function captureBadRequest(fn: () => void): BadRequestException | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err as BadRequestException;
  }
}

/** 取 queryBuilder 上所有 WHERE 子句（拼接便于形状断言） */
function predicates(qb: Record<string, jest.Mock>): string[] {
  return [
    ...(qb.where as jest.Mock).mock.calls.map((c) => String(c[0])),
    ...(qb.andWhere as jest.Mock).mock.calls.map((c) => String(c[0])),
  ];
}

/** 取最后一次 setParameter 的某个键值 */
function param(qb: Record<string, jest.Mock>, key: string): unknown {
  const calls = (qb.setParameter as jest.Mock).mock.calls;
  const hit = [...calls].reverse().find((c) => c[0] === key);
  return hit?.[1];
}
