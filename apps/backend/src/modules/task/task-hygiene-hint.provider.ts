/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - task **纪律族 hint provider**（阶段三决策 9 + v1.94.0-dev 依赖引导 + v1.95.0-dev 撞重）：
 *     把 task 写路径的领域事实（`task.created` / `task.status_changed` / `task.comment_added`）
 *     翻译成四条**即时纠偏**提示——
 *     ① 任务已完工但**没留结果证据**（`task_done_without_report`）；
 *     ② 任务进入 **review/done** 但仍有**未完成的 blocks 下游依赖**（`task_dependents_pending`）；
 *     ③ 对**已完工**任务追加评论（`comment_on_done_task`，可能意味着新增未完成工作）；
 *     ④ 新建任务与**同板其他 open 任务撞题**（`task_near_duplicate_suspected`——
 *        tier1 归一化等值 ∪ 白名单 tier2a，判定全在 `./task-title-normalize.ts`）。
 *   - service 侧只写领域事实（`emitFact('task.created', {...})`），**不出现任何
 *     hint 概念**；候选由拦截器合并进响应 `data.hints[]`（advisory，绝不改变业务结果与
 *     状态码，也不改任务状态、不解除依赖）。
 *
 * [代码职责]
 *   - `build(facts, payload, ctx?)`：按事实名逐条求值（四条分支），命中即产出候选；
 *     同响应内**去重**（同事实名 + 同载荷）与**调用级记忆化**（同 task 的实体点查只打
 *     一次库；同 board 的 open 候选扫描也只打一次）在本文件内收敛。一条
 *     `task.status_changed` 事实**可能产出两条候选**（完工缺证据 + 依赖引导），故状态
 *     分支返回候选数组。
 *   - `resolveMessage` / `familyOf` / `ttlOf` / `priority` / `surface`：全部委托
 *     `task-hint.constants.ts` 与 `HintRegistry`（本文件不写任何文案字面量；模板文案经
 *     常量的 `renderTaskHintMessage` 渲染）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.2「board 纪律族」（触发判据、触发人群小的
 *     刻意性说明、复活再 done 被窗口压制 = 刻意漏报）+ §4.7「task_dependents_pending」
 *     （依赖引导分支：blocks-only / SQL 下沉 / resourceKey 带 toStatus）+ §4.x
 *     「task_near_duplicate_suspected」（撞重：tier 定义 / 白名单与开放词表纪律 /
 *     标定残差 / 巨板 fail-open / resourceKey 的窗口空转 tradeoff）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **永不抛**：`build` 的每条事实各自 try/catch（失败 warn 后跳过该事实），外层拦截器
 *     虽也兜一层，但那是最后防线、不是设计（抛 = 该挂面永久静默）。
 *   - **禁正文入日志 / 禁正文入 data**：本 provider 的判据只用**计数与状态**（评论条数、
 *     关联文档条数、任务状态），**从不读评论/任务正文**——因此没有正文外流面。日志只落
 *     事实名 + 错误摘要。
 *     ⚠️ **回显「任务标题」是唯一例外口径**（文件头修订，v1.94.0-dev 起）：
 *     `task_dependents_pending` 回显下游 `{id,title,status}`、`task_near_duplicate_suspected`
 *     回显撞题候选同时含 `title`——**标题**是任务标题（不是正文），且两个口径都与
 *     **既有读面**同构（`task_controller_find_dependents` 早已把下游 title 暴露给同一批
 *     调用者；撞题面则只回**同板**任务的标题，而调用方能建卡就必然能列该板）。**描述/评论
 *     正文永不出现**；`task.created` 事实载荷带 title 也是同一条口径（标题可入袋，正文禁入）。
 *   - **触发人群小是刻意的**（decision 9，写进 §4.2 防误读）：`task_done_without_report`
 *     在有**任何**评论（含 report_task_result 自己发的那条）时永久豁免——这是「有过对话
 *     的任务不必再唠叨」的产品选择，不是漏判。`comment_on_done_task` 同理被
 *     `via='report'` 豁免（验收补证是完成流程本身的一部分）。
 *   - **复活再 done 被窗口压制 = 刻意漏报**：候选 `resourceKey` = taskId（依赖引导码 =
 *     `{taskId}:{toStatus}`），去重窗口 `(actor, code, resourceKey)` 6h——任务在 6h 内
 *     「done → 挪回 → 再 done」时第二次不发。这是防疲劳的必要代价（e2e 有断言钉住）。
 *   - **`via='report'` 豁免必须在事实载荷里**：豁免判据来自 `addComment` 的调用方
 *     （`reportResult` 传 `via:'report'` ⇒ emitFact 载荷带该键）。**不要**改成「看评论
 *     内容像不像 report」——那是脆弱的启发式。
 *   - **回库确认状态**（铁律 #22 判空）：事实里的 `toStatus` 只是线索，最终判据是任务行
 *     的当前 `status`——同一请求里可能先 done 再挪回，只看事实会把已回退的任务报错。
 *     依赖引导码**同样回库复核**（当前状态 ≠ 事实 toStatus ⇒ 放弃）。
 *   - **幂等重放不 emit ⇒ 撞重码在重放响应里恒不出现**：`task.created` 只在**真实写入
 *     成功**的两条路径上写袋（`task.service.create` 的无幂等键路径 + 带幂等键事务路径的
 *     提交后段）；23505 重放分支提前 return、根本不产生事实。产品口径：**只见重放响应的
 *     调用方不会知道曾有过撞重提示**（这是「2 期固化契约：replay 禁 emit」的直接后果，
 *     已写进 api-definition / skill）。
 *
 * [关联代码]
 *   - ./task-hint.constants.ts — 码表 / 文案 / 优先级 / profile 的**唯一真源**
 *   - ./task-title-normalize.ts — 撞重检测器（纯函数：tier1 + 白名单 tier2a）
 *   - ./task.service.ts — 三个 `emitFact` 挂点（`task.created` 两条返回路径齐步 +
 *     状态变更两条路径 + 评论）
 *   - ./task-dependency.service.ts — 依赖三端点的读侧口径（本文件回显与它同口径）
 *   - ../hints/hint.interceptor.ts — 消费方（`HintFactProvider` 契约 + fail-open 双层）
 *   - ../hints/hint-registry.ts — code 元数据（`TASK_HYGIENE_DEFINITIONS` 的 6h 窗口）
 *   - ../hints/hint-log.ts — 埋点（`surface='task_hygiene'`）
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（kill switch 键 `task_hygiene`）
 *   - task-hygiene-hint.provider.spec.ts — 判定矩阵单测
 *   - test/task-hygiene-hint.e2e-spec.ts — 真 PG（TaskDocLink join 未软删 doc + 依赖 join +
 *     同板 open 扫描，铁律 #23）
 *
 * [持久踩坑]
 *   TASK-HYG-1(证据判据是「计数」不是「存在性」): `task_done_without_report` 的证据集 =
 *     评论条数 + 指向**未软删** doc 的关联条数。两处都必须走 count（不是 findOne/exists）：
 *     ① 评论表软删行由 `@DeleteDateColumn` 自动排除（`count()` 隐式加 `deleted_at IS NULL`）；
 *     ② 关联表 `task_doc_links` **裸 uuid 无 FK**，软删语义全靠 join 条件
 *     （`doc.deleted_at IS NULL`）——漏掉它会把「文档已被软删、任务其实没有可用证据」
 *     误判成「有证据」，提示静默消失且无任何观测面。
 *   TASK-HYG-2(两条码互斥但都要 window): 同一请求里「完工 + 评论」可能同时命中两条码，
 *     但 `resourceKey` 相同（taskId）而 code 不同 ⇒ 去重键不同 ⇒ 两条都会送达（≤3 内）。
 *     这是预期行为（完工缺证据与「你在已完工任务上评论」是两件不同的事）。
 *   TASK-HYG-3(依赖判据必须**SQL 下沉**): `Task.deletedAt` 是 `select: false`（实体层
 *     声明）⇒ JS 侧 `task.deletedAt !== null` **恒为真**（字段根本不在 hydration 结果里），
 *     「查回来再过滤」会静默把软删下游算进来。状态过滤同理：`take` 后 JS 过滤会先截断再
 *     过滤，漏掉本应返回的行（`task-dependency.service.ts:185-199` 同款纪律）。
 *     故 `getCount` 与 `getMany(take)` 都必须在**同一套 SQL 条件**上求值。
 *   TASK-HYG-4(撞重的**记忆化语义**：缓存板级候选，**不缓存 selfId 过滤**): 同一次 build
 *     里同一 boardId 只扫一次库（`boardCache`），缓存的值必须是**板级 open 候选全量**
 *     （不带 `t.id <> selfId` 过滤）——因为**批内互撞**（`POST /tasks/batch` 一次建 N 条
 *     同名）时，每条事实的 selfId 不同、要剔除的对象也不同：把 selfId 过滤塞进缓存会让
 *     批内第 2..N 条**看不到兄弟卡**（漏报），而把 selfId 忘掉则会让**自己撞自己**（假报，
 *     e2e 有鉴别断言）。正确分层 = 缓存板级候选 / 剔除 selfId 与 `sameBatch` 标记在
 *     **per-fact 层**。
 *     巨板边界：扫描 `LIMIT 501`，超 500 行 ⇒ 固定前缀 warn + **「放弃」结论一并入缓存**
 *     （否则同一请求里 N 条 fact 会各打一次全表排序查询）。生产实测 435 open / 15 board
 *     ⇒ 今天不可达，warn 是未来巨板的观测位。
 *   TASK-HYG-5(标题口径): `task.created` 事实带 `title`，是本 provider **唯二**的
 *     「非计数/非状态」输入（另一个是依赖引导的下游 title）。判据只需标题、不需要正文，
 *     且标题必须**来自事实袋而不是回库读**——回库读会让「同请求里紧接着被改名」的任务按
 *     新标题比对（事实与响应脱钩）。检测器对非字符串标题 fail-closed（空候选，不抛）。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #22(findOne 判空)
 *   #23(jsonb/join 查询集成覆盖)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增码 ⇒ `factNames` + `build` 分支 + 常量四件套 + 注册表 + 守卫 spec 六处齐步
 *   □ 改证据判据 ⇒ 同步 task-hygiene-hint.e2e-spec.ts（真 PG）与本文件 [持久踩坑]
 *   □ 扩大白名单词表 ⇒ 先读 task-title-normalize.ts 的收录判据与标定残差（每加一词 = FP 面扩大）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskDependencyType, TaskStatus } from '@agent-chamber/shared';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { Doc } from '../../database/entities/doc.entity';
