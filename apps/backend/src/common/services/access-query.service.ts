/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/spec.md (权限与角色)
 *
 * [踩坑索引] B-50(列表权限过滤) D5(统一权限重构) B2(成员/权限收敛进关系表) OWNER-PROXY(owner代理白名单) MINE-QUERY(mine-only变体/缓存键隔离)
 *
 * [铁律关联] #4(文档优先) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: SearchService 私有白名单与 Policy 规则分两处维护，导致 Search 白名单
 *          缺少 invited/editor，且其他列表接口存在 Controller 层过滤分页错误。
 *          修复：抽取 AccessQueryService 作为统一白名单基础设施，规则与 Policy
 *          严格同步，并增加请求级缓存避免重复查询。见 Plan §1.1。
 *   B2: Batch 2 将 jsonb @> 查询替换为关系表 join：topic 侧读 topic_participants.status，
 *       board 侧读 board_members；删除 topic 继承子查询。见 plan-batch2-membership.md
 *
 *   OWNER-PROXY: v1.37 human actor 的 creator 白名单 = [actor.id, ...ownedAgentIds]
 *       （creator_id IN 查询，与 Policy read 规则严格同步）；agent actor 不触发（短路）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AsyncLocalStorage } from 'async_hooks';
import { Topic } from '../../database/entities/topic.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from './owner-proxy.service';
import { UserRole, Visibility, ActorType } from '@agent-chamber/shared';

/** AsyncLocalStorage token：请求级白名单缓存 */
export const ACCESS_QUERY_STORE = Symbol('ACCESS_QUERY_STORE');

/** 请求级缓存存储类型 */
export type AccessQueryStore = AsyncLocalStorage<Map<string, Promise<string[] | null>>>;

/** 缓存键前缀 */
const TOPIC_CACHE_PREFIX = 'topic';
const BOARD_CACHE_PREFIX = 'board';
const DOC_SPACE_CACHE_PREFIX = 'docspace';

/**
 * 统一权限白名单查询服务
 *
 * 负责按当前 Actor 计算可访问的 Topic / Board / DocSpace ID 白名单，
 * 供 Search、Topic、Board、Task、Milestone、DocSpace 等列表接口在 Service 层做 IN 过滤。
 *
 * 规则同步约定：
 * - 本服务白名单规则必须与 TopicPolicy.can() / BoardPolicy.can() / DocSpacePolicy.can()
 *   的 read 分支严格保持一致。
 * - 修改 Policy read 规则时，必须同步更新本服务。
 * - TopicPolicy / BoardPolicy / DocSpacePolicy 方法顶部已加规则同步注释。
 *
 * mine-only 变体（getMyBoardIds / getMyTopicIds，v1.70 插件绑定推断底座）：
 * - 语义 = 可见白名单的子集（creator + member/participant，去掉 open 源），随 Policy
 *   read 规则同步；board 的 creator 路径保留 owner-proxy 名下 agent 创建的语义。
 * - admin 不短路：admin 求 mine 也只是 creator/member 身份（区别于 getAccessible*
 *   的 admin → null 全放行）。
 * - 匿名/缺 actor → []（open 源已排除，"我的"必须有身份）。
 *
 * 请求级缓存：
 * - 通过 AccessQueryInterceptor + AsyncLocalStorage 实现。
 * - 同一次 HTTP 请求内，同一 Actor 的 Topic/Board/DocSpace 白名单只查一次 DB。
 * - 缓存键：普通白名单 `topic|board:<actorKey>`；mine 变体 `topic|board:mine:<actorKey>`
 *   ——mine 前缀隔离，同一请求内 mine 与默认口径互不串缓存。
 * - 单元测试未触发拦截器时，回退到无缓存直接查询。
 */
@Injectable()
export class AccessQueryService {
  constructor(
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(DocSpace)
    private docSpaceRepo: Repository<DocSpace>,
    @InjectRepository(TopicParticipant)
    private participantRepo: Repository<TopicParticipant>,
    @InjectRepository(BoardMember)
    private memberRepo: Repository<BoardMember>,
    @InjectRepository(DocSpaceMember)
    private docSpaceMemberRepo: Repository<DocSpaceMember>,
    @Inject(ACCESS_QUERY_STORE)
    private store: AccessQueryStore,
    private ownerProxy: OwnerProxyService,
  ) {}

