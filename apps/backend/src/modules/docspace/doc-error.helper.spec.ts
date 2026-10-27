/**
 * doc-error.helper 单测矩阵（F4 项5 第 7 条；铁律 #17：per-item 错误形状是测试契约）
 *
 * 覆盖 errorOf v2 的全分类（HTTP 形状 / PG 映射 / PublicBatchError / 其余）与
 * message 截断、以及 batchErrorLogSummary 的消毒纪律（剔换行、不记原文）。
 *
 * 为什么必须逐分支断言：per-item error 是**匿名可达**响应面的一部分（批量导入的
 * 调用方可以是任何持 key 的 agent），「哪一类错误透出什么」是安全边界，不是实现细节。
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { QueryFailedError } from 'typeorm';
import { PER_ITEM_ERROR_MESSAGE_MAX, PublicBatchError } from '../../common/utils/batch-error.util';
import { batchErrorLogSummary, errorOf } from './doc-error.helper';

/** 构造带 driverError 的 PG 错误（形态与 all-exceptions.filter.spec 一致） */
function pgError(
  message: string,
  driverError: { code?: string; detail?: string } = {},
): QueryFailedError {
  const driver = Object.assign(new Error(message), driverError);
  return new QueryFailedError('INSERT', [], driver);
}

describe('errorOf（per-item 错误形状，F4 项5）', () => {
  describe('① HTTP 形状（HttpException / response.{message,code} 同形错误）', () => {
    it('字符串 message → 原样透出，code 取 response.code', () => {
      const err = new BadRequestException({
        message: 'Document does not exist',
        code: ErrorCode.DOC_NOT_FOUND,
      });

      expect(errorOf(err)).toEqual({
        message: 'Document does not exist',
        code: ErrorCode.DOC_NOT_FOUND,
      });
    });

    it("数组 message → join('; ')（与 filter 的 DTO 多违规聚合同形）", () => {
      const err = new BadRequestException({
        message: ['path should not be empty', 'content must be a string'],
      });

      expect(errorOf(err).message).toBe('path should not be empty; content must be a string');
    });

    it('无 response.code 时不带 code 键（不写 undefined）', () => {
      const err = new BadRequestException('plain message');

      const result = errorOf(err);
      // NestJS 把字符串入参放进 response.message（不是 HTTP reason phrase）
      expect(result.message).toBe('plain message');
      expect('code' in result).toBe(false);
    });
  });

  describe('② PostgreSQL driver 错误 → 映射单源的固定文案 + 派生 code', () => {
    it('23505 unique violation → Resource conflict + RESOURCE_CONFLICT（且不含 PG 原文）', () => {
      const result = errorOf(
        pgError('duplicate key value violates unique constraint "docs_path_key"', {
          code: '23505',
        }),
      );

      expect(result).toEqual({ message: 'Resource conflict', code: ErrorCode.RESOURCE_CONFLICT });
      expect(result.message).not.toMatch(/relation|constraint|violates/i);
    });

    it('22P02（明文不映射清单）→ 固定 Internal error，**不**伪装成用户输入错误', () => {
      // 22P02 是 9082464c 家族的服务端缺陷码：filter 保持 500，per-item 亦不得透出原文
      const result = errorOf(
        pgError('invalid input syntax for type integer: "abc"', { code: '22P02' }),
      );

      expect(result).toEqual({ message: 'Internal error' });
    });

    it('未知 sqlstate（无 message 子串命中）→ Internal error，不带 code', () => {
      const result = errorOf(
        pgError('server-side defect with user input echo xyz', { code: 'XX999' }),
      );

      expect(result).toEqual({ message: 'Internal error' });
      expect(result.message).not.toContain('xyz');
    });

    it('sqlstate 码表内（42601 语法错）→ Invalid query input + VALIDATION_ERROR', () => {
      expect(errorOf(pgError('syntax error at or near "SELEC"', { code: '42601' }))).toEqual({
        message: 'Invalid query input',
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('uuid 子串分支 → Invalid UUID format（无 sqlstate 也命中）', () => {
      expect(errorOf(pgError('invalid input syntax for type uuid: "not-a-uuid"'))).toEqual({
        message: 'Invalid UUID format',
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('外键 + detail「is not present in table」→ 404 语义文案', () => {
      const err = pgError(
        'insert or update on table "docs" violates foreign key constraint "fk_1"',
        {
          detail: 'Key (space_id)=(x) is not present in table "doc_spaces".',
        },
      );

      expect(errorOf(err)).toEqual({
        message: 'Referenced resource not found',
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('外键（无 not present）→ Invalid reference', () => {
      const err = pgError(
        'insert or update on table "docs" violates foreign key constraint "fk_1"',
      );

      expect(errorOf(err)).toEqual({
        message: 'Invalid reference',
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  describe('③ PublicBatchError → 原 message 透出（应用级诊断）', () => {
    it('文案原样透出且不带 code（无业务码）', () => {
      const err = new PublicBatchError("Ambiguous category name 'Arch' (2 matches)");

      expect(errorOf(err)).toEqual({ message: "Ambiguous category name 'Arch' (2 matches)" });
    });
  });

  describe('④ 其余一切 → 固定 Internal error（不再回退 err.message）', () => {
    it('普通 Error 的 message **不透出**（v1 的泄露面已堵）', () => {
      const result = errorOf(new Error('relation "docs" does not exist at /srv/app'));

      expect(result).toEqual({ message: 'Internal error' });
    });

    it('带 code 的业务错误不被误吞成 PG 错误（A-C5：禁按 err.code duck-typing）', () => {
      const businessError = Object.assign(new Error('business rule violated'), { code: '23505' });

      // 若按 code duck-typing，这里会变成 'Resource conflict' —— 状态码与文案双双走错
      expect(errorOf(businessError)).toEqual({ message: 'Internal error' });
    });

    it('非 Error 值（string / null / undefined）→ Internal error，不抛', () => {
      expect(errorOf('boom').message).toBe('Internal error');
      expect(errorOf(null).message).toBe('Internal error');
      expect(errorOf(undefined).message).toBe('Internal error');
      expect(errorOf({ foo: 'bar' }).message).toBe('Internal error');
    });

    it('HttpException（非 BadRequest）也走 HTTP 分支（status 不影响形状）', () => {
      const err = new HttpException(
        { message: 'Too many requests', code: ErrorCode.RATE_LIMITED },
        HttpStatus.TOO_MANY_REQUESTS,
      );

      expect(errorOf(err)).toEqual({ message: 'Too many requests', code: ErrorCode.RATE_LIMITED });
    });
  });

  describe('message 截断上界（PER_ITEM_ERROR_MESSAGE_MAX）', () => {
    it('超长 HttpException message 截断到 500 字符', () => {
      const err = new BadRequestException({ message: 'x'.repeat(1200) });

      const result = errorOf(err);
      expect(result.message).toHaveLength(PER_ITEM_ERROR_MESSAGE_MAX);
    });

    it('超长 PublicBatchError message 同样截断', () => {
      const result = errorOf(new PublicBatchError('y'.repeat(900)));

      expect(result.message).toHaveLength(PER_ITEM_ERROR_MESSAGE_MAX);
    });

    it('短文案不被改写（截断不是归一）', () => {
      expect(errorOf(new PublicBatchError('short')).message).toBe('short');
    });
  });
});

describe('batchErrorLogSummary（per-item 失败的服务端摘要，F4 项5 第 6 条）', () => {
  it('PG 错误 → 构造名 + sqlstate + 消毒后文案 + 业务键', () => {
    const summary = batchErrorLogSummary(
      pgError('duplicate key value violates unique constraint "docs_path_key"', { code: '23505' }),
      'path=docs/a.md',
    );

    expect(summary).toBe(
      'path=docs/a.md err=QueryFailedError sqlstate=23505 msg=Resource conflict',
    );
    // 原文（约束名）绝不进日志行
    expect(summary).not.toContain('docs_path_key');
  });

  it('业务错误带 code 时**不**把它当 sqlstate 打印（同 A-C5 单源判定）', () => {
    const businessError = Object.assign(new PublicBatchError('Ambiguous route'), { code: '23505' });

    const summary = batchErrorLogSummary(businessError, 'intent=x');

    expect(summary).toBe('intent=x err=PublicBatchError msg=Ambiguous route');
  });

  it('换行被剔除（业务键可注入，不净化就能伪造日志行）', () => {
    const summary = batchErrorLogSummary(new Error('a\nb\r\nc'), 'path=docs/\ninjected.md');

    expect(summary).not.toMatch(/[\r\n]/);
    expect(summary).toContain('msg=Internal error');
  });

  it('非 Error 值用 typeof 兜底（err=string），不抛', () => {
    expect(batchErrorLogSummary('boom', 'path=x')).toBe('path=x err=string msg=Internal error');
  });
});
