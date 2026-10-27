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
 * 单个资源的**访问剖面**（Notifications 二期双层判据的公共输入，plan §D3）。
 *
 * 为什么存在（而不是让通知模块自己算）：通知的"该不该推"= **安全层（read==true，防越权）**
 * ∧ **注意力层（成员/归属，防噪音）**。安全层必须是**当前真实读权限**，而读权限判据
 * （open ∪ creator(含 owner-proxy) ∪ member ∪ admin）在本仓只有一份真相——本服务。通知模块
 * 自建一份近似推断 = 越权外发（把私有看板/空间的标题推到用户手机上）。
 *
 * 字段全部**面向候选者集合**（一次调用喂饱两类判据）：调用方把自己的候选用户 id 全传进来，
 * 拿到"这批人里有谁能读 / 谁是成员"——集合之外的 id 一律不出现。
 * 与 `getAccessibleBoardIds` / `getAccessibleDocSpaceIds`（白名单法）同口径，由等价性断言测试守卫。
 */
export interface ResourceAccessProfile {
  /** 资源可见性（`COALESCE(settings->>'visibility','open')` 同口径；值域小写） */
  visibility: Visibility;
  /** 资源 creator_id（owner-proxy 判定输入：候选者 ∩ {creator, 其 ownedAgents} 即 creator 源命中） */
  creatorActorId: string;
  /** 候选者中属于该资源成员集的人（注意力层的"成员/归属"分量） */
  memberUserIds: Set<string>;
  /** 候选者中**有读权限**的人（安全层：open ∪ creator(含 owner-proxy) ∪ member ∪ admin） */
  readableUserIds: Set<string>;
}

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
 * - **Notifications 二期新增第二族（资源访问剖面）**：`resolveBoardAccess` /
 *   `resolveSpaceAccess` 是同一份 read 谓词的**按资源剖面**形态（供通知双层判据）。
 *   改 read 规则必须**同时**更新白名单族（`computeAccessible*`）与剖面族
 *   （`buildAccessProfile`）——两族由 `test/access-profile.e2e-spec.ts` 的等价性断言守卫
 *   （`u ∈ getAccessibleBoardIds(u) ⇔ u ∈ resolveBoardAccess(board,[u]).readableUserIds`）。
 * - **剖面族的候选集合由调用方保证"已过滤软删 actor"**：本服务只按传入的 `candidateUserIds`
 *   做 role / 成员查询，**不额外校验 `actors.deleted_at`**（用户软删事实在 actors 行上，
 *   而剖面法只收 userIds）。编排器（批 2）的候选查询必须显式过滤
 *   `actors.deleted_at IS NULL`；否则软删用户的旧绑定会被当活候选。
 *   - **剖面的 owner-proxy 展开是"一次批量查询"**（Notifications 二期批 2）：`buildAccessProfile`
 *     用 `OwnerProxyService.getOwnedAgentIdsByOwners` 对**整批候选**一次取回（`owner_id IN (...)`），
 *     而不是在候选循环里逐个 `getOwnedAgentIds`——后者会让"一次事件的查询数"随候选人数线性增长，
 *     破坏通知路由"与候选人数无关"的性能承诺。两者语义必须同步（改一处改两处）。
 *   - **`withDeleted` 选项管的是"资源行"（soft-deleted space）**，与 actor 软删无关。
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

  /**
   * 获取当前 Actor 的「我的」DocSpace ID 白名单（mine-only，Notifications 二期补口）。
   *
   * 语义与 {@link getMyBoardIds} 对称：creator(含 owner-proxy) + member（doc_space_members 行），
   * **排除仅因 open 可见的项**；admin 不短路。
   *
   * 为什么二期才补：一期没有"我的空间"消费点。二期通知设置面的 `relevantScopes.spaces`
   * （"作用域类通知的触发面"）需要它——**不能用** `getAccessibleDocSpaceIds` 顶替：那个带
   * open 源，会把平台全部公开空间算进"你的触发面"（用户看到"你有 200 个空间"而实际无关）。
   *
   * @param actor 当前统一身份
   * @returns string[] 始终为数组（匿名/缺 actor → 空数组），调用方按 IN 过滤
   */
  async getMyDocSpaceIds(actor?: UnifiedActor): Promise<string[]> {
    return this.withCache(`${DOC_SPACE_CACHE_PREFIX}:mine:${this.actorKey(actor)}`, () =>
      this.computeMyDocSpaceIds(actor),
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
    //
    // ── 镜像一致性（F4-2 / P-N3 / S-N8）：**board read 条件未变，本段不改代码** ──
    // 与 TaskPolicy 的关系（TaskPolicy 侧本批改的是「assignee 通道合取 boardRead」+
    // 软删板三态，read 谓词本身未动，故此处无需同步）：
    // ① **列表可见 ⇒ 单条可读**成立（同一份 read 谓词）；
    // ② **反向不成立**（两个方向都要知道）：
    //    - 软删板：单条 GET /tasks/:id 走 TaskPolicy 的软删板分支（OPEN 外人仍可读 /
    //      PRIVATE 仅成员），而板白名单里软删板只剩 member 源能命中（见 ③）；
    //    - orphan task（tasks.list_id NOT NULL，当前不可达）：不属任何板，任何板白名单
    //      都不覆盖它（TaskPolicy 对 orphan 的 read 返回 true）。
    // ③ **已知不对称（S-N8，知情接受）**：creatorBoardQb 带 `b.deleted_at IS NULL`，
    //    memberBoardQb **不带** —— 板软删后 creator 源不再命中、member 源仍命中。这不是
    //    笔误：member 源语义是"成员关系行存在即有 read"，而 board_members 行不随板软删
    //    消失；两侧口径不同是存量行为。本批不动——改动会让「我的看板」在板软删后出现
    //    条目增减，属独立的行为变更，需单独评估。
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

    const [openRows, creatorRows, memberRows] = await Promise.all([
      openSpaceQb.getRawMany<{ id: string }>(),
      this.creatorDocSpaceQb(creatorIds).getRawMany<{ id: string }>(),
      this.memberDocSpaceQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...openRows, ...creatorRows, ...memberRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /**
   * 计算「我的」DocSpace 白名单（mine-only，Notifications 二期补口）：creator + member，无 open 源。
   * admin 不短路（与 {@link computeMyBoardIds} 同口径）。
   */
  private async computeMyDocSpaceIds(actor?: UnifiedActor): Promise<string[]> {
    if (!actor?.id || !actor?.type) {
      return []; // 匿名/缺 actor：无"我的"（open 源已排除）
    }

    const creatorIds = await this.resolveCreatorIds(actor);

    const [creatorRows, memberRows] = await Promise.all([
      this.creatorDocSpaceQb(creatorIds).getRawMany<{ id: string }>(),
      this.memberDocSpaceQb(actor.id).getRawMany<{ id: string }>(),
    ]);

    const ids = new Set<string>();
    [...creatorRows, ...memberRows].forEach((row) => ids.add(row.id));
    return Array.from(ids);
  }

  /**
   * creator 白名单查询构建器（DocSpace）：creator_id IN (本人 + owner 代理的 agent ids)。
   * 三源白名单与 mine 变体共用（抽成方法避免"两处各写一遍 where"这一漂移源）。
   */
  private creatorDocSpaceQb(creatorIds: string[]) {
    return this.docSpaceRepo
      .createQueryBuilder('ds')
      .select('ds.id', 'id')
      .where('ds.creator_id IN (:...creatorIds)')
      .andWhere('ds.deleted_at IS NULL')
      .setParameter('creatorIds', creatorIds);
  }

  /** member 白名单查询构建器（DocSpace）：doc_space_members 行存在即有 read 权限 */
  private memberDocSpaceQb(actorId: string) {
    return this.docSpaceMemberRepo
      .createQueryBuilder('dsm')
      .select('dsm.space_id', 'id')
      .where('dsm.actor_id = :actorId')
      .setParameter('actorId', actorId);
  }

  // ═══════════════════ 资源访问剖面（Notifications 二期） ═══════════════════

  /**
   * 计算**看板**的访问剖面（plan §D3）。
   *
   * 签名**只收 userIds**（调用方不传 agentIds / isAdmin）：role 与 owner-proxy 展开都在方法内部
   * 从 DB 实时读取——从签名上消除"调用方自报身份"与"role 陈旧窗口"两条越权路径
   * （security 评审 V1）。
   *
   * 判据与 {@link getAccessibleBoardIds} **同口径**（单源）：`open` ∪ `creator_id IN
   * (候选者 ∪ 其 ownedAgents)` ∪ `board_members.actor_id`；admin 安全层直接放行。
   * 差异只在**返回形状**：白名单法返回"该用户的全部可读 id"，本方法返回"该资源对这批候选者
   * 的可读/成员分布"——由等价性断言测试（mine-query 同族）守卫两者不漂移。
   *
   * @param boardId 看板 id
   * @param candidateUserIds 候选平台用户 id（**只收 userIds**，见上）
   * @returns 访问剖面；看板不存在（或已软删）返回 null（铁律 #22 判空）
   */
  async resolveBoardAccess(
    boardId: string,
    candidateUserIds: string[],
  ): Promise<ResourceAccessProfile | null> {
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    if (!board) return null;

    const candidates = dedupeIds(candidateUserIds);
    const roles = await this.loadCandidateRoles(candidates);
    const memberUserIds = await this.loadBoardMembers(boardId, candidates);

    return this.buildAccessProfile(
      board.settings,
      board.creatorId,
      candidates,
      roles,
      memberUserIds,
    );
  }

  /**
   * 计算 **DocSpace** 的访问剖面（plan §D3；判据同 {@link getAccessibleDocSpaceIds}）。
   *
   * @param spaceId 空间 id
   * @param candidateUserIds 候选平台用户 id（**只收 userIds**）
   * @param opts.withDeleted true = 连软删的空间行也读（`doc_deleted` / **整空间删除**场景：
   *   事件到达时空间行已软删，但"读权限"应按**删除前**的可见性判定——否则整空间删除的通知
   *   会给所有非 admin 候选者判成"无权限"而静默全灭）。**默认 false**（正常路径按存活行判）。
   * @returns 访问剖面；空间不存在（或已软删且未传 withDeleted）返回 null
   */
  async resolveSpaceAccess(
    spaceId: string,
    candidateUserIds: string[],
    opts?: { withDeleted?: boolean },
  ): Promise<ResourceAccessProfile | null> {
    const space = await this.docSpaceRepo.findOne({
      where: { id: spaceId },
      withDeleted: opts?.withDeleted === true,
    });
    if (!space) return null;

    const candidates = dedupeIds(candidateUserIds);
    const roles = await this.loadCandidateRoles(candidates);
    const memberUserIds = await this.loadDocSpaceMembers(spaceId, candidates);

    return this.buildAccessProfile(
      space.settings,
      space.creatorId,
      candidates,
      roles,
      memberUserIds,
    );
  }

  /**
   * 三个谓词源的公共装配（Board / DocSpace 同形，见 {@link ResourceAccessProfile}）。
   *
   * @param settings 资源 settings jsonb（读 `visibility`，缺键回落 `open`）
   * @param creatorActorId 资源 creator_id
   * @param candidates 去重后的候选用户 id
   * @param roles 候选者 id → role（admin 安全层放行，见 {@link loadCandidateRoles}）
   * @param memberUserIds 候选者中属于该资源成员集的人
   * @returns 访问剖面（候选者之外的 id 一律不进任何集合）
   */
  private async buildAccessProfile(
    settings: Record<string, unknown> | null | undefined,
    creatorActorId: string,
    candidates: string[],
    roles: Map<string, UserRole>,
    memberUserIds: Set<string>,
  ): Promise<ResourceAccessProfile> {
    // visibility 与既有白名单 SQL 的 `COALESCE(settings->>'visibility','open') = 'open'` **逐条对齐**（m10）：
    // · 缺键 / null ⇒ SQL 的 `->>` 给 NULL、COALESCE 回落 'open' ⇒ **open**
    // · `'open'` ⇒ open
    // · 其余（含**空串**、非字符串如数字）⇒ SQL 侧取值不为 'open' ⇒ **非 open**
    //   （空串曾被当成 open——那是与白名单族分叉：等值性断言用例会红）
    const rawVisibility = settings?.['visibility'];
    const visibility: Visibility =
      rawVisibility === undefined || rawVisibility === null
        ? Visibility.OPEN
        : (rawVisibility as Visibility);
    const isOpen = visibility === Visibility.OPEN;

    // owner-proxy 展开：**一次批量查询**（条数与候选人数无关）——供下面循环按用户取用。
    // 为什么不能沿用"循环内逐个 getOwnedAgentIds"：那是本方法唯一的 O(N) 查询源，而通知路由
    // 的性能承诺是与候选人数无关（一次事件里的候选可能有几十上百人）。admin 候选先剔除：
    // admin 在上面的循环里走"安全层直接放行"分支，不需要 owner-proxy 输入。
    // 候选用户 id 恒来自 `users` 表（人类），故这里直接按 ownerId 批量查，不必再合成 human actor。
    const ownedAgentsByOwner = await this.ownerProxy.getOwnedAgentIdsByOwners(
      candidates.filter((userId) => roles.get(userId) !== UserRole.ADMIN),
    );

    const readableUserIds = new Set<string>();
    for (const userId of candidates) {
      // ① admin 安全层放行（role 实时读自 users 表，见 loadCandidateRoles）
      if (roles.get(userId) === UserRole.ADMIN) {
        readableUserIds.add(userId);
        continue;
      }
      // ② open 源
      if (isOpen) {
        readableUserIds.add(userId);
        continue;
      }
      // ③ creator 源（含 owner-proxy：本人 + 其拥有的 agent 创建的资源视同 creator）
      const creatorIds = [userId, ...(ownedAgentsByOwner.get(userId) ?? [])];
      if (creatorIds.includes(creatorActorId)) {
        readableUserIds.add(userId);
        continue;
      }
      // ④ member 源（board_members / doc_space_members 行存在即 read）
      if (memberUserIds.has(userId)) readableUserIds.add(userId);
    }

    return { visibility, creatorActorId, memberUserIds, readableUserIds };
  }

  /**
   * 实时读候选者的 role（**不缓存、不落快照**——admin 降权必须即时生效）。
   *
   * @param candidateUserIds 去重后的候选用户 id
   * @returns id → role（**查不到的 id 不在 Map 里**：actor 已被硬删的候选者按"无 role"处置）
   */
  private async loadCandidateRoles(candidateUserIds: string[]): Promise<Map<string, UserRole>> {
    const roles = new Map<string, UserRole>();
    if (candidateUserIds.length === 0) return roles;
    // 裸 SQL 而非 User 仓储：PermissionModule 的 forFeature 不含 User（本服务只借连接池取一份
    // 事实），且这条查询形状固定（两列、按 PK 集合）——计划书 §D3 亦点名此写法
    const rows = (await this.boardRepo.query('SELECT id, role FROM users WHERE id = ANY($1)', [
      candidateUserIds,
    ])) as Array<{ id: string; role: UserRole }>;
    for (const row of rows) roles.set(row.id, row.role);
    return roles;
  }

  /** 候选者中属于该看板成员集的人（单条查询；非候选者的成员行不返回） */
  private async loadBoardMembers(
    boardId: string,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (candidateUserIds.length === 0) return new Set();
    const rows = await this.memberRepo
      .createQueryBuilder('bm')
      .select('bm.actor_id', 'id')
      .where('bm.board_id = :boardId', { boardId })
      .andWhere('bm.actor_id IN (:...candidateUserIds)', { candidateUserIds })
      .getRawMany<{ id: string }>();
    return new Set(rows.map((row) => row.id));
  }

  /** 候选者中属于该空间成员集的人（单条查询；非候选者的成员行不返回） */
  private async loadDocSpaceMembers(
    spaceId: string,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (candidateUserIds.length === 0) return new Set();
    const rows = await this.docSpaceMemberRepo
      .createQueryBuilder('dsm')
      .select('dsm.actor_id', 'id')
      .where('dsm.space_id = :spaceId', { spaceId })
      .andWhere('dsm.actor_id IN (:...candidateUserIds)', { candidateUserIds })
      .getRawMany<{ id: string }>();
    return new Set(rows.map((row) => row.id));
  }
}

/**
 * 去重并剔除空串（候选集合来自调用方，jsonb/事件载荷都可能带垃圾值——铁律 #21 输入防御）。
 *
 * @param ids 原始 id 列表
 * @returns 去重后的非空 id 数组（保持出现顺序）
 */
function dedupeIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}