  /**
   * 计算 human actor 的白名单 creator id 集合（本人 + 其拥有的 agent id，owner 代理）
   *
   * 与 Policy read 规则同步：人类 owner 对其 agent 创建的资源视同 creator 可读。
   * agent actor → 仅本人（行为不变，不触发 owner 代理查询——性能短路）。
   */
  private async resolveCreatorIds(actor?: UnifiedActor): Promise<string[]> {
    if (!actor?.id || !actor?.type) {
      return [];
    }
    if (actor.type !== ActorType.HUMAN) {
      return [actor.id];
    }
    const ownedAgentIds = await this.ownerProxy.getOwnedAgentIds(actor);
    return [actor.id, ...ownedAgentIds];
  }

  /**
   * 获取当前 Actor 可访问的 Topic ID 白名单
   * @param actor 当前统一身份
   * @returns null 表示 Admin 不过滤；string[] 表示需要 IN 过滤的 ID 列表（空数组 = 无权限）
   */
  async getAccessibleTopicIds(actor?: UnifiedActor): Promise<string[] | null> {
    if (actor?.role === UserRole.ADMIN) {
      return null;
    }

    return this.withCache(`${TOPIC_CACHE_PREFIX}:${this.actorKey(actor)}`, () =>
      this.computeAccessibleTopicIds(actor),
    );
  }

  /**
   * 获取当前 Actor 的「我的」Topic ID 白名单（mine-only，v1.70）
   *
   * 语义 = creator（含 owner-proxy 名下 agent 创建的）+ participant（status IN
   * invited/active），**排除仅因 open 可见的项**；admin 不短路（同样按 creator/
   * participant 身份计算，与 getAccessibleTopicIds 的 admin→null 全放行不同）。
   *
   * 供 GET /topics?mine=true 使用（插件绑定自动推断的"我的"语义底座）。
   * @param actor 当前统一身份
   * @returns string[] 始终为数组（匿名/缺 actor → 空数组），调用方按 IN 过滤
   */
  async getMyTopicIds(actor?: UnifiedActor): Promise<string[]> {
    return this.withCache(`${TOPIC_CACHE_PREFIX}:mine:${this.actorKey(actor)}`, () =>
      this.computeMyTopicIds(actor),
    );
  }

  /**
   * 获取当前 Actor 可访问的 Board ID 白名单
   * @param actor 当前统一身份
   * @returns null 表示 Admin 不过滤；string[] 表示需要 IN 过滤的 ID 列表（空数组 = 无权限）
   */
  async getAccessibleBoardIds(actor?: UnifiedActor): Promise<string[] | null> {
    if (actor?.role === UserRole.ADMIN) {
      return null;
    }

    return this.withCache(`${BOARD_CACHE_PREFIX}:${this.actorKey(actor)}`, () =>
      this.computeAccessibleBoardIds(actor),
    );
  }

  /**
   * 获取当前 Actor 的「我的」Board ID 白名单（mine-only，v1.70）
   *
   * 语义 = creator(含 owner-proxy 名下 agent 创建的) + member（board_members 行），
   * **排除仅因 open 可见的项**；admin 不短路（同样按 creator/member 身份计算，
   * 与 getAccessibleBoardIds 的 admin→null 全放行不同）。
   *
   * 供 GET /boards?mine=true 使用（插件绑定自动推断的"我的"语义底座）。
   * @param actor 当前统一身份
   * @returns string[] 始终为数组（匿名/缺 actor → 空数组），调用方按 IN 过滤
   */
  async getMyBoardIds(actor?: UnifiedActor): Promise<string[]> {
    return this.withCache(`${BOARD_CACHE_PREFIX}:mine:${this.actorKey(actor)}`, () =>
      this.computeMyBoardIds(actor),
    );
  }

  /** 请求级缓存读取或计算（泛型：mine 变体恒返回 string[]，普通白名单可返回 null） */
  private withCache<T extends string[] | null>(key: string, compute: () => Promise<T>): Promise<T> {
    const store = this.store.getStore();
    if (!store) {
      // 非 HTTP 请求上下文（如测试、CLI），直接计算不缓存
      return compute();
    }

    const cached = store.get(key) as Promise<T> | undefined;
    if (cached) {
      return cached;
    }

    const promise = compute();
    store.set(key, promise);
    return promise;
  }

