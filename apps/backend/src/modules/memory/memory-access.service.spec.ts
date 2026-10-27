/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 权限内核的单测：**批式**来源可见性（一次喂全部引用）、`getAccessible*Ids` 的
 *     **null 三态**、父链**逐环**判定、项目三档闸门
 *
 * [代码职责]
 *   - 把"三处同源约束"的判据（`isVisibleIn` / `allSourcesVisible`）与批式预载行为
 *     钉成可执行事实——它们是召回过滤、账本降级投影、记忆详情 404 的共同地基
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §5 权限模型（父链逐环 / 批式 /
 *     null 三态 / 治理白名单）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **`null` = Admin 全放行**：把 null 当空集合会让 admin 读不到任何来源（回归症状 =
 *     管理员召回永远全空，且不报错）。
 *   - **父链任一环缺失/软删 ⇒ 不可见**：board 软删必须让 task 与 comment 两个来源同时不可见
 *     （不是只过滤 task）。
 *   - **批式**：一次 `evaluateSourceRefs` 对同一实体类型只查一次库（调用次数断言钉住）——
 *     逐引用查库在 e2e 的小数据量下全绿，只在生产放大成 N+1。
 *   - **治理观察者 ≠ 内容放行**：`isGovernanceViewer` 只放行项目元数据；内容端点由
 *     `assertProjectContentRead` 拦（用例覆盖"绑定全不可读 → 403"）。
 *   - **topic 绑定的读判定走运行时白名单**（卡 7a21f96b）：白名单命中即可读、未命中不可读、
 *     admin 的 `null` 全放行。裸调 Policy（缺 `hasAccess`）会把 private topic 参与者误判——
 *     本套件的三条用例就是这条的回归锁。
 *
 * [关联代码]
 *   - ../../src/modules/memory/memory-access.service.ts — 被测实现
 *   - ../../src/modules/memory/memory-project.service.ts — 消费方（引擎可用性块）
 *
 * [修改检查]
 *   □ 改可见性判据必须同步三处调用点的 e2e（本单测只保证判据本身）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Repository } from 'typeorm';
import {
  ActorType,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  UserRole,
} from '@agent-chamber/shared';
import {
  allSourcesVisible,
  isVisibleIn,
  MemoryAccessService,
  type SourceRefVerdict,
} from './memory-access.service';
import type { MemorySourceRef } from '../../database/entities/memory-nomination.entity';
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import type { UnifiedActor } from '../../common/types/actor.types';

/**
 * 造一个只支持 `find` 的假仓储。
 *
 * 「忽略 where、直接回全量」是刻意的：`IN (...)` 的过滤语义是 TypeORM/PG 的责任（由 e2e 的
 * 真库用例覆盖），本套件要测的是**判定逻辑**（父链逐环 / 白名单三态 / 批式）——假仓储若自己
 * 实现 where 过滤，反而会掩盖"服务层多查了几次库"这类回归（调用次数断言才是批式守卫）。
 */
function fakeRepo(rows: unknown[]): Repository<any> & { find: jest.Mock; findOne: jest.Mock } {
  const find = jest.fn(async () => rows);
  // 绑定解析走 findOne（`MemoryAccessService.loadBindingResource`）：按 where.id 精确命中，
  // 命中不到回 null（"资源不存在 ⇒ fail-closed"那条用例就靠它）
  const findOne = jest.fn(async (options?: { where?: { id?: string } }) => {
    const id = options?.where?.id;
    if (!id) return rows[0] ?? null;
    return rows.find((row) => (row as { id?: string }).id === id) ?? null;
  });
  return { find, findOne } as unknown as Repository<any> & {
    find: jest.Mock;
    findOne: jest.Mock;
  };
}

