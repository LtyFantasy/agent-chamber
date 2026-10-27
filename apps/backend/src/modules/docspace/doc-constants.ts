/**
 * DocSpace 模块业务常量（单源收口，评审任务 ed67b65e 建立）
 *
 * 背景：no-magic-string-compare 黑名单要求比较运算引用常量而非字面量。
 * - DOC_SOURCE_NATIVE：doc.source 的 native 哨兵，review-0831 任务 8fab2a9d 已上移
 *   shared 单源（packages/shared/src/dto/docspace.dto.ts），此处 re-export 保持兼容
 *   （ingest 来源开放如 'git:xxx' 不枚举）。
 * - CODE_ENTRY_TYPE：review-0831 任务 a8a295df 上移 shared 单源
 *   （packages/shared/src/dto/docspace-response.dto.ts，DOC_ROUTE_CODE_ENTRY_TYPES
 *   旁命名化派生），此处 re-export 保持兼容（doc-route/doc-bundle/route-health
 *   既有 import 路径不变）。
 */
import { CODE_ENTRY_TYPE, DOC_SOURCE_NATIVE } from '@agent-chamber/shared';

/** 文档源哨兵值：'native'（平台 API/MCP 可写）；ingest 来源开放（如 'git:xxx'），不枚举 */
export { DOC_SOURCE_NATIVE };

/**
 * codeEntryType 命名化派生（值域单源 = shared DOC_ROUTE_CODE_ENTRY_TYPES）：
 * - exact（缺省）：精确文件/目录路径，health recheck 全量校验
 * - pattern：glob 风格泛化写法，health recheck 豁免存在性校验
 * 定义见 shared docspace-response.dto.ts（本文件 re-export 保持兼容）
 */
export { CODE_ENTRY_TYPE };

/** codeEntryType 联合类型（供 DTO/类型标注复用；shared 同款导出） */
export type { CodeEntryType } from '@agent-chamber/shared';

/**
 * DocSpace 写族统一的幂等 entityType 标记（idempotency_records.entity_type 列）。
 *
 * 幂等键作用域 `uq_idempotency_actor_key (actor_id, client_request_id)` 是**全平台共享**的：
 * entityType 是模块身份标记，同键被其他模块占用时靠它判定冲突（409 IDEMPOTENCY_KEY_CONFLICT）。
 *
 * 归属说明：通用幂等实现已上移 `apps/backend/src/common/services/idempotency.helper.ts`
 * （v1.63.0 幂等 helper 抽公共）；**模块标记留在模块内**（实现属 common，身份属各模块）。
 */
export const DOC_IDEMPOTENCY_ENTITY_TYPE = 'doc';

/**
 * 存量 tag rename/merge 的幂等 entityType 标记（3 期，v1.92.0-dev；plan D13/A8）。
 *
 * 语义：幂等作用域是 (actor_id, client_request_id)，entityId = spaceId（一次 rename 是
 * **空间级批量操作**，不绑定单文档）。`doc_space` 这个值在 `AUDIT_ENTITY_TYPES` 里是审计
 * 的 entityType 词汇，两者语义不同域（一个是幂等身份标记，一个是审计归属）——此处取
 * 同名字符串只是可读性选择，不构成耦合。
 */
export const DOC_TAG_RENAME_IDEMPOTENCY_ENTITY_TYPE = 'doc_space';

/**
 * DocCategory merge 的幂等 entityType 标记（3 期，v1.92.0-dev；plan D13/A8）。
 * entityId = sourceCategoryId（被合并方）。
 */
export const DOC_CATEGORY_MERGE_IDEMPOTENCY_ENTITY_TYPE = 'doc_category';

/**
 * 409 `DOC_CONTENT_CONFLICT` 消息的**恢复动作后缀**（阶段三，决策 10）。
 *
 * 为什么需要：乐观锁 409 的最常见误用是「拿同一个 payload 盲重试」——前提 hash 未刷新时
 * 重试必然再 409，调用方会陷入重试循环并把它误判成服务端故障。把恢复动作写进 message
 * （而不是让 MCP/上层凭 code 自己编话术）是**单源**做法：本模块八处抛点共用同一句话。
 *
 * ⚠️ **不要改成在异常过滤器里按 code 挂文案**：过滤器是平台级公共件（所有模块的错误都
 * 路过它），在那里按某个域的 code 分支 = 让 docspace 契约渗进公共层；且 task.service.ts:1327
 * 有**同码跨域**的抛点（task 侧的乐观锁），过滤器按 code 挂文案会连它一起改写。
 *
 * 文案覆盖**两种**前置条件形态（P3-1）：`expectedContentHash`（content 乐观锁）与
 * `expectedSectionHash`（section 锚乐观锁）——故不说"重取 contentHash"，而说"重新读取最新
 * 版本（read_doc 取 contentHash / 取 outline 拿 sectionHash）"。
 */
export const DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX =
  ' 冲突通常意味着内容已被他人修改——先重新读取最新版本（read_doc 取 contentHash / ' +
  '取 outline 拿 sectionHash），再携带对应 hash 重写；勿用同一 payload 盲重试' +
  '（前提未刷新时必然再 409）。';