// 撞重码（v1.95.0-dev）：同板 open 候选查询要 join 列→板（用实体类做 join 目标，避免裸表名）
import { BoardList } from '../../database/entities/board-list.entity';
import { makeHintCandidate, type HintCandidate } from '../hints/hint-core';
// ⚠️ **值导入**：HintRegistry 是被注入的构造器参数（`import type` 会被 TS 擦除，
// emitDecoratorMetadata 退化成 Object ⇒ 启动期 "can't resolve dependencies"）
import { HintRegistry } from '../hints/hint-registry';
import {
  renderTaskHintMessage,
  TASK_HINT,
  TASK_HINT_MESSAGES,
  TASK_HINT_PRIORITY,
  TASK_HINT_SURFACE,
} from './task-hint.constants';
// 撞重检测器（纯函数：tier1 归一化等值 + 白名单 tier2a；标定与白名单纪律见该文件头）
import { findDuplicateTitles } from './task-title-normalize';
import type { HintFact } from '../hints/hint-facts';
import type { HintFactProvider, HintProviderContext } from '../hints/hint.interceptor';

/**
 * 事实名（服务层 `emitFact` 与本文件 `factNames` 的**同一批字面量**）。
 *
 * 与 memory nomination provider 共享同一批事实名——跨模块常量会诱发
 * task → memory 的反向依赖，故两侧各自持有字面量；漂移守卫 = e2e 的写路径用例
 * （事实名打错 = 该路径永远无 hints，e2e 必红）。
 */