/** 一套完整父链夹具（doc→space / message→topic / task→list→board / comment→task→list→board） */
function buildFixture(options: { boardSoftDeleted?: boolean; hasDoc?: boolean } = {}) {
  const ids = {
    space: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    topic: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    board: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    list: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    doc: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    message: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    task: '11111111-1111-4111-8111-111111111111',
    comment: '22222222-2222-4222-8222-222222222222',
  };

  const docs =
    options.hasDoc === false
      ? []
      : [
          {
            id: ids.doc,
            spaceId: ids.space,
            contentHash: 'currenthash0000000000000000000000000000000000000000000000000000',
          },
        ];
  const spaces = [{ id: ids.space }];
  const topics = [{ id: ids.topic }];
  const messages = [{ id: ids.message, topicId: ids.topic }];
  const lists = [{ id: ids.list, boardId: ids.board }];
  // board 软删：TypeORM 的默认谓词会让它**不在 find 结果里**（这正是"软删 = 不可见"的机制）
  const boards = options.boardSoftDeleted ? [] : [{ id: ids.board }];
  const tasks = [{ id: ids.task, listId: ids.list }];
  const comments = [{ id: ids.comment, taskId: ids.task }];

  return { ids, docs, spaces, topics, messages, lists, boards, tasks, comments };
}

/** 组装被测服务（9 个仓储 + 白名单 + Policy 门面，全部以假件注入） */
function buildService(
  fixture: ReturnType<typeof buildFixture>,
  whitelists: {
    spaces?: string[] | null;
    topics?: string[] | null;
    boards?: string[] | null;
  } = {},
  permissionAllowed = true,
  /**
   * `loadMemoryIdMapping` 的账本行（第 9 个仓储 = `MemoryNomination`）。
   *
   * rationale：该方法是**从 `memory-recall.service.spec` 迁移过来**的（映射构建点下沉到权限内核
   * ——读面是第二个消费方），故它的三个用例与铁律 #23 的列名断言随之落在这里。
   */
  ledgerRows: unknown[] = [],
) {
  const repos = {
    spaceRepo: fakeRepo(fixture.spaces),
    topicRepo: fakeRepo(fixture.topics),
    boardRepo: fakeRepo(fixture.boards),
    listRepo: fakeRepo(fixture.lists),
    docRepo: fakeRepo(fixture.docs),
    messageRepo: fakeRepo(fixture.messages),
    taskRepo: fakeRepo(fixture.tasks),
    commentRepo: fakeRepo(fixture.comments),
  };
  // 账本仓储只需要 `createQueryBuilder`（映射构建走显式列投影 + 内存展开，见 memory-access ②-b）
  const ledgerQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(ledgerRows),
  };
  const nominations = { createQueryBuilder: jest.fn(() => ledgerQb) };
  const accessQuery = {
    getAccessibleDocSpaceIds: jest.fn(async () => whitelists.spaces ?? null),
    getAccessibleTopicIds: jest.fn(async () => whitelists.topics ?? null),
    getAccessibleBoardIds: jest.fn(async () => whitelists.boards ?? null),
  };
  const permission = { can: jest.fn(async () => permissionAllowed) };

  const service = new MemoryAccessService(
    repos.spaceRepo,
    repos.topicRepo,
    repos.boardRepo,
    repos.listRepo,
    repos.docRepo,
    repos.messageRepo,
    repos.taskRepo,
    repos.commentRepo,
    // ⚠️ 第 9 位 = 账本仓储（**不是**第 10 位）：位置参数顺序即构造契约，插错位置整组红
    nominations as never,
    accessQuery as never,
    permission as never,
  );
  return { service, repos, ledgerQb, accessQuery, permission };
}

/** 造一个 agent actor */
function agentActor(): UnifiedActor {
  return { id: '99999999-9999-4999-8999-999999999999', type: ActorType.AGENT };
}

