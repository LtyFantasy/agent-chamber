/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 检索中文根治（路线 A / CJK 单字化）批次 1-a：**DB 侧单字化向量迁移**——
 *     建 `cjk_unigram_text()` + 换 4 张检索表 search_vector 触发器函数体 + 4 表
 *     全量回填（本批只带这一条 pending 迁移）
 *
 * [代码职责]
 *   - up（单事务，顺序写死，计划 §3-8/§5）：建函数 → 换 4 触发器 → doc_sections
 *     回填+随表零差异自校验 → experience_entries 回填+自校验 → DISABLE
 *     trg_messages_updated_at / trg_tasks_updated_at → messages/tasks 回填+自校验
 *     → ENABLE
 *   - down（与 up 配对，顺序写死）：恢复 4 旧触发器函数体 → doc_sections 旧算法
 *     回填+自校验 → experience 旧算法回填+自校验 → DISABLE → 两小表旧算法回填
 *     +自校验 → ENABLE → 最后 DROP 函数
 *
 * [权威文档]
 *   - 主文档: 检索中文根治计划终稿 v1.5 §2.1（函数/类清单/剥离族规格）+ §5（迁移
 *     策略；函数体文本以此为准，逐字不得改写）
 *   - 补充: scripts/search-eval/census/REPORT.md §4.3/§7.1（R-1 收窄与 K-gate 泄漏
 *     证据）；src/common/utils/search/tsquery-compiler.ts — 查询侧同一类清单单源
 *
 * [关键不变量]
 *   - **函数体文本 = 计划 §2.1 逐字**：`regexp_replace(translate(COALESCE(t,''),
 *     <剥离族>, ''), '([<类清单>])', ' \1 ', 'g')`——**两侧插分隔**（`'\1 '` 会把
 *     `token续期` → `token续` 回归；已验修）。类清单 = CJK 基本区 U+4E00–9FEF +
 *     扩展 A U+3400–4DB5（**上界收窄 = 最后词字**，F3：端点未赋值码点 = parser
 *     分隔符，留在①内 arm 退化、K-gate 泄漏在端点重开）+ 词字枚举 々/〆/〇/〱-〵/〻
 *     + 假名 ぁ-ゖァ-ヺ + ー U+30FC。
 *   - **剥离族 = 恰好 6 个字符**（U+200B/200C/200D/FE0E/FE0F/20E3，与查询侧
 *     normalizeQuery 同表）。⚠️ TRANSLATE-NO-RANGE：`translate` 无区间语法，散文
 *     记号 `U+200B–200D` 会把 `–`/`U`/`+`/字母数字全当删除集（实测
 *     `translate('A1B','U+200B–200D','')='A1'` 静默毁数据）；源码直接粘贴 6 个
 *     不可见字形会被编辑器/工具链静默改写 ⇒ 本文件以 `chr()` 显式拼接落同一组
 *     码点（语义逐字一致；黄金值 `A1B` 原样 + `1️⃣`→`1` 专防，见 §6/演练报告）。
 *   - **回填表达式与触发器体同一文本**（实测触发器不覆盖 SET ⇒ 回填是唯一事实源；
 *     禁 `WHERE search_vector IS NULL`；先换函数再回填）。本文件以成对常量
 *     （`*_BACKFILL_EXPR` ↔ 触发器体内 `NEW.` 形态）承载——改一侧必须改另一侧，
 *     迁移内自校验（`IS DISTINCT FROM` count=0 否则 RAISE）会抓住漂移。
 *   - **messages/tasks 回填必须在 DISABLE updated_at 触发器之后、ENABLE 之前**
 *     （否则两表全量 updated_at 被冲成 NOW()，不可逆且 API 可见）；DISABLE 取
 *     ShareRowExclusiveLock = 写阻塞读不断 ⇒ 两小表回填挪最后，锁窗 = 两小表
 *     回填+校验时长（自校验随表紧跟，窗口内不含两大表校验）。
 *   - **普通 DDL，禁止 `transaction = false`**（本仓缺省 transaction='all'，整批
 *     pending 迁移共用一个事务；显式 override 会抛
 *     ForbiddenTransactionModeOverrideError——先例见 1790200000000 文件头）。
 *     本迁移全部产物（函数/DISABLE/回填）在 PG 中本就可事务化，契合单事务设计。
 *   - **VACUUM/REINDEX 禁止进迁移事务**（部署后置，见计划 §3-12/§5）。
 *
 * [关联代码]
 *   - src/common/utils/search/tsquery-compiler.ts — 查询侧同一三元类清单/剥离族单源
 *   - src/common/utils/search/search-sql.ts — headlineExpr 引用 `cjk_unigram_text(`
 *     （批次 1 消费方接线后才在真库执行）
 *   - src/database/pg-session-defaults.ts — 连接级 pg_trgm 阈值单源（本迁移不涉及）
 *   - test/migration-drift-baseline.txt — 漂移门禁（函数/触发器属其盲区，见文件头；
 *     本迁移预期零 baseline 变更，守卫 = 演练库黄金值/触发器体断言）
 *   - scripts/search-eval/migration-1a-report.md — 演练库全流程验证报告
 *
 * [持久踩坑]
 *   - UPDATED-AT-BACKFILL(回填冲时间戳): 任何 messages/tasks 全量 UPDATE 若不禁
 *     `trg_*_updated_at` ⇒ updated_at 全量冲成 NOW()（不可逆、API 可见）。安全方向:
 *     本迁移 up/down 都把两小表回填夹在 DISABLE/ENABLE 之间；**部署后置的幂等
 *     重跑复验必须复用同一段 DISABLE/ENABLE + 同一回填表达式文本**（计划 §3-12）。
 *   - TRANSLATE-NO-RANGE(剥离族写法): 见 [关键不变量]——黄金值 `cjk_unigram_text(
 *     'v1.85.0 X-API-Key')` 原样返回 + `cjk_unigram_text('A1B')='A1B'` 是专防锚点。
 *
 * [铁律关联] #7(编译优先) #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 函数体/类清单/剥离族变更 = schema 级不变量变更：同步查询侧编译器单源 +
 *     评估集重跑 + 演练库黄金值回归
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 检索中文根治批次 1-a：CJK 单字化向量迁移。
 *
 * 机制（计划 §2.1）：`cjk_unigram_text()` 对检索文本先做零宽/变体族剥离，再对
 * ① 可分字脚本（CJK/假名/词字枚举）逐字**两侧**插入空格——`to_tsvector('simple',…)`
 * 因此把每个 CJK 字切为独立 token（原文整段连写 = 1 token，子词匹配原理上不可能）。
 * 4 触发器函数体统一改写为最外层包 `cjk_unigram_text(…)`（COALESCE/列拼接结构原样
 * 保留），回填表达式与触发器体同一文本。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 函数体与表达式单源（up/down/自校验共用；改动任一 = 契约变更）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `cjk_unigram_text` 建函数 DDL（计划 §2.1 逐字规格；IMMUTABLE + schema 限定 public +
 * PARALLEL SAFE——纯文本变换无副作用无 DB 访问，显式标注避免「查询树含 unsafe 函数
 * ⇒ 全查询强制串行计划」的隐患）。
 *
 * 实现注记：剥离族 6 字符以 `chr()` 显式拼接（8203=U+200B、8204=U+200C、8205=U+200D、
 * 65038=U+FE0E、65039=U+FE0F、8419=U+20E3）——与「6 个字面字符」语义逐字一致；
 * 不用字面粘贴（不可见字形会被工具链改写）也不用散文区间（TRANSLATE-NO-RANGE）。
 * 类清单字面量逐字 = `一-龏`(U+4E00–9FEF) `㐀-䶵`(U+3400–4DB5) `々`(3005) `〆`(3006)
 * `〇`(3007) `〱-〵`(3031–3035) `〻`(303B) `ぁ-ゖ`(3041–3096) `ァ-ヺ`(30A1–30FA) `ー`(30FC)。
 */
