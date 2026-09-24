import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { assertNoBracketedArrayQuery } from './experience-query-form';

/**
 * 查询串**形态**守卫单测（plan §2 传参协议 / §7 真实 query 串形态）。
 *
 * 为什么这个守卫必须单独测：`signals[]=a` 经 Express 的 qs 解析后与 `signals=a` 产生
 * **同样的 `req.query` 形状**，任何 DTO/service 层校验都无法区分二者——唯一判据是原始
 * URL。故形态矩阵必须在这里穷尽，e2e 再用真实 HTTP 请求复核一次。
 */
describe('assertNoBracketedArrayQuery', () => {
  it('无查询串 → 放行', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences')).not.toThrow();
  });

  it('空查询串 → 放行', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences?')).not.toThrow();
  });

  it('契约形态（重复参数）→ 放行：`signals=a&signals=b`', () => {
    expect(() =>
      assertNoBracketedArrayQuery(
        '/api/v1/experiences?signals=econnrefused&signals=port-unreachable',
      ),
    ).not.toThrow();
  });

  it('单值形态 → 放行（单值也要能用）', () => {
    expect(() =>
      assertNoBracketedArrayQuery('/api/v1/experiences?signals=econnrefused&page=1'),
    ).not.toThrow();
  });

  it('括号形态 `signals[]=` → 400，文案给重复参数写法与"一个元素一条症状"', () => {
    let caught: BadRequestException | undefined;
    try {
      assertNoBracketedArrayQuery('/api/v1/experiences?signals[]=a&signals[]=b');
    } catch (err) {
      caught = err as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.getStatus()).toBe(400);
    const payload = caught?.getResponse() as { message: string; code: number };
    expect(payload.message).toContain('signals[]');
    expect(payload.message).toContain('?signals=a&signals=b');
    expect(payload.message).toContain('一个元素一条症状');
    // 400 而不是静默忽略：静默接受比拒绝危险得多（调用方会以为过滤生效了）
    expect(payload.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('下标形态 `signals[0]=` → 400', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences?signals[0]=a')).toThrow(
      BadRequestException,
    );
  });

  it('domains 括号形态 → 400（数组参数同族）', () => {
    const err = capture(() => assertNoBracketedArrayQuery('/api/v1/experiences?domains[]=devops'));
    expect((err?.getResponse() as { message: string }).message).toContain('domains[]');
  });

  it('非数组参数的括号形态 → 400（通用文案，绝不静默忽略）', () => {
    const err = capture(() => assertNoBracketedArrayQuery('/api/v1/experiences?sort[0]=recent'));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err?.getResponse() as { message: string }).message).toContain(
      'Bracketed query parameter',
    );
  });

  it('百分号编码的括号形态 `signals%5B%5D=` → 400（解码后判定）', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences?signals%5B%5D=a')).toThrow(
      BadRequestException,
    );
  });

  it('参数值里含方括号不算违规（只有键名形态受影响）', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences?q=error[code]')).not.toThrow();
  });

  it('括号后的合法重复参数仍被拒（形态判定先于参数名合法性）', () => {
    expect(() => assertNoBracketedArrayQuery('/api/v1/experiences?signals=a&signals[]=b')).toThrow(
      BadRequestException,
    );
  });
});

/** 捕获断言函数抛出的 BadRequestException（未抛则返回 undefined） */
function capture(fn: () => void): BadRequestException | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err as BadRequestException;
  }
}