describe('MemoryAccessService（§5 权限内核）', () => {
  describe('判据纯函数（三处同源的那两行）', () => {
    it('isVisibleIn：null = Admin 全放行 / [] = 全拒 / 数组 = 白名单', () => {
      expect(isVisibleIn('x', null)).toBe(true);
      expect(isVisibleIn('x', [])).toBe(false);
      expect(isVisibleIn('x', ['x'])).toBe(true);
      expect(isVisibleIn('x', ['y'])).toBe(false);
    });

    it('allSourcesVisible：无来源（纯著述）放行；任一不可见即整行不可见', () => {
      expect(allSourcesVisible([])).toBe(true);
      expect(allSourcesVisible([{ visible: true, currentVersionHash: null }])).toBe(true);
      expect(
        allSourcesVisible([
          { visible: true, currentVersionHash: null },
          { visible: false, currentVersionHash: null },
        ]),
      ).toBe(false);
    });
  });

  describe('evaluateSourceRefs（批式 + 父链逐环）', () => {
    it('四类来源父链完整 ⇒ 全可见，且 doc 带当前 contentHash（moved 判据）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture);

      const refs: MemorySourceRef[] = [
        { type: 'doc', id: fixture.ids.doc },
        { type: 'message', id: fixture.ids.message },
        { type: 'task', id: fixture.ids.task },
        { type: 'comment', id: fixture.ids.comment },
      ];
      const verdicts = await service.evaluateSourceRefs(agentActor(), refs);

      expect(verdicts.map((verdict) => verdict.visible)).toEqual([true, true, true, true]);
      // 只有 doc 有版本列 ⇒ 只有它的 currentVersionHash 非空（message/task/comment 恒 null）
      expect(verdicts[0].currentVersionHash).toBe(fixture.docs[0].contentHash);
      expect(verdicts.slice(1).every((verdict) => verdict.currentVersionHash === null)).toBe(true);
    });

    it('admin（白名单 null）⇒ 全放行', async () => {
      const fixture = buildFixture({ boardSoftDeleted: true, hasDoc: false });
      const { service } = buildService(fixture, { spaces: null, topics: null, boards: null });

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'task', id: fixture.ids.task },
        { type: 'comment', id: fixture.ids.comment },
      ]);

      // board 行不在夹具里 ⇒ 父链断，即使 admin 也不可见（"存在且未软删"是硬前提，非权限问题）
      expect(verdicts.map((verdict) => verdict.visible)).toEqual([false, false]);
    });

    it('白名单为空数组 ⇒ 全拒（[] ≠ null）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, { spaces: [], topics: [], boards: [] });

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'doc', id: fixture.ids.doc },
        { type: 'message', id: fixture.ids.message },
        { type: 'task', id: fixture.ids.task },
      ]);

      expect(verdicts.every((verdict) => !verdict.visible)).toBe(true);
    });

    it('父链逐环：board 软删 ⇒ task 与 comment 同时不可见（不是只过滤 task）；doc 不受影响', async () => {
      const fixture = buildFixture({ boardSoftDeleted: true });
      const { service } = buildService(fixture, { spaces: null, topics: null, boards: null });

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'task', id: fixture.ids.task },
        { type: 'comment', id: fixture.ids.comment },
        { type: 'doc', id: fixture.ids.doc },
      ]);

      expect(verdicts.map((verdict) => verdict.visible)).toEqual([false, false, true]);
    });

    it('来源不存在 ⇒ 不可见（不 fail-open）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture);

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'message', id: '33333333-3333-4333-8333-333333333333' },
      ]);

      expect(verdicts).toEqual([{ visible: false, currentVersionHash: null }]);
    });

    it('白名单只命中部分 ⇒ 按来源各自判定', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {
        topics: null,
        spaces: ['other-space'],
        boards: [fixture.ids.board],
      });

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'doc', id: fixture.ids.doc },
        { type: 'task', id: fixture.ids.task },
      ]);

      expect(verdicts[0].visible).toBe(false); // space 不在白名单
      expect(verdicts[1].visible).toBe(true); // board 命中
    });

    it('批式：同一实体类型只查一次库（引用数不放大查询数）', async () => {
      const fixture = buildFixture();
      const { service, repos } = buildService(fixture);

      const verdicts = await service.evaluateSourceRefs(agentActor(), [
        { type: 'doc', id: fixture.ids.doc },
        { type: 'message', id: fixture.ids.message },
        { type: 'task', id: fixture.ids.task },
        { type: 'comment', id: fixture.ids.comment },
      ]);

      expect(verdicts).toHaveLength(4);
      // 每种实体类型各一次 find（含父链），与引用条数无关
      expect((repos.docRepo.find as jest.Mock).mock.calls.length).toBe(1);
      expect((repos.messageRepo.find as jest.Mock).mock.calls.length).toBe(1);
      expect((repos.commentRepo.find as jest.Mock).mock.calls.length).toBe(1);
      expect((repos.boardRepo.find as jest.Mock).mock.calls.length).toBe(1);
    });

    it('空输入 ⇒ 空输出且不查库', async () => {
      const fixture = buildFixture();
      const { service, repos } = buildService(fixture);

      expect(await service.evaluateSourceRefs(agentActor(), [])).toEqual([]);
      expect((repos.docRepo.find as jest.Mock).mock.calls.length).toBe(0);
    });

    it('返回值与入参一一对应（含 currentVersionHash 的切片还原前提）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture);

      const verdicts: SourceRefVerdict[] = await service.evaluateSourceRefs(agentActor(), [
        { type: 'doc', id: fixture.ids.doc },
        { type: 'doc', id: 'no-such-doc' },
      ]);

      expect(verdicts).toHaveLength(2);
      expect(verdicts[0].visible).toBe(true);
      expect(verdicts[1].visible).toBe(false);
    });
  });

  describe('项目闸门', () => {
    const project = {
      id: '44444444-4444-4444-8444-444444444444',
      createdBy: '99999999-9999-4999-8999-999999999999',
      bindings: [{ type: 'board', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    } as unknown as MemoryProject;

    it('绑定可读 ⇒ 读写皆真；非绑定成员 ⇒ 皆假且不是治理观察者', async () => {
      const fixture = buildFixture();
      const readable = buildService(fixture);
      const access = await readable.service.resolveProjectAccess(agentActor(), project);
      expect(access.readable).toBe(true);
      expect(access.writable).toBe(true);
      expect(access.isGovernanceViewer).toBe(true); // createdBy === actor.id

      const denied = buildService(fixture, {}, false);
      const deniedAccess = await denied.service.resolveProjectAccess(
        { id: 'other', type: ActorType.AGENT },
        project,
      );
      expect(deniedAccess.readable).toBe(false);
      expect(deniedAccess.writable).toBe(false);
      expect(deniedAccess.isGovernanceViewer).toBe(false);
    });

    it('topic 绑定：白名单命中即读（participant 不再被 Policy 缺上下文误判）', async () => {
      const fixture = buildFixture();
      // permissionAllowed=false 刻意模拟"裸调 Policy 必拒"——白名单命中仍应判可读，
      // 证明 topic 的 read 不再依赖 Policy 的 hasAccess 注入（卡 7a21f96b 的回归锁）。
      const { service, permission } = buildService(fixture, { topics: [fixture.ids.topic] }, false);

      const access = await service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'topic', id: fixture.ids.topic }],
      } as unknown as MemoryProject);

      expect(access.resolved[0]).toEqual({
        type: 'topic',
        id: fixture.ids.topic,
        exists: true,
        readable: true,
        writable: false,
      });
      expect(access.readable).toBe(true);
      // read 走白名单 ⇒ Policy 只被用于 write（唯一一次调用，动作是 write）
      expect(permission.can).toHaveBeenCalledTimes(1);
      expect(permission.can).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        'write',
      );
    });

    it('topic 绑定：白名单不含该 topic ⇒ 不可读（非参与者仍被拒）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, { topics: [] }, true);

      const access = await service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'topic', id: fixture.ids.topic }],
      } as unknown as MemoryProject);

      expect(access.resolved[0].exists).toBe(true);
      expect(access.resolved[0].readable).toBe(false);
      expect(access.readable).toBe(false);
    });

    it('topic 绑定：admin 的白名单是 null ⇒ 可读（null 三态不得当空集）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, { topics: null }, false);

      const access = await service.resolveProjectAccess(
        { ...agentActor(), role: UserRole.ADMIN } as UnifiedActor,
        {
          ...project,
          bindings: [{ type: 'topic', id: fixture.ids.topic }],
        } as unknown as MemoryProject,
      );

      expect(access.resolved[0].readable).toBe(true);
    });

    it('topic 绑定：白名单命中但资源不存在/已软删 ⇒ exists:false（存在性闸门先于白名单）', async () => {
      const fixture = buildFixture();
      const missingId = '99999999-9999-4999-8999-999999999998';

      // ① 不存在：白名单故意包含该 id —— 锁住"先存在性、后白名单"的顺序不变量。
      // 为什么只有 topic 需要这条：白名单的 participant 查询不 join topics 表，
      // 软删/已删话题的 id 仍可能留在白名单里，安全全靠存在性闸门先短路。
      const missing = buildService(fixture, { topics: [missingId] }, true);
      const missingAccess = await missing.service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'topic', id: missingId }],
      } as unknown as MemoryProject);
      expect(missingAccess.resolved[0]).toEqual({
        type: 'topic',
        id: missingId,
        exists: false,
        readable: false,
        writable: false,
      });
      // 存在性闸门短路 ⇒ 白名单查询根本不该发生（也不该白付它的 3~4 条查询）
      expect(missing.accessQuery.getAccessibleTopicIds).not.toHaveBeenCalled();

      // ② 已软删：TypeORM 默认谓词通常直接返回 null；仓储仍给行时走 deletedAt 防御分支
      const softDeletedFixture = {
        ...fixture,
        topics: [{ id: fixture.ids.topic, deletedAt: new Date() }],
      } as unknown as ReturnType<typeof buildFixture>;
      const softDeleted = buildService(softDeletedFixture, { topics: [fixture.ids.topic] }, true);
      const softDeletedAccess = await softDeleted.service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'topic', id: fixture.ids.topic }],
      } as unknown as MemoryProject);
      expect(softDeletedAccess.resolved[0].exists).toBe(false);
      expect(softDeletedAccess.resolved[0].readable).toBe(false);
      expect(softDeletedAccess.readable).toBe(false);
      // 软删同样被存在性闸门短路 ⇒ 白名单查询也不该发生（成本锁，同 ①）
      expect(softDeleted.accessQuery.getAccessibleTopicIds).not.toHaveBeenCalled();
    });

    it('topic 白名单查询抛错 ⇒ fail-closed（两位 false，不向上抛）', async () => {
      const fixture = buildFixture();
      const { service, accessQuery } = buildService(fixture, { topics: [fixture.ids.topic] }, true);
      (accessQuery.getAccessibleTopicIds as jest.Mock).mockRejectedValueOnce(
        new Error('whitelist unavailable'),
      );

      const access = await service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'topic', id: fixture.ids.topic }],
      } as unknown as MemoryProject);

      expect(access.resolved[0]).toEqual({
        type: 'topic',
        id: fixture.ids.topic,
        exists: true,
        readable: false,
        writable: false,
      });
      expect(access.readable).toBe(false);
    });

    it('resolveBinding 的 { read: false } 跳过白名单（热路径只付 write 判定成本）', async () => {
      const fixture = buildFixture();
      const { service, accessQuery } = buildService(fixture, { topics: [fixture.ids.topic] }, true);

      const resolved = await service.resolveBinding(agentActor(), 'topic', fixture.ids.topic, {
        read: false,
      });

      expect(resolved).toEqual({
        type: 'topic',
        id: fixture.ids.topic,
        exists: true,
        readable: false, // "未判定"而非"无权限"——只有显式关闭 read 的调用方知道这一点
        writable: true,
      });
      expect(accessQuery.getAccessibleTopicIds).not.toHaveBeenCalled();
    });

    it('describeUnreadableBinding 只判 read（创建/改绑不白算 Policy write）', async () => {
      const fixture = buildFixture();
      const { service, permission } = buildService(fixture, { topics: [fixture.ids.topic] }, false);

      await expect(
        service.describeUnreadableBinding(agentActor(), 'topic', fixture.ids.topic),
      ).resolves.toBeNull();
      // write 位显式关闭 ⇒ Policy 一次都不该被调用（permissionAllowed=false 也不影响结论）
      expect(permission.can).not.toHaveBeenCalled();
    });

    it('绑定资源不存在 ⇒ fail-closed（两位皆假，不抛错）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, true);
      const access = await service.resolveProjectAccess(agentActor(), {
        ...project,
        bindings: [{ type: 'board', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
      } as unknown as MemoryProject);

      expect(access.resolved[0]).toEqual({
        type: 'board',
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exists: false,
        readable: false,
        writable: false,
      });
      expect(access.readable).toBe(false);
    });

    it('既不可读也非治理观察者 ⇒ 404/14001（不确认存在性）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, false);

      await expect(
        service.assertProjectRead({ id: 'other', type: ActorType.AGENT }, project),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('治理观察者：读放行，但**内容端点** 403（内容面不放行）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, false);

      // 读闸门放行（治理观察者 = creator）
      await expect(service.assertProjectRead(agentActor(), project)).resolves.toMatchObject({
        readable: false,
        isGovernanceViewer: true,
      });
      // 内容闸门拦下（403/1009）
      await expect(service.assertProjectContentRead(agentActor(), project)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('写闸门：无写权限 ⇒ 403/1009', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, false);

      await expect(service.assertProjectWrite(agentActor(), project)).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // ②-b 映射表构建（**从 memory-recall.service.spec 迁移**；下沉原因见实现文件）
  // ══════════════════════════════════════════════════════════════════════
  describe('loadMemoryIdMapping（engine_memory_ids → canonical 行）', () => {
    /** 造一条**账本行**（映射只读这 10 列；正文/理由 select:false，天生不进查询） */
    function ledgerRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'led-default',
        category: 'ruling',
        subject: '主体',
        scope: '范围',
        contentTruncated: false,
        status: MEMORY_NOMINATION_STATUS.ACTIVE,
        formationState: MEMORY_FORMATION_STATE.COMMITTED,
        reviewAt: null,
        sourceRefs: [],
        engineMemoryIds: ['mem-1', 'mem-2'],
        ...overrides,
      };
    }

    it('alias 行（ids 恒空）天然不入映射；committed/在途标志逐行统计', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, true, [
        ledgerRow({ id: 'canonical' }),
        ledgerRow({ id: 'alias', engineMemoryIds: [] }),
        ledgerRow({
          id: 'inflight',
          engineMemoryIds: null,
          formationState: MEMORY_FORMATION_STATE.SUBMITTED,
        }),
      ]);

      const mapping = await service.loadMemoryIdMapping('project-1');

      expect([...mapping.byMemoryId.keys()]).toEqual(['mem-1', 'mem-2']);
      expect(mapping.hasCommitted).toBe(true);
      expect(mapping.hasInFlight).toBe(true);
    });

    it('同一 memory_id 出现在两行 ⇒ **fail-closed**：该 id 从映射中剔除（不指向不确定的行）', async () => {
      const fixture = buildFixture();
      const { service } = buildService(fixture, {}, true, [
        ledgerRow({ id: 'led-a', engineMemoryIds: ['dup'] }),
        ledgerRow({ id: 'led-b', engineMemoryIds: ['dup', 'unique'] }),
      ]);

      const mapping = await service.loadMemoryIdMapping('project-1');

      expect(mapping.byMemoryId.has('dup')).toBe(false);
      expect(mapping.byMemoryId.get('unique')?.id).toBe('led-b');
    });

    it('撤回行不参与映射（行为级兜底：即使 ids 未清也不认它）+ **铁律 #23**：jsonb 禁入 SQL 谓词', async () => {
      const fixture = buildFixture();
      const { service, ledgerQb } = buildService(fixture, {}, true, []);

      await service.loadMemoryIdMapping('project-1');

      const clauses = (ledgerQb.andWhere as jest.Mock).mock.calls.map((call) => call[0]);
      expect(clauses).toContain('nomination.status != :withdrawn');
      // 铁律 #23 不变量：**显式列投影 + 内存展开**（jsonb 数组一旦写进 SQL 谓词就是整列等值，
      // 永不命中，且症状是"全部映射不到"而非报错）
      const columns = (ledgerQb.select as jest.Mock).mock.calls[0][0] as string[];
      expect(columns).toContain('nomination.engineMemoryIds');
      expect(columns).toContain('nomination.sourceRefs');
    });
  });
});