  /** Actor 缓存键：未认证为 anon，已认证为 type:id */
  private actorKey(actor?: UnifiedActor): string {
    if (!actor?.id || !actor?.type) {
      return 'anon';
    }
    return `${actor.type}:${actor.id}`;
  }

  /**
   * creator 白名单查询构建器（Topic）：creator_id IN (本人 + owner 代理的 agent ids)
   * 三源白名单与 mine 变体共用（mine 去掉 open 源即本查询 + participant 查询）。
   */
  private creatorTopicQb(creatorIds: string[]) {
    return this.topicRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where('t.creator_id IN (:...creatorIds)')
      .andWhere('t.deleted_at IS NULL')
      .setParameter('creatorIds', creatorIds);
  }

  /**
   * participant 白名单查询构建器（Topic）：topic_participants.status IN (invited, active)
   * （对齐 unread SQL 口径，Batch 2 替代已废弃的 settings.invitedAgentIds jsonb @>）。
   */
  private accessibleTopicQb(actorId: string) {
    return this.participantRepo
      .createQueryBuilder('tp')
      .select('tp.topic_id', 'id')
      .where('tp.participant_id = :actorId')
      .andWhere('tp.status IN (:...accessibleStatuses)')
      .setParameter('actorId', actorId)
      .setParameter('accessibleStatuses', ['invited', 'active']);
  }

