/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **项目注册表**的服务级单测：`engineAvailability` 三态（本地数据端点嵌的
 *     **唯一判据点**）、创建/更新两条写路径的绑定校验与引擎绑定三元组、换绑 workspace 的
 *     不可逆守卫、列表的可见性过滤与分页钳制、**创建的三分支（二期自助开通）**
 *
 * [代码职责]
 *   - 把"注册表里没有半配置状态""判据不看 `MEMORY_CONFIG`""换绑前必须查 耐久账本行"
 *     "全缺 + engine=hument + 客户端可用 ⇒ 自动注册，其余 ⇒ 400/零注册调用"
 *     "provision 成功后 save 失败 ⇒ best-effort `disableProject` 善后（绝不改变原报错路径）"
 *     这些不变量的**分支组合**钉成可执行事实（e2e 只跑得动端到端组合，边界要靠本套件）
 *
 * [权威文档]
 *   - 判据单源 = `memory-project.service.ts` 的 [关键不变量]（本文档不复述，改代码先改它）
 *
 * [关键不变量]
 *   - **`engineAvailability` 只看 token 是否为 null + 项目引擎三列**：拿 `MEMORY_CONFIG.engine`
 *     判会把"测试注入 FakeEngine"的装配判成未配置（闸门实际是开着的）
 *   - **`engine=none` ⇒ 三列强制 null**；`engine≠none` ⇒ 三列缺一即 400 且 `data.field` 指名字段
 *   - **PATCH 用值判定而不是 `hasOwnProperty`**：`useDefineForClassFields`（target=ES2022）+
 *     ValidationPipe 会给**未发送**的字段也定义 own property（值 undefined），
 *     故 hasOwnProperty 恒真 ⇒ "只改 name"会撞上"引擎三元组缺一不可"的 400
 *   - **换绑 workspace 的判据 = 旧值非 null ∧ 新值不同（含清空）**，此时必须查
 *     `formation_state=committed` 的行数（>0 ⇒ 409/14002）
 *   - **`canReadContent` 逐请求实算，且四条调用路径各有来源**：`findOne` 接住 `assertProjectRead`
 *     的返回值（不多查）、`findAll` 把 `{project, access}` 配对带过分页切片（切片不串位）、
 *     `update` 改绑后**重算**（授权判定仍用变更前的 access）、`create` 恒真 by construction。
 *     本套件对四条各有一条断言——任何一条"顺手复用旧值"都会在这里红。
 *     另：`create` 的投影必须留在 save 的 try **之外**（评审 M-1：save 已 commit 时投影抛错
 *     **不是孤儿**，不得触发孤儿善后）——套件有专门用例钉住"投影失败 ⇒ 零 disable"
 *   - **`provisioningAvailable` 是部署级开关**（`this.provisioning !== null`）：与 items 无关，
 *     零项目也返回（单测在 findAll 两态各断言一次）
 *   - **引擎身份 claim 与项目落库同事务**：本套件用 `manager.transaction` 替身把
 *     "insert orIgnore → 回读归属"钉成可执行分支（同项目幂等 / 他人占用 409 / 回读空
 *     fail-closed）；真实并发仲裁与回填 winner 由 `test/memory-engine-binding-claims.e2e-spec.ts`
 *     打真库验证——mock 证明不了 23505/ON CONFLICT 的库语义。
 *
 * [关联代码]
 *   - ./memory-project.service.ts — 被测实现
 *   - ./memory.constants.ts — 错误构造器（14001/14002/9000/1009）与分页上界
 *
 * [修改检查]
 *   □ 改绑定校验/换绑判据必须同步 e2e 的 ⑧⑨ 用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  ActorType,
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_PROJECT_STATUS,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryEngineBindingClaim } from '../../database/entities/memory-engine-binding-claim.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService, sameMemoryProjectBindings } from './memory-project.service';
import type { MemoryEngine as MemoryEnginePort } from './engines/memory-engine.interface';
import {
  buildProvisioningIdempotencyKey,
  type HumentDisableResult,
  type HumentProvisioningClient,
  type HumentProvisioningFailure,
  type HumentProvisioningResult,
} from './engines/hument-provisioning.client';

const ACTOR_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const BINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** 造一个 agent actor（权限判定被 mock 掉，本套件只验服务层编排） */
function agentActor(): UnifiedActor {
  return { id: ACTOR_ID, type: ActorType.AGENT };
}

/** 造一个项目实体（带齐全的时间列——`toDto` 会 `toISOString()`） */
function buildProject(overrides: Partial<MemoryProject> = {}): MemoryProject {
  return {
    id: PROJECT_ID,
    slug: 'chamber',
    name: 'Agent Chamber',
    bindings: [{ type: 'board', id: BINDING_ID }],
    engine: MEMORY_ENGINE.NONE,
    engineWorkspaceId: null,
    engineActorId: null,
    engineCredentialRef: null,
    status: MEMORY_PROJECT_STATUS.ACTIVE,
    // 库侧默认 true（`memory_projects.retain_query_text`）；单测显式带上，
    // 让"投影回显开关"的断言有事实基础（而不是断言一个 undefined）
    retainQueryText: true,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as MemoryProject;
}

/** 链式 QueryBuilder 替身（列表路径只需 where/andWhere/orderBy/addOrderBy/getMany） */
function queryBuilderOf(rows: MemoryProject[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
}

/**
 * `memory_engine_binding_claims` 仓储替身（事务内 `INSERT … ON CONFLICT DO NOTHING` + 回读）。
 *
 * `claimProjectId` 语义：
 * - `undefined`（缺省）⇒ 回读命中**本次插入的 projectId**（正常幂等路径）；
 * - 具体 id ⇒ 回读返回该归属（模拟"被别的项目占用"）；
 * - `null` ⇒ 回读为空（模拟 claim 未能成立，服务层必须 fail-closed 409）。
 */
function claimsRepoOf(options: {
  claimProjectId?: string | null;
  /** 仅当**事务内已插入**后，回读返回该归属（模拟"预查后被并发抢占"的竞态） */
  claimOwnerAfterInsert?: string;
}) {
  let inserted: { projectId?: string } | null = null;
  const qb: any = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn((values: { projectId?: string }) => {
      inserted = values;
      return qb;
    }),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => ({})),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(async () => {
      if (options.claimProjectId === null) return null;
      // 显式指定归属（模拟"被别的项目占用"）优先
      if (options.claimProjectId !== undefined) {
        return { id: 'claim-1', projectId: options.claimProjectId } as MemoryEngineBindingClaim;
      }
      // 没有显式归属时：**尚未插入** = 预查阶段无 claim（自动注册前预查）；
      // 插入之后 = 回读命中本次插入的 projectId（同项目幂等路径）。
      if (!inserted) return null;
      if (options.claimOwnerAfterInsert !== undefined) {
        return {
          id: 'claim-1',
          projectId: options.claimOwnerAfterInsert,
        } as MemoryEngineBindingClaim;
      }
      return {
        id: 'claim-1',
        projectId: inserted.projectId ?? 'prj-saved',
      } as MemoryEngineBindingClaim;
    }),
  };
  return { repo, qb, inserted: () => inserted };
}

