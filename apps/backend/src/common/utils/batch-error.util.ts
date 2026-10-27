/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md (批量导入 per-item 错误政策)
 *   - 补充: docs/api-definition.md（batchUpsert / importBundle 的 per-item error 形状）
 *
 * [踩坑索引] PERITEM-RAW-ERR(F4 项5：per-item 裸 err.message 出响应面) PUBERR-LEAK(S-N6)
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   PERITEM-RAW-ERR: doc 段（doc-error.helper.errorOf）与 media 段
 *          （attachment.service 的 importFromBundle / bindBundleMedia 的 reason）
 *          曾各自回退 err.message——PG 原文（表名 / 约束名 / invalid uuid 的输入回显）
 *          随 per-item 结果进**匿名可达**的响应面（同一 POST /doc-spaces/:id/bundle 的
 *          docs 段与 media.failed[] 是同端点同形状）。修复：文案策略下沉本文件单源，
 *          两段共用同一分类（reviewer MAJOR-1）。
 *   PUBERR-LEAK: PublicBatchError 的 message **原样透出**（应用级诊断的刻意例外），
 *          所以「谁能构造它」是安全边界：只允许字面量 / 模板字面量（S-N6）。
 *          构造点集合由 batch-error.util.spec.ts 白名单双向相等钉死。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 本文件是 per-item 错误**文案与分类**的唯一单源（doc 段 + media 段共同消费），
 *     禁止在消费点各写一份分类——两段分叉就是 F4 项5 的漏洞形态
 *   □ 新增「可透出原文」的错误类型必须走 PublicBatchError 并登记白名单 spec
 * =============================================================================
 */
import { HttpException } from '@nestjs/common';
import { describePgError } from './pg-error.util';

/**
 * per-item error message 的长度上界（字符数）：它是响应体的一部分，必须有界
 *（DTO 校验的数组 message join 后可能很长）。
 */
export const PER_ITEM_ERROR_MESSAGE_MAX = 500;

/** 非 HttpException / PG / PublicBatchError 的未知错误对外固定文案（v1 曾回退 err.message） */
const INTERNAL_ERROR_MESSAGE = 'Internal error';

/** per-item 错误形状（message 恒为字符串且已消毒；code 仅在有业务码时出现） */
export interface BatchErrorShape {
  message: string;
  code?: number;
}

/** 按上界截断 message（不改变已足够短的文案） */
function truncateMessage(message: string): string {
  return message.length > PER_ITEM_ERROR_MESSAGE_MAX
    ? message.slice(0, PER_ITEM_ERROR_MESSAGE_MAX)
    : message;
}

/**
 * 把「HTTP 形状」的 message 读成字符串：字符串直接用；数组按 all-exceptions.filter
 * 既有约定 `join('; ')`（class-validator 每约束一条违规，聚合后调用方一次看全）。
 * 两者皆非 → null，交给后续分类（**不**回退 err.message）。
 */
function readMessageField(rawMessage: unknown): string | null {
  if (typeof rawMessage === 'string') return truncateMessage(rawMessage);
  if (Array.isArray(rawMessage)) return truncateMessage(rawMessage.map(String).join('; '));
  return null;
}

/**
 * 读 `response.{message,code}` 形态（不要求是 HttpException 实例）。
 *
 * ⚠️ 这是**放宽的透出面**，不是 bug 而是历史契约：任何带 `response.message` 的错误对象
 * 都会经这里透出（doc.service.spec 的 batchUpsert 用例就用这种测试替身形态，真运行时
 * 是 HttpException）。后果：**新引入的第三方错误源若把原文塞进 `response.message`，
 * 就会直接进响应面**——引入方必须评估该文本可否公开，不能只看错误类型。
 * 同理，**字符串入参的 `HttpException` 也会透出**（`getResponse()` 直接返回那个字符串，
 * 见下方 ① 的类型细节）——**禁止把捕获到的错误文本以字符串形式包进 HttpException**，
 * 那等于手工绕过消毒链（错误原文从此路径原样进响应面，与 PublicBatchError 的构造纪律
 * 是同一条禁令的两种形态）。
 */
function readResponseShape(err: unknown): BatchErrorShape | null {
  const holder = err as { response?: { message?: unknown; code?: unknown } } | null;
  const message = readMessageField(holder?.response?.message);
  if (message === null) return null;
  const rawCode = holder?.response?.code;
  return typeof rawCode === 'number' ? { message, code: rawCode } : { message };
}