const FACT_TASK_STATUS_CHANGED = 'task.status_changed';
const FACT_TASK_COMMENT_ADDED = 'task.comment_added';
/** 新建任务（v1.95.0-dev 撞重码的输入；由 `task.service.create` 的两条成功返回路径齐步写入） */
const FACT_TASK_CREATED = 'task.created';

/** 评论事实的豁免标记（`reportResult` 内部路径专用；见文件头不变量） */
const VIA_REPORT = 'report';

/**
 * 撞重回显的候选条数上限（`totalCount` 仍报全量）。
 *
 * rationale：与依赖引导的 `DEPENDENTS_RETURN_CAP` 同款——advisory 的「知悉型」提示，
 * 列 3 条足以让读者判断是否与自己相关；全量列表有既有读面（`task_controller_find_tasks`）。
 */
const TITLE_MATCH_RETURN_CAP = 3;

/**
 * 同板 open 候选的**扫描上限**（`LIMIT 501` ⇒ 超 500 行即放弃）。
 *
 * rationale：扫描成本是Θ(板内任务数)（`ORDER BY created_at` 无可用索引），巨板会让一次
 * 请求带上全表排序。超过 500 行 ⇒ 固定前缀 warn + 放弃（fail-open：不提示好过拖慢写路径）。
 * 生产实测最大板 435 open / 共 15 board ⇒ **今天不可达**；warn 落点是未来巨板的观测位。
 */
const BOARD_OPEN_TASK_SCAN_LIMIT = 500;

/**
 * 「不算候选」的状态集（SQL 下沉用）：done / archived 的任务不再是「在办的活」。
 *
 * 与 `task-dependency.service.ts` 的 `DEPENDENT_DONE_STATUSES` 同一语义（第二个消费点，
 * 保持逐字一致以免两处口径漂移）。
 */
const BOARD_CLOSED_STATUSES: readonly TaskStatus[] = [TaskStatus.DONE, TaskStatus.ARCHIVED];

/**
 * 依赖引导的触发状态集（**归一化小写**）：进入这两态即意味着「本任务的完成信号已发出」，
 * 而下游还在等它。`in_progress` / `todo` / `backlog` 不提示（任务还在办，等它是正常的）。
 */
const DEPENDENTS_PENDING_STATUSES: readonly string[] = [
  TaskStatus.REVIEW.toLowerCase(),
  TaskStatus.DONE.toLowerCase(),
];

/**
 * 依赖引导码回显的下游任务条数上限（`totalCount` 仍报全量）。
 *
 * rationale：提示是 advisory 的「知悉型」引导，列出 3 条足以让读者判断是否与自己相关；
 * 全量列表有既有的读面（`task_controller_find_dependents`），文案里已给出指针。
 */
const DEPENDENTS_RETURN_CAP = 3;

/**
 * 「下游仍在办」的状态排除集（SQL 下沉用）：done / archived 都不算「在等它」。
 *
 * 与 `task-dependency.service.ts` 的 `findBlockers` / `hasBlockers` 同一个集合
 * （同一语义的第二个消费点，保持逐字一致以免两处口径漂移）。
 */
const DEPENDENT_DONE_STATUSES: readonly TaskStatus[] = [TaskStatus.DONE, TaskStatus.ARCHIVED];

/**
 * 事实载荷里的 ID 读取（非字符串 / 空串 → `null`）。
 *
 * 事实袋载荷约定 = 扁平对象 + 标量优先（见 hint-facts 的 `HintFact` 注释）；
 * 一切非字符串形态 fail-closed（不抛、不猜）。
 */
