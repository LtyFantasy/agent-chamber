import { isExternalHref, resolveDocPath, PLATFORM_DOC_LINK_RE } from './doc-link';

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

describe('resolveDocPath', () => {
  it('原样 path 直接命中', () => {
    expect(resolveDocPath('docs/architecture.md', pathToId)).toBe('id-arch');
    expect(resolveDocPath('README.md', pathToId)).toBe('id-readme');
  });

  it('剥离 # 锚点后命中', () => {
    expect(resolveDocPath('docs/spec.md#error-codes', pathToId)).toBe('id-spec');
  });

  it('归一化 ./ 前缀', () => {
    expect(resolveDocPath('./README.md', pathToId)).toBe('id-readme');
  });

  it('归一化连续 ../ 前缀', () => {
    expect(resolveDocPath('../README.md', pathToId)).toBe('id-readme');
    expect(resolveDocPath('../../docs/spec.md', pathToId)).toBe('id-spec');
  });

  it('原样未命中时尝试补 docs/ 前缀', () => {
    expect(resolveDocPath('architecture.md', pathToId)).toBe('id-arch');
  });

  it('未命中返回 null（断链）', () => {
    expect(resolveDocPath('docs/missing.md', pathToId)).toBeNull();
  });

  it.each([
    '#section', // 纯锚点
    'images/logo.png', // 非 .md 相对路径
    'assets/', // 目录
  ])('非职责范围 %s 返回 undefined（不干预）', (href) => {
    expect(resolveDocPath(href, pathToId)).toBeUndefined();
  });
});
