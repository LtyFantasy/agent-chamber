import { docDisplayLabel, fileBaseName } from './doc-label';

describe('fileBaseName', () => {
  it('取路径最后一段并去 .md 后缀（大小写不敏感）', () => {
    expect(fileBaseName('memory/2026-09-02.md')).toBe('2026-09-02');
    expect(fileBaseName('README.md')).toBe('README');
    expect(fileBaseName('docs/A.MD')).toBe('A');
    expect(fileBaseName('notes.txt')).toBe('notes.txt'); // 非 .md 原样保留
    expect(fileBaseName('')).toBe('');
  });
});

describe('docDisplayLabel（文件名主 + 标题辅 + 去重）', () => {
  it('标题与文件名实质不同 → 双标签', () => {
    expect(docDisplayLabel({ path: 'docs/a.md', title: 'Alpha' })).toEqual({
      primary: 'a',
      secondary: 'Alpha',
    });
  });

  it('标题≈文件名（忽略大小写）→ 去重不显示辅标签', () => {
    expect(docDisplayLabel({ path: 'README.md', title: 'Readme' }).secondary).toBeNull();
  });

  it('标题带 .md 后缀仍≈文件名 → 去重', () => {
    expect(docDisplayLabel({ path: 'DEPLOY.md', title: 'DEPLOY.md' }).secondary).toBeNull();
  });

  it('空 / 空白 / 缺省标题 → 仅文件名', () => {
    expect(docDisplayLabel({ path: 'x.md', title: '' }).secondary).toBeNull();
    expect(docDisplayLabel({ path: 'x.md', title: '  ' }).secondary).toBeNull();
    expect(docDisplayLabel({ path: 'x.md', title: null }).secondary).toBeNull();
  });
});