  /** 计算 Topic 白名单（Admin 已提前返回） */
  private async computeAccessibleTopicIds(actor?: UnifiedActor): Promise<string[] | null> {
    const openTopicQb = this.topicRepo
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where("COALESCE(t.settings->>'visibility', 'open') = :open")
      .andWhere('t.deleted_at IS NULL')
      .setParameter('open', Visibility.OPEN);

    if (!actor?.id || !actor?.type) {
      const rows = await openTopicQb.getRawMany<{ id: string }>();
      return rows.map((row) => row.id);
    }

    // v1.37 owner 代理：human actor 的 creator 白名单 = 本人 + 其拥有的 agent id
    const creatorIds = await this.resolveCreatorIds(actor);

    const [openRows, creatorRows, accessibleRows] = await Promise.all([
      openTopicQb.getRawMany<{ id: string }>(),
      this.creatorTopicQb(creatorIds).getRawMany<{ id: string }>(),
      this.accessibleTopicQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...openRows, ...creatorRows, ...accessibleRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /**
   * 计算「我的」Topic 白名单（mine-only）：creator + participant，无 open 源。
   * admin 不短路（admin 求 mine 也只是 creator/participant 身份）。
   */
  private async computeMyTopicIds(actor?: UnifiedActor): Promise<string[]> {
    if (!actor?.id || !actor?.type) {
      return []; // 匿名/缺 actor：无"我的"（open 源已排除）
    }

    // v1.37 owner 代理：human actor 的 creator 白名单 = 本人 + 其拥有的 agent id
    const creatorIds = await this.resolveCreatorIds(actor);

    const [creatorRows, accessibleRows] = await Promise.all([
      this.creatorTopicQb(creatorIds).getRawMany<{ id: string }>(),
      this.accessibleTopicQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...creatorRows, ...accessibleRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /** 计算 Board 白名单（Admin 已提前返回） */
  private async computeAccessibleBoardIds(actor?: UnifiedActor): Promise<string[] | null> {
    // Batch 2: open 只看 board 自身 visibility（不再 join topic 做 max 判定）
    const openBoardQb = this.boardRepo
      .createQueryBuilder('b')
      .select('b.id', 'id')
      .where("COALESCE(b.settings->>'visibility', 'open') = :open")
      .andWhere('b.deleted_at IS NULL')
      .setParameter('open', Visibility.OPEN);

    if (!actor?.id || !actor?.type) {
      const rows = await openBoardQb.getRawMany<{ id: string }>();
      return rows.map((row) => row.id);
    }

    // v1.37 owner 代理：human actor 的 creator 白名单 = 本人 + 其拥有的 agent id
    const creatorIds = await this.resolveCreatorIds(actor);

    const [openRows, creatorRows, memberRows] = await Promise.all([
      openBoardQb.getRawMany<{ id: string }>(),
      this.creatorBoardQb(creatorIds).getRawMany<{ id: string }>(),
      this.memberBoardQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...openRows, ...creatorRows, ...memberRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /**
   * 计算「我的」Board 白名单（mine-only）：creator + member，无 open 源。
   * admin 不短路（admin 求 mine 也只是 creator/member 身份）。
   */
  private async computeMyBoardIds(actor?: UnifiedActor): Promise<string[]> {
    if (!actor?.id || !actor?.type) {
      return []; // 匿名/缺 actor：无"我的"（open 源已排除）
    }

    // v1.37 owner 代理：human actor 的 creator 白名单 = 本人 + 其拥有的 agent id
    const creatorIds = await this.resolveCreatorIds(actor);

    const [creatorRows, memberRows] = await Promise.all([
      this.creatorBoardQb(creatorIds).getRawMany<{ id: string }>(),
      this.memberBoardQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...creatorRows, ...memberRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /**
   * creator 白名单查询构建器（Board）：creator_id IN (本人 + owner 代理的 agent ids)，
   * 保留 owner-proxy 名下 agent 创建的语义。三源白名单与 mine 变体共用。
   */
  private creatorBoardQb(creatorIds: string[]) {
    return this.boardRepo
      .createQueryBuilder('b')
      .select('b.id', 'id')
      .where('b.creator_id IN (:...creatorIds)')
      .andWhere('b.deleted_at IS NULL')
      .setParameter('creatorIds', creatorIds);
  }

  /**
   * member 白名单查询构建器（Board）：board_members 行存在即有 read 权限
   * （Batch 2 替代 jsonb invited/editor + topic 继承）。
   */
  private memberBoardQb(actorId: string) {
    return this.memberRepo
      .createQueryBuilder('bm')
      .select('bm.board_id', 'id')
      .where('bm.actor_id = :actorId')
      .setParameter('actorId', actorId);
  }

  /**
   * 获取当前 Actor 可访问的 DocSpace ID 白名单
   * @param actor 当前统一身份
   * @returns null 表示 Admin 不过滤；string[] 表示需要 IN 过滤的 ID 列表（空数组 = 无权限）
   */
  async getAccessibleDocSpaceIds(actor?: UnifiedActor): Promise<string[] | null> {
    if (actor?.role === UserRole.ADMIN) {
      return null;
    }

    return this.withCache(`${DOC_SPACE_CACHE_PREFIX}:${this.actorKey(actor)}`, () =>
      this.computeAccessibleDocSpaceIds(actor),
    );
  }

  /** 计算 DocSpace 白名单（Admin 已提前返回） */
  private async computeAccessibleDocSpaceIds(actor?: UnifiedActor): Promise<string[] | null> {
    // open 看 space 自身 visibility（对齐 board 模式）
    const openSpaceQb = this.docSpaceRepo
      .createQueryBuilder('ds')
      .select('ds.id', 'id')
      .where("COALESCE(ds.settings->>'visibility', 'open') = :open")
      .andWhere('ds.deleted_at IS NULL')
      .setParameter('open', Visibility.OPEN);

    if (!actor?.id || !actor?.type) {
      const rows = await openSpaceQb.getRawMany<{ id: string }>();
      return rows.map((row) => row.id);
    }

    // v1.37 owner 代理：human actor 的 creator 白名单 = 本人 + 其拥有的 agent id
    const creatorIds = await this.resolveCreatorIds(actor);
    const creatorSpaceQb = this.docSpaceRepo
      .createQueryBuilder('ds')
      .select('ds.id', 'id')
      .where('ds.creator_id IN (:...creatorIds)')
      .andWhere('ds.deleted_at IS NULL')
      .setParameter('creatorIds', creatorIds);

    // doc_space_members 行存在即有 read 权限
    const memberSpaceQb = this.docSpaceMemberRepo
      .createQueryBuilder('dsm')
      .select('dsm.space_id', 'id')
      .where('dsm.actor_id = :actorId')
      .setParameter('actorId', actor.id);

    const [openRows, creatorRows, memberRows] = await Promise.all([
      openSpaceQb.getRawMany<{ id: string }>(),
      creatorSpaceQb.getRawMany<{ id: string }>(),
      memberSpaceQb.getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...openRows, ...creatorRows, ...memberRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }
}