/** `projects` 仓储替身（`manager.transaction` 支持 claim 写入；见文件头不变量） */
function projectsRepoOf(
  options: {
    existing?: MemoryProject | null;
    rows?: MemoryProject[];
    save?: (entity: MemoryProject) => Promise<MemoryProject>;
  },
  claims: ReturnType<typeof claimsRepoOf>,
  nominations: unknown,
) {
  const qb = queryBuilderOf(options.rows ?? []);
  const repo: any = {
    findOne: jest.fn(async () => options.existing ?? null),
    create: jest.fn((input: Partial<MemoryProject>) => ({ ...input }) as MemoryProject),
    save: jest.fn(async (entity: MemoryProject) =>
      options.save
        ? options.save(entity)
        : {
            // 真实 save() 会回填 id / 审计时间列（toDto 直接 toISOString，缺了就炸）
            ...entity,
            id: entity.id ?? 'prj-saved',
            status: entity.status ?? MEMORY_PROJECT_STATUS.ACTIVE,
            createdAt: entity.createdAt ?? new Date('2026-10-03T00:00:00.000Z'),
            updatedAt: entity.updatedAt ?? new Date('2026-10-03T00:00:00.000Z'),
          },
    ),
    createQueryBuilder: jest.fn(() => qb),
    /** 暴露给断言：列表查询的谓词链 */
    qb,
  };
  // 事务替身：`manager.getRepository(实体)` 路由到对应仓储替身（与真实 TypeORM 同形）
  const manager: any = {
    transaction: jest.fn(async (isolationOrRun: unknown, run?: (m: unknown) => Promise<unknown>) =>
      (typeof isolationOrRun === 'function' ? isolationOrRun : run!)(manager),
    ),
    getRepository: jest.fn((entity: unknown) =>
      entity === MemoryEngineBindingClaim
        ? claims.repo
        : entity === MemoryNomination
          ? nominations
          : repo,
    ),
  };
  repo.manager = manager;
  return repo;
}

/** 组装被测服务（access / engine / provisioning 全部以假件注入） */
function buildService(options: {
  existing?: MemoryProject | null;
  rows?: MemoryProject[];
  save?: (entity: MemoryProject) => Promise<MemoryProject>;
  engine?: unknown;
  /** 自助开通客户端替身（缺省 null = 未启用，保持存量用例语义） */
  provisioning?: unknown;
  bindingProblem?: string | null;
  /** 任意历史账本是否存在（不按形成态或软删过滤）。 */
  ledgerExists?: boolean;
  /** claim 回读归属覆盖（见 claimsRepoOf） */
  claimProjectId?: string | null;
  /** 事务内插入后回读返回的归属（模拟预查后被并发抢占） */
  claimOwnerAfterInsert?: string;
}) {
  const claims = claimsRepoOf({
    claimProjectId: options.claimProjectId,
    claimOwnerAfterInsert: options.claimOwnerAfterInsert,
  });
  const nominations = {
    exists: jest.fn(async () => options.ledgerExists ?? false),
  };
  const projects = projectsRepoOf(options, claims, nominations);
  // ⚠️ 形参显式声明（而不是 `async () => ...`）：否则 `mockImplementation` 传两参会被
  // TS 判成"目标签名参数太少"——本套件要按行定制可见性，必须能替换实现
  const access = {
    resolveProjectAccess: jest.fn(async (_actor: unknown, _project: MemoryProject) => ({
      readable: true,
      writable: true,
      isGovernanceViewer: false,
      resolved: [],
    })),
    assertProjectRead: jest.fn(async (_actor?: unknown, _project?: unknown) => ({
      readable: true,
      writable: true,
      isGovernanceViewer: false,
      resolved: [],
    })),
    describeUnreadableBinding: jest.fn(
      async (_actor?: unknown, _type?: string, _id?: string) => options.bindingProblem ?? null,
    ),
  };

  const service = new MemoryProjectService(
    projects as unknown as Repository<MemoryProject>,
    nominations as unknown as Repository<MemoryNomination>,
    access as unknown as MemoryAccessService,
    (options.engine ?? null) as unknown as MemoryEnginePort | null,
    (options.provisioning ?? null) as unknown as HumentProvisioningClient | null,
  );
  return { service, projects, nominations, access, claims };
}

/**
 * 自助开通客户端替身：`provision` / `disableProject` 的返回由参数给定
 * （默认一个永远不该被调到的桩——"未预期调用"要响亮而不是静默计数）。
 */
function provisioningStub(result?: HumentProvisioningResult, disable?: HumentDisableResult) {
  return {
    provision: jest.fn(
      async (_slug: string, _displayName?: string): Promise<HumentProvisioningResult> => {
        if (!result) throw new Error('provisioning stub was called unexpectedly');
        return result;
      },
    ),
    disableProject: jest.fn(async (_slug: string): Promise<HumentDisableResult> => {
      if (!disable) throw new Error('provisioning disable stub was called unexpectedly');
      return disable;
    }),
  };
}

/** 注册成功的派生三键（与服务层 `provisionEngineBinding` 的产物同形：credential_ref = `ref-<slug>`） */
function provisionedOk(slug: string, replay = false): HumentProvisioningResult {
  return {
    ok: true,
    value: {
      workspaceId: slug,
      actorId: 'chamber',
      credentialRef: `ref-${slug}`,
      replay,
    },
  };
}

/** 注册失败面（只给分类与可选状态码；服务层据此翻 reason） */
function provisionedFailure(failure: HumentProvisioningFailure): HumentProvisioningResult {
  return { ok: false, failure };
}

/** 孤儿善后成功面（disableProject 落地为 disabled） */
function provisionedDisableOk(replay = false): HumentDisableResult {
  return { ok: true, value: { state: 'disabled', replay } };
}

/** 孤儿善后失败面（服务层只取分类名进日志，绝不改变 create 的报错路径） */
function provisionedDisableFailure(failure: HumentProvisioningFailure): HumentDisableResult {
  return { ok: false, failure };
}

/** 引擎替身（本套件只关心"token 是否为 null"，从不真正调用引擎） */
const fakeEngineToken = { name: 'fake' };

