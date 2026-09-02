import { isExternalHref, resolveDocPath, resolveDocHref, PLATFORM_DOC_LINK_RE } from './doc-link';

/** 测试用 path → id 映射（模拟空间文档列表） */
const pathToId = new Map<string, string>([
  ['README.md', 'id-readme'],
  ['docs/architecture.md', 'id-arch'],
  ['docs/spec.md', 'id-spec'],
  ['guides/t.md', 'id-guide'],
]);

describe('isExternalHref', () => {
  it.each(['https://a.com/x', 'http://a.com', 'HTTPS://A.COM', 'mailto:a@b.com'])(
    '外部协议 %s 判定为外部链接',
    (href) => {
      expect(isExternalHref(href)).toBe(true);
    },
  );

  it.each(['docs/architecture.md', '/docs/space-1?doc=x', '#anchor', './README.md'])(
    '站内/相对链接 %s 不判定为外部链接',
    (href) => {
      expect(isExternalHref(href)).toBe(false);
    },
  );
});

describe('PLATFORM_DOC_LINK_RE', () => {
  it('匹配平台规范链接并提取 spaceId/docId', () => {
    const m = PLATFORM_DOC_LINK_RE.exec(
      '/docs/56f74b2f-6f13-4fa1-a24a-4feae531535a?doc=5f194825-2b99-43f5-8bcb-ef7142e51062',
    );
    expect(m?.[1]).toBe('56f74b2f-6f13-4fa1-a24a-4feae531535a');
    expect(m?.[2]).toBe('5f194825-2b99-43f5-8bcb-ef7142e51062');
  });

  it.each([
    '/docs/space-1?doc=not-a-uuid', // docId 非 UUID
    '/docs/space-1', // 缺 ?doc=
    'docs/architecture.md', // 相对 path 链接
  ])('不匹配 %s', (href) => {
    expect(PLATFORM_DOC_LINK_RE.test(href)).toBe(false);
  });
});

describe('resolveDocPath（v1.61.0 严格 POSIX 源目录解析，与后端 link-health.ts 同源）', () => {
  it('空间根绝对（/ 前缀）：去前导 / 后精确命中，不依赖源目录', () => {
    expect(resolveDocPath('/docs/architecture.md', pathToId, 'docs/spec.md')).toBe('id-arch');
    expect(resolveDocPath('/README.md', pathToId, 'docs/vision/README.md')).toBe('id-readme');
  });

  it('剥离 # 锚点后命中（根绝对 + 源相对双形态）', () => {
    expect(resolveDocPath('/docs/spec.md#error-codes', pathToId, 'docs/README.md')).toBe('id-spec');
    expect(resolveDocPath('./spec.md#section-x', pathToId, 'docs/README.md')).toBe('id-spec');
  });

  it('同目录相对 ./ 与裸文件名：按源目录精确解析', () => {
    // docs/README.md 内 ./spec.md → docs/spec.md；裸 spec.md 同理
    expect(resolveDocPath('./spec.md', pathToId, 'docs/README.md')).toBe('id-spec');
    expect(resolveDocPath('spec.md', pathToId, 'docs/README.md')).toBe('id-spec');
  });

  it('嵌套目录上溯 ../：docs/spec.md 内 ../guides/t.md → guides/t.md', () => {
    expect(resolveDocPath('../guides/t.md', pathToId, 'docs/spec.md')).toBe('id-guide');
  });

  it('旧启发式 docs/ 前缀补全已删除：docs/README.md 内 ../架构 裸文件名不再命中顶层', () => {
    // 从 docs/ 子目录写顶层 README.md 裸文件名 = docs/README.md 不存在 → 断链，
    // 根绝对写法（/README.md）才是正确姿势（行为变更钉死）
    expect(resolveDocPath('README.md', pathToId, 'docs/README.md')).toBeNull();
    expect(resolveDocPath('/README.md', pathToId, 'docs/README.md')).toBe('id-readme');
  });

  it('越出空间根（normalize 结果以 .. 开头）→ null（不可达 = 断链）', () => {
    // docs/spec.md 上加两级 → ../t.md 越界；一层 → guides/t.md 恰好不越界
    expect(resolveDocPath('../../t.md', pathToId, 'docs/spec.md')).toBeNull();
    expect(resolveDocPath('../guides/t.md', pathToId, 'docs/spec.md')).toBe('id-guide');
  });

  it('自引用：docs/spec.md 内 ./spec.md 命中自身', () => {
    expect(resolveDocPath('./spec.md', pathToId, 'docs/spec.md')).toBe('id-spec');
  });

  it('未命中返回 null（断链）', () => {
    expect(resolveDocPath('/docs/missing.md', pathToId, 'docs/spec.md')).toBeNull();
    expect(resolveDocPath('./missing.md', pathToId, 'docs/spec.md')).toBeNull();
  });

  it.each([
    '#section', // 纯锚点
    'images/logo.png', // 非 .md 相对路径
    'assets/', // 目录
    '', // 空 href
  ])('非职责范围 %s 返回 undefined（不干预）', (href) => {
    expect(resolveDocPath(href, pathToId, 'docs/spec.md')).toBeUndefined();
  });
});

describe('resolveDocHref（懒加载版路径解析：只做路径数学，不依赖文档列表）', () => {
  it('与 resolveDocPath 同源：根绝对/源相对/上溯/越界判定一致', () => {
    expect(resolveDocHref('/docs/architecture.md', 'docs/spec.md')).toBe('docs/architecture.md');
    expect(resolveDocHref('./spec.md', 'docs/README.md')).toBe('docs/spec.md');
    expect(resolveDocHref('../guides/t.md', 'docs/spec.md')).toBe('guides/t.md');
    expect(resolveDocHref('../../t.md', 'docs/spec.md')).toBeNull();
  });

  it('剥离 # 锚点后返回纯路径', () => {
    expect(resolveDocHref('/docs/spec.md#error-codes', 'docs/README.md')).toBe('docs/spec.md');
  });

  it.each([
    '#section', // 纯锚点
    'images/logo.png', // 非 .md 相对路径
    'assets/', // 目录
    '', // 空 href
  ])('非职责范围 %s 返回 undefined（不干预）', (href) => {
    expect(resolveDocHref(href, 'docs/spec.md')).toBeUndefined();
  });
});