const CREATE_CJK_UNIGRAM_TEXT = `
CREATE FUNCTION public.cjk_unigram_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $func$
  SELECT regexp_replace(
    translate(
      COALESCE(t, ''),
      chr(8203) || chr(8204) || chr(8205) || chr(65038) || chr(65039) || chr(8419),
      ''
    ),
    '([一-龏㐀-䶵々〆〇〱-〵〻ぁ-ゖァ-ヺー])',
    ' \\1 ',
    'g'
  );
$func$
`;

/**
 * 四表检索文本拼接表达式（回填/自校验形态，列名无前缀）。
 * ⚠️ 与各触发器函数体内的 `NEW.` 前缀形态**必须保持同一文本**（唯一事实源约束；
 * 迁移内自校验会抓住两侧漂移）。
 */
const DOC_SECTIONS_SOURCE = `COALESCE(heading_path, '') || ' ' || COALESCE(content, '')`;
const EXPERIENCE_SOURCE =
  `COALESCE(title, '') || ' ' || ` +
  `COALESCE(summary, '') || ' ' || ` +
  `COALESCE(array_to_string(signals, ' '), '') || ' ' || ` +
  `COALESCE(array_to_string(domains, ' '), '') || ' ' || ` +
  `COALESCE(content, '')`;
const MESSAGES_SOURCE = `COALESCE(content, '')`;
const TASKS_SOURCE = `COALESCE(title, '') || ' ' || COALESCE(description, '')`;

