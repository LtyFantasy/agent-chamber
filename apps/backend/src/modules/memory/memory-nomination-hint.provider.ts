/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 hint **拦截器通道的首个生产 provider**（v1.93.0-dev 阶段三：**通用触发**）：
 *     任一写路径（任务状态真实变更 / 新建任务评论 / 发送话题消息 / 单文档 upsert）之后，
 *     判断「本次写到的资源是否被 ≥1 个**活跃**记忆项目绑定」**且**「触发者对该资源有
 *     write 权限」——两者都成立 ⇒ 产出一条 `memory_nomination_suggested` 候选，由拦截器
 *     挂进响应 `data.hints[]`（advisory，绝不改变业务结果与状态码）。
 *   - **通用是缺省**（2026-10-12 Owner 拍板）：不读正文、不扫词——「这个资源上有值得进
 *     记忆的写入」本身就是提示理由。词表退为**可选精调层**（见下）。
 *   - service 侧只写领域事实（`emitFact('task.status_changed', { taskId, boardId, ... })`），
 *     **不出现任何 hint 概念**；本文件把事实翻译成提示（事实 vs 决策的切分）。
 *
 * [代码职责]
 *   - `build(facts, payload, ctx)`：按事实名逐条求值（四种事实见 `FACT_*` 常量），命中即
 *     产出候选；同响应内**同资源**的多个事实合并成**一条**候选（`data.projectIds` 取并集，
 *     顺序 = 事实序 + 每条查询内 id ASC——见 `findActiveProjectIds`）。
 *   - 成本纪律：一次 build 内折叠**完全重复**的事实 + 记忆化绑定查询 / 实体点查 / 权限判定
 *     （`BuildContext`，调用级）；折叠键的选型理由见 `foldDuplicateFacts` 注释。
 *   - 权限过滤：逐资源 `MemoryAccessService.resolveBinding` 的 `writable` 位（见决策 8 的
 *     等价性论证）——**不可写 ⇒ 不产出**，并落 `reason=permission_filtered` 的 debug 埋点。
 *   - `resolveMessage` / `familyOf` / `ttlOf`：全部委托领域单源（文案常量 / `'memory'` /
 *     `HintRegistry.ttlOf`）——本文件不写任何文案字面量。
 *   - `resolveNominationKeywordMode(env)`：**纯函数**解析词表精调层（缺省 = 通用）。
 *   - 绑定判定谓词 = `memory-binding-query.andWhereProjectBindingsContain`（与项目列表的
 *     `?bindingType=&bindingId=` 反查共用一份，见该文件头）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.1（通用触发 / doc 挂面 / 分母边界）、§5（观测）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」；
 *     AGENTS.md §5.3「记忆实验面消费纪律」（memory 分支）
 *
 * [关键不变量]
 *   - **永不抛**：`build` 的每条事实各自 try/catch（失败 warn 后跳过该事实，继续下一条），
 *     外层拦截器虽也兜一层，但那是最后防线、不是设计（抛 = 该挂面永久静默）。
 *   - **fail-closed 的身份缺省**（决策 7）：`ctx` 缺失或 `ctx.actor === null` ⇒ 视为匿名 ⇒
 *     write 判定必然不过 ⇒ **无候选** + `reason=permission_filtered` 埋点。这是**正确性
 *     修正**（不能把「不知道是谁」当成「有权提名」），不是兼容垫片。
 *   - **禁正文入日志 / 禁正文入 data**：warn 只落 fact 名 + 错误摘要；正文（任务描述 /
 *     评论 / 消息）是用户数据，日志与 `data` 都不承载它（`data` 里只有 id）。
 *     **通用模式从不读正文**——正文读取只发生在词表精调层命中时（决策 2/8 的成本收敛）。
 *   - **`data` 是结构化出口**（消费方**不要解析 message**），四字段：
 *     ① `projectIds`：命中的全部活跃项目 id（合并后并集，确定序）；
 *     ② `source`：本次写入的来源标识 `{ type, id }`——`type` 从事实名/资源形态推导
 *        （task.status_changed / task.comment_added ⇒ `task`；topic.message_sent ⇒ `topic`；
 *        doc.upserted ⇒ `doc`），`id` = 去重资源键（taskId / topicId / docId）；
 *     ③ `suggestedTool: 'memory_controller_list_nominations'`：查看该资源已提名记录的现成入口；
 *     ④ `suggestedParams`：③ 的可执行示例 `{ id, page, pageSize }`——`id` 取
 *        `projectIds[0]`（**取舍**：`list_nominations` 一次只查一个项目，而 `projectIds`
 *        是全集；给确定性首项当抓手，消费方可自行换其余 id），path 参数名 `id` 与
 *        controller `@Param('id')` / automcp 工具签名逐字一致。
 *   - **绑定判定必须走真实 containment**：谓词单源 = `memory-binding-query.ts`
 *     （铁律 #23：嵌套 jsonb 等值永不命中；mock 单测测不出 ORM 生成的 SQL ⇒ 由
 *     `test/memory-nomination-hint.e2e-spec.ts` 打真 PG 覆盖）。
 *   - **只认 `status='active'` + `deleted_at IS NULL` 的项目**：归档项目已退出当前工作
 *     语境（不再提示新裁决），软删项目视为不存在（与全模块"软删 = 不存在"同款）。
 *   - **同资源多事实去重成单候选**：候选的 `resourceKey` = taskId / topicId / docId，
 *     去重窗口 `(actor, code, resourceKey)` 的语义因此是「这条资源 10min 内提过一次就
 *     不再提」（窗口长度单源 = 注册表 `HintDefinition.ttlMs`）。
 *   - **节流不省 DB 开销是刻意取舍**：去重窗口在拦截器（候选层）生效，而绑定查询发生在
 *     候选构造**之前** ⇒ 命中事实的每次请求都会打库（成本口径见 MEM-NOM-1）。
 *     **预算为 0 时本 provider 仍被求值**（决策 5：观测「域侧挤占」的唯一途径）。
 *
 * [关联代码]
 *   - ../hints/hint.interceptor.ts — 消费方（`HintFactProvider` 契约 + fail-open 双层 +
 *     多 provider 合并求值）
 *   - ../hints/hint-registry.ts — code 元数据（`memory_nomination_suggested` 的 10min 窗口）
 *   - ../hints/hint-facts.ts — 事实袋（本文件输入的来源）
 *   - ../hints/hint-log.ts — `logHintSuppressed` + `HINT_SUPPRESS_REASON.permissionFiltered`
 *   - ./memory.constants.ts — `MEMORY_RULING_KEYWORDS` / `MEMORY_NOMINATION_HINT_CODE` /
 *     `MEMORY_NOMINATION_HINT_MESSAGE` 的**唯一真源**
 *   - ./memory-access.service.ts — 逐资源 write 判定（`resolveBinding().writable`）
 *   - ./memory-binding-query.ts — 绑定 containment 谓词（与列表反查共用）
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（kill switch 键
 *     `memory_nomination`）
 *   - ../task/task.service.ts / ../topic/topic.service.ts / ../docspace/doc.controller.ts —
 *     **四个 `emitFact` 挂点**（状态变更两条路径 / 评论 / 话题消息 / 单文档 upsert）
 *   - memory-nomination-hint.provider.spec.ts — 事实分支/词表两模式/权限过滤/委托的单测矩阵
 *
 * [持久踩坑]
 *   MEM-NOM-1(成本口径，阶段三修订): 每次命中事实的**上界** = ① 绑定 containment **顺序扫描**
 *     1 次/资源（`memory_projects.bindings` 刻意**不建 GIN 索引**——表极小，给几十行的表加
 *     索引与维护成本不成比例）；② 身份链 PK 点查 ≤2 次（评论事实：task → list）；③ 权限判定
 *     1 次/资源（`resolveBinding` 内部 = 1 次资源 PK 读 + 1 次 **policy write** 判定——
 *     只算 writable，read 位显式关闭，故 topic 的运行时白名单（3~4 条查询）不在本路径成本内）；
 *     ④ **仅精调模式**另付 1 次正文点查。
 *     **通用模式（缺省）不读正文**——这是阶段三相对阶段二的成本**下降**；
 *     **预算=0 时仍然付全部上述成本**（拦截器按决策 5 在 0 预算下也求值，用于观测域侧挤占）。
 *     重估条件 = 「绑定资源写 QPS 明显放大」（届时把窗口判定前置下沉）。
 *   MEM-NOM-2(事实与库的一致性): 事实载荷只信 id，**判据一律回库**（评论/消息可能被并发软删；
 *     任务的 listId/boardId 可能被并发移动）；回库读到 `null` ⇒ 放弃本次提示（`findOne` 判空，
 *     铁律 #22），绝不拿事实里的陈旧快照当判据。
 *   MEM-NOM-3(一次 build 的成本上界): ①**完全重复**的事实（同事实名 + 同载荷）先折叠
 *     ②绑定查询按 `type:id` 记忆化、实体点查按「实体:形态」记忆化、权限判定按 `type:id`
 *     记忆化（`BuildContext`，**调用级**不跨请求）。**刻意不按「事实名 + 资源 id」折叠**：
 *     精调模式下同一资源上的两条不同内容事实（同 task 两条评论 / 同 topic 两条消息）一旦
 *     折叠，就会出现"后一条命中裁决词、前一条不命中 ⇒ 提示静默丢失"的召回损失；hints 是
 *     advisory，宁可多查一次内容。
 *   MEM-NOM-4(触发链有**两条**状态事实源): 任务状态的真实变更来自 `task.service.update()`
 *     （PATCH status）与 `move()` 的 mappedStatus 自动联动——**后者曾漏挂**（P2-3）。
 *     新增任何"间接改状态"的写路径时，都要问一句"这条路径要不要 emit 事实"。
 *   MEM-NOM-5(doc 挂点的分母边界): `doc.upserted` 只由 **controller 单文档 upsert 入口**
 *     陈述（unchanged / 仅 rechunked / 幂等 replay 三者不 emit）——批量 upsert / patch /
 *     append / move 这些写口**不在本批分母内**（写进 hint-system.md §4.1）。分母不完整是
 *     已知且刻意的（先覆盖最高频的写口），不要拿"某路径没提示"当成 bug。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #22(findOne 判空)
 *   #23(jsonb 查询集成覆盖)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增事实类型 ⇒ `factNames` + `build` 分支 + 服务层 emitFact 挂点 + 单测矩阵四处齐步
 *   □ 改绑定判定 ⇒ 同步 memory-binding-query.ts 与 e2e（真 PG）
 *   □ 改权限判定口径 ⇒ 同步 MEM-NOM-1 的成本口径与 e2e（权限过滤用例）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MEMORY_PROJECT_STATUS } from '@agent-chamber/shared';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Message } from '../../database/entities/message.entity';
