/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **更正编排**的服务级单测：预检四闸（跨项目/非 active/未形成/已有有效更正行）、
 *     新主张三要素继承提名链路、**未达成释放唯一位**（withdrawn + 清 ids）、达成走
 *     `completeCorrectionLink`
 *
 * [代码职责]
 *   - 把"哪些终态算未达成（no_memory/rejected/conflict）而哪些必须保持 active"钉成
 *     可执行事实——这条一旦错，症状是"同一条旧主张再也无法更正"（表现为 409，
 *     排障时最容易被误判成引擎问题）
 *
 * [权威文档]
 *   - 判据单源 = `memory-correction.service.ts` 的 [关键不变量]
 *
 * [关键不变量]
 *   - **`correction_of` 部分唯一索引的谓词含 `status <> 'withdrawn'`**：未达成必须
 *     withdrawn + 清 ids，否则唯一位被永久占用
 *   - **`failed` / `unknown` / `submitted` 不算未达成**：行保持 active 以便 retry 续跑
 *     （若也释放唯一位，续跑会撞上"同一 old 已有另一行"的仲裁）
 *   - **预检先于引擎三约束**：预检失败时不得消耗一次引擎配额（`correct()` 只链接
 *     两个**已形成且 active** 的记忆）
 *   - **`oldMemoryId` 必须属于旧行**（否则是一条越权写入路径）——显式指定时逐字透传给
 *     `completeCorrectionLink`（它可能不是旧行主记忆）
 *
 * [关联代码]
 *   - ./memory-correction.service.ts — 被测实现
 *   - ./memory-formation.service.ts — 被复用的原语（本套件以假件替代，只验编排）
 *
 * [修改检查]
 *   □ 改"未达成"集合必须同步 e2e ⑤ 的"唯一位释放"用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Repository } from 'typeorm';
import {
  ActorType,
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_PROJECT_STATUS,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryCorrectionService } from './memory-correction.service';
import { MemoryFormationService, type FormationAttemptOutcome } from './memory-formation.service';
import type { MemoryEngine as MemoryEnginePort } from './engines/memory-engine.interface';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const OLD_LEDGER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NEW_LEDGER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

/** 造一个 agent actor */
function agentActor(): UnifiedActor {
  return { id: ACTOR_ID, type: ActorType.AGENT };
}

