/**
 * lib/experience.test.ts — 经验库 web 契约翻译层单测
 *
 * 覆盖三块：
 * ① `serializeRepeatedParams` 的重复键形态（后端数组参数契约，plan §2）——并**用真实
 *    axios `getUri` 对照**默认方括号形态，把"为什么必须显式传序列化器"钉成可执行断言；
 * ② `buildExperienceQueryParams` 的取值规则（空串/空数组不发键、元素归一化）；
 * ③ 展示映射与派生量（quality → Badge 变体、env 行序、四节模板、chip 校验、分页派生）。
 */

import axios from 'axios';
import {
  EXPERIENCE_ELEMENT_MAX_LENGTH,
  buildExperienceContentTemplate,
  buildExperienceQueryParams,
  experienceEnvRows,
  experienceIntentBadgeVariant,
  experiencePagination,
  experienceQualityBadgeVariant,
  newClientRequestId,
  normalizeElements,
  serializeRepeatedParams,
  validateExperienceChip,
} from './experience';

describe('serializeRepeatedParams（数组参数重复键契约）', () => {
  it('数组展开为重复键，而非逗号拼接', () => {
    expect(serializeRepeatedParams({ signals: ['a', 'b'], domains: ['devops'] })).toBe(
      'signals=a&signals=b&domains=devops',
    );
  });

  it('undefined / null 值跳过，不产出噪音参数', () => {
    expect(serializeRepeatedParams({ q: undefined, intent: null, sort: 'recent' })).toBe(
      'sort=recent',
    );
  });

  it('逐键逐值 URL 编码（含中文查询串与空格）', () => {
    expect(serializeRepeatedParams({ q: '端口 不可达' })).toBe(
      'q=%E7%AB%AF%E5%8F%A3%20%E4%B8%8D%E5%8F%AF%E8%BE%BE',
    );
  });

  /**
   * 与真实 axios 的对照：证明「默认形态是方括号（后端 400 的根因）」与
   * 「显式序列化器产出重复键（后端接受）」两件事——axios `getUri` 与请求构建走
   * 同一段 buildURL 代码，故这是对真实 URL 形态的断言，不是对自造字符串的断言。
   */
  it('对照 axios 默认：无序列化器 → signals[]=（后端守卫会 400）', () => {
    const url = axios.getUri({ url: '/experiences', params: { signals: ['a', 'b'] } });
    expect(decodeURIComponent(url)).toBe('/experiences?signals[]=a&signals[]=b');
  });

  it('对照 axios 显式序列化器：产出重复键形态', () => {
    const url = axios.getUri({
      url: '/experiences',
      params: { signals: ['a', 'b'] },
      paramsSerializer: serializeRepeatedParams,
    });
    expect(url).toBe('/experiences?signals=a&signals=b');
    // 服务端按重复键取值即可拿回完整数组（Express/URLSearchParams 同一套语义）
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('signals')).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('buildExperienceQueryParams（过滤态 → query 参数）', () => {
  it('空串 / 空数组 / 空白串一律不发送（避免 ?intent= 撞后端词表校验）', () => {
    expect(
      buildExperienceQueryParams({ q: '   ', intent: '', quality: '', domains: [], signals: [] }),
    ).toEqual({});
  });

  it('数组元素 trim + lowercase（与后端归一化对齐，否则大小写永远匹配不上）', () => {
    const params = buildExperienceQueryParams({ signals: [' ECONNREFUSED ', 'Port-Unreachable'] });
    expect(params.signals).toEqual(['econnrefused', 'port-unreachable']);
  });

  it('过滤项与分页透传（值保持原始类型，数组保持数组）', () => {
    const params = buildExperienceQueryParams({
      q: ' port ',
      intent: 'repair',
      quality: 'unverified',
      sort: 'most_used',
      page: 2,
      pageSize: 20,
    });
    expect(params).toEqual({
      q: 'port',
      intent: 'repair',
      quality: 'unverified',
      sort: 'most_used',
      page: 2,
      pageSize: 20,
    });
  });
});

describe('展示映射与派生量', () => {
  it('normalizeElements：去空 + 小写', () => {
    expect(normalizeElements([' A ', '', '  ', 'B'])).toEqual(['a', 'b']);
    expect(normalizeElements(undefined)).toEqual([]);
  });

  it('quality → Badge 变体：verified=success / suspect=warning / unverified=subtle', () => {
    expect(experienceQualityBadgeVariant('verified')).toBe('success');
    expect(experienceQualityBadgeVariant('suspect')).toBe('warning');
    expect(experienceQualityBadgeVariant('unverified')).toBe('subtle');
  });

  it('intent → Badge 变体恒为 outline（类型是中性分类，不抢可信度视觉）', () => {
    expect(experienceIntentBadgeVariant('pitfall')).toBe('outline');
    expect(experienceIntentBadgeVariant('decision')).toBe('outline');
  });

  it('experienceEnvRows：只出有值的键，顺序固定为 os/tool/version/runtime', () => {
    expect(experienceEnvRows({ runtime: 'node-20', os: 'wsl2' })).toEqual([
      { key: 'os', value: 'wsl2' },
      { key: 'runtime', value: 'node-20' },
    ]);
    expect(experienceEnvRows(undefined)).toEqual([]);
    expect(experienceEnvRows({ os: '  ' })).toEqual([]);
  });

  it('四节模板：四个二级标题 + 可被后端"验证方式"模式识别', () => {
    const md = buildExperienceContentTemplate({
      symptom: '症状',
      rootCause: '根因',
      fix: '解决方式',
      howVerified: '验证方式',
    });
    expect(md).toContain('## 症状');
    expect(md).toContain('## 根因');
    expect(md).toContain('## 解决方式');
    expect(md).toContain('## 验证方式');
    // 后端 EXPERIENCE_VERIFICATION_SECTION_PATTERN 认 how verified / 验证
    expect(md).toMatch(/验证/);
  });

  it('chip 校验：空 / 含逗号 / 超长 / 超数各自失败，重复元素放行', () => {
    expect(validateExperienceChip('  ', [], 20)).toBe('empty');
    expect(validateExperienceChip('a,b', [], 20)).toBe('comma');
    expect(validateExperienceChip('x'.repeat(EXPERIENCE_ELEMENT_MAX_LENGTH + 1), [], 20)).toBe(
      'too_long',
    );
    expect(validateExperienceChip('x', ['a', 'b'], 2)).toBe('too_many');
    expect(validateExperienceChip('A', ['a'], 20)).toBeNull();
    expect(validateExperienceChip('ECONNREFUSED', [], 20)).toBeNull();
  });

  it('分页派生：totalPages 至少 1，hasPrev/hasNext 按边界判定', () => {
    expect(experiencePagination(0, 1, 20)).toEqual({
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    });
    expect(experiencePagination(45, 2, 20)).toEqual({
      totalPages: 3,
      hasPrev: true,
      hasNext: true,
    });
    expect(experiencePagination(45, 3, 20)).toEqual({
      totalPages: 3,
      hasPrev: true,
      hasNext: false,
    });
  });

  it('newClientRequestId：每次调用新值且长度在 DTO 约束内', () => {
    const a = newClientRequestId();
    const b = newClientRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});