import { makeHintCandidate, type HintCandidate } from '../hints/hint-core';
// ⚠️ **值导入**：HintRegistry / MemoryAccessService 都是被注入的构造器参数
// （`import type` 会被 TS 擦除，emitDecoratorMetadata 退化成 Object ⇒ 启动期
// "can't resolve dependencies"）
import { HintRegistry } from '../hints/hint-registry';
import { MemoryAccessService } from './memory-access.service';
import { HINT_SUPPRESS_REASON, logHintSuppressed } from '../hints/hint-log';
import {
  MEMORY_NOMINATION_HINT_CODE,
  MEMORY_NOMINATION_HINT_MESSAGE,
  MEMORY_RULING_KEYWORDS,
} from './memory.constants';
import { andWhereProjectBindingsContain, type ProjectBindingNeedle } from './memory-binding-query';
import type { UnifiedActor } from '../../common/types/actor.types';
import type { HintFact } from '../hints/hint-facts';
import type { HintFactProvider, HintProviderContext } from '../hints/hint.interceptor';

/**
 * 事实名（服务层 `emitFact` 与本文件 `factNames` 的**同一批字面量**）。
 *
 * 为什么不把常量放 shared：事实名是**领域语言**（点分域名词），生产侧只有"service 写、
 * provider 读"两个点，且两侧都必须能独立编译（provider 在 memory 模块、挂点在
 * task/topic/docspace 模块）——跨模块常量会诱发反向依赖。漂移守卫 = e2e 的四条写路径
 * 用例（事实名打错 = 该路径永远无 hints，e2e 必红）。
 */
