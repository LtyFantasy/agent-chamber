/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）查询串**形态**守卫（括号数组参数拒绝）
 *
 * [代码职责]
 *   - 在请求进入 DTO 校验之前，检查原始 query string 是否用了 `signals[]=` /
 *     `signals[0]=` 之类的括号形态，是则 400 并给出正确写法
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（传参协议：REST = 重复 query 参数）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（序列化协议）
 *
 * [关键不变量]
 *   - **必须在 controller 层做，DTO 层做不到**：Express 默认查询解析器（qs）会把
 *     `signals[]=a` 归一成 `signals=['a']` —— `forbidNonWhitelisted` 看到的是**已知
 *     属性上的合法数组**，不会报错；于是 axios 的默认数组序列化形态会被**静默接受**。
 *     真实消费者（platform-client/MCP handler）写错的代价不是"报错"，而是"看起来生效但
 *     实际没按预期过滤"——静默接受比拒绝危险得多
 *   - 判定基于 `req.originalUrl` 的**原始查询串**（重解析，不看已归一的 `req.query` 键）：
 *     只有原始串还留着方括号，归一后的对象里已经没有痕迹
 *   - 只拦**括号形态**：`signals=a&signals=b`（重复参数）必须放行——那是本模块的契约形态
 *
 * [关联代码]
 *   - experience.controller.ts findAll() — 唯一的调用点（GET /experiences）
 *   - dto/query-experience.dto.ts — 值层面校验（元素逗号/长度/上限）
 *   - experience-query-form.spec.ts — 单元测试（形态矩阵）
 *
 * [持久踩坑]
 *   EXPERIENCE-BRACKET-ARRAY-QS(QS 归一): `signals[]=` 在 qs 解析下与 `signals=` 产生
 *     同样的 `req.query` 形状，任何在 DTO/service 层的校验都无法区分二者。安全方向:
 *     在 controller 就地把原始查询串当作判据（本文件），并在 e2e 用真实 query 串断言。
 * =============================================================================
 */
import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';

/** 被守卫的数组参数名（与 QueryExperienceDto 的数组字段一一对应） */
const ARRAY_QUERY_PARAMS = ['signals', 'domains'] as const;

/**
 * 括号形态判定：键名以 `[]` 结尾（`signals[]=`）或含下标（`signals[0]=`）。
 *
 * @param key 原始查询串里的参数名（未解码前不含 `=`）
 */
function isBracketedKey(key: string): boolean {
  return key.endsWith('[]') || /\[[^\]]*\]$/.test(key);
}

/**
 * 断言原始查询串未使用括号数组形态；命中即 400（含正确写法的可操作文案）。
 *
 * @param originalUrl Express 的 `req.originalUrl`（形如 `/api/v1/experiences?signals[]=a`）
 * @throws BadRequestException 400 / VALIDATION_ERROR——文案给出重复参数写法
 */
export function assertNoBracketedArrayQuery(originalUrl: string): void {
  const queryStart = originalUrl.indexOf('?');
  if (queryStart === -1) return;

  const rawQuery = originalUrl.slice(queryStart + 1);
  if (!rawQuery) return;

  for (const pair of rawQuery.split('&')) {
    const rawKey = pair.split('=')[0] ?? '';
    if (!rawKey) continue;
    // 键名可能被百分号编码（`signals%5B%5D`）；解码失败按原文判定（宁可放过不误伤）
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (isBracketedKey(key)) {
      // 只对已知数组参数给"重复参数"指引；其他参数走通用文案（仍是 400，不静默忽略）
      const base = key.replace(/\[[^\]]*\]$/, '');
      const known = (ARRAY_QUERY_PARAMS as readonly string[]).includes(base);
      throw new BadRequestException({
        message: known
          ? `Bracketed array syntax is not supported: \`${key}=\`. Repeat the parameter instead ` +
            `(\`?${base}=a&${base}=b\`). Bracket form is rejected rather than silently accepted, ` +
            `because it is normalized by the query parser and would otherwise look like it worked. ` +
            `请用重复参数传数组（一个元素一条症状）`
          : `Bracketed query parameter \`${key}=\` is not supported. Use flat parameter names ` +
            `(e.g. \`?q=...&intent=repair\`); for array parameters repeat the name ` +
            `(\`?signals=a&signals=b\`).`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
  }
}
