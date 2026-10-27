/**
 * per-item 错误文案单源（batch-error.util.ts）的机器强制 + 构造点白名单（F4 项5 / S-N6）。
 *
 * 两块断言：
 * ① **构造点白名单双向相等**（S-N6「消毒链被绕过复活」）：`PublicBatchError` 的 message
 *    会原样透出，所以「谁能构造它」是安全边界。构造点集合（文件 + 宿主方法 + 处数）必须与
 *    清单双向相等（多一个未登记通道 / 少一个陈旧条目都红），且每个构造点的参数必须是
 *    **字面量 / 模板字面量**——参数禁用形态扫描 + 首字符结构断言双保险，后者堵住
 *    「`const raw = err.message; new PublicBatchError(raw)`」这类别名绕过。
 * ② **分类矩阵**（文案单源）：PG / PublicBatchError / HTTP 形状 / 其余各自的对外文案。
 *
 * 扫描面 = `apps/backend/src/**` 的**非测试源码**（排除 `*.spec.ts` / `*.d.ts`）：
 * 白名单要盯的是「谁能构造出可公开透出的错误」这条**生产**边界；测试文件里为断言而构造的
 * 实例不随产物发布、不影响任何响应面（把它们纳入只会让白名单随测试数量漂移）。
 *
 * 范式对照：config/agent-scope-exemptions.spec.ts 的引用者双向相等断言（同一手法、同一理由）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { QueryFailedError } from 'typeorm';
import {
  batchErrorShape,
  PER_ITEM_ERROR_MESSAGE_MAX,
  PublicBatchError,
  sanitizeBatchErrorMessage,
} from './batch-error.util';

/** 本 spec 位于 apps/backend/src/common/utils → 上溯两级 = apps/backend/src */
const SRC_ROOT = path.join(__dirname, '..', '..');
/** monorepo 根（转成清单里的 `apps/backend/src/...` 形状）：utils → common → src → backend → apps → 根 */
const MONOREPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

