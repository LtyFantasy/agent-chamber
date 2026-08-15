import type { DocSectionOutline } from '@agent-chamber/shared';
import { dedupeOutlineSections } from './outline-sections';

/**
 * dedupeOutlineSections 契约测试（铁律 #17，bug 1a6b57d0 回归守卫）：
 * 超长 section 的续 chunk（同 headingPath/headingLevel 的连续条目）在大纲中
 * 只显示一次；不同 section 不受影响。
 */
describe('dedupeOutlineSections', () => {
  /** 构造最小 section 大纲条目 */
  const sec = (
    position: number,
    headingPath: string | null,
    headingLevel: number,
  ): DocSectionOutline => ({ position, headingPath, headingLevel });

  it('空数组原样返回', () => {
    expect(dedupeOutlineSections([])).toEqual([]);
  });

  it('无重复时保持原顺序原数量', () => {
    const input = [sec(0, 'A', 1), sec(1, 'A § B', 2), sec(2, 'C', 1)];
    expect(dedupeOutlineSections(input)).toEqual(input);
  });

  it('连续重复（续 chunk）折叠为首条，保留其 position', () => {
    // 复刻 ADR-0005 §7：一个超长 section 被切成 13 个续 chunk
    const dup = (p: number) => sec(p, 'D2-02B § 7. Pinned ResetExpectationRegistryV1', 2);
    const input = [
      sec(0, 'D2-02B § 6. Open fresh session', 2),
      ...Array.from({ length: 13 }, (_, i) => dup(i + 1)),
      sec(14, 'D2-02B § 8. NonceRecordV1', 2),
    ];
    const out = dedupeOutlineSections(input);
    expect(out).toHaveLength(3);
    expect(out[1].position).toBe(1); // 保留首条续 chunk 的 position 供滚动定位
  });

  it('同名但不相邻的标题不折叠（两个真实 section）', () => {
    const input = [sec(0, 'Notes', 2), sec(1, 'Other', 2), sec(2, 'Notes', 2)];
    expect(dedupeOutlineSections(input)).toHaveLength(3);
  });

  it('headingPath 相同但层级不同不折叠', () => {
    const input = [sec(0, 'A § B', 2), sec(1, 'A § B', 3)];
    expect(dedupeOutlineSections(input)).toHaveLength(2);
  });

  it('不改动入参数组', () => {
    const input = [sec(0, 'A', 1), sec(1, 'A', 1)];
    dedupeOutlineSections(input);
    expect(input).toHaveLength(2);
  });
});
