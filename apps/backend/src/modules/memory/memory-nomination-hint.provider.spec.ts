/**
 * MemoryNominationHintProvider 单测（mock 仓储）
 *
 * 覆盖（阶段三通用化后的设计矩阵）：
 * - **通用模式（缺省）**：绑定 + 权限成立即产出——**不读正文**（成本断言：内容仓储零调用）；
 * - **词表精调层两模式**（决策 2）：`preset`（内建词表）与 `custom`（env 逗号分隔）都要扫词，
 *   未命中 / 词表为空正文 → 空候选；`resolveNominationKeywordMode` 纯函数三态边界；
 * - **权限过滤 + fail-closed**（决策 7/8）：`ctx` 缺失 / `actor=null` ⇒ 无候选（匿名）；
 *   `resolveBinding().writable=false` ⇒ 无候选且落 `reason=permission_filtered` 埋点；
 * - 四类事实全分支（状态变更 / 评论 / 话题消息 / doc upsert），含身份链断环；
 * - 绑定侧：未绑定 → 空候选；多项目命中 → projectIds 齐（按 N 处理）；
 * - 同响应多事实**同资源** → 去重成单候选（projectIds 取并集）；不同资源 → 两条；
 * - 仓抛错 → 不抛（per-fact fail-open，其余事实照常）；
 * - 绑定反查谓词 = active + 未软删 + containment 两态（**谓词文本**守卫）；
 * - 委托：`resolveMessage` === `MEMORY_NOMINATION_HINT_MESSAGE`、`familyOf` === 'memory'、
 *   `ttlOf` 委托注册表 === **10min**（阶段三决策 1）。
 *
 * ⚠️ **mock 测不出 ORM 生成的 SQL**（铁律 #23）：本文件只钉「分支决策」，
 * 「containment 谓词真的能在真 PG 上命中绑定 / 权限过滤」由
 * `test/memory-nomination-hint.e2e-spec.ts` 覆盖（真 PG）。
 */
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { HintRegistry } from '../hints/hint-registry';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Message } from '../../database/entities/message.entity';
import { MemoryAccessService } from './memory-access.service';
import {
  MEMORY_NOMINATION_HINT_CODE,
  MEMORY_NOMINATION_HINT_MESSAGE,
  MEMORY_RULING_KEYWORDS,
} from './memory.constants';
import {
  MEMORY_NOMINATION_HINT_KEYWORDS_ENV,
  MemoryNominationHintProvider,
  resolveNominationKeywordMode,
} from './memory-nomination-hint.provider';
import type { HintFact } from '../hints/hint-facts';
import type { HintProviderContext } from '../hints/hint.interceptor';
import type { UnifiedActor } from '../../common/types/actor.types';

/** 命中项目 id 的固定夹具 */
const PROJECT_ID = 'prj-1';
const PROJECT_ID_2 = 'prj-2';

/** 请求身份夹具（写权限判定需要它；actor=null = 匿名） */
const ACTOR = {
  id: 'agent-1',
  type: 'agent',
  name: '测试 agent',
} as unknown as UnifiedActor;
const CTX: HintProviderContext = { actor: ACTOR };

/** 假 QueryBuilder（记录谓词与排序，供"绑定反查谓词/确定序"用例断言） */
function makeBindingQb() {
  const calls: Array<{ method: 'where' | 'andWhere'; sql: string; params?: unknown }> = [];
  /** `orderBy` 的实参对（P2-4：确定序是 `data.projectIds` 契约的一部分） */
  const orderByCalls: Array<[string, string]> = [];
  // 四个链式方法都返回同一个 qb（TypeORM 的链式形态）；先声明再挂实现，
  // 避免"对象字面量自引用"触发的 TS7022（implicitly any）
  const qb = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getMany: jest.fn(),
  };
  qb.select.mockReturnValue(qb);
  qb.where.mockImplementation((sql: string, params?: unknown) => {
    calls.push({ method: 'where', sql, params });
    return qb;
  });
  qb.andWhere.mockImplementation((sql: string, params?: unknown) => {
    calls.push({ method: 'andWhere', sql, params });
    return qb;
  });
  qb.orderBy.mockImplementation((sql: string, order: string) => {
    orderByCalls.push([sql, order]);
    return qb;
  });
  return { qb, calls, orderByCalls };
}