/**
 * per-item 错误的**分类单源**（doc 段 errorOf 与 media 段 reason 共用）：
 * ① HTTP 形状（HttpException，或任意带 `response.message` 的错误对象）→ 其 message
 *    （数组 join('; ')）+ response.code；
 *    - 补丁（reviewer MINOR-2）：基类 `HttpException` 以**字符串**入参构造时
 *      `getResponse()` 就是那个字符串（子类 BadRequestException 等才包成
 *      `{statusCode,message,error}`）——不补这条会丢掉诊断、落进 'Internal error'；
 * ② PostgreSQL driver 错误（pg-error.util.describePgError 命中）→ 映射单源的固定文案 +
 *    派生业务码（排障线索改走服务端结构化日志，不进响应面）；
 * ③ PublicBatchError → 原 message 透出（应用级诊断，构造纪律见该类注释）；
 * ④ 其余一切 → 固定 'Internal error'（**不再回退 err.message**，那正是泄露面）。
 */
function classifyBatchError(err: unknown): BatchErrorShape {
  const responseShape = readResponseShape(err);
  if (responseShape) return responseShape;

  if (err instanceof HttpException) {
    const res: unknown = err.getResponse();
    if (typeof res === 'string') return { message: truncateMessage(res) };
  }

  const pg = describePgError(err);
  if (pg) return { message: truncateMessage(pg.message), code: pg.code };

  if (err instanceof PublicBatchError) return { message: truncateMessage(err.message) };

  return { message: INTERNAL_ERROR_MESSAGE };
}

/**
 * per-item 错误的**对外文案**（消毒后，恒为字符串且有长度上界）。
 *
 * 单源纪律：本函数是 doc 段（`doc-error.helper.errorOf`）与 media 段
 * （`attachment.service` 的 importFromBundle / bindBundleMedia 的 `reason`）共同消费的
 * 唯一文案来源——两段写在同一个 `POST /doc-spaces/:id/bundle` 响应里，各写一份分类
 * 必然漂移，而漂移的那一份就是泄露面（reviewer MAJOR-1）。
 *
 * @param err 任意被 catch 的错误
 * @returns 可公开的固定/已消毒文案
 */
export function sanitizeBatchErrorMessage(err: unknown): string {
  return classifyBatchError(err).message;
}

/**
 * per-item 错误的完整形状（message + 可选业务码）。
 *
 * 与 `sanitizeBatchErrorMessage` 共用同一分类过程（不是各判一次）——否则会出现
 * 「文案取 HTTP 形状、码取自 PG」这类错配。
 *
 * @param err 任意被 catch 的错误
 * @returns { message, code? }
 */
export function batchErrorShape(err: unknown): BatchErrorShape {
  return classifyBatchError(err);
}

/**
 * 批量导入 per-item 错误的应用级诊断标记类（F4 项5 / 决策表项5；威胁 S-N6）。
 *
 * ## 唯一合法用法
 *
 * `throw new PublicBatchError('<固定诊断文案>')` —— 参数**只允许字面量 / 模板字面量**，
 * 且模板里只放**应用自己构造的业务键回显**（分类名、doc path、intent 等）。
 *
 * ⛔ **禁止**把捕获到的错误原文作为参数：`new PublicBatchError(err.message)`、
 * `new PublicBatchError(String(err))`、`new PublicBatchError(err.stack)` —— 这会把
 * PostgreSQL 原文（表名 / 约束名 / `driverError.detail` 里的用户输入回显）重新带回
 * 响应面，**绕过本文件的消毒链复活泄露**（S-N6 的「消毒链被绕过复活」形态）。
 * 若确实需要透出底层原因，走服务端结构化日志，不进响应。
 *
 * ## 与 errorOf 的契约
 *
 * `classifyBatchError` 对本类**原样透出其 message**——这是刻意的例外：本类的 message
 * 由应用自己书写、内容天然可公开（业务键诊断），而其余非 HTTP/PG 的未知错误一律降级为
 * 固定文案 'Internal error'。因此「谁有权构造本类」是安全边界的一部分，构造点集合由
 * batch-error.util.spec.ts 白名单双向相等钉死（新增构造点必须显式登记并说明文案可公开）。
 *
 * ## 位置
 *
 * 刻意放在 `common/utils/`（而非某个业务模块）：doc 段（docspace）与 media 段
 * （attachments）都要识别它，放在任一业务模块里都会逼出**反向 import**。
 */
export class PublicBatchError extends Error {
  constructor(message: string) {
    super(message);
    // name 显式固定：日志摘要（batchErrorLogSummary）与本类堆栈首行都能看出是应用级诊断
    this.name = 'PublicBatchError';
  }
}
