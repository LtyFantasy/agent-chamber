import { buildPathTree, type PathTreeNode } from './sidebar-tree';
import type { DocSummary } from '@/types';

/** 目录节点窄化类型（断言用） */
type FolderNode = Extract<PathTreeNode, { type: 'folder' }>;

/** 最小文档 fixture：title 默认取路径末段，便于按字母序断言 */
const doc = (id: string, path: string, title?: string): DocSummary => ({
  id,
  spaceId: 'space-1',
  path,
  title: title ?? path.split('/').pop() ?? path,
});

/** 目录节点访问器：断言先行，命中失败即抛错中断（测试内窄化 TS 类型用） */
function expectFolder(nodes: PathTreeNode[], name: string): FolderNode {
  const node = nodes.find((n) => n.type === 'folder' && n.name === name);
  expect(node).toBeDefined();
  if (!node || node.type !== 'folder') throw new Error(`expected folder "${name}"`);
  return node;
}

/** 子树顶层展示序列：folder 显名、file 显标题——用于断言「folder 在前 + 字母序」 */
const displayOrder = (nodes: PathTreeNode[]) =>
  nodes.map((n) => (n.type === 'folder' ? n.name : n.doc.title));

describe('buildPathTree（纯函数）', () => {
  it('空输入返回空树', () => {
    expect(buildPathTree([])).toEqual([]);
  });

  it('根级散文件（path 无目录前缀）挂树顶并按字母序', () => {
    const tree = buildPathTree([
      doc('1', 'z.md', 'Zulu'),
      doc('2', 'a.md', 'Alpha'),
      doc('3', 'index.md', 'Index'),
    ]);
    expect(tree.map((n) => (n.type === 'file' ? n.doc.id : n.name))).toEqual(['2', '3', '1']);
  });

  it('嵌套组装：多层目录按层级归位，folder 计数 = 子树文档总数（含嵌套）', () => {
    const tree = buildPathTree([
      doc('1', 'docs/a.md', 'A'),
      doc('2', 'docs/sub/b.md', 'B'),
      doc('3', 'docs/sub/deep/c.md', 'C'),
    ]);
    expect(tree).toHaveLength(1);
    const docsFolder = expectFolder(tree, 'docs');
    expect(docsFolder).toMatchObject({ path: 'docs', count: 3 });
    expect(displayOrder(docsFolder.children)).toEqual(['sub', 'A']); // folder 在前、file 在后

    const sub = expectFolder(docsFolder.children, 'sub');
    expect(sub).toMatchObject({ path: 'docs/sub', count: 2 });
    // sub 内：folder（deep）在前、file（B）在后
    expect(displayOrder(sub.children)).toEqual(['deep', 'B']);

    const deep = expectFolder(sub.children, 'deep');
    expect(deep).toMatchObject({ path: 'docs/sub/deep', count: 1 });
    expect(displayOrder(deep.children)).toEqual(['C']);
  });

  it('folder 优先 + 各自字母序（根级与深层各自稳定）', () => {
    const tree = buildPathTree([
      doc('1', 'docs/z.md', 'Zulu'),
      doc('2', 'docs/a.md', 'Alpha'),
      doc('3', 'docs/ma/m.md', 'M'),
      doc('4', 'docs/aa/a.md', 'AA'),
      doc('5', 'root.md', 'Root'),
      doc('6', 'zzz/x.md', 'X'),
    ]);
    // 根级散文件挂树顶；其后根级 folder 按字母序（docs 在 zzz 前）
    expect(displayOrder(tree)).toEqual(['Root', 'docs', 'zzz']);

    const docsFolder = expectFolder(tree, 'docs');
    // docs 层：folder（aa/ma）在前，file（Alpha/Zulu）在后，各自字母序
    expect(displayOrder(docsFolder.children)).toEqual(['aa', 'ma', 'Alpha', 'Zulu']);
    expect(docsFolder.count).toBe(4);
  });

  it('单层与多层混合：浅目录与深层目录并存、同名目录段各自独立', () => {
    const tree = buildPathTree([
      doc('1', 'top.md', 'Top'),
      doc('2', 'guides/a.md', 'A'),
      doc('3', 'guides/x/deep.md', 'Deep'),
      doc('4', 'docs/a.md', 'A2'),
      doc('5', 'docs/x/b.md', 'B'),
    ]);
    expect(displayOrder(tree)).toEqual(['Top', 'docs', 'guides']); // 根级散文件 + folder 字母序
    // 同名目录段 'x' 在 guides 与 docs 下各自独立（路径前缀不同，不串层）
    const guides = expectFolder(tree, 'guides');
    expect(displayOrder(guides.children)).toEqual(['x', 'A']);
    expect(guides.children[0]).toMatchObject({ path: 'guides/x', count: 1 });
    const docs = expectFolder(tree, 'docs');
    expect(displayOrder(docs.children)).toEqual(['x', 'A2']);
    expect(docs.children[0]).toMatchObject({ path: 'docs/x', count: 1 });
  });

  it('同路径前缀共享同一文件夹节点（计数去重不双计）', () => {
    const tree = buildPathTree([
      doc('1', 'docs/a.md'),
      doc('2', 'docs/b.md'),
      doc('3', 'docs/c.md'),
    ]);
    expect(tree).toHaveLength(1);
    const docsFolder = expectFolder(tree, 'docs');
    expect(docsFolder.count).toBe(3);
    expect(docsFolder.children).toHaveLength(3); // 三个文件并列，不再叠加子文件夹
  });

  it('folders 空目录（无任何文档的路径段）不产出节点', () => {
    // 所有文档都在根级：dirSegments 为空，不产生任何 folder 节点
    const tree = buildPathTree([doc('1', 'only.md'), doc('2', 'two.md')]);
    expect(tree.every((n) => n.type === 'file')).toBe(true);
  });
});