interface Harness {
  provider: MemoryNominationHintProvider;
  /** 绑定反查结果（getMany 返回的行） */
  projectRows: Array<{ id: string }>;
  /** 让绑定查询按**调用序**返回不同项目集（"两条事实命中不同 project 集"的并集用例） */
  projectRowsByCall: (sets: Array<Array<{ id: string }>>) => void;
  /** 本次 build 内**绑定查询的实际次数**（成本纪律断言：记忆化后同绑定只打一次） */
  projectQueryCount: () => number;
  calls: Array<{ method: 'where' | 'andWhere'; sql: string; params?: unknown }>;
  /** `orderBy` 实参（`[['project.id','ASC']]` = 确定序已声明） */
  orderByCalls: Array<[string, string]>;
  tasks: { findOne: jest.Mock };
  comments: { findOne: jest.Mock };
  lists: { findOne: jest.Mock };
  messages: { findOne: jest.Mock };
  /** 权限判定（`resolveBinding`）：默认 writable=true；`permissionCalls` 断记忆化 */
  access: { resolveBinding: jest.Mock };
}

/** 组装 provider（默认：绑定命中 PROJECT_ID、写权限成立、各内容查找未配置） */
function buildHarness(
  over: { projectRows?: Array<{ id: string }>; writable?: boolean } = {},
): Harness {
  const { qb, calls, orderByCalls } = makeBindingQb();
  qb.getMany.mockResolvedValue(over.projectRows ?? [{ id: PROJECT_ID }]);

  const projects = {
    createQueryBuilder: jest.fn(() => qb),
  } as unknown as Repository<MemoryProject>;
  const tasks = { findOne: jest.fn().mockResolvedValue(null) };
  const comments = { findOne: jest.fn().mockResolvedValue(null) };
  const lists = { findOne: jest.fn().mockResolvedValue(null) };
  const messages = { findOne: jest.fn().mockResolvedValue(null) };
  const access = {
    resolveBinding: jest.fn(async (actor: unknown, type: string, id: string) => ({
      type,
      id,
      exists: true,
      readable: true,
      writable: over.writable ?? actor !== null,
    })),
  };

  const provider = new MemoryNominationHintProvider(
    projects,
    tasks as unknown as Repository<Task>,
    comments as unknown as Repository<TaskComment>,
    lists as unknown as Repository<BoardList>,
    messages as unknown as Repository<Message>,
    new HintRegistry(),
    access as unknown as MemoryAccessService,
  );
  return {
    provider,
    projectRows: over.projectRows ?? [{ id: PROJECT_ID }],
    projectRowsByCall: (sets) => {
      qb.getMany.mockReset();
      for (const set of sets) qb.getMany.mockResolvedValueOnce(set);
      // 超出预设序列 ⇒ 空集（fail-open：让"多打了一次库"表现为候选为空，而不是 undefined 崩）
      qb.getMany.mockResolvedValue([]);
    },
    projectQueryCount: () => qb.getMany.mock.calls.length,
    calls,
    orderByCalls,
    tasks,
    comments,
    lists,
    messages,
    access,
  };
}

/** `task.status_changed` 事实（默认带 boardId） */
function statusFact(over: Record<string, unknown> = {}): HintFact {
  return {
    name: 'task.status_changed',
    payload: {
      taskId: 'task-1',
      boardId: 'board-1',
      fromStatus: 'in_progress',
      toStatus: 'done',
      ...over,
    },
  };
}

/** 评论事实 */
function commentFact(over: Record<string, unknown> = {}): HintFact {
  return { name: 'task.comment_added', payload: { taskId: 'task-1', commentId: 'c-1', ...over } };
}

/** 话题消息事实 */
function messageFact(over: Record<string, unknown> = {}): HintFact {
  return { name: 'topic.message_sent', payload: { topicId: 'topic-1', messageId: 'm-1', ...over } };
}