describe('MemoryProjectService（项目注册表）', () => {
  // ══════════════════════════════════════════════════════════════════════
  // 引擎可用性块：本地数据端点嵌的**唯一判据点**
  // ══════════════════════════════════════════════════════════════════════
  describe('engineAvailability（判据只认 token + 项目三列）', () => {
    it('token 为 null ⇒ not_configured（**即使项目已绑好引擎三列**）', () => {
      const { service } = buildService({ engine: null });
      const block = service.engineAvailability(
        buildProject({
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act-1',
          engineCredentialRef: 'cred-1',
        }),
      );

      // 全局未配 = 部署面没接引擎：与"本项目没绑"是两个不同的处置动作
      expect(block).toEqual({
        engine: MEMORY_ENGINE.HUMENT,
        available: false,
        reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
      });
    });

    it('token 在但项目 engine=none ⇒ project_engine_unbound（分码，不是 not_configured）', () => {
      const { service } = buildService({ engine: fakeEngineToken });
      const block = service.engineAvailability(buildProject({ engine: MEMORY_ENGINE.NONE }));

      expect(block).toEqual({
        engine: MEMORY_ENGINE.NONE,
        available: false,
        reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      });
    });

    it('token 在 + engine=hument + 三列齐 ⇒ available（reason 必须为 null）', () => {
      const { service } = buildService({ engine: fakeEngineToken });
      const block = service.engineAvailability(
        buildProject({
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act-1',
          engineCredentialRef: 'cred-1',
        }),
      );

      expect(block).toEqual({ engine: MEMORY_ENGINE.HUMENT, available: true, reason: null });
    });

    it('三列缺一（含纯空白串）⇒ project_engine_unbound；hasCompleteEngineBinding 逐列假', () => {
      const { service } = buildService({ engine: fakeEngineToken });
      const base = {
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      } as const;

      const blanks: Array<Partial<MemoryProject>> = [
        { engineWorkspaceId: null },
        { engineWorkspaceId: '   ' }, // 空白串不是"已绑定"——trim 后为空即未绑
        { engineActorId: undefined },
        { engineCredentialRef: '' },
      ];
      for (const blank of blanks) {
        const project = buildProject({ ...base, ...blank });
        expect(service.hasCompleteEngineBinding(project)).toBe(false);
        expect(service.engineAvailability(project).reason).toBe(
          MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        );
      }
      expect(service.hasCompleteEngineBinding(buildProject(base))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 读面
  // ══════════════════════════════════════════════════════════════════════
  describe('findProjectOrThrow / findOne', () => {
    it('行不存在（含软删，被 TypeORM 默认谓词排除）⇒ 404/14001', async () => {
      const { service } = buildService({ existing: null });

      await expect(service.findProjectOrThrow(PROJECT_ID)).rejects.toMatchObject({
        status: 404,
        response: { code: ErrorCode.MEMORY_PROJECT_NOT_FOUND },
      });
    });

    it('详情先过读闸门再投影（含 engineAvailability 块 + canReadContent）', async () => {
      const project = buildProject();
      const { service, access } = buildService({ existing: project, engine: fakeEngineToken });

      const dto = await service.findOne(agentActor(), PROJECT_ID);

      expect(access.assertProjectRead).toHaveBeenCalledWith(agentActor(), project);
      // ⚠️ **接住 `assertProjectRead` 的返回值**即可（它本就返回访问结论）——绝不为此多查一次
      expect(access.resolveProjectAccess).not.toHaveBeenCalled();
      expect(dto).toMatchObject({
        id: PROJECT_ID,
        slug: 'chamber',
        bindings: [{ type: 'board', id: BINDING_ID }],
        createdAt: '2026-10-01T00:00:00.000Z',
        engineAvailability: {
          engine: MEMORY_ENGINE.NONE,
          available: false,
          reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
        },
        canReadContent: true,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 写面：创建
  // ══════════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('绑定不可读 ⇒ 400/9000 且 message **指名字段**（bindings[type:id]）', async () => {
      const { service } = buildService({
        bindingProblem: `bindings[topic:${BINDING_ID}] is not readable by the caller (可读 required)`,
      });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'topic', id: BINDING_ID }],
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: ErrorCode.VALIDATION_ERROR,
          message: expect.stringContaining(`bindings[topic:${BINDING_ID}]`),
        },
      });
    });

    it('engine=none ⇒ 三列**强制 null**（即便 DTO 传了值——不许留半个绑定）', async () => {
      const { service, projects } = buildService({ engine: fakeEngineToken });

      await service.create(agentActor(), {
        slug: 'chamber',
        name: 'n',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.NONE,
        engineWorkspaceId: 'ws-should-be-dropped',
        engineActorId: 'act-should-be-dropped',
        engineCredentialRef: 'cred-should-be-dropped',
      });

      expect(projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: MEMORY_ENGINE.NONE,
          engineWorkspaceId: null,
          engineActorId: null,
          engineCredentialRef: null,
        }),
      );
    });

    it('engine=hument 三元组缺一 ⇒ 400 且 data.field 指名字段', async () => {
      const { service, projects } = buildService({ engine: fakeEngineToken });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineCredentialRef: 'cred-1',
          // engineActorId 缺席
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineActorId' } },
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('凭据引用形如真 key（apikey_/sk_）⇒ 400（该列会随投影回显给读权限者）', async () => {
      const { service } = buildService({ engine: fakeEngineToken });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act-1',
          engineCredentialRef: 'apikey_live_不是引用名',
        }),
      ).rejects.toMatchObject({ status: 400, response: { code: ErrorCode.VALIDATION_ERROR } });
    });

    it('slug 预检命中 ⇒ 409/14002（唯一索引仍是并发窗口的最终仲裁者）', async () => {
      const { service, projects } = buildService({ existing: buildProject() });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('并发窗口的 23505(uq_memory_projects_slug) ⇒ 409；其它 PG 错误原样抛出', async () => {
      const concurrent = buildService({
        engine: fakeEngineToken,
        save: async () => {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'uq_memory_projects_slug',
          });
        },
      });
      await expect(
        concurrent.service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
        }),
      ).rejects.toMatchObject({ status: 409 });

      const other = buildService({
        engine: fakeEngineToken,
        save: async () => {
          throw Object.assign(new Error('fk violation'), {
            code: '23503',
            constraint: 'fk_memory_nominations_project',
          });
        },
      });
      await expect(
        other.service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
        }),
      ).rejects.toThrow('fk violation');
    });

    it('成功 ⇒ 投影（含 slug/绑定/引擎可用性块）', async () => {
      const { service } = buildService({ engine: fakeEngineToken });

      const dto = await service.create(agentActor(), {
        slug: 'chamber',
        name: 'Agent Chamber',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });

      expect(dto).toMatchObject({
        slug: 'chamber',
        createdBy: ACTOR_ID,
        bindings: [{ type: 'board', id: BINDING_ID }],
        engineAvailability: { available: true, reason: null },
        // create 的绑定校验已要求**每个绑定都可读** ⇒ 这里的 true 是 by construction
        // （投影口径的完整性要求，不是一条有效断言——见 service 里 create 的注释）
        canReadContent: true,
      });
    });

    // ── 二期自助开通：创建的三分支（全缺自动注册 / 全显式零注册 / 部分缺 400）──────
    it('全缺三键 + engine=hument + 客户端可用 ⇒ 自动注册并把**派生三键**落库', async () => {
      const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
      const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

      const dto = await service.create(agentActor(), {
        slug: 'prov-walk-01',
        name: '走查样本',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
      });

      // 注册恰好一次，且把 slug + **trim 后的展示名**交给客户端（幂等键由客户端派生＝单源）
      expect(provisioning.provision).toHaveBeenCalledTimes(1);
      expect(provisioning.provision).toHaveBeenCalledWith('prov-walk-01', '走查样本');
      expect(buildProvisioningIdempotencyKey('prov-walk-01')).toBe(
        'chamber-provision-prov-walk-01',
      );
      // 派生三键逐列落库（workspace=slug / actor=chamber / credential_ref=`ref-<slug>`）
      expect(projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'prov-walk-01',
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'prov-walk-01',
          engineActorId: 'chamber',
          engineCredentialRef: 'ref-prov-walk-01',
        }),
      );
      expect(dto.engineAvailability).toEqual({
        engine: MEMORY_ENGINE.HUMENT,
        available: true,
        reason: null,
      });
    });

    it('Hub 返回越界的 workspaceId ⇒ **fail-closed 拒绝**（503/闭集 reason，禁止改写/截断，不落库）', async () => {
      // 含换行的 workspaceId = 越界（Hub 侧异常/被篡改）；**绝不**替换或截断后落库
      const provisioning = provisioningStub({
        ok: true,
        value: {
          workspaceId: 'ws\nwith-newline',
          actorId: 'chamber',
          credentialRef: 'ref-bad',
          replay: false,
        },
      });
      const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

      await expect(
        service.create(agentActor(), {
          slug: 'prov-bad-ws',
          name: '越界样本',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: { reason: MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED },
        },
      });
      // Hub 已登记但本地零副作用（save 从未发生；孤儿由运维对账，不做 best-effort 收口）
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('显式三键的 workspaceId 字符集闸门（服务层第二道，铁律 #21）：越界 ⇒ 400 指名字段', async () => {
      const { service, projects } = buildService({ engine: fakeEngineToken });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: '越界显式',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          // DTO 的 @Matches 会拦它；这里直呼 service = 验证**服务层**也不放行
          engineWorkspaceId: 'ws/../escape',
          engineActorId: 'act-1',
          engineCredentialRef: 'cred-1',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineWorkspaceId' } },
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('engineActorId / engineCredentialRef 同字符集闸门：越界 ⇒ 400 指名字段（F3）', async () => {
      const invalidActor = buildService({ engine: fakeEngineToken });
      await expect(
        invalidActor.service.create(agentActor(), {
          slug: 'chamber',
          name: '越界 actor',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act/../escape',
          engineCredentialRef: 'cred-1',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineActorId' } },
      });
      expect(invalidActor.projects.save).not.toHaveBeenCalled();

      const invalidCred = buildService({ engine: fakeEngineToken });
      await expect(
        invalidCred.service.create(agentActor(), {
          slug: 'chamber',
          name: '越界 cred',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act-1',
          engineCredentialRef: 'cred\nref',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineCredentialRef' } },
      });
      expect(invalidCred.projects.save).not.toHaveBeenCalled();
    });

    it('**改绑**路径的 workspaceId 闸门：首尾空白 ⇒ 400 且不落库（标识符永不 trim 改写）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-old',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, projects } = buildService({ existing: project, engine: fakeEngineToken });

      // `' ws-new '` 若被静默 trim 成 `ws-new` 落库 = 改写标识符（plan §5 明令禁止）
      await expect(
        service.update(agentActor(), PROJECT_ID, { engineWorkspaceId: ' ws-new ' }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineWorkspaceId' } },
      });
      expect(projects.save).not.toHaveBeenCalled();
      // 原值原样保留（未落库 = 内存实体也没被改）
      expect(project.engineWorkspaceId).toBe('ws-old');
    });

    it('三键全缺但三键都是**空串/空白** ⇒ 仍走自动注册（trim 口径，不当"部分缺"）', async () => {
      const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
      const { service } = buildService({ engine: fakeEngineToken, provisioning });

      await service.create(agentActor(), {
        slug: 'prov-walk-01',
        name: 'n',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: '   ',
        engineActorId: '',
        engineCredentialRef: '',
      });

      expect(provisioning.provision).toHaveBeenCalledTimes(1);
    });

    it('自动注册把 `name` **trim 后**交给 provision（展示名不留首尾空白，NIT-3）', async () => {
      const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
      const { service } = buildService({ engine: fakeEngineToken, provisioning });

      await service.create(agentActor(), {
        slug: 'prov-walk-01',
        name: '  走查样本  ',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
      });

      expect(provisioning.provision).toHaveBeenCalledWith('prov-walk-01', '走查样本');
    });

    it('三键**全显式** ⇒ 手工老路，**零注册调用**（Kairos 迁移 / 特殊 workspace 场景）', async () => {
      // 桩一旦被调到就抛错 ⇒ "零调用"是被动的、不可误判的断言
      const provisioning = provisioningStub();
      const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

      const dto = await service.create(agentActor(), {
        slug: 'chamber',
        name: 'n',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-manual',
        engineActorId: 'act-manual',
        engineCredentialRef: 'cred-manual',
      });

      expect(provisioning.provision).not.toHaveBeenCalled();
      expect(projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engineWorkspaceId: 'ws-manual',
          engineActorId: 'act-manual',
          engineCredentialRef: 'cred-manual',
        }),
      );
      expect(dto.engineAvailability.available).toBe(true);
    });

    it('**部分缺** ⇒ 400 指名字段（即便自助开通可用；不猜测缺的那一列）', async () => {
      const provisioning = provisioningStub();
      const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          // actorId / credentialRef 缺席
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineActorId' } },
      });
      expect(provisioning.provision).not.toHaveBeenCalled();
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('全缺 + engine=hument 但**未启用自助开通**（token=null）⇒ 现有 400（现状不变）', async () => {
      const { service, projects } = buildService({ engine: fakeEngineToken, provisioning: null });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR, data: { field: 'engineWorkspaceId' } },
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('slug 预检先于 provision ⇒ 已占用时 409 且**零注册调用**（绝不在 Hub 留孤儿）', async () => {
      const provisioning = provisioningStub();
      const { service } = buildService({
        engine: fakeEngineToken,
        provisioning,
        existing: buildProject({ slug: 'taken' }),
      });

      await expect(
        service.create(agentActor(), {
          slug: 'taken',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
      expect(provisioning.provision).not.toHaveBeenCalled();
    });

    it('注册失败 ⇒ 503/14000 + 按失败类型分 reason，且 **save 未被调用**（本地零副作用）', async () => {
      const cases: Array<[HumentProvisioningFailure, string]> = [
        [
          { kind: 'timeout', message: 't', latencyMs: 1 },
          MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT,
        ],
        [
          { kind: 'unreachable', message: 'u', latencyMs: 1 },
          MEMORY_UNAVAILABLE_REASON.PROVISIONING_UNAVAILABLE,
        ],
        [
          { kind: 'http', httpStatus: 409, message: 'c', latencyMs: 1 },
          MEMORY_UNAVAILABLE_REASON.PROVISIONING_CONFLICT,
        ],
        [
          {
            kind: 'http',
            httpStatus: 400,
            engineCode: 'invalid_argument',
            message: 'f',
            latencyMs: 1,
          },
          MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED,
        ],
        [
          { kind: 'invalid_response', message: 'half-registered', latencyMs: 1 },
          MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED,
        ],
      ];

      for (const [failure, reason] of cases) {
        const provisioning = provisioningStub(provisionedFailure(failure));
        const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

        await expect(
          service.create(agentActor(), {
            slug: 'chamber',
            name: 'n',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toMatchObject({
          status: 503,
          response: { code: ErrorCode.MEMORY_UNAVAILABLE, data: { reason } },
        });
        expect(projects.save).not.toHaveBeenCalled();
      }
    });

    it('注册失败时把 engineCode 透传进 data（消费方不必解析文案）', async () => {
      const provisioning = provisioningStub(
        provisionedFailure({
          kind: 'http',
          httpStatus: 403,
          engineCode: 'scope_denied',
          message: 'Hument operator registration returned HTTP 403',
          requestId: 'req-1',
          latencyMs: 3,
        }),
      );
      const { service } = buildService({ engine: fakeEngineToken, provisioning });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.MEMORY_UNAVAILABLE,
          data: {
            reason: MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED,
            engineCode: 'scope_denied',
          },
        },
      });
    });

    it('注册成功但 save 撞 23505（**并发败者**）⇒ 409 + warn 级 ORPHAN CHECK + **不调 disable**（复核发现胜者行）', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        // 不脚本 disable：一旦被调到即抛错（"不该 disable"必须响亮，见 not.toHaveBeenCalled）
        const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
        const { service, projects } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'uq_memory_projects_slug',
            });
          },
        });
        // ⚠️ 模拟真实并发：slug 预检时**还无行**（findOne #1 = null）；
        // 派生三元组预查 = 无历史行（findOne #2 = null）；
        // save 撞 23505 之后**胜者的行已 commit 且可见**（findOne #3 = 该行）
        projects.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(buildProject({ slug: 'prov-walk-01' }));

        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toMatchObject({ status: 409 });

        // ★ B-1：本地已有胜者的行 ⇒ **绝不 disable**（否则会把正在服务的 workspace 置于死地）
        expect(provisioning.disableProject).not.toHaveBeenCalled();

        // ★ N1：良性竞态**不是孤儿** ⇒ 只 warn，**不**刷 ERROR、**不**给运维处方
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warned = String(warnSpy.mock.calls[0][0]);
        expect(warned).toContain('disable_skipped:local_row_exists');
        expect(warned).toContain('concurrent winner');
        expect(warned).toContain('NO operator action required');
        expect(warned).not.toContain('ORPHAN WORKSPACE');
        expect(warned).not.toContain('OPERATOR SURGERY');
        // 诊断仍只记类型名 + PG code，**绝不落 error.message**
        expect(warned).toContain('Error/23505');
        expect(warned).not.toContain('duplicate key');
        // ★ F1：孤儿复核必须覆盖 withDeleted（软删历史项目同样不是孤儿）
        expect(projects.findOne).toHaveBeenNthCalledWith(3, {
          where: { slug: 'prov-walk-01' },
          withDeleted: true,
        });
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('save **成功**但投影抛错 ⇒ 绝不当孤儿善后、也绝不 disable（评审 M-1：try 只包 save）', async () => {
      // 这是 M-1 的回归守卫：投影（resolveProjectAccess / toDto）一旦被放进 save 的 try 内，
      // 它的任何失败都会落进"save 失败 ⇒ Hub 孤儿"模板——可此时 save **已 commit**
      // （项目建成了、客户端却收到错误、重试撞 409），而善后还会去 disable 一个**正在服务**的
      // workspace。本用例把那次调用打红，断言 disable 一次都没发。
      const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
      const { service, access, projects } = buildService({
        engine: fakeEngineToken,
        provisioning,
      });
      // create 路径上 `resolveProjectAccess` 只在 save **之后**调一次
      // （绑定可读性校验走的是 `describeUnreadableBinding`，不是它）⇒ 这一次就是投影那次
      access.resolveProjectAccess.mockRejectedValueOnce(new Error('binding lookup driver error'));

      await expect(
        service.create(agentActor(), {
          slug: 'prov-walk-01',
          name: '走查样本',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toThrow('binding lookup driver error');

      // save 确实成功了（行已落库）——所以这不是孤儿，善后必须保持沉默
      expect(projects.save).toHaveBeenCalledTimes(1);
      expect(provisioning.disableProject).not.toHaveBeenCalled();
    });

    it('前提复核查询**抛错** ⇒ warn 级 ORPHAN CHECK（状态未知）+ **不调 disable**，原错误不被顶替', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const provisioning = provisioningStub(provisionedOk('prov-walk-01'));
        const { service, projects } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('pg hiccup'), { code: '40001' });
          },
        });
        // findOne #1（slug 预检）= 无行；#2（派生三元组预查）= 无行；
        // #3（disable 前复核）= 查询本身失败
        projects.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error('connection terminated'));

        // 原 save 错误照常抛出（复核失败绝不顶替它、也绝不 disable）
        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toThrow('pg hiccup');

        expect(provisioning.disableProject).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        const warned = String(warnSpy.mock.calls[0][0]);
        expect(warned).toContain('disable_skipped:check_failed');
        expect(warned).toContain('UNKNOWN');
        expect(warned).not.toContain('ORPHAN WORKSPACE');
        expect(warned).not.toContain('OPERATOR SURGERY');
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('注册成功但 save 撞**非 23505**（PG 抖动，本地确实无行）⇒ 原异常透出 + 孤儿日志 + **照常 disable**', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const provisioning = provisioningStub(
          provisionedOk('prov-walk-01'),
          provisionedDisableOk(),
        );
        const { service } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            // PG 抖动 / 死锁 / 驱动错：同样留下"Hub 已登记、Chamber 无项目"的孤儿
            throw Object.assign(new Error('pg hiccup'), { code: '40001' });
          },
        });

        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toThrow('pg hiccup');

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = String(errorSpy.mock.calls[0][0]);
        expect(logged).toContain('ORPHAN WORKSPACE');
        expect(logged).toContain('Error/40001');
        expect(logged).toContain('chamber-provision-prov-walk-01');
        // 本地无行（复核通过）⇒ disable 照常发出
        expect(provisioning.disableProject).toHaveBeenCalledTimes(1);
        expect(provisioning.disableProject).toHaveBeenCalledWith('prov-walk-01');
        expect(logged).toContain('best-effort disable: disabled');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('disable 回 **replay receipt** ⇒ 日志记 `disabled(replayed-receipt)`（不谎报"本次禁成功"）', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const provisioning = provisioningStub(
          provisionedOk('prov-walk-01'),
          provisionedDisableOk(true), // replay:true = 同 key 的历史 receipt
        );
        const { service } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('pg hiccup'), { code: '40001' });
          },
        });

        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toThrow('pg hiccup');

        expect(String(errorSpy.mock.calls[0][0])).toContain(
          'best-effort disable: disabled(replayed-receipt)',
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('孤儿善后 disable **失败** ⇒ 日志记 `disable_failed:<分类>`，create 仍抛**原 save 错误**', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const provisioning = provisioningStub(
          provisionedOk('prov-walk-01'),
          provisionedDisableFailure({ kind: 'unreachable', message: 'u', latencyMs: 1 }),
        );
        const { service } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'uq_memory_projects_slug',
            });
          },
        });

        // 原 save 错误的语义（23505 → 409）**不被善后失败改变**（严格 best-effort）
        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toMatchObject({ status: 409 });

        expect(provisioning.disableProject).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain(
          'best-effort disable: disable_failed:unreachable',
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('孤儿善后 disable **抛错** ⇒ 兜底记类型名，**绝不顶替** create 的原报错', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        // 客户端承诺 never-throw；这里刻意违约，验证服务层的兜底（善后不许改变错误路径）
        const provisioning = {
          provision: jest.fn(async () => provisionedOk('prov-walk-01')),
          disableProject: jest.fn(async () => {
            throw new TypeError('boom');
          }),
        };
        const { service } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('pg hiccup'), { code: '40001' });
          },
        });

        // 抛出的是**原 save 错误**（pg hiccup），不是善后路径里的 boom
        await expect(
          service.create(agentActor(), {
            slug: 'prov-walk-01',
            name: '走查样本',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toThrow('pg hiccup');

        expect(String(errorSpy.mock.calls[0][0])).toContain(
          'best-effort disable: disable_failed:TypeError',
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('provision 本身失败 ⇒ **不调** disableProject（Hub 上没有登记，无孤儿可善后）', async () => {
      const provisioning = provisioningStub(
        provisionedFailure({
          kind: 'http',
          httpStatus: 403,
          engineCode: 'scope_denied',
          message: 'f',
          latencyMs: 1,
        }),
        provisionedDisableOk(),
      );
      const { service } = buildService({ engine: fakeEngineToken, provisioning });

      await expect(
        service.create(agentActor(), {
          slug: 'prov-walk-01',
          name: '走查样本',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({ status: 503 });

      expect(provisioning.provision).toHaveBeenCalledTimes(1);
      expect(provisioning.disableProject).not.toHaveBeenCalled();
    });

    it('mayHaveLanded（见过 202 后的无定论失败）⇒ 一律映射 provisioning_timeout（评审 S-4）', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        // kind=unreachable 本身会映射成 unavailable（"请求未到达"），但 hedged ⇒ 必须说成 timeout
        const provisioning = provisioningStub(
          provisionedFailure({
            kind: 'unreachable',
            message: 'Hument operator call timed out (no receipt)',
            mayHaveLanded: true,
            latencyMs: 5,
          }),
        );
        const { service, projects } = buildService({ engine: fakeEngineToken, provisioning });

        await expect(
          service.create(agentActor(), {
            slug: 'chamber',
            name: 'n',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
          }),
        ).rejects.toMatchObject({
          status: 503,
          response: {
            code: ErrorCode.MEMORY_UNAVAILABLE,
            data: { reason: MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT },
          },
        });
        expect(projects.save).not.toHaveBeenCalled();
        // 日志里也留痕，便于对"可能已落"的登记做人工核对
        expect(String(errorSpy.mock.calls[0][0])).toContain('mayHaveLanded=true');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('手工老路撞 23505 ⇒ 409 且**不**记孤儿（没有注册发生，无孤儿可言）', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const provisioning = provisioningStub();
        const { service } = buildService({
          engine: fakeEngineToken,
          provisioning,
          save: async () => {
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'uq_memory_projects_slug',
            });
          },
        });

        await expect(
          service.create(agentActor(), {
            slug: 'chamber',
            name: 'n',
            bindings: [{ type: 'board', id: BINDING_ID }],
            engine: MEMORY_ENGINE.HUMENT,
            engineWorkspaceId: 'ws-1',
            engineActorId: 'act-1',
            engineCredentialRef: 'cred-1',
          }),
        ).rejects.toMatchObject({ status: 409 });

        expect(provisioning.provision).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    // ── 引擎身份永久占用（plan §2.3；真实并发/回填见 claims e2e）──────────────
    it('engine=none ⇒ **不写** claim（没有引擎身份可占）', async () => {
      const { service, claims } = buildService({ engine: fakeEngineToken });

      await service.create(agentActor(), {
        slug: 'chamber',
        name: 'n',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.NONE,
      });

      expect(claims.qb.execute).not.toHaveBeenCalled();
      expect(claims.repo.findOne).not.toHaveBeenCalled();
    });

    it('完整 hument 三元组 ⇒ 事务内 claim 插入（orIgnore）并回读同项目', async () => {
      const { service, projects, claims } = buildService({ engine: fakeEngineToken });

      const dto = await service.create(agentActor(), {
        slug: 'chamber',
        name: 'n',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });

      expect(projects.manager.transaction).toHaveBeenCalledTimes(1);
      expect(claims.qb.orIgnore).toHaveBeenCalled();
      // projectId 是 save 回填后的真实 id（创建路径没有预生成 id）
      expect(claims.inserted()).toMatchObject({ projectId: dto.id });
      // M2：create 的新占用保持"当前创建时间"语义（不显式传 firstClaimedAt，交给 DB now()）
      expect(claims.inserted()).not.toHaveProperty('firstClaimedAt');
      expect(claims.repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('claim 已属于**别的** projectId ⇒ 409/14002（文案不含任何用户输入/owner id）', async () => {
      const { service } = buildService({
        engine: fakeEngineToken,
        claimProjectId: 'another-project-id',
      });

      const error = await service
        .create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-secret',
          engineActorId: 'act-secret',
          engineCredentialRef: 'cred-secret-ref',
        })
        .catch((err: unknown) => err);
      expect(error).toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
      const message = (error as { response: { message: string } }).response.message;
      // F3：workspace / actor / credentialRef / owner project id 一律不回显
      for (const forbidden of [
        'ws-secret',
        'act-secret',
        'cred-secret-ref',
        'another-project-id',
      ]) {
        expect(message).not.toContain(forbidden);
      }
      expect(message).toContain('DIFFERENT engine identity');
    });

    it('claim 回读为空 ⇒ fail-closed 409（不把"没占上"当成功）', async () => {
      const { service } = buildService({ engine: fakeEngineToken, claimProjectId: null });

      await expect(
        service.create(agentActor(), {
          slug: 'chamber',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
          engineWorkspaceId: 'ws-1',
          engineActorId: 'act-1',
          engineCredentialRef: 'cred-1',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
    });

    it('自动注册后事务内 claim 竞态 ⇒ 409 且**不** disable（F1：claim 冲突不是孤儿）', async () => {
      const provisioning = provisioningStub(provisionedOk('prov-race-01'));
      const { service } = buildService({
        engine: fakeEngineToken,
        provisioning,
        // 预查（insert 前）无 claim；事务内插入后回读发现被别的项目抢占
        claimOwnerAfterInsert: 'another-project-id',
      });

      await expect(
        service.create(agentActor(), {
          slug: 'prov-race-01',
          name: '并发抢占',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });

      expect(provisioning.provision).toHaveBeenCalledTimes(1);
      // ★ Hub workspace 可能仍有历史归属 ⇒ claim 冲突绝不允许 disable
      expect(provisioning.disableProject).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 写面：更新
  // ══════════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('无写权限且非 creator ⇒ 403/1009（**不是 409**：无权不是状态冲突）', async () => {
      const project = buildProject({ createdBy: 'someone-else' });
      const { service, access } = buildService({ existing: project });
      access.resolveProjectAccess.mockResolvedValue({
        readable: true,
        writable: false,
        isGovernanceViewer: false,
        resolved: [],
      });

      await expect(service.update(agentActor(), PROJECT_ID, { name: 'n' })).rejects.toMatchObject({
        status: 403,
        response: { code: ErrorCode.PERMISSION_DENIED },
      });
    });

    it('只改 name ⇒ 引擎三列**不被触碰**（值判定；hasOwnProperty 会让这里 400）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, projects, nominations } = buildService({
        existing: project,
        engine: fakeEngineToken,
      });

      const dto = await service.update(agentActor(), PROJECT_ID, { name: '新名字' });

      expect(dto.name).toBe('新名字');
      expect(dto).toMatchObject({
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      // 未触碰引擎 ⇒ 不做换绑守卫、不查 耐久账本行
      expect(nominations.exists).not.toHaveBeenCalled();
      expect(projects.save).toHaveBeenCalledTimes(1);
    });

    it('换 workspace 且已有 耐久账本行 ⇒ 409/14002（判据带 projectId + withDeleted）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-old',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, projects, nominations } = buildService({
        existing: project,
        engine: fakeEngineToken,
        ledgerExists: true,
      });

      await expect(
        service.update(agentActor(), PROJECT_ID, { engineWorkspaceId: 'ws-new' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
      expect(nominations.exists).toHaveBeenCalledWith({
        where: { projectId: PROJECT_ID },
        withDeleted: true,
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('换 workspace 但无 耐久账本行 ⇒ 落新值（守卫不该拦正常的首次绑定）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-old',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service } = buildService({ existing: project, engine: fakeEngineToken });

      const dto = await service.update(agentActor(), PROJECT_ID, {
        engineWorkspaceId: 'ws-new',
        engineActorId: 'act-2',
        engineCredentialRef: 'cred-2',
      });

      expect(dto).toMatchObject({
        engineWorkspaceId: 'ws-new',
        engineActorId: 'act-2',
        engineCredentialRef: 'cred-2',
      });
    });

    it('清空 workspace（engine=none）也算"换"：旧值非 null 时必须查 耐久账本行', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-old',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, nominations } = buildService({ existing: project, engine: fakeEngineToken });

      const dto = await service.update(agentActor(), PROJECT_ID, { engine: MEMORY_ENGINE.NONE });

      expect(nominations.exists).toHaveBeenCalledTimes(1);
      expect(dto).toMatchObject({
        engine: MEMORY_ENGINE.NONE,
        engineWorkspaceId: null,
        engineActorId: null,
        engineCredentialRef: null,
      });
    });

    it('bindings:[] ⇒ 清空且**不**做可读性校验（清空是合法的存量态）；canReadContent **重算**为 false', async () => {
      const { service, access } = buildService({ existing: buildProject() });
      // 两次调用刻意给不同结论：① 授权判定读**变更前** access（放行）② 投影读**变更后** access
      // （绑定已清空、非 admin ⇒ 内容端点关闭）。若实现把变更前的值直接投影，本用例当场红。
      access.resolveProjectAccess
        .mockResolvedValueOnce({
          readable: true,
          writable: true,
          isGovernanceViewer: false,
          resolved: [],
        })
        .mockResolvedValueOnce({
          readable: false,
          writable: false,
          isGovernanceViewer: true,
          resolved: [],
        });

      const dto = await service.update(agentActor(), PROJECT_ID, { bindings: [] });

      expect(access.describeUnreadableBinding).not.toHaveBeenCalled();
      expect(dto.bindings).toEqual([]);
      expect(dto.canReadContent).toBe(false);
      expect(access.resolveProjectAccess).toHaveBeenCalledTimes(2);
    });

    it('bindings 非空 ⇒ 逐条校验（不可读即 400，不落库）', async () => {
      const { service, projects } = buildService({
        existing: buildProject(),
        bindingProblem: `bindings[board:${BINDING_ID}] does not exist or has been deleted`,
      });

      await expect(
        service.update(agentActor(), PROJECT_ID, { bindings: [{ type: 'board', id: BINDING_ID }] }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: ErrorCode.VALIDATION_ERROR,
          message: expect.stringContaining(`bindings[board:${BINDING_ID}]`),
        },
      });
      expect(projects.save).not.toHaveBeenCalled();
    });

    it('retainQueryText:false ⇒ 翻关（值判定：`false` 是"改"，不能被 `?? true` 之类的兜底吞掉）', async () => {
      const { service, projects } = buildService({ existing: buildProject() });

      const dto = await service.update(agentActor(), PROJECT_ID, { retainQueryText: false });

      expect(dto.retainQueryText).toBe(false);
      // 落库实体上同样是 false（不是"跳过了没写"）
      expect((projects.save.mock.calls[0][0] as MemoryProject).retainQueryText).toBe(false);
    });

    it('retainQueryText:true ⇒ 从关翻回开（双向可翻转）', async () => {
      const { service } = buildService({ existing: buildProject({ retainQueryText: false }) });

      const dto = await service.update(agentActor(), PROJECT_ID, { retainQueryText: true });

      expect(dto.retainQueryText).toBe(true);
    });

    it('只改 name ⇒ retainQueryText **不被触碰**（undefined = 未发送，保持关）', async () => {
      const { service, projects } = buildService({
        existing: buildProject({ retainQueryText: false }),
      });

      const dto = await service.update(agentActor(), PROJECT_ID, { name: '只改名' });

      expect(dto.retainQueryText).toBe(false);
      expect((projects.save.mock.calls[0][0] as MemoryProject).retainQueryText).toBe(false);
    });

    // ── 引擎身份永久占用（plan §2.3；真实回旧三元组/清空不释放见 claims e2e）──
    it('PATCH 重发同一三元组 ⇒ 事务内 claim 幂等放行（不新增归属）', async () => {
      const triple = {
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      };
      const project = buildProject(triple);
      const { service, projects, claims } = buildService({
        existing: project,
        engine: fakeEngineToken,
      });

      const dto = await service.update(agentActor(), PROJECT_ID, triple);

      expect(dto).toMatchObject(triple);
      expect(projects.manager.transaction).toHaveBeenCalledTimes(1);
      expect(claims.qb.orIgnore).toHaveBeenCalled();
      expect(claims.inserted()).toMatchObject({ projectId: PROJECT_ID });
    });

    it('PATCH 清空引擎 ⇒ 旧三元组 best-effort 补 claim，但不对 none 做严格占用', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, claims } = buildService({ existing: project, engine: fakeEngineToken });

      const dto = await service.update(agentActor(), PROJECT_ID, { engine: MEMORY_ENGINE.NONE });

      expect(dto.engine).toBe(MEMORY_ENGINE.NONE);
      // 旧身份永久占用：best-effort 写一次（DO NOTHING，不判 owner）
      expect(claims.qb.execute).toHaveBeenCalledTimes(1);
      expect(claims.inserted()).toMatchObject({
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
        projectId: PROJECT_ID,
        // M2：旧项目补录的 firstClaimedAt = 项目 createdAt（不是本次 PATCH 时间）
        firstClaimedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      // 新状态是 none ⇒ 没有严格回读
      expect(claims.repo.findOne).not.toHaveBeenCalled();
    });

    it('非引擎 PATCH 且项目已有完整三元组 ⇒ best-effort 补 claim（幂等，不判 owner）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-1',
        engineActorId: 'act-1',
        engineCredentialRef: 'cred-1',
      });
      const { service, projects, claims } = buildService({
        existing: project,
        engine: fakeEngineToken,
      });

      await service.update(agentActor(), PROJECT_ID, { name: '只改名' });

      expect(projects.manager.transaction).toHaveBeenCalledTimes(1);
      expect(claims.qb.execute).toHaveBeenCalledTimes(1);
      expect(claims.inserted()).toMatchObject({
        projectId: PROJECT_ID,
        // M2：非引擎 PATCH 补录同样用项目 createdAt
        firstClaimedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(claims.repo.findOne).not.toHaveBeenCalled();
    });

    it('改绑到别的项目已占的三元组 ⇒ 409/14002（事务回滚，不落新绑定）', async () => {
      const project = buildProject({
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: 'ws-old',
        engineActorId: 'act-old',
        engineCredentialRef: 'cred-old',
      });
      const { service } = buildService({
        existing: project,
        engine: fakeEngineToken,
        claimProjectId: 'another-project-id',
      });

      await expect(
        service.update(agentActor(), PROJECT_ID, {
          engineWorkspaceId: 'ws-taken',
          engineActorId: 'act-taken',
          engineCredentialRef: 'cred-taken',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 列表：过滤在分页之前
  // ══════════════════════════════════════════════════════════════════════
  describe('findAll', () => {
    it('给 bindingId 不给 bindingType ⇒ 400/9000（反查面含糊必须显式拒绝）', async () => {
      const { service } = buildService({});

      await expect(service.findAll(agentActor(), { bindingId: BINDING_ID })).rejects.toMatchObject({
        status: 400,
        response: { code: ErrorCode.VALIDATION_ERROR },
      });
    });

    it('pageSize 越界钳制到 100（列表是只读面，不报错）；page 缺省 1', async () => {
      const rows = Array.from({ length: 120 }, (_, index) =>
        buildProject({ id: `prj-${index}`, slug: `s-${index}` }),
      );
      const { service } = buildService({ rows });

      const result = await service.findAll(agentActor(), { pageSize: 9999 });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(100); // MEMORY_MAX_PAGE_SIZE
      expect(result.total).toBe(120);
      expect(result.items).toHaveLength(100);
    });

    it('可见性过滤在**分页之前**：不可读且非治理观察者的行不占页码', async () => {
      const rows = [
        buildProject({ id: 'prj-hidden', slug: 'hidden' }),
        buildProject({ id: 'prj-visible', slug: 'visible' }),
        buildProject({ id: 'prj-gov', slug: 'gov' }),
      ];
      const { service, access } = buildService({ rows });
      access.resolveProjectAccess.mockImplementation(
        async (_actor: unknown, project: MemoryProject) => {
          if (project.id === 'prj-hidden') {
            return { readable: false, writable: false, isGovernanceViewer: false, resolved: [] };
          }
          return {
            readable: project.id === 'prj-visible',
            writable: false,
            isGovernanceViewer: project.id === 'prj-gov',
            resolved: [],
          };
        },
      );

      const result = await service.findAll(agentActor(), { pageSize: 1, page: 2 });

      // 过滤后剩 2 条（visible + gov），第 2 页 1 条 = gov（不可读但治理观察者放行）
      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.id)).toEqual(['prj-gov']);
      // ⚠️ `canReadContent` 必须来自**该行自己的** access（配对带过分页切片）——
      // gov 行 readable=false ⇒ false；若实现把配对丢了/串位，这里会拿到 visible 行的 true
      expect(result.items[0].canReadContent).toBe(false);
    });

    it('canReadContent 逐行取**自己的** access（跨分页切片不串位）', async () => {
      // 三行、第 2 行不可读（治理观察者放行 ⇒ 不被过滤），pageSize=2 ⇒ 第 2 页只剩第 3 行：
      // 既验"一页内不串位"，也验"配对值**带过了切片**"（正是 access 出循环作用域那个坑）
      const rows = [
        buildProject({ id: 'prj-1', slug: 's1' }),
        buildProject({ id: 'prj-2', slug: 's2' }),
        buildProject({ id: 'prj-3', slug: 's3' }),
      ];
      const { service, access } = buildService({ rows });
      access.resolveProjectAccess.mockImplementation(
        async (_actor: unknown, project: MemoryProject) => ({
          readable: project.id !== 'prj-2',
          writable: false,
          isGovernanceViewer: true, // 三行都放行（否则被过滤掉）
          resolved: [],
        }),
      );

      // 第 1 页：只把 false 给第 2 行自己，没有串给邻居
      const first = await service.findAll(agentActor(), { pageSize: 2, page: 1 });
      expect(first.items.map((item) => [item.id, item.canReadContent])).toEqual([
        ['prj-1', true],
        ['prj-2', false],
      ]);

      // 第 2 页（切片后只剩第 3 行）：配对值必须跟着切片走
      const second = await service.findAll(agentActor(), { pageSize: 2, page: 2 });
      expect(second.items.map((item) => [item.id, item.canReadContent])).toEqual([['prj-3', true]]);
    });

    it('provisioningAvailable = **部署级**开关（client 装没装），零项目也带；与项目无关', async () => {
      // 关闭态（buildService 缺省 provisioning = null）⇒ false
      const off = await buildService({ rows: [] }).service.findAll(agentActor(), {});
      expect(off.items).toEqual([]);
      expect(off.provisioningAvailable).toBe(false);

      // 装配态 ⇒ true（同一次响应里与 items 无关，是部署态）
      const on = await buildService({
        rows: [buildProject()],
        provisioning: provisioningStub(provisionedOk('p-1')),
      }).service.findAll(agentActor(), {});
      expect(on.items).toHaveLength(1);
      expect(on.provisioningAvailable).toBe(true);
    });

    it('jsonb 绑定反查走 containment（`@>`）而非等值——等值谓词对嵌套数组永不命中', async () => {
      const { service, projects } = buildService({ rows: [] });

      await service.findAll(agentActor(), {
        bindingType: 'board',
        bindingId: BINDING_ID,
        slug: 'chamber',
        page: 1,
      });

      const clauses = (projects.qb.andWhere as jest.Mock).mock.calls.map((call) => call[0]);
      expect(clauses).toContain('project.bindings @> :binding::jsonb');
      expect(clauses).toContain('project.slug = :slug');
      // 软删行不进列表（与部分唯一索引的谓词同源）
      expect((projects.qb.where as jest.Mock).mock.calls[0][0]).toBe('project.deleted_at IS NULL');
    });
  });
  describe('当前引擎身份唯一索引的兼容错误语义', () => {
    /** 模拟目标索引抢先于 claim 判定抛出的 PG 错误；原始详情不得出接口。 */
    const collision = () =>
      Object.assign(new Error('private-ws/private-actor/private-ref'), {
        code: '23505',
        constraint: 'uq_memory_projects_engine_triple',
      });
    /** 完整手工绑定输入：用非秘密引用名，不调用注册引擎。 */
    const binding = {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: 'private-ws',
      engineActorId: 'private-actor',
      engineCredentialRef: 'private-ref',
    };

    it('create 精确翻译目标索引 23505 为既有 409，且不回显 PG detail', async () => {
      const { service } = buildService({
        save: async () => {
          throw collision();
        },
      });
      const error = await service
        .create(agentActor(), {
          slug: 'identity-conflict',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          ...binding,
        })
        .catch((err: unknown) => err);
      expect(error).toMatchObject({
        status: 409,
        response: {
          code: ErrorCode.MEMORY_PROJECT_CONFLICT,
          data: { reason: 'engine_binding_claimed' },
        },
      });
      for (const value of ['private-ws', 'private-actor', 'private-ref']) {
        expect(JSON.stringify(error)).not.toContain(value);
      }
    });

    it('PATCH 同源翻译目标索引冲突', async () => {
      const { service } = buildService({
        existing: buildProject(),
        save: async () => {
          throw collision();
        },
      });
      await expect(service.update(agentActor(), PROJECT_ID, binding)).rejects.toMatchObject({
        status: 409,
        response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
      });
    });

    it('auto-provision 目标索引冲突不是孤儿，绝不 disable 既有 workspace', async () => {
      const provisioning = provisioningStub(provisionedOk('identity-race'));
      const { service } = buildService({
        provisioning,
        save: async () => {
          throw collision();
        },
      });
      await expect(
        service.create(agentActor(), {
          slug: 'identity-race',
          name: 'n',
          bindings: [{ type: 'board', id: BINDING_ID }],
          engine: MEMORY_ENGINE.HUMENT,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { data: { reason: 'engine_binding_claimed' } },
      });
      expect(provisioning.provision).toHaveBeenCalledTimes(1);
      expect(provisioning.disableProject).not.toHaveBeenCalled();
    });

    it.each([
      { code: '23505', constraint: 'unrelated_unique' },
      { code: '40001', constraint: 'uq_memory_projects_engine_triple' },
    ])('不误吞非目标错误 %j', async (shape) => {
      const original = Object.assign(new Error('other db failure'), shape);
      const { service } = buildService({
        existing: buildProject(),
        save: async () => {
          throw original;
        },
      });
      await expect(service.update(agentActor(), PROJECT_ID, binding)).rejects.toBe(original);
    });
  });
});

/** bindings 值语义不能依赖JSON对象键序或集合排列。 */
describe('sameMemoryProjectBindings', () => {
  it('忽略对象键序和排列，但不忽略type/id差异', () => {
    const first = [
      { type: 'board' as const, id: BINDING_ID },
      { type: 'topic' as const, id: PROJECT_ID },
    ];
    const second = [
      { id: PROJECT_ID, type: 'topic' as const },
      { id: BINDING_ID, type: 'board' as const },
    ];
    expect(sameMemoryProjectBindings(first, second)).toBe(true);
    expect(sameMemoryProjectBindings(first, [{ type: 'docSpace', id: BINDING_ID }])).toBe(false);
  });
});