const FACT_TASK_STATUS_CHANGED = 'task.status_changed';
const FACT_TASK_COMMENT_ADDED = 'task.comment_added';
const FACT_TOPIC_MESSAGE_SENT = 'topic.message_sent';
const FACT_DOC_UPSERTED = 'doc.upserted';

/** 词表精调层的 env 键（逗号分隔关键词；`preset` = 内建 `MEMORY_RULING_KEYWORDS`） */
export const MEMORY_NOMINATION_HINT_KEYWORDS_ENV = 'MEMORY_NOMINATION_HINT_KEYWORDS';

/**
 * 词表精调层模式（决策 2 的三态）。
 *
 * - `generic`（**缺省**）：不读正文、不扫词——绑定 + 权限即触发；
 * - `preset`：env = `preset` ⇒ 用内建 `MEMORY_RULING_KEYWORDS`；
 * - `custom`：env = 逗号分隔词表 ⇒ 用调用方给的那一份。
 */
export type NominationKeywordMode =
  | { mode: 'generic' }
  | { mode: 'preset'; keywords: readonly string[] }
  | { mode: 'custom'; keywords: readonly string[] };

/**
 * 解析词表精调层（**纯函数**，显式入参不读 env——env 只在 `build` 里取一次）。
 *
 * 语义边界：空串 / 全空白 / 逗号分隔后无有效词 ⇒ 落 `generic`（**空词表不等于"什么
 * 都不提示"**，那会把 env 拼错变成静默关停——fail-open 到通用模式）。
 *
 * @param env 环境变量原值（`process.env.MEMORY_NOMINATION_HINT_KEYWORDS`）
 */
export function resolveNominationKeywordMode(env?: string): NominationKeywordMode {
  const raw = env?.trim();
  if (!raw) return { mode: 'generic' };
  if (raw.toLowerCase() === 'preset') {
    return { mode: 'preset', keywords: MEMORY_RULING_KEYWORDS };
  }
  const keywords = raw
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  if (keywords.length === 0) return { mode: 'generic' };
  return { mode: 'custom', keywords };
}

/** 一次事实求值的命中结果：`resourceKey`（去重键 = taskId / topicId / docId）+ 命中的活跃项目 id */
interface FactHit {
  /** 去重窗口资源键（与拦截器 `(actor, code, resourceKey)` 的第三段同源） */
  resourceKey: string;
  /** 命中的活跃记忆项目 id（通常 1 个，按 N 处理） */
  projectIds: string[];
}