/** doc upsert 事实（阶段三新增的第四个写口） */
function docFact(over: Record<string, unknown> = {}): HintFact {
  return { name: 'doc.upserted', payload: { docId: 'doc-1', spaceId: 'space-1', ...over } };
}

describe('resolveNominationKeywordMode（词表精调层纯函数，决策 2）', () => {
  it('缺省 / 空串 / 全空白 ⇒ generic（**不读正文**的通用模式）', () => {
    expect(resolveNominationKeywordMode(undefined)).toEqual({ mode: 'generic' });
    expect(resolveNominationKeywordMode('')).toEqual({ mode: 'generic' });
    expect(resolveNominationKeywordMode('   ')).toEqual({ mode: 'generic' });
  });

  it('`preset`（大小写不敏感）⇒ 内建词表', () => {
    expect(resolveNominationKeywordMode('preset')).toEqual({
      mode: 'preset',
      keywords: MEMORY_RULING_KEYWORDS,
    });
    expect(resolveNominationKeywordMode(' PREset ')).toEqual({
      mode: 'preset',
      keywords: MEMORY_RULING_KEYWORDS,
    });
  });

  it('自定义词表 ⇒ 按逗号切分 + trim + 去空（**空词表回落 generic**，不静默关停）', () => {
    expect(resolveNominationKeywordMode(' alpha , beta ')).toEqual({
      mode: 'custom',
      keywords: ['alpha', 'beta'],
    });
    // 全是逗号 / 空白 token ⇒ 无有效词 ⇒ generic（fail-open 到通用模式）
    expect(resolveNominationKeywordMode(' , , ')).toEqual({ mode: 'generic' });
  });
});

