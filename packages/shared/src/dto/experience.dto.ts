/**
 * 经验库（Experience Base）— 输入 DTO 值域与列宽常量单源
 *
 * 本文件承载「写侧契约」的可共享部分：列长上限常量、env 指纹键白名单、排序值域。
 * 输入 DTO（Create/Patch/Search）在 backend `modules/experience/dto/` 落地并引用本文件
 * 的常量与类型，**禁止在 backend 另立一份同名常量**。
 *
 * 列宽常量落点对齐 `docspace.dto.ts` 的 DOC_TITLE_MAX_LENGTH/DOC_SUMMARY_MAX_LENGTH 先例
 * （列宽单源 = 模块的 shared DTO 文件；entity 列长装饰器 + DTO @MaxLength 共用一处）。
 */

// ─── 列宽上限（列宽单源）─────────────────────────────────

/**
 * 标题列长上限（experience_entries.title varchar(200)；plan v1.3 §1.1）
 *
 * 单源供两处引用：entity 列长装饰器 / Create-PatchExperienceDto @MaxLength。
 * ⚠️ 改此值必须配套 TypeORM migration 变更 experience_entries.title 列长
 * （生产库禁止直接改列，铁律 §0.2）。
 */
export const EXPERIENCE_TITLE_MAX_LENGTH = 200;

/**
 * 摘要列长上限（500；`experience_entries.summary` varchar(500)）
 *
 * rationale：列表投影**不含 content 全文**，摘要是消费方判断"值不值得点进详情"的唯一
 * 依据，故录入必填且要有界——超长值会让 PG 报 22001 而非业务 400（铁律 #21）。
 *
 * 与 TITLE/CONTENT 同处的原因：列宽单源 = 本文件（entity 列长装饰器 + DTO `@MaxLength`
 * 共用一处，禁在 backend 另立同名常量）。
 */
export const EXPERIENCE_SUMMARY_MAX_LENGTH = 500;

/**
 * 正文列长上限（65536 = 64KB，DTO 层超限 400；plan v1.3 §1.1）
 *
 * rationale：这是**产品上限**而不是技术硬限——PG `text` 列本身无长度限制，
 * tsvector 的技术天花板约 1MB（`to_tsvector` 对超长输入有截断），64KB 留约 10x
 * 余量。刻意卡在 DTO 层（而非 DB CHECK）以便调参不需要 migration：
 * 经验笔记是「一条症状一条笔记」，64KB 已远超单条经验的合理体量。
 */
export const EXPERIENCE_CONTENT_MAX_LENGTH = 65536;

// ─── env 环境指纹 ────────────────────────────────────────

/**
 * env 键白名单（experience_entries.env jsonb 的**受控键**；plan v1.3 §1.1/§2）
 *
 * 分面分类的核心取舍：**键受控、值开放**——键不收敛则同一环境指纹会被拆成无数写法
 * （os/osName/platform）无法做精确相等匹配；值开放是因为工具/运行时的取值域无法穷举。
 * 写侧强制：键白名单外一律 400 并回显本清单（plan §2「归一化」）；值侧 trim+lowercase。
 */
export const EXPERIENCE_ENV_KEYS = ['os', 'tool', 'version', 'runtime'] as const;

/** env 键名类型 */
export type ExperienceEnvKey = (typeof EXPERIENCE_ENV_KEYS)[number];

/**
 * 经验条环境指纹（experience_entries.env jsonb）
 *
 * 语义：记录者复现该问题时的环境快照；查询侧 envOs/envTool/envVersion/envRuntime
 * 四参数与键**精确相等**匹配（各参数之间是 AND，plan §2）。全部键可选——
 * 经验笔记允许只写「哪个工具 + 哪个版本」而不写操作系统。
 *
 * 键示例：os=`wsl2`/`ubuntu-22.04`；tool=`docker`/`next.js`；version=`15.18`/`v1.78.1`；
 * runtime=`node-20`/`python-3.11`。
 *
 * ⚠️ 键清单单源 = `EXPERIENCE_ENV_KEYS`（本类型从其派生，**禁再手抄一份键清单**）。
 * 注意还有第三处消费：migration 1790000000000 的 4 条 env 表达式索引——加/改键时
 * 索引侧必须同步（否则新键过滤退化为 Seq Scan，且该四条索引对漂移门禁不可见）。
 */
export type ExperienceEnv = Partial<Record<ExperienceEnvKey, string>>;

// ─── 排序值域 ────────────────────────────────────────────

/**
 * 列表排序模式（GET /experiences 的 sort 参数值域；plan v1.3 §3）
 *
 * - recent：`updated_at DESC`（缺省；无 q 无索引 = 有意取舍，小表 seq scan 正确，
 *   plan §1.3——**勿"顺手补索引"**）
 * - most_used：`distinct_helped_count DESC`（(entry,actor) 去重后的有效命中数）
 *
 * 命名与派生照 `docspace.dto.ts` 的 AppendPosition / APPEND_POSITION_VALUES 先例
 * （DTO 文件内的请求值域，与 enums/ 的封闭词表分居两处：本值域不落库）。
 */
export type ExperienceSort = 'recent' | 'most_used';

/** ExperienceSort 合法值清单（DTO @IsIn 校验与 MCP 工具 schema enum 共用，单一事实来源） */
export const EXPERIENCE_SORT_VALUES: readonly ExperienceSort[] = ['recent', 'most_used'];