/** 新算法向量表达式（回填/自校验共用） */
const newVectorExpr = (source: string): string =>
  `to_tsvector('simple', cjk_unigram_text(${source}))`;

/** 旧算法向量表达式（down 回填/自校验共用） */
const oldVectorExpr = (source: string): string => `to_tsvector('simple', ${source})`;

/**
 * 随表零差异自校验（`IS DISTINCT FROM` count=0 否则 RAISE——计划 §3-8 写死形态；
 * 注意 NULL 安全：search_vector 为 NULL 的行也会被 IS DISTINCT FROM 抓住）。
 */
const selfCheckSql = (table: string, vectorExpr: string): string => `
DO $$
DECLARE mismatches bigint;
BEGIN
  SELECT count(*) INTO mismatches FROM ${table}
   WHERE search_vector IS DISTINCT FROM ${vectorExpr};
  IF mismatches <> 0 THEN
    RAISE EXCEPTION '${table} search_vector 回填零差异自校验失败: % 行不一致', mismatches;
  END IF;
END
$$
`;

// ═══════════════════════════════════════════════════════════════════════════
// 触发器函数体（up = 新算法；down = 旧算法——旧体与现网逐字一致，仅以库内
// pg_get_functiondef  dump 为准核对过，COALESCE/列拼接/守卫条件原样保留）
// ═══════════════════════════════════════════════════════════════════════════