/**
 * 事实**来源类型**（候选 `data.source.type` 的取值域）。
 *
 * 从事实名/资源形态推导：`task.status_changed` / `task.comment_added` ⇒ `task`；
 * `topic.message_sent` ⇒ `topic`；`doc.upserted` ⇒ `doc`。与 `data.source.id`
 * （= 去重资源键 resourceKey）一起给消费方一个**结构化的来源定位**
 * （**不要解析 message**），使「这条提示说的是哪个资源」不依赖文案措辞。
 */
export type ResourceSourceType = 'task' | 'topic' | 'doc';

/**
 * 一次事实求值的**绑定目标**：事实经身份链解析出的「被写的资源」。
 *
 * 把四种事实统一成同一形状后，绑定判定 / 权限判定 / 词表判定这三段**只写一遍**
 * （此前三条 evaluate 各写一遍，是漂移面）。
 */
interface ResourceTarget {
  /** 绑定反查条件（`{ type, id }`） */
  needle: ProjectBindingNeedle;
  /** 去重窗口资源键（taskId / topicId / docId） */
  resourceKey: string;
  /** 事实来源类型（候选 `data.source.type` 的取值域，见 {@link ResourceSourceType}） */
  sourceType: ResourceSourceType;
  /**
   * 正文读取器（**仅词表精调模式调用**）——通用模式从不触发 ⇒ 零正文读取。
   * 返回 `null` = 回库查不到（并发软删）⇒ 放弃本次提示（铁律 #22）。
   *
   * ⚠️ **缺读取器在精调模式下 = fail-closed**（P2-3）：它意味着事实没带正文实体 id
   * （如 `task.comment_added` 缺 `commentId`）⇒ 词表判据无从执行 ⇒ 不产出。
   * 唯一例外见 {@link keywordExempt}。
   */
  loadText?: () => Promise<string | null>;
  /**
   * **词表闸门豁免**（仅 `doc.upserted`）：该写口**没有正文读取器**（§4.1 要求零实体查询，
   * 事实只带 `{docId, spaceId}`）——若按缺读取器 fail-closed，词表精调模式会把整个 doc
   * 写口静默关掉。故它显式声明豁免：触发理由只有「被绑定 + 有 write 权限」这一条。
   *
   * **禁止**在别的写口用它——那些写口有正文实体 id，缺 id 属于事实畸形，应当 fail-closed。
   */
  keywordExempt?: boolean;
}

/**
 * 事实载荷里的 ID 读取（非字符串 / 空串 → `null`）。
 *
 * 事实袋的载荷约定是**扁平对象 + 标量优先**（见 hint-facts 的 `HintFact` 注释），
 * 这里对一切非字符串形态 fail-closed（不抛、不猜）。
 */
