/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md (错误码体系)
 *   - 补充: docs/architecture.md §3.2 (全局异常过滤器)
 *
 * [踩坑索引] SQLSTATE-MAP(显式码表收窄) PG-ERR-DUCK(A-C5 禁 duck-typing)
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   SQLSTATE-MAP: QueryFailedError 只按**显式码表**映射（{22021,42601,54001}→400）；
 *          22012/22023/22P02 明文不映射（500 留 stack——22P02 是 9082464c 家族、
 *          22023 是 GUC 配置面，映成 400 = 把服务端 bug 伪装成用户错误）。
 *          见 INPUT_SQLSTATE_CODES 头注（security ②，检索中文根治批次 1-b）。
 *   PG-ERR-DUCK: 判定必须走 QueryFailedError 实例 / driverError 槽位，**禁止按
 *          `err.code` duck-typing**（A-C5）：PublicBatchError 等应用级错误自带 code，
 *          按 code 判定会把它们误吞成 PG 错误，错误文案与状态码双双走错。
 *          见 isPgDriverError()。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 本文件是 PG 错误映射的**唯一单源**：filter 与 docspace per-item 消毒共消费，
 *     禁止在任何消费点复制码表 / message 子串分支（分叉即漂移）
 *   □ 修改映射分支 = 改对外错误契约，必须同步 all-exceptions.filter.spec.ts
 *     （含「明文不映射」的反向断言）
 * =============================================================================
 */
import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { QueryFailedError } from 'typeorm';

/** `describePgError` 的映射结果（message 恒为固定文案，永不回显 PG 原文 / 用户输入） */
export interface PgErrorDescription {
  /** 对外 HTTP 状态码 */
  status: HttpStatus;
  /** 统一信封的业务错误码 */
  code: ErrorCode;
  /** 固定文案（不回显 driverError.detail） */
  message: string;
}

/**
 * SQLSTATE 显式码表（security 复核必改收窄版，检索中文根治批次 1-b）：只映射
 * **输入类码** → 400 VALIDATION_ERROR。
 * - `22021` invalid byte sequence for encoding（如查询串夹 NUL——DTO 层之外的
 *   service 直调兜底面）；
 * - `42601` syntax error（SQL/tsquery 语法错——编译器上线后主要残留面是手写 SQL
 *   段与未来新查询形态）；
 * - `54001` statement too complex（语句复杂度超限，可由超长查询触发）。
 *
 * ⚠️ **明确不映射**（保持 500 + stack，服务端缺陷语义，code review security ②）：
 * `22012`（division by zero）、`22023`（invalid parameter value——GUC 配置面）、
 * `22P02`（invalid text representation——正是本仓 ts_headline options bug 9082464c
 * 家族）。把它们映成 400 会把服务端 bug 伪装成用户输入错误，排查线索（stack）被吞。
 * 码表外的 QueryFailedError 继续走 message 子串匹配与 500 兜底。
 */
const INPUT_SQLSTATE_CODES: ReadonlySet<string> = new Set(['22021', '42601', '54001']);

/**
 * 判定「这是 PostgreSQL driver 抛出的错误」。
 *
 * 判定面 = `instanceof QueryFailedError` **或** 存在 `driverError` 槽位。
 * - 为什么不能按 `err.code` duck-typing（A-C5）：`code` 是应用级错误的通用槽位
 *   （PublicBatchError、未来任何带 code 的业务错误都可能有），按 code 判定会把它们
 *   误吞成 PG 错误——状态码与文案双双走错，且吞掉应用级诊断。
 * - 为什么要 driverError 兜底：monorepo 里可能出现两份 typeorm（pnpm 多版本、
 *   测试替身），`instanceof` 会假阴性；`driverError` 是 pg driver 专属槽位，
 *   业务错误没有它，因此兜底不会引入误吞。
 */
function isPgDriverError(err: unknown): boolean {
  if (err instanceof QueryFailedError) return true;
  return typeof err === 'object' && err !== null && 'driverError' in err;
}