const TRIGGER_DOC_SECTIONS_UP = `
CREATE OR REPLACE FUNCTION public.maintain_doc_section_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.heading_path IS DISTINCT FROM OLD.heading_path THEN
          NEW.search_vector := to_tsvector('simple',
            cjk_unigram_text(COALESCE(NEW.heading_path, '') || ' ' || COALESCE(NEW.content, ''))
          );
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_EXPERIENCE_UP = `
CREATE OR REPLACE FUNCTION public.maintain_experience_entry_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT'
           OR NEW.title IS DISTINCT FROM OLD.title
           OR NEW.summary IS DISTINCT FROM OLD.summary
           OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.signals IS DISTINCT FROM OLD.signals
           OR NEW.domains IS DISTINCT FROM OLD.domains THEN
          NEW.search_vector := to_tsvector('simple',
            cjk_unigram_text(COALESCE(NEW.title, '') || ' ' ||
            COALESCE(NEW.summary, '') || ' ' ||
            COALESCE(array_to_string(NEW.signals, ' '), '') || ' ' ||
            COALESCE(array_to_string(NEW.domains, ' '), '') || ' ' ||
            COALESCE(NEW.content, ''))
          );
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_MESSAGES_UP = `
CREATE OR REPLACE FUNCTION public.maintain_message_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content THEN
          NEW.search_vector := to_tsvector('simple', cjk_unigram_text(COALESCE(NEW.content, '')));
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_TASKS_UP = `
CREATE OR REPLACE FUNCTION public.maintain_task_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description THEN
          NEW.search_vector := to_tsvector('simple',
            cjk_unigram_text(COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.description, ''))
          );
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_DOC_SECTIONS_DOWN = `
CREATE OR REPLACE FUNCTION public.maintain_doc_section_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.heading_path IS DISTINCT FROM OLD.heading_path THEN
          NEW.search_vector := to_tsvector('simple',
            COALESCE(NEW.heading_path, '') || ' ' || COALESCE(NEW.content, '')
          );
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_EXPERIENCE_DOWN = `
CREATE OR REPLACE FUNCTION public.maintain_experience_entry_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT'
           OR NEW.title IS DISTINCT FROM OLD.title
           OR NEW.summary IS DISTINCT FROM OLD.summary
           OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.signals IS DISTINCT FROM OLD.signals
           OR NEW.domains IS DISTINCT FROM OLD.domains THEN
          NEW.search_vector := to_tsvector('simple',
            COALESCE(NEW.title, '') || ' ' ||
            COALESCE(NEW.summary, '') || ' ' ||
            COALESCE(array_to_string(NEW.signals, ' '), '') || ' ' ||
            COALESCE(array_to_string(NEW.domains, ' '), '') || ' ' ||
            COALESCE(NEW.content, '')
          );
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_MESSAGES_DOWN = `
CREATE OR REPLACE FUNCTION public.maintain_message_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content THEN
          NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
        END IF;
        RETURN NEW;
      END;
      $function$
`;

const TRIGGER_TASKS_DOWN = `
CREATE OR REPLACE FUNCTION public.maintain_task_search_vector()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description THEN
          NEW.search_vector := to_tsvector('simple', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.description, ''));
        END IF;
        RETURN NEW;
      END;
      $function$
`;

// ═══════════════════════════════════════════════════════════════════════════
// 迁移主体
// ═══════════════════════════════════════════════════════════════════════════

export class CjkUnigramSearchVector1791400000000 implements MigrationInterface {
  name = 'CjkUnigramSearchVector1791400000000';