function readId(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 正文命中词表判定（**仅精调模式调用**；词表单源由调用方传入）。
 *
 * @param text 被扫描的正文（任务 = `title + '\n' + description`；评论 / 消息 = `content`）
 * @param keywords 生效词表
 * @returns true = 至少命中一个词
 */
function hitsKeywords(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * 一次 `build` 调用内的查询缓存。
 *
 * **调用级、不跨请求**：请求之间没有复用意义，跨请求缓存还会把"库里刚刚变了"的陈旧结果
 * 带进下一次提示判定（hint 是 advisory，但陈旧判据会把噪音带进信封）。
 */
interface BuildContext {
  /** 绑定查询记忆化：`${type}:${id}` → 活跃项目 id（圆桌一次 HTTP 多消息时省掉重复顺序扫描） */
  bindingCache: Map<string, Promise<string[]>>;
  /** 权限判定记忆化：`${type}:${id}` → 可写（同资源多条事实只判一次） */
  permissionCache: Map<string, Promise<boolean>>;
  /**
   * 已落过 `permission_filtered` 埋点的资源键（**调用级**）：同资源多条事实只落一行 debug，
   * 否则一次圆桌多消息会在日志里刷出 N 行同样的「不可提名」（观测噪音掩盖信号）。
   */
  permissionLogged: Set<string>;
  /** 实体点查记忆化：`${kind}:${id}` → 实体（同一实体的不同查询形态各自分键，见调用点） */
  entityCache: Map<string, Promise<unknown>>;
}

/**
 * 记忆化实体点查（同一 build 内同键只打一次库）。
 *
 * 失败同样被缓存——同一个失败查询被多条事实重复发起没有意义。每个 key 的 promise 都由
 * **发起它的那次调用立即 await**，故不存在"无人处理的 rejection"。
 */
function cachedFindOne<T>(
  ctx: BuildContext,
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const cached = ctx.entityCache.get(key) as Promise<T | null> | undefined;
  if (cached) return cached;
  const pending = load();
  ctx.entityCache.set(key, pending);
  return pending;
}

/**
 * 折叠**语义重复**的事实（同一动作在同一请求里被 emit 两次的形态：重试循环 / 重放路径）。
 *
 * 折叠键 = `事实名 + 载荷全等`，**刻意不按「事实名 + 资源 id」**：精调模式下一资源上的
 * 两条**不同内容**事实（同一 task 的两条评论、同一 topic 的两条消息）若被折叠，就会出现
 * "后一条命中裁决词、前一条不命中 ⇒ 提示静默丢失"的召回损失。hints 是 advisory——宁可多查
 * 一次内容，不可漏发；而那条真正昂贵的**绑定 containment 顺序扫描**由 {@link BuildContext}
 * 的记忆化收敛（N 条同绑定事实 → 1 次扫描），成本目标已达成。
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
 * 「该提名了」提示的 provider（见文件头不变量）。
 *
 * 生命周期 = 进程（Nest 单例，由 MemoryModule provide / AppModule 经 provider chain 注入）。
 */
@Injectable()
export class MemoryNominationHintProvider implements HintFactProvider<string> {
  private readonly logger = new Logger(MemoryNominationHintProvider.name);

  /** 本 provider 关注的事实名（与 task/topic/docspace 的 emitFact 字面量对齐） */
  readonly factNames: readonly string[] = [
    FACT_TASK_STATUS_CHANGED,
    FACT_TASK_COMMENT_ADDED,
    FACT_TOPIC_MESSAGE_SENT,
    FACT_DOC_UPSERTED,
  ];

  /** 产出面（进埋点 `surface`；词表见 hint-log，本值是 memory 侧新增项） */
  readonly surface = 'memory_nomination';

  constructor(
    @InjectRepository(MemoryProject) private readonly projects: Repository<MemoryProject>,
    // ⚠️ 这四个仓储的注册点 = memory.module.ts 的 forFeature（**不是这里**）：
    // 本 provider 由 MemoryModule provide，故 @InjectRepository 从该模块解析
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskComment) private readonly comments: Repository<TaskComment>,
    @InjectRepository(BoardList) private readonly lists: Repository<BoardList>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    private readonly registry: HintRegistry,
    // 逐资源 write 判定（决策 8）：同模块 provider（memory.module.ts 已注册）
    private readonly access: MemoryAccessService,
  ) {}

  /** 文案单源 = `MEMORY_NOMINATION_HINT_MESSAGE`（本文件不写字面量文案） */
  resolveMessage(): string {
    return MEMORY_NOMINATION_HINT_MESSAGE;
  }

  /** 族归属：memory 侧统一 `'memory'`（与注册表 `family` 字段同值） */
  familyOf(): string | null {
    return 'memory';
  }

  /**
   * 去重窗口长度：**单源 = 注册表**（`HintDefinition.ttlMs`；本 code = 10min）。
   *
   * 为什么由 provider 委托而不是拦截器直接查表：拦截器不认识 code（分层纪律），
   * 而 provider 持有 registry —— 于是「窗口长度」这个领域事实只在一处声明。
   */
  ttlOf(code: string): number | undefined {
    return this.registry.ttlOf(code);
  }

  /**
   * 事实 + 响应载荷 + 请求身份 → 候选（见文件头不变量）。
   *
   * 成本纪律：一次 build 内 ①**折叠语义重复的事实**（同一动作被 emit 两次的重试/重放形态）
   * ②**记忆化绑定查询 / 实体点查 / 权限判定**（`BuildContext`）。
   * 词表精调模式**每次 build 解析一次**（env 在进程内不变，但解析是纯函数、成本可忽略
   * ——不在构造期缓存，避免单测需要重建 provider）。
   *
   * @param facts 本请求事实袋快照（拦截器在响应封装前取出）
   * @param _payload handler 原始载荷（**本 provider 不读**——提示只依赖事实 + 库，
   *   与响应形状解耦；参数保留是为了满足 `HintFactProvider` 契约）
   * @param ctx 请求身份（**缺失 / actor=null ⇒ 匿名 ⇒ fail-closed 无候选**，见文件头不变量）
   * @returns 0..N 条候选（同资源合并；无命中 → 空数组，**不是**空占位）
   */
  async build(
    facts: readonly HintFact[],
    _payload: unknown,
    ctx?: HintProviderContext,
  ): Promise<readonly HintCandidate[]> {
    /** 命中的资源 → 命中项目 id 集 + 来源类型（同资源多事实合并成一条候选的容器） */
    const hits = new Map<string, { projectIds: Set<string>; sourceType: ResourceSourceType }>();
    /** 本 build 调用的查询缓存（见本方法注释的成本纪律） */
    const cache: BuildContext = {
      bindingCache: new Map(),
      permissionCache: new Map(),
      permissionLogged: new Set(),
      entityCache: new Map(),
    };
    /** 词表精调层（缺省 generic：不读正文） */
    const keywordMode = resolveNominationKeywordMode(
      process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV],
    );
    /** 请求身份（缺失 = 匿名；fail-closed 走 permission_filtered 埋点） */
    const actor: UnifiedActor | null = ctx?.actor ?? null;

    for (const fact of foldDuplicateFacts(facts)) {
      try {
        const target = await this.resolveTarget(fact, cache);
        if (!target) continue;
        const hit = await this.evaluateTarget(target, keywordMode, actor, cache);
        if (!hit) continue;
        const bucket = hits.get(hit.resourceKey) ?? {
          projectIds: new Set<string>(),
          // 同 resourceKey 必同来源（task/topic/doc 的 id 空间互不重合），取首个命中即可
          sourceType: target.sourceType,
        };
        for (const projectId of hit.projectIds) bucket.projectIds.add(projectId);
        hits.set(hit.resourceKey, bucket);
      } catch (error) {
        // per-fact fail-open：单条事实判不了不影响其余事实；日志只落 fact 名 + 错误摘要
        // （**禁正文**：正文是用户数据，见文件头不变量）
        this.logger.warn(
          `[MEMORY_NOMINATION_HINT_FACT_FAILED] fact=${fact.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return [...hits.entries()].map(([resourceKey, { projectIds, sourceType }]) => {
      const projectIdList = [...projectIds];
      return makeHintCandidate(MEMORY_NOMINATION_HINT_CODE, 'suggestion', resourceKey, {
        projectIds: projectIdList,
        // 来源标识：让消费方知道「这条提示说的是哪个资源」而不必解析 message
        source: { type: sourceType, id: resourceKey },
        suggestedTool: 'memory_controller_list_nominations',
        // ★ 取舍：`list_nominations` 一次只查一个项目，而 `projectIds` 是命中全集
        // （可能有多个绑定项目）——示例取**确定性首项**（= 事实序 + 每条查询内 id ASC），
        // 消费方可自行换其余 id 翻页/切换。path 参数名 `id` 与 controller
        // `@Param('id')` / automcp 工具签名逐字一致（不是 projectId）。
        suggestedParams: { id: projectIdList[0], page: 1, pageSize: 10 },
      });
    });
  }

  /**
   * 事实 → 绑定目标（**不认识的事实名 → `null`，不抛**）。
   *
   * 「解析目标」这一步只做身份链（拿 needle + resourceKey + 正文读取器），不做绑定/权限
   * 判定——那三段统一在 {@link evaluateTarget} 里。
   */
  private async resolveTarget(fact: HintFact, cache: BuildContext): Promise<ResourceTarget | null> {
    switch (fact.name) {
      case FACT_TASK_STATUS_CHANGED:
        return this.targetTaskStatusChanged(fact.payload, cache);
      case FACT_TASK_COMMENT_ADDED:
        return this.targetTaskCommentAdded(fact.payload, cache);
      case FACT_TOPIC_MESSAGE_SENT:
        return this.targetTopicMessageSent(fact.payload, cache);
      case FACT_DOC_UPSERTED:
        return this.targetDocUpserted(fact.payload);
      default:
        return null;
    }
  }

  /**
   * 目标 → 命中（绑定 → 权限 → 词表，三段串行；任一不过即放弃）。
   *
   * 顺序刻意如此：**绑定判定最便宜的前置闸门**（无绑定就没有提名的可能，连权限都不用判），
   * 权限判定第二（不可写 = 无权提名，词表扫不扫都一样），正文读取最后（**只在精调模式**）。
   *
   * @param target 身份链解析出的被写资源
   * @param keywordMode 词表精调层模式（generic ⇒ **不读正文**）
   * @param actor 请求身份（null = 匿名 ⇒ 权限判定必不过 ⇒ fail-closed）
   * @param cache 本 build 调用的查询缓存
   */
  private async evaluateTarget(
    target: ResourceTarget,
    keywordMode: NominationKeywordMode,
    actor: UnifiedActor | null,
    cache: BuildContext,
  ): Promise<FactHit | null> {
    const projectIds = await this.findActiveProjectIds(target.needle, cache);
    if (projectIds.length === 0) return null;

    const writable = await this.isResourceWritable(actor, target.needle, cache);
    if (!writable) {
      // 观测期区分「无绑定」与「不可提名」（决策 8）：本资源确实被活跃项目绑定，但触发者
      // 没有 write 权限 ⇒ 不产出。**不占去重窗口**（根本没送达），只是 debug 一行。
      this.logPermissionFiltered(target, actor, cache);
      return null;
    }

    // 词表精调层（决策 2 + P2-3）：通用模式直接放行，**不读正文**。精调模式下：
    // ① 有正文读取器 ⇒ 回库读并判词（`null` = 实体已并发软删 ⇒ fail-closed，铁律 #22）；
    // ② **无读取器** ⇒ 事实没带正文实体 id（如评论缺 commentId）⇒ 判据无从执行 ⇒
    //    fail-closed 不产出——**不再**默默跳过闸门（那会让"缺 id 的畸形事实"反而更宽松）；
    // ③ 例外 = `keywordExempt`（仅 doc.upserted：该写口无正文读取器，见字段注释）。
    if (keywordMode.mode !== 'generic' && target.keywordExempt !== true) {
      const text = target.loadText ? await target.loadText() : null;
      if (text === null) return null;
      if (!hitsKeywords(text, keywordMode.keywords)) return null;
    }

    return { resourceKey: target.resourceKey, projectIds };
  }

  /**
   * `task.status_changed`：事实自带 boardId（`Task` 实体**不存 boardId**，服务层已从
   * list→board 派生），故绑定判定无需父链。
   *
   * @param payload `{ taskId, boardId?, fromStatus, toStatus }`
   */
  private targetTaskStatusChanged(
    payload: Record<string, unknown> | undefined,
    cache: BuildContext,
  ): ResourceTarget | null {
    const taskId = readId(payload, 'taskId');
    const boardId = readId(payload, 'boardId');
    // boardId 缺失（list→board 派生失败）⇒ 无法判定绑定，放弃（不抛、不猜）
    if (!taskId || !boardId) return null;

    return {
      needle: { type: 'board', id: boardId },
      resourceKey: taskId,
      sourceType: 'task',
      // 正文读取器只在精调模式被调用；调用时回库读（事实不带正文，见 MEM-NOM-2）
      loadText: async () => {
        const task = await cachedFindOne(cache, `task:${taskId}:content`, () =>
          this.tasks.findOne({ where: { id: taskId }, select: ['id', 'title', 'description'] }),
        );
        if (!task) return null;
        return `${task.title}\n${task.description ?? ''}`;
      },
    };
  }

  /**
   * `task.comment_added`：评论 → task(listId) → list(boardId) 三段 PK 链
   * （comment 实体不存 boardId），任一环缺失即放弃。
   *
   * 阶段三起**不再预读评论正文**（那是内容读取）：身份链只走 task→list；正文仅在精调模式
   * 经 `loadText` 回库读（`comment.taskId` 与事实的一致性由「以事实 taskId 为链首」保证——
   * 评论挂在别的任务上时，我们读到的是那条任务的状态，语义仍然自洽）。
   *
   * @param payload `{ taskId, commentId, via? }`（**不带正文**：正文回库读，见 MEM-NOM-2）
   * @param cache 本 build 调用的查询缓存
   */
  private async targetTaskCommentAdded(
    payload: Record<string, unknown> | undefined,
    cache: BuildContext,
  ): Promise<ResourceTarget | null> {
    const taskId = readId(payload, 'taskId');
    const commentId = readId(payload, 'commentId');
    if (!taskId) return null;
    // 与状态变更路径**不同键**（查询形态不同：这里只要 listId）——见 cachedFindOne 注释
    const task = await cachedFindOne(cache, `task:${taskId}:list`, () =>
      this.tasks.findOne({ where: { id: taskId }, select: ['id', 'listId'] }),
    );
    if (!task) return null; // 判空（铁律 #22）

    const list = await cachedFindOne(cache, `list:${task.listId}`, () =>
      this.lists.findOne({ where: { id: task.listId }, select: ['id', 'boardId'] }),
    );
    if (!list) return null;

    return {
      needle: { type: 'board', id: list.boardId },
      resourceKey: taskId,
      sourceType: 'task',
      // 精调模式才读评论正文；**缺 commentId ⇒ 无读取器 ⇒ 精调模式 fail-closed**
      // （P2-3：之前注释说"视为不命中"但实现是跳过闸门直接产出，注释与实现相反——现已一致）
      ...(commentId
        ? {
            loadText: async () => {
              const comment = await cachedFindOne(cache, `comment:${commentId}`, () =>
                this.comments.findOne({ where: { id: commentId }, select: ['id', 'content'] }),
              );
              return comment ? comment.content : null;
            },
          }
        : {}),
    };
  }

  /**
   * `topic.message_sent`：话题**本身就是**绑定类型之一（topic / board / docSpace），
   * 故直接按 topicId 反查，无需父链。
   *
   * @param payload `{ topicId, messageId }`（**不带正文**：正文回库读，见 MEM-NOM-2）
   */
  private targetTopicMessageSent(
    payload: Record<string, unknown> | undefined,
    cache: BuildContext,
  ): ResourceTarget | null {
    const topicId = readId(payload, 'topicId');
    const messageId = readId(payload, 'messageId');
    if (!topicId) return null;

    return {
      needle: { type: 'topic', id: topicId },
      resourceKey: topicId,
      sourceType: 'topic',
      // 缺 messageId ⇒ 无读取器 ⇒ 精调模式 fail-closed（同评论面，见 P2-3）
      ...(messageId
        ? {
            loadText: async () => {
              const message = await cachedFindOne(cache, `message:${messageId}`, () =>
                this.messages.findOne({ where: { id: messageId }, select: ['id', 'content'] }),
              );
              return message ? message.content : null;
            },
          }
        : {}),
    };
  }

  /**
   * `doc.upserted`：**零实体查询**——事实自带 `spaceId` 与 `docId`，`docSpace` 本身就是
   * 绑定类型之一，故绑定判定只需 `{type:'docSpace', id: spaceId}` 逐字 containment。
   *
   * @param payload `{ docId, spaceId }`（controller 单文档 upsert 成功且非 unchanged/replay 时陈述）
   */
  private targetDocUpserted(payload: Record<string, unknown> | undefined): ResourceTarget | null {
    const docId = readId(payload, 'docId');
    const spaceId = readId(payload, 'spaceId');
    if (!docId || !spaceId) return null;

    return {
      needle: { type: 'docSpace', id: spaceId },
      resourceKey: docId,
      sourceType: 'doc',
      // 本写口**没有正文读取器**（零实体查询，见方法注释）⇒ 显式声明词表闸门豁免：
      // 若按「缺读取器 = fail-closed」处理，词表精调模式会把整个 doc 写口静默关掉（P2-3）
      keywordExempt: true,
    };
  }

  /**
   * 触发者能否**写**这个资源（决策 8 的等价性论证落地处）。
   *
   * 为什么"资源可写 ⟺ 项目可提名"：事实资源本身就是该项目 `bindings` 的一个元素，而项目的
   * `writable` 定义是「任一绑定可写」——本资源可写即足以让该项目可写；反之本资源不可写时
   * 也**不足以断定**项目整体不可写（别的绑定可能可写），故这里采取**事实粒度**的判定：
   * 写不了这条资源就不该提示"把它提名进记忆"（提名是写侧动作）。这个粒度更便宜也更诚实。
   *
   * @param actor 请求身份（null = 匿名 ⇒ 恒 false）
   * @param needle 绑定反查条件
   * @param cache 本 build 调用的查询缓存（同资源只判一次）
   */
  private isResourceWritable(
    actor: UnifiedActor | null,
    needle: ProjectBindingNeedle,
    cache: BuildContext,
  ): Promise<boolean> {
    // 匿名 ⇒ 直接 false（不查库；fail-closed，见文件头不变量）
    const resourceId = needle.id;
    if (!actor || !resourceId) return Promise.resolve(false);

    const cacheKey = `${needle.type}:${resourceId}`;
    const cached = cache.permissionCache.get(cacheKey);
    if (cached) return cached;

    const pending = (async (): Promise<boolean> => {
      // 值已在上方捕获（属性窄化在闭包内不保留）
      // 只消费 writable ⇒ 显式关掉 read 位：topic 的 read 走运行时白名单（3~4 条查询），
      // 本方法是**每条绑定 memory 的写事件**都会触发的热路径，不该为不读的位付这笔钱
      //（成本口径见文件头 MEM-NOM-1）。
      const resolved = await this.access.resolveBinding(actor, needle.type, resourceId, {
        read: false,
      });
      return resolved.writable;
    })();
    cache.permissionCache.set(cacheKey, pending);
    return pending;
  }

  /**
   * 该绑定命中的**活跃**记忆项目 id（`status='active'` + `deleted_at IS NULL` + containment）。
   *
   * 只 select `id`：绑定判据不需要其余列（`bindings` 是 jsonb，整行取回也无谓，但白拿不如不拿）。
   * **`ORDER BY project.id ASC`**：候选 `data.projectIds` 的顺序是契约的一部分——不排序时
   * PG 的返回序随扫描策略变化，同一请求两次可能不同。与列表端点 `findAll` 的
   * `project.created_at DESC, project.id ASC` 同款「总有确定性次序」纪律。
   *
   * @param needle 绑定反查条件（`{type, id}`）
   * @param ctx 本 build 调用的查询缓存（**同 key 只打一次库**——见 MEM-NOM-3）
   * @returns 命中的项目 id 数组（无命中 → 空数组；**恒返回数组**，调用方判长度）
   */
  private findActiveProjectIds(needle: ProjectBindingNeedle, ctx: BuildContext): Promise<string[]> {
    const cacheKey = `${needle.type}:${needle.id ?? ''}`;
    const cached = ctx.bindingCache.get(cacheKey);
    if (cached) return cached;

    const pending = (async (): Promise<string[]> => {
      const qb = this.projects
        .createQueryBuilder('project')
        .select(['project.id'])
        .where('project.status = :status', { status: MEMORY_PROJECT_STATUS.ACTIVE })
        .andWhere('project.deleted_at IS NULL')
        .orderBy('project.id', 'ASC');
      andWhereProjectBindingsContain(qb, 'project', needle);

      const rows = await qb.getMany();
      return rows.map((row) => row.id);
    })();

    ctx.bindingCache.set(cacheKey, pending);
    return pending;
  }

  /**
   * 权限不可达的 debug 埋点（**不占去重窗口**：根本没送达）。
   *
   * `reason` 值域单源 = `HINT_SUPPRESS_REASON.permissionFiltered`；`resourceKey` 是机器资源
   * id（taskId / topicId / docId），**不含用户原文**（见 hint-log 的标量纪律）。
   */
  private logPermissionFiltered(
    target: ResourceTarget,
    actor: UnifiedActor | null,
    cache: BuildContext,
  ): void {
    // 同资源只落一行（调用级记忆化；P3-2）——观测噪音收敛，且不改变任何判定
    if (cache.permissionLogged.has(target.resourceKey)) return;
    cache.permissionLogged.add(target.resourceKey);
    logHintSuppressed(this.logger, {
      code: MEMORY_NOMINATION_HINT_CODE,
      status: 'suggestion',
      family: 'memory',
      surface: this.surface,
      // spaceId 不在 provider 的判据里（绑定资源可能是 board/topic）；留 null 而不是猜
      spaceId: null,
      // 谁被过滤了（观测期最关心的维：匿名 → null；有身份 → 那个 actor id）
      actorId: actor?.id ?? null,
      resourceKey: target.resourceKey,
      reason: HINT_SUPPRESS_REASON.permissionFiltered,
    });
  }
}