/**
 * 把 PostgreSQL / TypeORM 底层错误映射为对外可用的 { status, code, message }。
 *
 * 唯一单源：全局异常过滤器（all-exceptions.filter）与批量 per-item 错误消毒
 * （common/utils/batch-error.util 的分类链）共用本实现——两处各写一份码表必然漂移。
 *
 * 入口判定（复审 MINOR-5 注记）：`instanceof QueryFailedError` **或** `'driverError' in err`
 * ——比抽取前 filter 里那句 `instanceof QueryFailedError` **放宽**了一档（跨包副本 / 测试
 * 替身形态也收）。放宽的是「是不是 PG driver 错误」这个入口，**映射分支逐字一致**；
 * 且放宽面窄到 driverError 这个 pg driver 专属槽位，业务错误没有它，故不会误吞
 * （A-C5：仍然禁止按 err.code duck-typing）。
 *
 * 优先级（顺序即语义，与 all-exceptions.filter 历史实现逐字一致）：
 * ① SQLSTATE 显式码表（INPUT_SQLSTATE_CODES）→ 400 VALIDATION_ERROR；
 * ② message 含 `invalid input syntax for type uuid` → 400 VALIDATION_ERROR；
 * ③ message 含 `violates foreign key constraint` → detail 含 `is not present in table`
 *    则 404 NOT_FOUND，否则 400 VALIDATION_ERROR（外键既可指向不存在资源也可指向非法值）；
 * ④ message 含 `violates unique constraint` → 409 RESOURCE_CONFLICT。
 *
 * 全部不命中 → **null**（调用方保留自己的兜底：filter 走 500 INTERNAL_ERROR +
 * stack；per-item 消毒走 'Internal error'）——null 是「不是可映射的 PG 错误」，
 * 不是「未知错误」，调用方不得把它当成匹配失败来包装。
 *
 * @param err 任意被 catch 的错误（QueryFailedError / 业务错误 / 未知值）
 * @returns 映射结果；非 PG driver 错误或四类分支全不命中时返回 null
 */
export function describePgError(err: unknown): PgErrorDescription | null {
  if (!isPgDriverError(err)) return null;

  const pgError = err as { message?: string; driverError?: { code?: string; detail?: string } };
  const pgMessage = pgError.message || '';
  const driverError = pgError.driverError;
  // detail 只在 ③ 的外键判别里参与匹配（PG 的「引用了不存在的资源」信息只在 detail）
  const detail = driverError?.detail || '';
  const fullMessage = `${pgMessage} ${detail}`.toLowerCase();
  const sqlstate = driverError?.code ?? '';

  // ① SQLSTATE 显式码表优先（码表与「明文不映射」清单见 INPUT_SQLSTATE_CODES 头注）：
  //    输入类码 → 400（message 固定文案——PG 原文含 detail 可能回显用户输入）
  if (INPUT_SQLSTATE_CODES.has(sqlstate)) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid query input',
    };
  }
  if (pgMessage.includes('invalid input syntax for type uuid')) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid UUID format',
    };
  }
  if (pgMessage.includes('violates foreign key constraint')) {
    const missingReference = fullMessage.includes('is not present in table');
    return missingReference
      ? {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Referenced resource not found',
        }
      : {
          status: HttpStatus.BAD_REQUEST,
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid reference',
        };
  }
  if (pgMessage.includes('violates unique constraint')) {
    return {
      status: HttpStatus.CONFLICT,
      code: ErrorCode.RESOURCE_CONFLICT,
      message: 'Resource conflict',
    };
  }
  return null;
}

/**
 * 读取 PG driver 的 SQLSTATE（**仅供服务端结构化日志**，永不进响应面）。
 *
 * 判定复用同一把尺子 `isPgDriverError`（而不是直接读 `err.code` 或 `err.driverError`）——
 * 业务错误同样可能带 `code`，只有 PG driver 错误才有可读的 sqlstate；读错会把业务码
 * 混进排障日志，误导定位（A-C5 的同一条理由）。
 *
 * @param err 任意被 catch 的错误
 * @returns SQLSTATE 字符串；非 PG driver 错误或未携带时返回 null
 */
export function readPgSqlstate(err: unknown): string | null {
  if (!isPgDriverError(err)) return null;
  const code = (err as { driverError?: { code?: unknown } }).driverError?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}