describe('MemoryNominationHintProvider', () => {
  const originalEnv = process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV];
    else process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV] = originalEnv;
  });

  describe('通用模式（缺省：绑定 + 权限即触发，不读正文）', () => {
    it('task.status_changed（带 boardId）→ 候选，且**内容仓储零调用**', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build([statusFact()], null, CTX);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        code: MEMORY_NOMINATION_HINT_CODE,
        status: 'suggestion',
        resourceKey: 'task-1',
        data: {
          projectIds: [PROJECT_ID],
          source: { type: 'task', id: 'task-1' },
          suggestedTool: 'memory_controller_list_nominations',
          suggestedParams: { id: PROJECT_ID, page: 1, pageSize: 10 },
        },
      });
      // 通用模式的成本下降点：正文读取整段消失
      expect(h.tasks.findOne).not.toHaveBeenCalled();
      expect(h.comments.findOne).not.toHaveBeenCalled();
      expect(h.messages.findOne).not.toHaveBeenCalled();
    });

    it('task.comment_added → 候选（身份链仍走 task→list 取 boardId，但不读评论正文）', async () => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      h.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' });

      const candidates = await h.provider.build([commentFact()], null, CTX);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('task-1');
      // 评论事实的 source.type 同为 task（id = taskId，不是 commentId）
      expect(candidates[0].data).toEqual({
        projectIds: [PROJECT_ID],
        source: { type: 'task', id: 'task-1' },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: PROJECT_ID, page: 1, pageSize: 10 },
      });
      expect(h.comments.findOne).not.toHaveBeenCalled();
    });

    it('topic.message_sent → 候选（topic 直接是绑定类型，零额外查询）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build([messageFact()], null, CTX);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('topic-1');
      expect(candidates[0].data).toEqual({
        projectIds: [PROJECT_ID],
        source: { type: 'topic', id: 'topic-1' },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: PROJECT_ID, page: 1, pageSize: 10 },
      });
      expect(h.calls[2]).toMatchObject({
        sql: 'project.bindings @> :binding::jsonb',
        params: { binding: JSON.stringify([{ type: 'topic', id: 'topic-1' }]) },
      });
      expect(h.messages.findOne).not.toHaveBeenCalled();
    });

    it('doc.upserted → 候选（needle=docSpace 逐字，**零实体查询**）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build([docFact()], null, CTX);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('doc-1');
      expect(candidates[0].data).toEqual({
        projectIds: [PROJECT_ID],
        source: { type: 'doc', id: 'doc-1' },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: PROJECT_ID, page: 1, pageSize: 10 },
      });
      expect(h.calls[2]).toMatchObject({
        sql: 'project.bindings @> :binding::jsonb',
        params: { binding: JSON.stringify([{ type: 'docSpace', id: 'space-1' }]) },
      });
      // 零实体查询：四个仓储一个都没碰
      expect(h.tasks.findOne).not.toHaveBeenCalled();
      expect(h.comments.findOne).not.toHaveBeenCalled();
      expect(h.lists.findOne).not.toHaveBeenCalled();
      expect(h.messages.findOne).not.toHaveBeenCalled();
    });

    it('doc.upserted 缺 docId / spaceId → 空候选（不查绑定）', async () => {
      const missingSpace = buildHarness();
      expect(
        await missingSpace.provider.build([docFact({ spaceId: undefined })], null, CTX),
      ).toEqual([]);
      expect(missingSpace.projectQueryCount()).toBe(0);

      const missingDoc = buildHarness();
      expect(await missingDoc.provider.build([docFact({ docId: undefined })], null, CTX)).toEqual(
        [],
      );
      expect(missingDoc.projectQueryCount()).toBe(0);
    });

    it('boardId 缺失（状态变更）→ 不查绑定也不放弃判据之外的东西（放弃，不猜）', async () => {
      const h = buildHarness();

      expect(await h.provider.build([statusFact({ boardId: undefined })], null, CTX)).toEqual([]);
      expect(h.projectQueryCount()).toBe(0);
    });

    it('未绑定（活跃项目 0 命中）→ 空候选，且**不做权限判定**（绑定是更便宜的前置闸门）', async () => {
      const h = buildHarness({ projectRows: [] });

      expect(await h.provider.build([statusFact()], null, CTX)).toEqual([]);
      expect(h.access.resolveBinding).not.toHaveBeenCalled();
    });

    it('多项目命中 → projectIds 齐（按 N 处理）', async () => {
      const h = buildHarness({ projectRows: [{ id: PROJECT_ID }, { id: PROJECT_ID_2 }] });

      const candidates = await h.provider.build([statusFact()], null, CTX);

      expect(candidates[0].data).toEqual({
        projectIds: [PROJECT_ID, PROJECT_ID_2],
        source: { type: 'task', id: 'task-1' },
        suggestedTool: 'memory_controller_list_nominations',
        // 多项目时 suggestedParams.id 取**首元素**（可执行示例，见 provider 注释的取舍）
        suggestedParams: { id: PROJECT_ID, page: 1, pageSize: 10 },
      });
    });

    it('绑定反查谓词 = active + deleted_at IS NULL + containment（**谓词文本**在此守卫）', async () => {
      const h = buildHarness();

      await h.provider.build([statusFact()], null, CTX);

      // ⚠️ 这三个谓词**只在这里**做文本守卫，它们**过滤掉的**行（归档项目 / 软删项目 / 未绑定）
      // 只有真 PG 能证伪 ⇒ 行为面由 test/memory-nomination-hint.e2e-spec.ts 覆盖
      expect(h.calls).toEqual([
        { method: 'where', sql: 'project.status = :status', params: { status: 'active' } },
        { method: 'andWhere', sql: 'project.deleted_at IS NULL', params: undefined },
        {
          method: 'andWhere',
          sql: 'project.bindings @> :binding::jsonb',
          params: { binding: JSON.stringify([{ type: 'board', id: 'board-1' }]) },
        },
      ]);
      // P2-4：确定序是 `data.projectIds` 契约的一部分
      expect(h.orderByCalls).toEqual([['project.id', 'ASC']]);
    });
  });

  describe('权限过滤 + fail-closed（决策 7/8）', () => {
    it('缺 ctx（只传两参）⇒ 视为匿名 ⇒ 无候选（fail-closed，正确性修正不可被绕过）', async () => {
      const h = buildHarness();

      expect(await h.provider.build([statusFact()], null)).toEqual([]);
      // 绑定照查（绑定是更便宜的前置闸门，先于权限）；但匿名**不做权限判定**（直接 false）
      expect(h.projectQueryCount()).toBe(1);
      expect(h.access.resolveBinding).not.toHaveBeenCalled();
    });

    it('ctx.actor = null ⇒ 无候选（不查库做权限判定）', async () => {
      const h = buildHarness();

      expect(await h.provider.build([statusFact()], null, { actor: null })).toEqual([]);
      expect(h.access.resolveBinding).not.toHaveBeenCalled();
    });

    it('resolveBinding().writable = false ⇒ 无候选，且落 reason=permission_filtered 埋点', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const h = buildHarness({ writable: false });

        expect(await h.provider.build([statusFact()], null, CTX)).toEqual([]);

        const lines = debugSpy.mock.calls
          .map((call) => call[0] as string)
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          tag: 'DOC_HINT_SUPPRESSED',
          code: MEMORY_NOMINATION_HINT_CODE,
          reason: 'permission_filtered',
          surface: 'memory_nomination',
          actorId: 'agent-1',
          resourceKey: 'task-1',
        });
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('权限判定**按资源记忆化**：同资源多条事实只判一次（同绑定的圆桌多消息形态）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build(
        [messageFact(), messageFact({ messageId: 'm-2' })],
        null,
        CTX,
      );

      expect(candidates).toHaveLength(1);
      expect(h.access.resolveBinding).toHaveBeenCalledTimes(1);
      // S1 回归锁：热路径只消费 writable ⇒ 必须显式关闭 read（topic 白名单是 3~4 条查询）
      expect(h.access.resolveBinding).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { read: false },
      );
    });

    it('`permission_filtered` 埋点也**按资源记忆化**（P3-2：同资源多事实只落一行 debug）', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const h = buildHarness({ writable: false });

        // 同 topic 的两条消息（不同 messageId ⇒ 两条独立事实，但同一 resourceKey）
        const candidates = await h.provider.build(
          [messageFact(), messageFact({ messageId: 'm-2' })],
          null,
          CTX,
        );
        expect(candidates).toEqual([]);

        const lines = debugSpy.mock.calls
          .map((call) => call[0] as string)
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.reason === 'permission_filtered');
        // 去重前这里是 2 行（每条事实一行）——观测噪音会把真信号埋掉
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ resourceKey: 'topic-1' });
      } finally {
        debugSpy.mockRestore();
      }
    });
  });

  describe('词表精调层（决策 2：preset / custom 两个模式都要扫词）', () => {
    beforeEach(() => {
      process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV] = 'preset';
    });

    it.each([...MEMORY_RULING_KEYWORDS])('preset：裁决词「%s」命中 → 产出候选', async (keyword) => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue({
        id: 'task-1',
        title: `标题 ${keyword} 后缀`,
        description: null,
      });

      const candidates = await h.provider.build([statusFact()], null, CTX);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('task-1');
    });

    it('preset：title 命中 / description 单命中（拼接扫描不丢段）', async () => {
      const titleHit = buildHarness();
      titleHit.tasks.findOne.mockResolvedValue({ id: 'task-1', title: '拍板了', description: null });
      expect(await titleHit.provider.build([statusFact()], null, CTX)).toHaveLength(1);

      const descHit = buildHarness();
      descHit.tasks.findOne.mockResolvedValue({
        id: 'task-1',
        title: '普通标题',
        description: '这条一律照办',
      });
      expect(await descHit.provider.build([statusFact()], null, CTX)).toHaveLength(1);
    });

    it('preset：未命中 / 空正文 → 空候选（正文读了但不命中）', async () => {
      const noHit = buildHarness();
      noHit.tasks.findOne.mockResolvedValue({
        id: 'task-1',
        title: '普通标题',
        description: '普通描述',
      });
      expect(await noHit.provider.build([statusFact()], null, CTX)).toEqual([]);

      const empty = buildHarness();
      empty.tasks.findOne.mockResolvedValue({ id: 'task-1', title: '', description: null });
      expect(await empty.provider.build([statusFact()], null, CTX)).toEqual([]);
    });

    it('preset：正文回库判空（并发软删）→ 空候选（铁律 #22）', async () => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue(null);

      expect(await h.provider.build([statusFact()], null, CTX)).toEqual([]);
    });

    it('preset：评论面也要扫词（命中 ⇒ 候选 / 未命中 ⇒ 空）', async () => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      h.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' });
      h.comments.findOne.mockResolvedValue({ id: 'c-1', content: '以后一律这样' });
      expect(await h.provider.build([commentFact()], null, CTX)).toHaveLength(1);

      const noHit = buildHarness();
      noHit.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      noHit.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' });
      noHit.comments.findOne.mockResolvedValue({ id: 'c-1', content: '普通评论' });
      expect(await noHit.provider.build([commentFact()], null, CTX)).toEqual([]);
    });

    it('preset：话题消息面扫词（命中 / 未命中）', async () => {
      const hit = buildHarness();
      hit.messages.findOne.mockResolvedValue({ id: 'm-1', content: '禁止这样干' });
      expect(await hit.provider.build([messageFact()], null, CTX)).toHaveLength(1);

      const noHit = buildHarness();
      noHit.messages.findOne.mockResolvedValue({ id: 'm-1', content: '普通消息' });
      expect(await noHit.provider.build([messageFact()], null, CTX)).toEqual([]);
    });

    it('preset：**缺 commentId / messageId ⇒ fail-closed 无候选**（P2-3：不再默默跳过词表闸门）', async () => {
      // 评论面：事实畸形（没有正文实体 id）⇒ 词表判据无从执行 ⇒ 不产出
      const noCommentId = buildHarness();
      noCommentId.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      noCommentId.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' });
      expect(
        await noCommentId.provider.build([commentFact({ commentId: undefined })], null, CTX),
      ).toEqual([]);
      // 连正文仓储都不该被碰（没有 id 可查）
      expect(noCommentId.comments.findOne).not.toHaveBeenCalled();

      // 话题面同理
      const noMessageId = buildHarness();
      expect(
        await noMessageId.provider.build([messageFact({ messageId: undefined })], null, CTX),
      ).toEqual([]);
      expect(noMessageId.messages.findOne).not.toHaveBeenCalled();
    });

    it('custom（自定义词表）：只有该词命中才产出（内建词表此时不生效）', async () => {
      process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV] = 'alpha, beta';
      const h = buildHarness();
      // 内建词「一律」在自定义模式下**不算命中**
      h.tasks.findOne.mockResolvedValue({ id: 'task-1', title: '这条一律照办', description: null });
      expect(await h.provider.build([statusFact()], null, CTX)).toEqual([]);

      const hit = buildHarness();
      hit.tasks.findOne.mockResolvedValue({ id: 'task-1', title: 'alpha 规则', description: null });
      expect(await hit.provider.build([statusFact()], null, CTX)).toHaveLength(1);
    });

    it('doc.upserted 在精调模式下也**不读正文**（该写口无正文判据 ⇒ 只留绑定+权限理由）', async () => {
      const h = buildHarness();

      // 通用 vs preset 对 doc 面结果一致（正文读取器缺省）
      process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV] = 'preset';
      expect(await h.provider.build([docFact()], null, CTX)).toHaveLength(1);
    });
  });

  describe('task.comment_added 身份链（comment → task → list → board）', () => {
    it('父链断环（任务不存在 / 列不存在）→ 空候选，不猜', async () => {
      const noTask = buildHarness();
      noTask.tasks.findOne.mockResolvedValue(null);
      expect(await noTask.provider.build([commentFact()], null, CTX)).toEqual([]);

      const noList = buildHarness();
      noList.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      noList.lists.findOne.mockResolvedValue(null);
      expect(await noList.provider.build([commentFact()], null, CTX)).toEqual([]);
    });
  });

  describe('多事实合并 / 异常 fail-open / 委托', () => {
    it('同响应同资源多事实（**绑定不同 board**）→ 单候选，projectIds = 两集确定序并集', async () => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      h.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-2' });
      h.projectRowsByCall([[{ id: PROJECT_ID_2 }], [{ id: PROJECT_ID }]]);

      const candidates = await h.provider.build(
        [statusFact(), commentFact()],
        null,
        CTX,
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('task-1');
      // 确定序 = 事实顺序（board-1 的集先入）+ **每条查询内 id ASC**：
      // 期望值刻意**不是**字典序，用来证明顺序来自事实序而不是"恰好排好了"
      // source 与 projectIds 并集**共存于同一候选**（多事实合并成一条）
      expect(candidates[0].data).toEqual({
        projectIds: [PROJECT_ID_2, PROJECT_ID],
        source: { type: 'task', id: 'task-1' },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: PROJECT_ID_2, page: 1, pageSize: 10 },
      });
      // 两次不同绑定 ⇒ 两次查询（不是"首个绑定胜出"）
      expect(h.projectQueryCount()).toBe(2);
    });

    it('同绑定的多条事实 → 绑定查询**只打一次**（记忆化；圆桌一次 HTTP 多消息的成本收敛）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build(
        [messageFact(), messageFact({ messageId: 'm-2' })],
        null,
        CTX,
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0].resourceKey).toBe('topic-1');
      // 绑定 containment 顺序扫描是本能力的成本大头：同 topic 的 N 条事实 ⇒ 1 次扫描
      expect(h.projectQueryCount()).toBe(1);
    });

    it('**完全重复**的事实（同事实名 + 同载荷）被折叠 → 只求值一次', async () => {
      const h = buildHarness();
      const duplicate = messageFact();

      const candidates = await h.provider.build(
        [duplicate, { ...duplicate, payload: { ...duplicate.payload } }],
        null,
        CTX,
      );

      expect(candidates).toHaveLength(1);
      expect(h.projectQueryCount()).toBe(1);
      expect(h.access.resolveBinding).toHaveBeenCalledTimes(1);
    });

    it('不同资源 → 两条候选（同响应多资源不去重）', async () => {
      const h = buildHarness();
      h.tasks.findOne.mockResolvedValue({ id: 'task-1', listId: 'list-1' });
      h.lists.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' });

      const candidates = await h.provider.build([statusFact(), messageFact()], null, CTX);

      expect(candidates.map((c) => c.resourceKey).sort()).toEqual(['task-1', 'topic-1']);
    });

    it('仓储抛错 → **不抛**，失败事实跳过、其余事实照常产出', async () => {
      const h = buildHarness();
      // 第一条事实（评论）的身份链抛错
      h.tasks.findOne.mockRejectedValueOnce(new Error('db down'));

      const candidates = await h.provider.build([commentFact(), messageFact()], null, CTX);

      expect(candidates.map((c) => c.resourceKey)).toEqual(['topic-1']);
    });

    it('不关心的事实名 / 载荷畸形 → 空候选（不抛）', async () => {
      const h = buildHarness();

      expect(await h.provider.build([{ name: 'doc.created', payload: { docId: 'd-1' } }], null, CTX)).toEqual([]);
      expect(
        await h.provider.build([{ name: 'task.status_changed', payload: { taskId: 42 } }], null, CTX),
      ).toEqual([]);
      expect(await h.provider.build([{ name: 'task.status_changed' }], null, CTX)).toEqual([]);
    });

    it('委托契约：resolveMessage / familyOf / ttlOf（=== **10min**，经注册表）/ surface / factNames', () => {
      const h = buildHarness();

      expect(h.provider.resolveMessage()).toBe(MEMORY_NOMINATION_HINT_MESSAGE);
      expect(h.provider.familyOf()).toBe('memory');
      expect(h.provider.ttlOf(MEMORY_NOMINATION_HINT_CODE)).toBe(10 * 60 * 1000);
      expect(h.provider.ttlOf('same_key_resend')).toBeUndefined();
      expect(h.provider.surface).toBe('memory_nomination');
      expect([...h.provider.factNames].sort()).toEqual([
        'doc.upserted',
        'task.comment_added',
        'task.status_changed',
        'topic.message_sent',
      ]);
    });
  });
});
