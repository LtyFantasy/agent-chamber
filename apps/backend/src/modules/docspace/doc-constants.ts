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