/** 造一个 active 项目 */
function buildProject(overrides: Partial<MemoryProject> = {}): MemoryProject {
  return {
    id: PROJECT_ID,
    slug: 'chamber',
    name: 'Agent Chamber',
    bindings: [{ type: 'board', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    engine: MEMORY_ENGINE.HUMENT,
    engineWorkspaceId: 'ws-1',
    engineActorId: 'act-1',
    engineCredentialRef: 'cred-1',
    status: MEMORY_PROJECT_STATUS.ACTIVE,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

/** 造一条账本行（默认 = 已形成且 active 的旧主张） */
function buildRow(overrides: Partial<MemoryNomination> = {}): MemoryNomination {
  return {
    id: OLD_LEDGER_ID,
    projectId: PROJECT_ID,
    nominatorId: ACTOR_ID,
    category: 'ruling',
    status: MEMORY_NOMINATION_STATUS.ACTIVE,
    formationState: MEMORY_FORMATION_STATE.COMMITTED,
    engineMemoryIds: ['mem-1', 'mem-2'],
    engineCorrectionId: null,
    correctionOf: null,
    ...overrides,
  } as MemoryNomination;
}

/** `FormationAttemptOutcome` 的最小造件 */
function attemptOutcome(
  formationState: MemoryNomination['formationState'],
  overrides: Partial<FormationAttemptOutcome> = {},
): FormationAttemptOutcome {
  return {
    formationState,
    recoveryPath: null,
    memoryIds: formationState === MEMORY_FORMATION_STATE.COMMITTED ? ['mem-new'] : [],
    deferred: false,
    engineNominationId: 'nom-1',
    engineCanonicalNominationId: null,
    signal: { duplicate: false, deferred: false, outcome: 'no_memory' },
    latencyMs: 12,
    ...overrides,
  };
}

/**
 * 组装被测服务。
 *
 * `nominations.findOne` 的**调用序**是本服务的预检骨架：① 取旧主张 ② 查同一 old 的有效更正行，
 * 故默认用 `mockResolvedValueOnce` 按序喂——需要单独定制的用例再覆盖。
 */
function buildService(options: {
  project?: MemoryProject;
  oldRow?: MemoryNomination | null;
  existingCorrection?: MemoryNomination | null;
  outcome?: FormationAttemptOutcome;
  engine?: unknown;
  availability?: { engine: string; available: boolean; reason: string | null };
  link?:
    | { replay: boolean; oldClaimStatus: 'superseded' }
    | {
        replay: boolean;
        oldClaimStatus: 'still_current';
        linkFailure: { kind: string; engineCode?: string; httpStatus?: number };
      };
}) {
  const newRow = buildRow({
    id: NEW_LEDGER_ID,
    status: MEMORY_NOMINATION_STATUS.ACTIVE,
    formationState: MEMORY_FORMATION_STATE.SUBMITTED,
    engineMemoryIds: null,
    correctionOf: OLD_LEDGER_ID,
  });

  const nominations = {
    findOne: jest
      .fn()
      .mockResolvedValueOnce(options.oldRow === undefined ? buildRow() : options.oldRow)
      .mockResolvedValueOnce(options.existingCorrection ?? null),
    query: jest.fn(async () => undefined),
  };

  const project = options.project ?? buildProject();
  const projectService = {
    findProjectOrThrow: jest.fn(async () => project),
    engineAvailability: jest.fn(
      () => options.availability ?? { engine: MEMORY_ENGINE.HUMENT, available: true, reason: null },
    ),
  };
  const access = { assertProjectWrite: jest.fn(async () => undefined) };

  const formation = {
    prepareClaim: jest.fn(async () => ({
      content: '装配正文',
      contentTruncated: false,
      sourceRefs: [],
      sourceLocators: [],
    })),
    createLedgerRow: jest.fn(async () => newRow),
    submitAttempt: jest.fn(
      async () => options.outcome ?? attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
    ),
    applyAttempt: jest.fn(async () => undefined),
    toHttpResult: jest.fn((_project: MemoryProject, row: MemoryNomination, opts: unknown) => ({
      httpStatus: 201,
      body: { ledgerId: row.id, status: row.status, options: opts } as never,
    })),
    completeCorrectionLink: jest.fn(
      async () => options.link ?? { replay: false, oldClaimStatus: 'superseded' as const },
    ),
    findLedgerOrThrow: jest.fn(async () => newRow),
  };

  const service = new MemoryCorrectionService(
    nominations as unknown as Repository<MemoryNomination>,
    projectService as unknown as MemoryProjectService,
    access as unknown as MemoryAccessService,
    formation as unknown as MemoryFormationService,
    (options.engine === undefined
      ? { name: 'fake' }
      : options.engine) as unknown as MemoryEnginePort | null,
  );

  return { service, nominations, projectService, access, formation, newRow, project };
}

/** 更正入参（新主张三要素；来源与覆盖一律省略，本套件不测装配） */
function correctDto(overrides: Partial<{ correctionOf: string; oldMemoryId: string }> = {}) {
  return {
    category: 'ruling',
    subject: '主体',
    scope: '范围',
    rationale: '理由',
    correctionOf: OLD_LEDGER_ID,
    ...overrides,
  };
}

describe('MemoryCorrectionService（更正编排）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 前置闸门（顺序 = 项目存在 → 归档 409 → 写权限 403 → 引擎闸 503）
  // ══════════════════════════════════════════════════════════════════════
  describe('前置闸门', () => {
    it('归档项目 ⇒ 409/14002（写路径关闭；且不进入预检）', async () => {
      const { service, nominations } = buildService({
        project: buildProject({ status: MEMORY_PROJECT_STATUS.ARCHIVED }),
      });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
      expect(nominations.findOne).not.toHaveBeenCalled();
    });

    it('无本项目写权限 ⇒ 403/1009（与"来源级 403"分文案）', async () => {
      const { service, access, nominations } = buildService({});
      access.assertProjectWrite.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toThrow(
        'forbidden',
      );
      expect(nominations.findOne).not.toHaveBeenCalled();
    });

    it('项目未绑引擎 ⇒ 503/14000 且 data.reason=project_engine_unbound', async () => {
      const { service } = buildService({
        availability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
      });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 503,
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND },
        },
      });
    });

    it('引擎 token 为 null（全局未配）⇒ 503/14000，reason=not_configured', async () => {
      const { service } = buildService({
        engine: null,
        availability: {
          engine: MEMORY_ENGINE.HUMENT,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
        },
      });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 503,
        response: { data: { reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED } },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 预检（引擎三约束先于 DB 拦截）
  // ══════════════════════════════════════════════════════════════════════
  describe('预检四闸', () => {
    it('旧行不存在 ⇒ 404/14003（不确认存在性）', async () => {
      const { service, formation } = buildService({ oldRow: null });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
      // 预检失败 ⇒ 不消耗引擎配额、不落新行
      expect(formation.submitAttempt).not.toHaveBeenCalled();
      expect(formation.createLedgerRow).not.toHaveBeenCalled();
    });

    it('旧行属于**别的项目** ⇒ 404/14003（跨项目不泄露"这行存在"）', async () => {
      const { service } = buildService({ oldRow: buildRow({ projectId: OTHER_PROJECT_ID }) });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_NOMINATION_NOT_FOUND },
      });
    });

    it('旧行非 active（superseded）⇒ 409/14005（不可更正一个已被取代的主张）', async () => {
      const { service } = buildService({
        oldRow: buildRow({ status: MEMORY_NOMINATION_STATUS.SUPERSEDED }),
      });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_NOMINATION_CONFLICT },
      });
    });

    it.each([
      ['未收敛（submitted）', MEMORY_FORMATION_STATE.SUBMITTED, ['mem-1']],
      ['终态拒绝（rejected）', MEMORY_FORMATION_STATE.REJECTED, ['mem-1']],
      ['committed 但 ids 为空（alias 镜像的退化态）', MEMORY_FORMATION_STATE.COMMITTED, []],
      ['ids 为 null', MEMORY_FORMATION_STATE.COMMITTED, null],
    ])(
      '旧行无已形成的记忆（%s）⇒ 409/14005（引擎只能更正两个已形成的记忆）',
      async (_label, state, ids) => {
        const { service, formation } = buildService({
          oldRow: buildRow({ formationState: state, engineMemoryIds: ids as string[] | null }),
        });

        await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject(
          {
            status: 409,
            response: { code: ErrorCode.MEMORY_NOMINATION_CONFLICT },
          },
        );
        expect(formation.submitAttempt).not.toHaveBeenCalled();
      },
    );

    it('oldMemoryId 显式指定但**不属于旧行** ⇒ 400/9000 且 data.field=oldMemoryId', async () => {
      const { service, formation } = buildService({});

      await expect(
        service.correct(agentActor(), PROJECT_ID, correctDto({ oldMemoryId: 'mem-not-mine' })),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'oldMemoryId' } },
      });
      // 越权写路径在到达引擎之前就被拦下
      expect(formation.submitAttempt).not.toHaveBeenCalled();
    });

    it('同一 old 已有有效更正行 ⇒ 409/14005（部分唯一索引的友好前置）', async () => {
      const { service, nominations, formation } = buildService({
        existingCorrection: buildRow({ id: 'cccccccc-3333-4333-8333-333333333333' }),
      });

      await expect(service.correct(agentActor(), PROJECT_ID, correctDto())).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_NOMINATION_CONFLICT },
      });
      // 谓词必须排除 withdrawn 行（否则"未达成的更正"会永久挡住同一个 old 的再更正）
      const where = (nominations.findOne as jest.Mock).mock.calls[1][0].where;
      expect(where.correctionOf).toBe(OLD_LEDGER_ID);
      expect(where.deletedAt).toBeDefined();
      expect(formation.createLedgerRow).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 未达成 ⇒ 释放唯一位（新行 withdrawn + 清 ids）
  // ══════════════════════════════════════════════════════════════════════
  describe('未达成三态（no_memory / rejected / conflict）', () => {
    it.each([
      ['no_memory', MEMORY_FORMATION_STATE.NO_MEMORY],
      ['rejected', MEMORY_FORMATION_STATE.REJECTED],
      ['conflict', MEMORY_FORMATION_STATE.CONFLICT],
    ])('%s ⇒ 新行 withdrawn + 清 ids + oldClaimStatus=still_current', async (_label, state) => {
      const { service, nominations, formation, newRow } = buildService({
        outcome: attemptOutcome(state as MemoryNomination['formationState']),
      });

      const result = await service.correct(agentActor(), PROJECT_ID, correctDto());

      // ① 裸 SQL 释放唯一位：status=withdrawn 且 engine_memory_ids=NULL（不变量的一半）
      expect(nominations.query).toHaveBeenCalledTimes(1);
      const [sql, params] = (nominations.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('engine_memory_ids = NULL');
      expect(sql).toContain('status = $2');
      expect(params).toEqual([NEW_LEDGER_ID, MEMORY_NOMINATION_STATUS.WITHDRAWN]);

      // ② 内存态同步（响应直接用，省一次读）
      expect(newRow.status).toBe(MEMORY_NOMINATION_STATUS.WITHDRAWN);
      expect(newRow.engineMemoryIds).toBeNull();

      // ③ 旧主张仍有效（更正未达成）；且**不**调 completeCorrectionLink
      expect(formation.completeCorrectionLink).not.toHaveBeenCalled();
      expect(formation.toHttpResult).toHaveBeenCalledWith(
        expect.anything(),
        newRow,
        expect.objectContaining({ oldClaimStatus: 'still_current', replay: false }),
      );
      expect(result).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 非终态 ⇒ 保持 active（唯一位不释放，便于 retry 续跑）
  // ══════════════════════════════════════════════════════════════════════
  describe('非终态（failed / unknown / submitted）', () => {
    it.each([
      ['failed', MEMORY_FORMATION_STATE.FAILED],
      ['unknown', MEMORY_FORMATION_STATE.UNKNOWN],
      ['submitted', MEMORY_FORMATION_STATE.SUBMITTED],
    ])('%s ⇒ **不**撤回（行保持 active 以便 retry 续跑）', async (_label, state) => {
      const { service, nominations, formation, newRow } = buildService({
        outcome: attemptOutcome(state as MemoryNomination['formationState'], {
          recoveryPath: 'same_key_resend',
          engineCode: 'provider_unavailable',
        }),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto());

      expect(nominations.query).not.toHaveBeenCalled(); // 唯一位未释放
      expect(newRow.status).toBe(MEMORY_NOMINATION_STATUS.ACTIVE);
      expect(formation.completeCorrectionLink).not.toHaveBeenCalled();
      expect(formation.toHttpResult).toHaveBeenCalledWith(
        expect.anything(),
        newRow,
        expect.objectContaining({
          oldClaimStatus: 'still_current',
          engineCode: 'provider_unavailable',
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 达成 ⇒ 引擎侧 correct + 双写
  // ══════════════════════════════════════════════════════════════════════
  describe('达成（committed）', () => {
    it('缺省 oldMemoryId = 旧行主记忆，且透传给 completeCorrectionLink', async () => {
      const { service, formation, project, newRow } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto());

      expect(formation.completeCorrectionLink).toHaveBeenCalledWith(
        NEW_LEDGER_ID,
        project,
        'mem-1',
      );
      expect(formation.toHttpResult).toHaveBeenCalledWith(
        project,
        newRow,
        expect.objectContaining({
          oldClaimStatus: 'superseded',
          recoveryPath: null,
          replay: false,
        }),
      );
    });

    it('显式指定 oldMemoryId（属于旧行）⇒ **逐字**透传（它可能不是主记忆）', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto({ oldMemoryId: 'mem-2' }));

      expect(formation.completeCorrectionLink).toHaveBeenCalledWith(
        NEW_LEDGER_ID,
        expect.anything(),
        'mem-2',
      );
    });

    it('引擎回执是幂等回放（replay=true）⇒ 原样回报（续跑靠它区分"早已达成")', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
        link: { replay: true, oldClaimStatus: 'superseded' },
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto());

      expect(formation.toHttpResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ replay: true, oldClaimStatus: 'superseded' }),
      );
    });

    it('链接失败（correct 被拒）⇒ linkFailure 透传进 toHttpResult（响应才会响亮呈现）', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
        link: {
          replay: false,
          oldClaimStatus: 'still_current',
          linkFailure: { kind: 'http', engineCode: 'source_access_denied', httpStatus: 403 },
        },
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto());

      // 漏传 = 响应又退回 201 + "Nothing further to do"（卡 61688768）
      expect(formation.toHttpResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          oldClaimStatus: 'still_current',
          linkFailure: { kind: 'http', engineCode: 'source_access_denied', httpStatus: 403 },
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 更正目标落库（中断续跑同参的锚点）
  // ══════════════════════════════════════════════════════════════════════
  describe('更正目标落库（createLedgerRow 的 correctionTargetMemoryId）', () => {
    it('缺省 oldMemoryId ⇒ 落**解析后**的主记忆（不是 null——续跑要能直接复用）', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto());

      expect(formation.createLedgerRow).toHaveBeenCalledWith(
        expect.objectContaining({
          correctionOf: OLD_LEDGER_ID,
          projectSnapshot: expect.any(Object),
          correctionTargetMemoryId: 'mem-1', // 旧行 engineMemoryIds = ['mem-1', 'mem-2'] ⇒ 主记忆
        }),
      );
    });

    it('显式 oldMemoryId ⇒ 落库值与透传值**逐字相同**（可能不是主记忆）', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.COMMITTED),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto({ oldMemoryId: 'mem-2' }));

      expect(formation.createLedgerRow).toHaveBeenCalledWith(
        expect.objectContaining({
          projectSnapshot: expect.any(Object),
          correctionTargetMemoryId: 'mem-2',
        }),
      );
      // 首跑仍走直传（不依赖落库值），两者同源同值
      expect(formation.completeCorrectionLink).toHaveBeenCalledWith(
        NEW_LEDGER_ID,
        expect.anything(),
        'mem-2',
      );
    });

    it('未达成（no_memory）也先落库：目标在发起时就定下，续跑才可能同参', async () => {
      const { service, formation } = buildService({
        outcome: attemptOutcome(MEMORY_FORMATION_STATE.NO_MEMORY),
      });

      await service.correct(agentActor(), PROJECT_ID, correctDto({ oldMemoryId: 'mem-2' }));

      // 落库发生在形成**之前**（② 步），与后续是否达成无关
      expect(formation.createLedgerRow).toHaveBeenCalledWith(
        expect.objectContaining({
          projectSnapshot: expect.any(Object),
          correctionTargetMemoryId: 'mem-2',
        }),
      );
    });
  });
});