  /**
   * up（单事务，顺序写死，计划 §3-8/§5）：
   * 建函数 → 换 4 触发器 → doc_sections 回填+自校验 → experience_entries 回填+
   * 自校验 → DISABLE 两小表 updated_at 触发器 → messages/tasks 回填+自校验 → ENABLE。
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 建函数（先换函数再回填——回填表达式依赖它在场）
    await queryRunner.query(CREATE_CJK_UNIGRAM_TEXT);

    // 2) 换 4 触发器函数体（CREATE OR REPLACE，触发器本体不动）
    await queryRunner.query(TRIGGER_DOC_SECTIONS_UP);
    await queryRunner.query(TRIGGER_EXPERIENCE_UP);
    await queryRunner.query(TRIGGER_MESSAGES_UP);
    await queryRunner.query(TRIGGER_TASKS_UP);

    // 3) doc_sections 回填 + 随表零差异自校验（禁 WHERE search_vector IS NULL——
    //    全量重建是唯一事实源；RowExclusiveLock，读不断）
    await queryRunner.query(
      `UPDATE doc_sections SET search_vector = ${newVectorExpr(DOC_SECTIONS_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('doc_sections', newVectorExpr(DOC_SECTIONS_SOURCE)));

    // 4) experience_entries 回填 + 自校验
    await queryRunner.query(
      `UPDATE experience_entries SET search_vector = ${newVectorExpr(EXPERIENCE_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('experience_entries', newVectorExpr(EXPERIENCE_SOURCE)));

    // 5) DISABLE 两小表 updated_at 触发器（ShareRowExclusiveLock = 写阻塞读不断；
    //    缩窗到两小表回填+校验，窗口内不含两大表）
    await queryRunner.query(`ALTER TABLE messages DISABLE TRIGGER trg_messages_updated_at`);
    await queryRunner.query(`ALTER TABLE tasks DISABLE TRIGGER trg_tasks_updated_at`);

    // 6) messages / tasks 回填 + 自校验（DISABLE 窗口内）
    await queryRunner.query(
      `UPDATE messages SET search_vector = ${newVectorExpr(MESSAGES_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('messages', newVectorExpr(MESSAGES_SOURCE)));
    await queryRunner.query(`UPDATE tasks SET search_vector = ${newVectorExpr(TASKS_SOURCE)}`);
    await queryRunner.query(selfCheckSql('tasks', newVectorExpr(TASKS_SOURCE)));

    // 7) ENABLE（锁窗结束）
    await queryRunner.query(`ALTER TABLE messages ENABLE TRIGGER trg_messages_updated_at`);
    await queryRunner.query(`ALTER TABLE tasks ENABLE TRIGGER trg_tasks_updated_at`);
  }

  /**
   * down（与 up 配对，顺序写死）：恢复旧函数体 → doc_sections 旧算法回填+自校验 →
   * experience 旧算法回填+自校验 → DISABLE → 两小表旧算法回填+自校验 → ENABLE →
   * 最后 DROP 函数。
   *
   * 注：两小表旧算法回填同样夹在 DISABLE/ENABLE 之间（与 up 同一纪律——否则 down
   * 会把 updated_at 冲成 NOW()）；`down()` 仅计划内反向操作，且必须配对后端回滚
   * （应用侧消费方依赖新向量的代码先回退，计划 §5）。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1) 恢复 4 旧触发器函数体
    await queryRunner.query(TRIGGER_DOC_SECTIONS_DOWN);
    await queryRunner.query(TRIGGER_EXPERIENCE_DOWN);
    await queryRunner.query(TRIGGER_MESSAGES_DOWN);
    await queryRunner.query(TRIGGER_TASKS_DOWN);

    // 2) doc_sections 旧算法回填 + 自校验
    await queryRunner.query(
      `UPDATE doc_sections SET search_vector = ${oldVectorExpr(DOC_SECTIONS_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('doc_sections', oldVectorExpr(DOC_SECTIONS_SOURCE)));

    // 3) experience_entries 旧算法回填 + 自校验
    await queryRunner.query(
      `UPDATE experience_entries SET search_vector = ${oldVectorExpr(EXPERIENCE_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('experience_entries', oldVectorExpr(EXPERIENCE_SOURCE)));

    // 4) DISABLE（同一 updated_at 纪律）
    await queryRunner.query(`ALTER TABLE messages DISABLE TRIGGER trg_messages_updated_at`);
    await queryRunner.query(`ALTER TABLE tasks DISABLE TRIGGER trg_tasks_updated_at`);

    // 5) messages / tasks 旧算法回填 + 自校验
    await queryRunner.query(
      `UPDATE messages SET search_vector = ${oldVectorExpr(MESSAGES_SOURCE)}`,
    );
    await queryRunner.query(selfCheckSql('messages', oldVectorExpr(MESSAGES_SOURCE)));
    await queryRunner.query(`UPDATE tasks SET search_vector = ${oldVectorExpr(TASKS_SOURCE)}`);
    await queryRunner.query(selfCheckSql('tasks', oldVectorExpr(TASKS_SOURCE)));

    // 6) ENABLE
    await queryRunner.query(`ALTER TABLE messages ENABLE TRIGGER trg_messages_updated_at`);
    await queryRunner.query(`ALTER TABLE tasks ENABLE TRIGGER trg_tasks_updated_at`);

    // 7) 最后 DROP 函数（顺序写死：一切引用清除之后再落）
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.cjk_unigram_text(text)`);
  }
}