function readId(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 折叠**完全重复**的事实（同事实名 + 同载荷）——同一动作被 emit 两次（重试/重放路径）。
 *
 * 折叠键 = 事实名 + 载荷全等：本 provider 的两条判据**都不读正文**，同资源的不同内容
 * 事实（两条评论）折叠后语义等价（都只是「该 task 多了一条评论」），故可以按资源折叠。
 * 这与 memory nomination provider 刻意**不**折叠的口径不同——那边要读正文判裁决词。
 */
function foldDuplicateFacts(facts: readonly HintFact[]): readonly HintFact[] {
  const seen = new Set<string>();
  const folded: HintFact[] = [];
  for (const fact of facts) {
    const key = `${fact.name}|${JSON.stringify(fact.payload ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    folded.push(fact);
  }
  return folded;
}

/**
 * task 纪律族 provider（见文件头不变量）。
 *
 * 生命周期 = 进程（Nest 单例，由 TaskModule provide / AppModule 经 provider chain 注入）。
 */
@Injectable()
export class TaskHygieneHintProvider implements HintFactProvider<string> {
  private readonly logger = new Logger(TaskHygieneHintProvider.name);

  /** 本 provider 关注的事实名（与 task.service 的 emitFact 字面量对齐） */
  readonly factNames: readonly string[] = [
    FACT_TASK_STATUS_CHANGED,
    FACT_TASK_COMMENT_ADDED,
    FACT_TASK_CREATED,
  ];

  /** 产出面（进埋点 `surface`；词表见 hint-log，本值是 task 侧新增项） */
  readonly surface = TASK_HINT_SURFACE;

  /** 参与排序的优先级序（同响应多条候选时的确定性；见 task-hint.constants.ts） */
  readonly priority = TASK_HINT_PRIORITY;

  constructor(
    // ⚠️ 五个仓储的注册点 = task.module.ts 的 forFeature（**不是这里**）：
    // 本 provider 由 TaskModule provide，故 @InjectRepository 从该模块解析
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskComment) private readonly comments: Repository<TaskComment>,
    @InjectRepository(TaskDocLink) private readonly docLinks: Repository<TaskDocLink>,
    // 依赖引导码（v1.94.0-dev）：下游 blocks 依赖的 SQL 下沉查询
    @InjectRepository(TaskDependency) private readonly dependencies: Repository<TaskDependency>,
    private readonly registry: HintRegistry,
  ) {}

  /** 文案单源 = `TASK_HINT_MESSAGES`（本文件不写字面量文案；模板经同居 helper 渲染） */
  resolveMessage(candidate: HintCandidate<string>): string {
    if (candidate.message) return candidate.message;
    // 未登记的码（类型层不该出现）→ 回落 code 本身，避免输出空文案
    const template = TASK_HINT_MESSAGES[candidate.code as never];
    if (template === undefined) return candidate.code;
    return renderTaskHintMessage(candidate.code as never, candidate.data);
  }

  /** 族归属：task 纪律族统一 `'board'`（与注册表 `family` 字段同值） */
  familyOf(): string | null {
    return 'board';
  }

  /**
   * 去重窗口长度：**单源 = 注册表**（`HintDefinition.ttlMs`；两条码 = 6h）。
   *
   * 为什么由 provider 委托而不是拦截器直接查表：拦截器不认识 code（分层纪律），
   * 而 provider 持有 registry —— 于是「窗口长度」这个领域事实只在一处声明。
   */
  ttlOf(code: string): number | undefined {
    return this.registry.ttlOf(code);
  }

  /**
   * 事实 → 候选（见文件头不变量）。
   *
   * @param facts 本请求事实袋快照（拦截器在响应封装前取出）
   * @param _payload handler 原始载荷（**本 provider 不读**——提示只依赖事实 + 库）
   * @param _ctx 请求身份（**本 provider 不消费**：task 端点的授权已由业务侧完成，
   *   提示对象就是刚完成这次写的 actor；此处保留参数以对齐 `HintFactProvider` 契约）
   * @returns 0..N 条候选（无命中 → 空数组，**不是**空占位）
   */
  async build(
    facts: readonly HintFact[],
    _payload: unknown,
    _ctx?: HintProviderContext,
  ): Promise<readonly HintCandidate[]> {
    const out: HintCandidate[] = [];
    /** 调用级记忆化：同 task 的状态点查只打一次库（两条事实可能指向同一任务） */
    const statusCache = new Map<string, Promise<Task | null>>();
    /**
     * 调用级记忆化（撞重码）：**板级 open 候选**每板只扫一次库。
     * 缓存的是**判定结果**（板级候选全量 或 「放弃」标记），**不带 selfId 过滤**——
     * 剔除 selfId 与 sameBatch 标记在 per-fact 层做（见 TASK-HYG-4）。
     */
    const boardCache = new Map<string, Promise<readonly Task[] | null>>();
    /**
     * 本请求**同批创建**的任务 id 集（`POST /tasks/batch` 一次建 N 条时，事实袋里会有 N 条
     * `task.created`）——用于给命中候选打 `sameBatch` 标（文案不区分，`data` 区分，
     * 消费方据此知道「撞的是本批刚建的卡」而不是历史卡）。
     */
    const batchTaskIds = new Set<string>();
    for (const fact of facts) {
      if (fact.name !== FACT_TASK_CREATED) continue;
      const id = readId(fact.payload, 'taskId');
      if (id) batchTaskIds.add(id);
    }

    for (const fact of foldDuplicateFacts(facts)) {
      try {
        let candidates: readonly HintCandidate[];
        if (fact.name === FACT_TASK_CREATED) {
          // 撞重分支（v1.95.0-dev）：单值或 null
          const duplicate = await this.evaluateNearDuplicate(
            fact.payload,
            boardCache,
            batchTaskIds,
          );
          candidates = duplicate ? [duplicate] : [];
        } else {
          // 注释事实分支先求值（返回单值或 null）——两条分支的返回形状不同：状态变更事实
          // **可能产出两条候选**（完工缺证据 + 依赖引导），评论事实最多一条
          const commentCandidate =
            fact.name === FACT_TASK_COMMENT_ADDED
              ? await this.evaluateCommentOnDoneTask(fact.payload, statusCache)
              : null;
          candidates =
            fact.name === FACT_TASK_STATUS_CHANGED
              ? await this.evaluateStatusChanged(fact.payload, statusCache)
              : commentCandidate
                ? [commentCandidate]
                : [];
        }
        out.push(...candidates);
      } catch (error) {
        // per-fact fail-open：单条事实判不了不影响其余事实；日志只落 fact 名 + 错误摘要
        // （**禁正文**：本 provider 本就不读正文，见文件头不变量）
        this.logger.warn(
          `[TASK_HYGIENE_HINT_FACT_FAILED] fact=${fact.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return out;
  }

  /**
   * `task.created` → `task_near_duplicate_suspected`（**同板 open 任务撞题**，v1.95.0-dev）。
   *
   * 判据三步（任一不成立即放弃；**不抛**）：
   * ① 载荷齐备：`taskId` / `boardId` / `title` 三者都必须是非空字符串——缺 `boardId`
   *    意味着 service 侧拿不到板（orphan 任务），**fail-closed 跳过**（不猜板）。
   * ② 取板级 open 候选（记忆化；`null` = 巨板放弃或查询失败 ⇒ 跳过）。
   * ③ 剔除**自己**（`t.id !== taskId`——缓存的候选含自己，见 TASK-HYG-4）后调纯函数检测器；
   *    无命中 ⇒ 不产出。
   *
   * `resourceKey` = **新 taskId**（不是 `hash(norm(title))`）：理由不是防疲劳（6h 窗口在本码
   * 近乎空转，见 hint-registry 的注记），而是**行为 join 可直接读**——审计日志（CREATE）与
   * `task_dependencies`（duplicates/relates_to）都以 taskId 为键，埋点用 taskId 就能把
   * 「提示过 → 后来真的挂了 duplicates 依赖」这条链路端到端串起来。
   *
   * @param payload `{ taskId, boardId, title }`（title 是**事实快照**，不回头读库，见 TASK-HYG-5）
   * @param boardCache 板级候选/放弃结论的记忆化（**不带 selfId 过滤**）
   * @param batchTaskIds 本请求同批创建的 taskId 集（打 `sameBatch` 标）
   */
  private async evaluateNearDuplicate(
    payload: Record<string, unknown> | undefined,
    boardCache: Map<string, Promise<readonly Task[] | null>>,
    batchTaskIds: ReadonlySet<string>,
  ): Promise<HintCandidate | null> {
    const taskId = readId(payload, 'taskId');
    const boardId = readId(payload, 'boardId');
    const rawTitle = payload?.title;
    if (!taskId || !boardId || typeof rawTitle !== 'string' || rawTitle.length === 0) return null;

    const boardTasks = await this.loadBoardOpenTasks(boardId, boardCache);
    if (!boardTasks) return null; // 巨板放弃 / 查询失败（fail-open）

    // **per-fact 层**剔除自己：缓存里的候选是板级全量（含自己）
    const others = boardTasks.filter((task) => task.id !== taskId);
    const matches = findDuplicateTitles(rawTitle, others);
    if (matches.length === 0) return null;

    const totalCount = matches.length;
    // 回显口径 = 与依赖引导同款的「结构化前 N 条」（`totalCount` 报全量）
    const echoed = matches.slice(0, TITLE_MATCH_RETURN_CAP).map((match) => ({
      id: match.candidate.id,
      title: match.candidate.title,
      status: match.candidate.status,
      // 撞的是**本请求同批刚建**的卡（文案不区分，data 区分——批内互撞与历史撞题是不同的处置）
      sameBatch: batchTaskIds.has(match.candidate.id),
      // 软/硬命中透 data 供观测与 agent 自判（tier1 = 归一化等值；tier2a = 白名单装饰剥离后等值）
      matchedBy: match.matchedBy,
    }));

    // 文案的渲染取值（模板占位符 = TASK_NEAR_DUPLICATE_PLACEHOLDERS；**不是** data 的键集）：
    // titles 必须是**预拼串**（renderHintTemplate 对数组只会 String() 成逗号串）
    const titles = echoed.map((match) => match.title).join('、');
    const overflow = totalCount > TITLE_MATCH_RETURN_CAP ? `等 ${totalCount} 个` : '';

    return makeHintCandidate(
      TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
      'suggestion',
      taskId,
      // 信封 data 键集**封闭**（守卫 spec/e2e 断言）：结构化消费只读这里
      { taskId, boardId, matches: echoed, totalCount },
      renderTaskHintMessage(TASK_HINT.NEAR_DUPLICATE_SUSPECTED, {
        total: totalCount,
        titles,
        overflow,
      }),
    );
  }

  /**
   * 板级 open 候选（记忆化包装；`null` = **放弃**：巨板 或 查询失败）。
   *
   * 失败也被缓存：同一次 build 里同一板重复同一失败查询毫无意义（与 `loadTaskStatus` 同款）。
   */
  private loadBoardOpenTasks(
    boardId: string,
    cache: Map<string, Promise<readonly Task[] | null>>,
  ): Promise<readonly Task[] | null> {
    const cached = cache.get(boardId);
    if (cached) return cached;
    const pending = this.scanBoardOpenTasks(boardId);
    cache.set(boardId, pending);
    return pending;
  }

  /**
   * 同板**未关闭**任务的扫描（`LIMIT 501`；铁律 #23 的 SQL 下沉纪律）。
   *
   * 条件（**逐条都必须在 SQL 里**，理由同 TASK-HYG-3）：
   * - `bl.board_id = :boardId`：跨板不判（不同板的同名任务往往是不同的事）；join 用
   *   `BoardList` **实体类**（不是裸表名）——由 TypeORM 解析成真表名，"task.list_id" 与
   *   列名都由命名策略保证一致；
   * - `t.deleted_at IS NULL`：**软删任务不算**（显式写出，不依赖 ORM 隐式条件——
   *   `Task.deletedAt` 是 `select: false`，靠 JS 侧过滤恒失效）；
   * - `t.status NOT IN (done, archived)`：完成的活不再是「在办」，撞题无意义；
   * - `ORDER BY t.created_at ASC, t.id ASC`：**原始卡优先展示**（撞重时读者最需要看到的是
   *   最早建的那张），`t.id` 兜住同 created_at 的确定性（PG 返回序随扫描策略变化）；
   * - `LIMIT 501`：超 500 行 ⇒ 判「巨板」放弃（`> BOARD_OPEN_TASK_SCAN_LIMIT`）。
   *   ⚠️ LIMIT 只约束**结果集**、不约束扫描成本：`ORDER BY created_at` 无索引时是
   *   Θ(板内任务数) 的排序（已知悉，巨板优化留待部分索引候选卡）。
   *   ⚠️ **边界松弛（登记）**：结果集**含本任务自己**（selfId 剔除在 per-fact 层，见 TASK-HYG-4），
   *   故「板内恰好 500 张其它 open 卡 + 自己 = 501 行」会被判成巨板而放弃（少提示一次，方向安全：
   *   宁可不提示）。若要精确需把 `t.id <> :selfId` 下沉 SQL——那会重新引入批内互撞的漏报，
   *   故**刻意不修**，只在此登记。
   *
   * @returns 板级候选（≤500 行）；超限 → `null`（warn 落点 + 放弃结论入缓存）
   */
  private async scanBoardOpenTasks(boardId: string): Promise<readonly Task[] | null> {
    const rows = await this.tasks
      .createQueryBuilder('t')
      .innerJoin(BoardList, 'bl', 'bl.id = t.list_id')
      .where('bl.board_id = :boardId', { boardId })
      .andWhere('t.deleted_at IS NULL')
      .andWhere('t.status NOT IN (:...closedStatuses)', {
        closedStatuses: [...BOARD_CLOSED_STATUSES],
      })
      // 只取判定与回显需要的三列（**不取 description/正文**，见文件头不变量）
      .select(['t.id', 't.title', 't.status'])
      .orderBy('t.created_at', 'ASC')
      .addOrderBy('t.id', 'ASC')
      .limit(BOARD_OPEN_TASK_SCAN_LIMIT + 1)
      .getMany();

    if (rows.length > BOARD_OPEN_TASK_SCAN_LIMIT) {
      // 固定前缀 warn（观测位；不含标题等任何用户内容）。生产实测最大板 435 open ⇒ 今天不可达
      this.logger.warn(
        `[TASK_HYGIENE_HINT_BOARD_TOO_LARGE] boardId=${boardId} rows>${BOARD_OPEN_TASK_SCAN_LIMIT}`,
      );
      return null;
    }
    return rows;
  }

  /**
   * 状态变更事实 → 候选（**可能两条**：完工缺证据 + 依赖引导）。
   *
   * 同一事实两条码的分工：`toStatus==done` 时两条都可能命中（完工缺证据 = 结果侧；
   * 依赖引导 = 下游侧），二者 `resourceKey` 不同（`taskId` vs `taskId:done`）⇒ 都送达。
   *
   * @param payload `{ taskId, boardId?, fromStatus, toStatus }`
   * @param statusCache 调用级状态点查记忆化
   */
  private async evaluateStatusChanged(
    payload: Record<string, unknown> | undefined,
    statusCache: Map<string, Promise<Task | null>>,
  ): Promise<readonly HintCandidate[]> {
    const doneWithoutReport = await this.evaluateDoneWithoutReport(payload, statusCache);
    const dependentsPending = await this.evaluateDependentsPending(payload, statusCache);
    return [
      ...(doneWithoutReport ? [doneWithoutReport] : []),
      ...(dependentsPending ? [dependentsPending] : []),
    ];
  }

  /**
   * 记忆化状态点查（同 build 内同 taskId 只打一次；失败也被缓存——重复同一失败无意义）。
   *
   * 只 select `id`/`status`：判据不需要其余列，**尤其不需要正文**（见文件头不变量）。
   */
  private loadTaskStatus(
    taskId: string,
    cache: Map<string, Promise<Task | null>>,
  ): Promise<Task | null> {
    const cached = cache.get(taskId);
    if (cached) return cached;
    const pending = this.tasks.findOne({ where: { id: taskId }, select: ['id', 'status'] });
    cache.set(taskId, pending);
    return pending;
  }

  /**
   * `task.status_changed` → `task_done_without_report`（**证据缺失**判据，见 TASK-HYG-1）。
   *
   * 判据三步（任一不成立即放弃）：
   * ① 载荷 `toStatus` 归一为 `done`（ci 比对——事实是领域语言，不保证大小写）；
   * ② 回库确认任务**当前**仍是 done（判空 + 一致性，铁律 #22）；
   * ③ 证据缺失 = 评论数 0 ∧ 指向未软删 doc 的关联数 0。
   *
   * @param payload `{ taskId, boardId?, fromStatus, toStatus }`
   * @param statusCache 调用级状态点查记忆化
   */
  private async evaluateDoneWithoutReport(
    payload: Record<string, unknown> | undefined,
    statusCache: Map<string, Promise<Task | null>>,
  ): Promise<HintCandidate | null> {
    const taskId = readId(payload, 'taskId');
    const toStatus = readId(payload, 'toStatus');
    if (!taskId || !toStatus) return null;
    // ci 比对：事实由 service 用领域语言写（值域 = TaskStatus），不假设大小写形态
    if (toStatus.toLowerCase() !== TaskStatus.DONE.toLowerCase()) return null;

    const task = await this.loadTaskStatus(taskId, statusCache);
    if (!task || task.status !== TaskStatus.DONE) return null; // 判空 + 回库一致性

    const commentCount = await this.comments.count({ where: { taskId } });
    if (commentCount > 0) return null; // 「有过任何评论」永久豁免（刻意窄化，见文件头不变量）

    const linkCount = await this.countAliveDocLinks(taskId);
    if (linkCount > 0) return null; // 有可用文档证据 ⇒ 不必提醒

    return makeHintCandidate(TASK_HINT.DONE_WITHOUT_REPORT, 'suggestion', taskId, {
      taskId,
      commentCount,
      docLinkCount: linkCount,
    });
  }

  /**
   * `task.status_changed` → `task_dependents_pending`（下游仍在办的 blocks 依赖）。
   *
   * 判据四步（任一不成立即放弃；**不抛**）：
   * ① 载荷 `toStatus` ci 归一 ∈ {review, done}（**归一值**同时用于 resourceKey 与 data，
   *    保持「同一状态只有一种机器表示」）；
   * ② 回库确认任务**当前**状态 === 该归一值（判空 + 一致性，铁律 #22——同一请求里
   *    可能先 review 再挪走）；
   * ③ 下游在办条数 = **SQL 下沉**查询（见 {@link countBlockingDependents}）为 0 ⇒ 一切正常，
   *    不产出（「下游都办完了」不是提示素材）；
   * ④ 回显取 `take 3`（`totalCount` 报全量）。
   *
   * @param payload `{ taskId, boardId?, fromStatus, toStatus }`
   * @param statusCache 调用级状态点查记忆化
   */
  private async evaluateDependentsPending(
    payload: Record<string, unknown> | undefined,
    statusCache: Map<string, Promise<Task | null>>,
  ): Promise<HintCandidate | null> {
    const taskId = readId(payload, 'taskId');
    const rawToStatus = readId(payload, 'toStatus');
    if (!taskId || !rawToStatus) return null;
    const toStatus = rawToStatus.toLowerCase();
    if (!DEPENDENTS_PENDING_STATUSES.includes(toStatus)) return null;

    const task = await this.loadTaskStatus(taskId, statusCache);
    // 判空 + 回库一致性（字段值域 = TaskStatus 字面量，故 ci 比对安全）
    if (!task || String(task.status).toLowerCase() !== toStatus) return null;

    const totalCount = await this.countBlockingDependents(taskId);
    if (totalCount === 0) return null; // 「一切正常」不提（非目标之一，见 docs/modules/hint-system.md §4.7）

    // 回显（同读面口径）：`{id,title,status}` —— 与 `task_controller_find_dependents` 端点
    // 的嵌套投影逐字段同构（见文件头「回显口径例外」）；**正文永不入回显**
    const rows = await this.loadBlockingDependents(taskId);
    const dependents = rows.map((row) => ({
      id: row.task.id,
      title: row.task.title,
      status: row.task.status,
    }));

    // 文案的渲染取值（模板占位符 = task-hint.constants.ts 的
    // TASK_DEPENDENTS_PENDING_PLACEHOLDERS；**不是**信封 data 的键集）
    const titles = dependents.map((dependent) => dependent.title).join('、');
    const overflow = totalCount > DEPENDENTS_RETURN_CAP ? `等 ${totalCount} 个` : '';

    return makeHintCandidate(
      TASK_HINT.DEPENDENTS_PENDING,
      'suggestion',
      // resourceKey 带 toStatus：review 与 done **各送达一次**；同一状态 6h 内横跳被压制
      `${taskId}:${toStatus}`,
      // 信封 data 键集**封闭**（守卫 spec/e2e 断言）：结构化消费只读这里
      {
        taskId,
        toStatus,
        dependencyType: TaskDependencyType.BLOCKS,
        dependents,
        totalCount,
      },
      // 模板渲染（同居 helper；缺键 → 空串兜底，不泄 undefined）
      renderTaskHintMessage(TASK_HINT.DEPENDENTS_PENDING, {
        toStatus,
        total: totalCount,
        titles,
        overflow,
      }),
    );
  }

  /**
   * 「在等本任务」的下游依赖基准查询（**同一套 SQL 条件**供 count 与 list 复用）。
   *
   * 条件（逐条对照 TASK-HYG-3 的踩坑）：
   * - `dep.depends_on_task_id = :taskId`：本任务是**被依赖方**（`dep.task` 即下游）；
   * - `dep.dependency_type = 'blocks'`：**只有 blocks 算「在等它」**——`relates_to` 是
   *   关联标记、`duplicates` 是去重标记，二者都不表达「下游的开工被它挡住」，把它们算进
   *   来会让提示在纯关联任务上误报；
   * - `t.deleted_at IS NULL`：**软删下游不算**（显式写出，不依赖 ORM 隐式条件——
   *   `Task.deletedAt` 是 `select: false`，靠 JS 侧过滤恒失效）；
   * - `t.status NOT IN (done, archived)`：已完成/已归档的下游不「在等它」。
   */
  private buildBlockingDependentsQuery(taskId: string) {
    return this.dependencies
      .createQueryBuilder('dep')
      .innerJoinAndSelect('dep.task', 't', 't.deleted_at IS NULL')
      .where('dep.depends_on_task_id = :taskId', { taskId })
      .andWhere('dep.dependency_type = :type', { type: TaskDependencyType.BLOCKS })
      .andWhere('t.status NOT IN (:...doneStatuses)', {
        doneStatuses: [...DEPENDENT_DONE_STATUSES],
      });
  }

  /**
   * 下游**在办** blocks 依赖的条数（SQL 下沉的 count 与上面的 list 同条件）。
   *
   * 为什么 count 与 list 分开而不共用一次 `getManyAndCount`：两者的**消费目的不同**
   * （count 决定「提不提」，list 决定「回显哪几条」），且 list 有 `take` —— TypeORM 的
   * `getManyAndCount` 在带 `take` 时 count 侧不会被 `take` 污染，但显式分离让「total 是全量」
   * 这件事在代码里可见（`take` 只影响回显）。
   */
  private countBlockingDependents(taskId: string): Promise<number> {
    return this.buildBlockingDependentsQuery(taskId).getCount();
  }

  /**
   * 下游**在办** blocks 依赖的回显行（`take 3`；顺序钉 `t.id ASC` 保证确定性——
   * PG 的返回序随扫描策略变化，不排序会让同一请求两次给出不同标题串）。
   */
  private loadBlockingDependents(taskId: string): Promise<TaskDependency[]> {
    return this.buildBlockingDependentsQuery(taskId)
      .orderBy('t.id', 'ASC')
      .take(DEPENDENTS_RETURN_CAP)
      .getMany();
  }

  /**
   * `task.comment_added` → `comment_on_done_task`（`via='report'` 豁免，见文件头不变量）。
   *
   * @param payload `{ taskId, commentId, via? }`（**不带正文**——本 provider 不读正文）
   * @param statusCache 调用级状态点查记忆化
   */
  private async evaluateCommentOnDoneTask(
    payload: Record<string, unknown> | undefined,
    statusCache: Map<string, Promise<Task | null>>,
  ): Promise<HintCandidate | null> {
    const taskId = readId(payload, 'taskId');
    if (!taskId) return null;
    // 豁免必须在**最前面**（早退，零查库）：report 补证评论是完成流程的一部分
    if (readId(payload, 'via') === VIA_REPORT) return null;

    const task = await this.loadTaskStatus(taskId, statusCache);
    if (!task || task.status !== TaskStatus.DONE) return null; // 判空 + 只在已完工时提示

    return makeHintCandidate(TASK_HINT.COMMENT_ON_DONE_TASK, 'suggestion', taskId, { taskId });
  }

  /**
   * 指向**未软删** doc 的关联条数（真 PG join；铁律 #23 的实例——软删语义靠 join 条件）。
   *
   * `task_doc_links` 是裸 uuid 无 FK 的中间表（见实体注释）：不加 `doc.deleted_at IS NULL`
   * 就会把「文档已软删」算成证据，提示静默消失且无观测面（见 TASK-HYG-1）。
   *
   * @returns 关联条数（≥0；任务不存在时为 0）
   */
  private countAliveDocLinks(taskId: string): Promise<number> {
    return this.docLinks
      .createQueryBuilder('link')
      .innerJoin(Doc, 'doc', 'doc.id = link.doc_id AND doc.deleted_at IS NULL')
      .where('link.task_id = :taskId', { taskId })
      .getCount();
  }
}