/** 构造调用锚点（写法含空白容忍；写在变量里 ⇒ 本 spec 自身源码不含字面锚点） */
const CALL_RE = /new\s+PublicBatchError\s*\(/g;

/** 宿主方法声明（允许 public/private/protected/static/async 修饰，2 空格缩进的类方法） */
const HANDLER_RE = /^ {2}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\(/;

/** 参数里禁止出现的「错误原文取用形态」（S-N6：消毒链被绕过复活的具体形态） */
const FORBIDDEN_ARGUMENT_TOKENS: readonly string[] = [
  '.message',
  '.stack',
  'String(',
  'JSON.stringify',
  'driverError',
];

interface CallSite {
  /** 仓库相对路径 */
  source: string;
  /** 宿主方法名（构造点落在哪个方法里） */
  handler: string;
  /** 供失败消息用的 file:line */
  locator: string;
  /** 构造参数原文（用于禁用形态与字面量结构检查） */
  argumentText: string;
}

/**
 * 合法构造点清单（双向相等的另一半）。
 *
 * 每条 = 一处构造点：`source#handler` + 该宿主方法内的构造处数 + 为什么这处文案可公开。
 * 行号刻意**不**进清单（随注释增减漂移，钉死会让断言变成噪音源）——用「文件 + 宿主方法 +
 * 处数」定位，既有辨识度又不随格式化漂移。
 */
const PUBLIC_BATCH_ERROR_CALL_SITES: ReadonlyArray<{
  source: string;
  handler: string;
  count: number;
  reason: string;
}> = [
  {
    source: 'apps/backend/src/modules/docspace/doc-bundle.service.ts',
    handler: 'importCategories',
    count: 1,
    reason:
      '分类同名歧义（bundle 业务键 name 在库内有多条）：文案只回显分类名与命中数，' +
      '是应用自己构造的诊断，不含任何 driver/原文信息。',
  },
  {
    source: 'apps/backend/src/modules/docspace/doc-bundle.service.ts',
    handler: 'importRoutes',
    count: 4,
    reason:
      '路由回导的四类应用级诊断（primaryDocPath 为空 / 主文档解析不到 / 次文档解析不到 / ' +
      '业务键歧义）：文案只回显 bundle 自带的 path、intent 与命中数，可公开。',
  },
  {
    source: 'apps/backend/src/modules/attachments/attachment.service.ts',
    handler: 'bindBundleMedia',
    count: 2,
    reason:
      '媒体回绑的两类应用级诊断（行不存在 / 行已绑到别的 doc 拒绝改绑）：文案只回显 bundle ' +
      '自带的 attachmentId。这两处**必须**是本类——media.failed[].reason 经文案单源消毒，' +
      '普通 Error 会被降级成 Internal error 丢掉诊断（复审 MAJOR-1 收口）。',
  },
];

/** 递归收集目录下全部 `.ts`（排除 `.d.ts` 与测试文件） */
function collectProductionTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectProductionTsFiles(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** 绝对路径 → 清单里的仓库相对形状 */
function toRepoRelative(file: string): string {
  return path.relative(MONOREPO_ROOT, file).split(path.sep).join('/');
}

/**
 * 从 `(` 位置读取**平衡括号内**的调用参数原文。
 *
 * 简化假设：字符串/模板字面量内的括号在现有构造点里是配平的（`('... (${n} matches)')`），
 * 因此单一深度计数器足够；若将来出现括号不配平的字面量，本函数返回 null，
 * 调用处会**判失败**而不是静默跳过（防锚点漂移变成假绿）。
 */
function readCallArguments(content: string, openParenIndex: number): string | null {
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return content.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/** 行级注释判定（`*` / `//` / `/*` 开头）——注释里的锚点提及不算构造点 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** 扫描生产源码，收集全部 PublicBatchError 构造点 */
function scanCallSites(): { sites: CallSite[]; filesScanned: number } {
  const sites: CallSite[] = [];
  const files = collectProductionTsFiles(SRC_ROOT);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const rel = toRepoRelative(file);
    const lines = content.split('\n');

    for (const match of content.matchAll(CALL_RE)) {
      const index = match.index ?? 0;
      const line = content.slice(0, index).split('\n').length;

      // 行级注释剔除：类文档里的**反例写法**（`new PublicBatchError(err.message)` 这类
      // 「禁止这样写」的示范）不是构造点。手法同 agent-scope-exemptions.spec.ts 的
      // 「行首锚点排除注释/字符串里的提及」——注释里的提及一律不算。
      if (isCommentLine(lines[line - 1] ?? '')) continue;

      // 宿主方法：自锚点向上找最近的 2 空格缩进方法声明（上限 200 行，找不到即失败）
      let handler: string | null = null;
      for (let i = line - 1; i >= 0 && line - 1 - i <= 200; i--) {
        const m = lines[i]?.match(HANDLER_RE);
        if (m) {
          handler = m[1];
          break;
        }
      }
      if (!handler) {
        throw new Error(
          `${rel}:${line} 构造函数调用前 200 行内找不到宿主方法声明——` +
            `扫描器需要修正（不要放宽断言，否则定位失效）`,
        );
      }

      const openParenIndex = index + match[0].length - 1;
      const argumentText = readCallArguments(content, openParenIndex);
      if (argumentText === null) {
        throw new Error(`${rel}:${line} 构造函数调用括号不配平——扫描器无法读取参数原文`);
      }

      sites.push({ source: rel, handler, locator: `${rel}:${line}`, argumentText });
    }
  }

  return { sites, filesScanned: files.length };
}

describe('PublicBatchError 构造点 — 源码 ↔ 白名单双向相等（S-N6）', () => {
  it('构造点集合 === 清单（多一个未登记通道 / 少一个陈旧条目都红）', () => {
    const { sites, filesScanned } = scanCallSites();

    // 扫描器健全性：必须真的扫到源码（防「目录写错 → 恒空集合 → 断言恒绿」）
    expect(filesScanned).toBeGreaterThan(100);
    expect(sites.length).toBeGreaterThan(0);

    const keyOf = (s: { source: string; handler: string }): string => `${s.source}#${s.handler}`;

    const scannedCounts = new Map<string, number>();
    for (const site of sites) {
      scannedCounts.set(keyOf(site), (scannedCounts.get(keyOf(site)) ?? 0) + 1);
    }
    const declaredCounts = new Map<string, number>();
    for (const entry of PUBLIC_BATCH_ERROR_CALL_SITES) {
      declaredCounts.set(keyOf(entry), entry.count);
    }

    const unregistered = sites
      .filter((s) => !declaredCounts.has(keyOf(s)))
      .map(
        (s) =>
          `${s.locator} → ${keyOf(s)}（源码构造点未登记：新增可公开透出的错误必须在本 spec 登记 ` +
          `并论证文案内容可公开）`,
      );
    const stale = PUBLIC_BATCH_ERROR_CALL_SITES.filter(
      (d) => scannedCounts.get(keyOf(d)) !== d.count,
    ).map(
      (d) =>
        `${keyOf(d)} 期望 ${d.count} 处，实际 ${scannedCounts.get(keyOf(d)) ?? 0} 处` +
        `（构造点数量已变：新增处需补理由，减少处请更新清单——陈旧条目会掩盖真实构造面）`,
    );

    expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] });
  });

  it('构造参数中不得出现错误原文的取用形态（S-N6：禁把捕获错误原文当参数）', () => {
    const { sites } = scanCallSites();

    const violations = sites
      .filter((s) => FORBIDDEN_ARGUMENT_TOKENS.some((token) => s.argumentText.includes(token)))
      .map(
        (s) =>
          `${s.locator} 构造参数含禁用形态（命中 ${FORBIDDEN_ARGUMENT_TOKENS.filter((t) => s.argumentText.includes(t)).join(', ')}）：` +
          `本类 message 会原样透出给调用方，传错误原文 = 把 PG 原文重新带回响应面`,
      );

    expect(violations).toEqual([]);
  });

  it('构造参数必须是字面量 / 模板字面量（堵别名绕过：const raw = err.message → new PublicBatchError(raw)）', () => {
    const { sites } = scanCallSites();

    // 结构断言：参数 trim 后首字符必须是引号（' / " / `）。禁用形态扫描只看
    // `.message` 等取值**写法**，先取到变量再传就能绕过——首字符断言是那道缺口。
    const violations = sites
      .filter((s) => !/^['"`]/.test(s.argumentText.trim()))
      .map(
        (s) =>
          `${s.locator} 构造参数首字符不是引号（实际开头 ${JSON.stringify(s.argumentText.trim().slice(0, 32))}）——` +
          `只允许字面量 / 模板字面量直接构造，变量透传无法证明文本可公开`,
      );

    expect(violations).toEqual([]);
    // 扫描器健全性：本仓当前至少 5 处（防「扫到 0 处 → 断言恒绿」）
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('每条白名单条目都写了理由（空理由 = 无效登记）', () => {
    const missing = PUBLIC_BATCH_ERROR_CALL_SITES.filter((e) => e.reason.trim().length < 20).map(
      (e) => `${e.source}#${e.handler}`,
    );
    expect(missing).toEqual([]);
  });
});

describe('sanitizeBatchErrorMessage — per-item 文案单源（doc 段与 media 段共用）', () => {
  /** 构造带 driverError 的 PG 错误（形态与 all-exceptions.filter.spec 一致） */
  const pgError = (
    message: string,
    driverError: { code?: string; detail?: string } = {},
  ): QueryFailedError =>
    new QueryFailedError('INSERT', [], Object.assign(new Error(message), driverError));

  it('PG 唯一约束冲突 → 固定文案 Resource conflict（无 relation/constraint/violates 字样）', () => {
    const message = sanitizeBatchErrorMessage(
      pgError('duplicate key value violates unique constraint "docs_path_key"', { code: '23505' }),
    );

    expect(message).toBe('Resource conflict');
    expect(message).not.toMatch(/relation|constraint|violates/i);
  });

  it('PG uuid 语法错（含用户输入回显）→ 固定文案，原文不出现在返回值里', () => {
    const message = sanitizeBatchErrorMessage(
      pgError('invalid input syntax for type uuid: "not-a-uuid-from-user"'),
    );

    expect(message).toBe('Invalid UUID format');
    expect(message).not.toMatch(/invalid input syntax|not-a-uuid-from-user/i);
  });

  it('PublicBatchError → 原 message 透出（应用级诊断的刻意例外）', () => {
    expect(sanitizeBatchErrorMessage(new PublicBatchError("Ambiguous category name 'Arch'"))).toBe(
      "Ambiguous category name 'Arch'",
    );
  });

  it('带 code 的业务错误不被误吞成 PG 错误（A-C5：禁按 err.code duck-typing）', () => {
    const businessError = Object.assign(new Error('business rule violated'), { code: '23505' });

    expect(sanitizeBatchErrorMessage(businessError)).toBe('Internal error');
  });

  it('普通 Error → 固定 Internal error（不外泄 message）', () => {
    expect(sanitizeBatchErrorMessage(new Error('relation "docs" does not exist'))).toBe(
      'Internal error',
    );
  });

  it('基类 HttpException 的字符串入参形态 → 透出该字符串（MINOR-2）', () => {
    expect(sanitizeBatchErrorMessage(new HttpException('Too many requests', 429))).toBe(
      'Too many requests',
    );
  });

  it('超长 message 截断到 PER_ITEM_ERROR_MESSAGE_MAX', () => {
    expect(sanitizeBatchErrorMessage(new PublicBatchError('y'.repeat(900)))).toHaveLength(
      PER_ITEM_ERROR_MESSAGE_MAX,
    );
  });

  it('batchErrorShape 与文案单源同判（message 与 code 不错配）', () => {
    expect(
      batchErrorShape(
        pgError('duplicate key value violates unique constraint "x_key"', { code: '23505' }),
      ),
    ).toEqual({ message: 'Resource conflict', code: ErrorCode.RESOURCE_CONFLICT });
    expect(batchErrorShape(new PublicBatchError('diagnostic'))).toEqual({
      message: 'diagnostic',
    });
  });
});
