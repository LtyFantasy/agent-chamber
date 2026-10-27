/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: review-0831 任务 bbd175dc 子项 2（批量错误提取逻辑收敛）
 *
 * [踩坑索引]
 *   - errorOf-dup-v1.57：doc-bundle.service.ts 的 errorOf 与 doc.service.ts
 *     batchUpsert 内联错误提取逐字重复，2026-08-31 收敛为本文件唯一实现。
 *   - PERITEM-RAW-ERR（F4 项5 / 同 P2-#4 理由）：v1 对非 HttpException 错误回退
 *     `err.message`，等于把 PG 原文（表名 / 约束名 / driverError.detail 里的用户输入
 *     回显）原样放进 per-item error 进响应面。v2 起除应用级诊断标记类外一律固定文案。
 *   - PERITEM-LOG-FLOOD（F4 项5 复审 MAJOR-2）：per-item 失败明细逐条 Logger.warn，
 *     而 categories/routes 的 DTO **没有数组上限**（media 有、docs 无）⇒ 单请求可产生
 *     数十 MB 日志。修复：前 PER_ITEM_LOG_DETAIL_MAX 条记明细，超出由聚合行收口。
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ per-item error 的对外形状 { message, code? } 是契约：改形状必须同步
 *     docs/spec.md 与 doc-error.helper.spec.ts 矩阵
 *   □ **文案与分类的单源在 common/utils/batch-error.util.ts**（doc 段与 media 段共用）：
 *     本文件只做「加业务码 + 日志摘要」两件事，禁止在这里再写一份分类
 *   □ 新增「可透出原文」的错误类型必须走 PublicBatchError 且登记白名单 spec
 * =============================================================================
 */

import { batchErrorShape, sanitizeBatchErrorMessage } from '../../common/utils/batch-error.util';
import { readPgSqlstate } from '../../common/utils/pg-error.util';

/**
 * per-item 失败**明细日志**的条数上界（F4 项5 复审 MAJOR-2）。
 *
 * 为什么必须有上界：三处批量 catch 逐条 Logger.warn，而 `categories` / `routes` 的 DTO
 * **没有数组上限**（`media` 有 @ArrayMaxSize、`docs` 也没有）——10MB 请求体可塞约 27 万条
 * 最小失败项，单请求就是几十 MB 日志（既是磁盘/IO 风险，也会把真正的告警淹掉）。
 * 口径：前 N 条记明细（排障要的就是「哪几条」），超出部分由循环后的**聚合行**收口
 * （总数仍完整可见，不丢信息）。doc.service 侧有 @ArrayMaxSize(50) 兜着，但三处统一口径
 * 更不易漏——新加批量端点时照抄即可。
 */
export const PER_ITEM_LOG_DETAIL_MAX = 10;

/**
 * 取 per-item 错误形状（batchUpsert / importBundle 批量容错的统一契约）。
 *
 * 形状 = { message, code? }；**message 恒为字符串、恒已消毒**（F4 项5 起的契约）。
 *
 * 分类与文案的**唯一单源**是 common/utils/batch-error.util.ts 的 `batchErrorShape`
 * （doc 段与 media 段共用同一分类：HTTP 形状 → PG 固定文案 + 派生 code → PublicBatchError
 * 原 message → 固定 'Internal error'）；本函数只是它在 DocSpace 侧的稳定入口名，
 * 供三处批量容错点共用——**禁止在此重写分类**，分叉即漂移（PERITEM-RAW-ERR 的成因）。
 *
 * ⚠️ 契约（2026-08-31 立 / 2026-10-17 F4 项5 收紧 + 复审）：三处批量容错
 * （doc.service.batchUpsert + doc-bundle.service.importCategories / importRoutes）必须共用
 * 本实现，禁止内联复制——{ message, code? } 是批量响应的对外契约（docs/spec.md）。
 *
 * @param err 任意被 catch 的错误（HttpException / PG 错误 / PublicBatchError / 未知值）
 * @returns 批量 per-item 错误形状 { message, code? }（无业务码时省略 code 键）
 */
export function errorOf(err: unknown): { message: string; code?: number } {
  return batchErrorShape(err);
}

/**
 * per-item 失败的**服务端结构化日志摘要**（三处批量 catch 点共用，F4 项5 第 6 条）。
 *
 * 形状：`<业务键> err=<构造名> [sqlstate=<码>] msg=<消毒后文案>`——「哪一条、哪类错误、
 * PG 码、对外文案」一行的排障信息，可 grep（doc-bundle 侧前缀 `import* per-item failed:`）。
 *
 * 纪律：
 * - **不记 stack**：per-item 失败是**预期内**的容错出口（单条失败不中止批次），记 stack
 *   只会把日志刷成噪音；需要堆栈的是 5xx 冒泡，由 all-exceptions.filter 负责。
 * - **不记错误原文**：raw message / driverError.detail 含用户输入回显（P2-#4），且批量场景
 *   会把它按条重放——摘要里的 msg 就是已消毒的对外文案
 *   （`sanitizeBatchErrorMessage` 的产品，与响应面同一份，不会「日志干净但响应泄露」）。
 * - **剔换行**：业务键来自请求体（**可注入内容**），不净化就能凭 `\n` 伪造日志行
 *   （手法同 config/judgment.config.ts 的 sanitizeLogValue；那里是 env 值同源纪律）。
 *
 * @param err 被 catch 的错误
 * @param itemKey 本条的定位键（batchUpsert → `path=...`；categories → `name=...`；
 *                routes → `intent=... primaryDocPath=...`）
 * @returns 单行日志摘要（调用方自行补方法名前缀）
 */
export function batchErrorLogSummary(err: unknown, itemKey: string): string {
  const parts = [itemKey, `err=${err instanceof Error ? err.constructor.name : typeof err}`];
  const sqlstate = readPgSqlstate(err);
  if (sqlstate) parts.push(`sqlstate=${sqlstate}`);
  parts.push(`msg=${sanitizeBatchErrorMessage(err)}`);
  return parts.join(' ').replace(/[\r\n]/g, '');
}
