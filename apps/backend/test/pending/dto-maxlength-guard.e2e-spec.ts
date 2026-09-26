/**
 * =============================================================================
 * 钉子用例（批次 0 第 6 项 · 改名法入库）—— 四 DTO 查询上限一致性守卫
 * =============================================================================
 * 机制：`*.pending.ts` 不被任何 jest 套件发现；**批次 1 激活 = 原地改名
 * `*.e2e-spec.ts`**（`query-task.dto.ts` 补 `@MaxLength(200)` 落地后——本守卫
 * 今天激活必红，因为 task DTO 尚无上限，这正是它守的东西）。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * 契约（计划 §2.2 DTO 项）：四消费方查询 DTO 上限对齐 200，与编译器
 * `SEARCH_QUERY_MAX_LENGTH=200` 硬截断兜底构成双层（DTO 是闸门，编译器截断是
 * 闸门被绕过时的兜底）。
 * =============================================================================
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DocSearchDto } from '../../src/modules/docspace/dto/doc-search.dto';
import { SearchQueryDto } from '../../src/modules/search/dto/search-query.dto';
import { QueryExperienceDto } from '../../src/modules/experience/dto/query-experience.dto';
import { QueryTaskDto } from '../../src/modules/task/dto/query-task.dto';
import { SEARCH_QUERY_MAX_LENGTH } from '../../src/common/utils/search/tsquery-compiler';

/**
 * ① 四 DTO `@MaxLength(200)` 一致性
 * - 查询: 200 字与 201 字两档（逐 DTO）
 * - fixture: 无（纯 class-validator 元数据校验，**不需要数据库**）
 * - 断言的不变量: 四 DTO 的 `q` 全部收 200 / 拒 201（maxLength 违例）；且上限值
 *   = `SEARCH_QUERY_MAX_LENGTH`（200）
 * - 失败含义: 任一 DTO 漏上限（今天 = QueryTaskDto）⇒ 编译器 200 硬截断被绕过，
 *   超长查询进 K-gate 64 arm 预算/重排出境体预算，四通道契约漂移
 */
describe('四 DTO @MaxLength(200) 一致性守卫', () => {
  const CASES: Array<{ name: string; make: (q: string) => object }> = [
    { name: 'DocSearchDto', make: (q) => plainToInstance(DocSearchDto, { q }) },
    { name: 'SearchQueryDto', make: (q) => plainToInstance(SearchQueryDto, { q }) },
    { name: 'QueryExperienceDto', make: (q) => plainToInstance(QueryExperienceDto, { q }) },
    { name: 'QueryTaskDto', make: (q) => plainToInstance(QueryTaskDto, { q }) },
  ];

  it('编译器上限常量 = 200（双层对齐的锚点）', () => {
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(200);
  });

  it.each(CASES)('$name：收 200 / 拒 201（maxLength 违例）', async ({ make }) => {
    const ok = make('a'.repeat(SEARCH_QUERY_MAX_LENGTH));
    const okErrors = await validate(ok);
    expect(okErrors.filter((e) => e.property === 'q')).toHaveLength(0);

    const tooLong = make('a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1));
    const errors = await validate(tooLong);
    const qErrors = errors.filter((e) => e.property === 'q');
    expect(qErrors.length).toBeGreaterThan(0);
    expect(Object.keys(qErrors[0].constraints ?? {})).toContain('maxLength');
  });
});
