import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchQueryDto } from './search-query.dto';
import { SEARCH_TYPE_VALUES, type SearchType } from '@agent-chamber/shared';

/**
 * SearchQueryDto 校验（统一批 744aae46：SearchType 双源收口到 shared
 * SEARCH_TYPE_VALUES 后，@IsIn 校验语义不得回归）：
 * - 非法 type 值必须被 DTO 校验拒绝（400），不得透传到 Service/SQL；
 * - SEARCH_TYPE_VALUES 全部合法值放行（与 shared 单一事实来源对齐）。
 */
describe('SearchQueryDto', () => {
  it('should reject invalid type value', async () => {
    const dto = plainToInstance(SearchQueryDto, { q: 'x', type: 'not-a-type' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'type' && e.constraints?.isIn)).toBe(true);
  });

  it('should accept every value in SEARCH_TYPE_VALUES', async () => {
    for (const type of SEARCH_TYPE_VALUES) {
      const dto = plainToInstance(SearchQueryDto, { q: 'x', type });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('should default type to all when omitted', () => {
    const dto = plainToInstance(SearchQueryDto, { q: 'x' });
    expect(dto.type).toBe<SearchType>('all');
  });
});
