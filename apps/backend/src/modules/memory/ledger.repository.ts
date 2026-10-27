/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 账本（`memory_nominations`）的**重放读取器**：把"原样重发"所需的冻结列
 *     （`content` / `rationale`）一次性带出——引擎重放**永不重装配**
 *
 * [代码职责]
 *   - `findForReplay(id)`：按 id 取账本行的**重放投影**（含 `select:false` 的两列）
 *   - 文件头钉住"**重放必须走它**"：任何绕过它的重放路径都会因为 `select:false` 静默拿到
 *     空正文（见 [持久踩坑]）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3（"重放=账本冻结列原样重发
 *     （content/rationale 经 `findForReplay` 的 addSelect），**永不重装配**"）+ §7 恢复三通道
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: database/entities/memory-nomination.entity.ts — `select:false` 列的契约面
 *
 * [关键不变量]
 *   - **`addSelect(['content','rationale'])` 内建且不可省**：实体把这两列标了 `select: false`
 *     （大文本，列表查询不该白付 IO）。省略 = ORM 返回 `undefined` 而**不报错** ⇒ 重放会把
 *     "空正文"原样发给引擎（症状：引擎收到空 content，400/拒收，而排障会一路查网络）。
 *   - **唯一重放访问器**：重放（`retry` / `recover` / 启动扫描）**只准经本方法取数据**；
 *     需要"详情页也要正文"时另开显式投影方法，**不要**在本方法上加重载参数（重放语义一旦
 *     可被参数改变，就有第二次实现）。
 *   - **软删行不返回**（`deletedAt` 由 TypeORM 默认谓词排除）：重放的对象必须是**现存**主张。
 *   - **本类只读**：账本写入（状态迁移 / ids 回填）属服务层事务，不在读模型里做
 *     （读写混在一个"repository"里会让"系统态写入不顶 updated_at"这类约束无处安放）。
 *
 * [关联代码]
 *   - database/entities/memory-nomination.entity.ts — 实体（两列的 `select:false` 来源）
 *   - engines/memory-engine.interface.ts — `NominateMemoryInput`（重放的落点：content/rationale）
 *   - engines/hument.engine.ts — 幂等键 `chamber-<账本id>`（重放的键由账本 id 拼装）
 *   - modules/memory/memory.service.ts（coder C）— 重放/续跑/恢复三通道的调用点
 *
 * [持久踩坑]
 *   MEMORY-SELECT-FALSE(静默空正文): `select:false` 列在未 addSelect 时**不报错**，只是字段
 *     `undefined`——重放路径若用 `findOne` 裸取，会把 undefined/空串当正文发出（Hument 侧
 *     400 或形成一条空记忆），而栈里看不到任何异常。安全方向: 重放一律走本方法。
 *   MEMORY-JSONB-PREDICATE(jsonb 谓词): 本方法**不**按 `engine_memory_ids` / `source_refs`
 *     过滤（jsonb 嵌套条件 = 整列等值永不命中，铁律 #23）；映射类查询在应用层内存做。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改返回投影必须同步重放调用方（少一列 = 重放体缺字段，引擎侧才报错）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';

/**
 * 账本重放投影（**唯一重放读取面**）。
 *
 * 只暴露重放真正需要的列：正文 + 理由 + 幂等键来源 + 类别。其余（引擎 id / 状态）由调用方
 * 用别的方法按需读取——把它们塞进来只会让"重放不该改状态"这条约束更难守。
 */
export interface MemoryLedgerReplayRow {
  /** 账本行 id（**幂等键 `chamber-<账本id>` 的来源**） */
  id: string;
  /** 所属项目（重放时用于取绑定目标 workspace/actor/credential） */
  projectId: string;
  /** 形成正文（冻结原文；**永不重装配**） */
  content: string;
  /** 审计理由（冻结原文） */
  rationale: string;
  /** 记忆类别（引擎请求体 `category`） */
  category: string;
}

/**
 * 账本读取器（**重放的唯一入口**；见文件头不变量）。
 *
 * 为什么单独成一个 provider 而不是在服务里 `@InjectRepository` 裸用：
 * `addSelect(['content','rationale'])` 是**不变量**（漏了不报错、只是静默空正文），
 * 收敛到一个方法后，重放路径不可能"忘带列"（单测直接断言 addSelect 的实参）。
 */
@Injectable()
export class MemoryLedgerRepository {
  constructor(
    @InjectRepository(MemoryNomination)
    private readonly nominations: Repository<MemoryNomination>,
  ) {}

  /**
   * 取账本行的**重放投影**（含 `select:false` 的 content / rationale）。
   *
   * @param id 账本行 id（`memory_nominations.id`）
   * @returns 重放所需列；行不存在（或已软删）→ `null`
   */
  async findForReplay(id: string): Promise<MemoryLedgerReplayRow | null> {
    const row = await this.nominations
      .createQueryBuilder('nomination')
      // ⚠️ 不可省：content / rationale 是 select:false，漏掉即静默空正文（见文件头踩坑）
      .addSelect(['nomination.content', 'nomination.rationale'])
      .where('nomination.id = :id', { id })
      .getOne();

    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      content: row.content,
      rationale: row.rationale,
      category: row.category,
    };
  }
}
