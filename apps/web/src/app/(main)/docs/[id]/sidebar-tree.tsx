/**
 * 左栏目录树（docs 空间详情页「目录」视图模式）。
 *
 * - `buildPathTree`：纯函数——DocSummary[] → 嵌套节点树（独立单测见 sidebar-tree.test.tsx）。
 * - `PathTreeView`：递归渲染组件；折叠状态由父组件注入（`collapsedFolders`，key = 文件夹路径前缀
 *   如 'docs'、'docs/sub'，仅会话内记忆），自身不持有状态。
 *
 * 设计意图（2026-08-22 评审修订③⑤）：目录树按 doc.path 目录前缀还原文件层级，是人类的默认心智模型；
 * 分类（category）是 Agent 策展的单层维度，保留为第二模式。同名标题可能来自不同目录，
 * 文件行用 title=path 提示解歧义。同款缩进线（ml-2 border-l border-border/40 pl-2）照抄分类树。
 */
import { FileText, FolderTree } from 'lucide-react';
import type { DocSummary } from '@/types';

/** 目录树节点：folder = 目录（含子树文档计数），file = 叶子文档 */
export type PathTreeNode =
  | { type: 'folder'; name: string; path: string; children: PathTreeNode[]; count: number }
  | { type: 'file'; doc: DocSummary };

/** folder/file 显示名排序（各自字母序；localeCompare 对大小写混合名稳定可预期） */
const compareByName = (a: string, b: string) => a.localeCompare(b);

/** 构建期内部容器：folder 用 Map 按段名快速定位子目录，避免逐层线扫 O(n²) */
interface FolderBuilder {
  name: string;
  path: string;
  files: DocSummary[];
  subfolders: Map<string, FolderBuilder>;
}

/** 递归把 builder 折叠成不可变 PathTreeNode：folder 在前、file 在后，各自字母序 */
function buildNodes(builder: FolderBuilder): PathTreeNode[] {
  const folderNodes: PathTreeNode[] = Array.from(builder.subfolders.values())
    .sort((a, b) => compareByName(a.name, b.name))
    .map((sub) => {
      const children = buildNodes(sub);
      // 计数 = 子树文档总数（含嵌套目录）：folder 行一眼看到体量
      const count = children.reduce(
        (sum, node) => sum + (node.type === 'file' ? 1 : node.count),
        0,
      );
      return { type: 'folder', name: sub.name, path: sub.path, children, count };
    });
  const fileNodes: PathTreeNode[] = builder.files
    .sort((a, b) => compareByName(a.title, b.title))
    .map((doc) => ({ type: 'file', doc }));
  return [...folderNodes, ...fileNodes];
}

/**
 * 纯函数：按 doc.path 的 '/' 分段组装目录树。
 * - 根级散文件（path 无目录前缀，如 'README.md'）优先挂树顶
 * - 每个节点 folder 在前、file 在后，各自按显示名（folder 段名 / file 标题）字母序
 */
export function buildPathTree(docs: DocSummary[]): PathTreeNode[] {
  const root: FolderBuilder = { name: '', path: '', files: [], subfolders: new Map() };
  for (const doc of docs) {
    const segments = doc.path.split('/');
    const dirSegments = segments.slice(0, -1);
    let current = root;
    let prefix = '';
    for (const seg of dirSegments) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = current.subfolders.get(seg);
      if (!child) {
        child = { name: seg, path: prefix, files: [], subfolders: new Map() };
        current.subfolders.set(seg, child);
      }
      current = child;
    }
    current.files.push(doc);
  }
  const rootFiles: PathTreeNode[] = root.files
    .sort((a, b) => compareByName(a.title, b.title))
    .map((doc) => ({ type: 'file', doc }));
  // 根级散文件已单独挂树顶——清空容器避免 buildNodes 对 root.files 二次输出（否则每个根级文件出现两行）
  root.files = [];
  return [...rootFiles, ...buildNodes(root)];
}

/**
 * 目录树文件行：样式与分类树的 DocTreeItem（page.tsx）对齐，
 * 另加 title=path 提示——目录树里同名标题可能来自不同目录（评审修订⑤）。
 */
function FileRow({
  doc,
  active,
  onSelect,
}: {
  doc: DocSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      title={doc.path}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
      }`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="flex-1 truncate text-xs">{doc.title}</span>
      {doc.docType && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {doc.docType}
        </span>
      )}
    </button>
  );
}

/**
 * 目录树视图：递归渲染 folder/file 节点。
 * 折叠 Set 以文件夹路径前缀为 key，由父组件持有——只在会话内记忆，刷新后恢复全展开（防过度设计）。
 */
export function PathTreeView({
  nodes,
  collapsedFolders,
  onToggleFolder,
  activeDocId,
  onSelectDoc,
}: {
  nodes: PathTreeNode[];
  collapsedFolders: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  activeDocId: string | null;
  onSelectDoc: (docId: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <div key={node.path}>
            <button
              onClick={() => onToggleFolder(node.path)}
              className="flex w-full items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <FolderTree className="h-3.5 w-3.5 text-primary/70" />
              <span className="flex-1 truncate text-left">{node.name}</span>
              <span className="text-[10px]">{node.count}</span>
            </button>
            {!collapsedFolders.has(node.path) && (
              /* 缩进线照抄分类树：子层左缩进 + 竖线分隔 */
              <div className="ml-2 space-y-0.5 border-l border-border/40 pl-2">
                <PathTreeView
                  nodes={node.children}
                  collapsedFolders={collapsedFolders}
                  onToggleFolder={onToggleFolder}
                  activeDocId={activeDocId}
                  onSelectDoc={onSelectDoc}
                />
              </div>
            )}
          </div>
        ) : (
          <FileRow
            key={node.doc.id}
            doc={node.doc}
            active={node.doc.id === activeDocId}
            onSelect={() => onSelectDoc(node.doc.id)}
          />
        ),
      )}
    </div>
  );
}
