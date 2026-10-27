/**
 * scope 豁免面的**双向相等**机器强制（2026-10-16 卡 72566c2e，安全评审唯一阻塞项的定稿写法）。
 *
 * 为什么必须是双向相等：非 GET 路由默认按 `write` 判定，所以"被标注集 ⊆ 清单"这类单向谓词
 * 恒为真（空洞断言）。只有"标注集 === 清单"才能保证：
 *   ① 新增 `@AgentScope('read')` 而未登记 ⇒ 红（多一个）；
 *   ② 清单里保留了一条已被删除/改写的标注 ⇒ 红（少一个），陈旧豁免不会静默存活。
 *
 * 实施方式 = **源文件扫描**（贴合 swagger-schema.spec.ts 的 DTO 扫描先例）：
 *   - 只扫 `src/modules/**\/*.controller.ts`；
 *   - 锚点行必须**以 `@AgentScope(` 开头**（行首匹配 ⇒ 注释里的提及不会误命中）；
 *   - 从锚点向前找最近的 HTTP 方法 decorator（`@Post('...')` 等）取 method + path；
 *     向后找最近的 `async <name>(` 取 handler 名。两个方向都设 60 行上限，
 *     找不到即判失败（不静默跳过——否则锚点漂移会变成假绿）。
 *
 * 刻意**不** import AppModule（`app.module.spec.ts` 已记录元数据断言被废弃的教训）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AGENT_SCOPE_READ_EXEMPTIONS,
  AGENT_SCOPE_READ_NOT_EXEMPT,
  AGENT_SCOPE_WRITE_DECIDED,
  type AgentScopeExemption,
} from './agent-scope-exemptions';

/**
 * 锚点查找窗口（向上/向下两腿各自独立，2026-10-17 F4 项3 复审后修正命名）。
 * 方向以**锚点所在行**为基准：向上 = 找 route decorator，向下 = 找 handler 签名。
 *
 * - **向上（route decorator）窗口 = 200**：handler 的 decorator 栈高度**由 Swagger
 *   文案决定**，而文案要求"逐态写清下一步做什么"（memory.controller 的 recall 一个
 *   `@ApiOperation` 就有 ~70 行）。实测五处登记点的向上距离：13 / 18 / 20 / 35 / **82**
 *   （memory recall）——旧值 60 意味着 recall 只剩 **1 行余量**（加一条 @ApiResponse
 *   就红），那是窗口尺寸不匹配代码现实，不是"decorator 顺序变了"。
 * - **向下（handler）窗口 = 60**：所有登记点的实测距离都是 1 行
 *   （`@AgentScope('read')` 直接压在 handler 签名上一行——这是本仓的写法约定）。
 *
 * ⚠️ 窗口只决定**能否定位**：定位不到就直接 `failures.push` ⇒ 整个 spec 红。
 * 真正的护栏不是窗口大小，而是四元组（method / path / source / handler）与清单的
 * **双向相等**断言——窗口放宽不会让错配的标注变成"通过"，只会让合法的长 decorator
 * 栈也能被认出来（向上仍是**取最近的一个** HTTP 方法 decorator，不是任意匹配）。
 */
const UPWARD_SEARCH_WINDOW_LINES = 200;
const DOWNWARD_SEARCH_WINDOW_LINES = 60;

/** 本 spec 所在目录（apps/backend/src/config） */
const SRC_ROOT = path.join(__dirname, '..');
const BACKEND_ROOT = path.join(__dirname, '..', '..');
const TEST_ROOT = path.join(BACKEND_ROOT, 'test');
/** decorator 模块的仓库相对路径（引用者集合断言的锚点） */
const DECORATOR_MODULE_PATH = 'apps/backend/src/common/decorators/agent-scope.decorator.ts';

/** monorepo 根（用于把绝对路径转成与清单里 `source` 一致的仓库相对路径）：config → src → backend → apps → 根 */
const MONOREPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

/** 绝对路径 → 清单里的 source 形状（`apps/backend/src/...`） */
function toRepoRelative(file: string): string {
  return path.relative(MONOREPO_ROOT, file).split(path.sep).join('/');
}

/** 递归收集目录下全部 `.ts`（不含 `.d.ts`）文件 */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** apps/backend/{src,test} 下全部 .ts */
function collectBackendTsFiles(): string[] {
  return [...collectTsFiles(SRC_ROOT), ...collectTsFiles(TEST_ROOT)];
}

interface ScannedAnnotation extends AgentScopeExemption {
  /** 供失败消息用的 file:line */
  locator: string;
}

/** 递归收集 controller 源文件 */
function collectControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectControllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 取文件的 `@Controller('prefix')` 前缀（无前缀 / `@Controller()` → 空串） */
function readControllerPrefix(content: string): string {
  const match = content.match(/@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/);
  if (!match) return '';
  return match[1] ?? match[2] ?? '';
}

/** 拼接归一化路由：`/` + controller 前缀 + decorator 路径（去掉重复斜杠；无全局 /api/v1 前缀） */
function normalizePath(controllerPrefix: string, decoratorPath: string): string {
  const segments = [controllerPrefix, decoratorPath].filter((s) => s.length > 0);
  return '/' + segments.join('/').replace(/^\/+/, '');
}

const HTTP_METHOD_RE = /@(Get|Post|Patch|Put|Delete|Options|Head|All|Trace|Connect)\(\s*(?:'([^']*)'|"([^"]*)")?/;

/**
 * 扫描全部 `src/**\/*.ts`（**不再限于 controller**）。
 *
 * 理由（2026-10-16 code-review M1）：guard 的真源是 `Reflect.getMetadata`——扫描面若只覆盖
 * `*.controller.ts`，一个写在 service / gateway / 非 `modules/` 目录下的 `@AgentScope` 标注
 * 会**对 guard 生效但对本 spec 隐形**（洞）。这里把扫描面扩到整个 `src/`；非 controller 文件
 * 的标注因取不到 HTTP 方法 decorator 而**报错**（而不是被静默跳过），从而强制显式登记。
 * 引用者集合的兜底断言见文件末尾 describe（连别名 import 与直写 SetMetadata 一起覆盖）。
 */
function scanAnnotations(): ScannedAnnotation[] {
  const results: ScannedAnnotation[] = [];
  const failures: string[] = [];

  for (const file of collectTsFiles(SRC_ROOT)) {
    const rel = toRepoRelative(file);
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const controllerPrefix = readControllerPrefix(content);

    lines.forEach((line, index) => {
      // 行首锚点：排除注释/字符串里的提及（它们不以 @ 开头）
      if (!/^\s*@AgentScope\(/.test(line)) return;
      const scopeMatch = line.match(/^\s*@AgentScope\(\s*'([^']+)'\s*\)/);
      if (!scopeMatch) {
        failures.push(`${rel}:${index + 1} @AgentScope 写法无法解析（只支持 @AgentScope('read')）`);
        return;
      }
      const scope = scopeMatch[1];
      if (scope !== 'read') {
        // 本清单只登记 read 豁免；write 覆写（收紧）不在豁免面内，但需显式登记在此以免被忽略
        failures.push(
          `${rel}:${index + 1} 出现非 read 的 @AgentScope('${scope}')——本清单只覆盖 read 豁免，` +
            `若确需 write 覆写请在本 spec 中显式登记`,
        );
        return;
      }

      // 向上找最近的 HTTP 方法 decorator（窗口见 UPWARD_SEARCH_WINDOW_LINES）
      let method: string | null = null;
      let decoratorPath = '';
      for (let i = index - 1; i >= 0 && index - i <= UPWARD_SEARCH_WINDOW_LINES; i--) {
        const m = lines[i].match(HTTP_METHOD_RE);
        if (m) {
          method = m[1].toUpperCase();
          decoratorPath = m[2] ?? m[3] ?? '';
          break;
        }
      }
      // 向下找最近的 handler 声明（2 空格缩进的类方法签名；排除 decorator 行）
      let handler: string | null = null;
      for (let i = index; i < lines.length && i - index <= DOWNWARD_SEARCH_WINDOW_LINES; i++) {
        const m = lines[i].match(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
        if (m) {
          handler = m[1];
          break;
        }
      }

      if (!method || !handler) {
        failures.push(
          `${rel}:${index + 1} 无法定位 method（${method}）或 handler（${handler}）——` +
            `decorator 顺序可能已变更，请修正扫描器而不是放宽断言`,
        );
        return;
      }

      results.push({
        method: method as AgentScopeExemption['method'],
        path: normalizePath(controllerPrefix, decoratorPath),
        source: rel,
        handler,
        reason: '',
        locator: `${rel}:${index + 1}`,
      });
    });
  }

  expect(failures).toEqual([]);
  return results;
}

/** 元组比较键（四元组，全部参与相等判定——路径写错也必须红） */
function keyOf(e: Pick<AgentScopeExemption, 'method' | 'path' | 'source' | 'handler'>): string {
  return `${e.method} ${e.path} | ${e.source}#${e.handler}`;
}

describe('API Key scope 豁免面 — 源码 ↔ 清单 双向相等', () => {
  it('扫描到的 @AgentScope(\'read\') 集合 === 签入清单（多一个/少一个都红）', () => {
    const scanned = scanAnnotations();
    const declared = AGENT_SCOPE_READ_EXEMPTIONS;

    const scannedKeys = new Set(scanned.map((a) => keyOf(a)));
    const declaredKeys = new Set(declared.map((d) => keyOf(d)));

    const extraInSource = scanned
      .filter((a) => !declaredKeys.has(keyOf(a)))
      .map((a) => `${a.locator} → ${keyOf(a)}（源码有标注但清单未登记：请在 config/agent-scope-exemptions.ts 登记并给出理由）`);
    const staleInList = declared
      .filter((d) => !scannedKeys.has(keyOf(d)))
      .map((d) => `${keyOf(d)}（清单有登记但源码无对应标注：豁免已失效或被改写，请删除该条）`);

    expect({ extraInSource, staleInList }).toEqual({ extraInSource: [], staleInList: [] });
  });

  it('豁免清单条数与源码标注数一致（显式快照：新增 POST 的 review 信号）', () => {
    expect(scanAnnotations()).toHaveLength(AGENT_SCOPE_READ_EXEMPTIONS.length);
    expect(AGENT_SCOPE_READ_EXEMPTIONS).toHaveLength(5);
  });

  it('每条豁免都写了理由（空理由 = 无效登记）', () => {
    const missing = AGENT_SCOPE_READ_EXEMPTIONS.filter((e) => e.reason.trim().length < 20).map(keyOf);
    expect(missing).toEqual([]);
  });

  it('显式不豁免名单与显式判定记录非空（防止被清空后失去评审依据）', () => {
    expect(AGENT_SCOPE_READ_NOT_EXEMPT.length).toBeGreaterThanOrEqual(6);
    expect(AGENT_SCOPE_WRITE_DECIDED.length).toBeGreaterThanOrEqual(3);
  });
});

describe('非常规方法面 — 守卫的方法映射必须覆盖真实路由面', () => {
  it('controller 里只出现 GET/POST/PATCH/PUT/DELETE（无 @Options/@Head/@All/@Trace/@Connect 旁路）', () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const file of collectControllerFiles(path.join(SRC_ROOT, 'modules'))) {
      const rel = toRepoRelative(file);
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        const m = line.match(/^\s*@(Options|Head|All|Trace|Connect)\(/);
        if (m) violations.push(`${rel}:${index + 1} @${m[1]}(`);
        const normal = line.match(/^\s*@(Get|Post|Patch|Put|Delete)\(/);
        if (normal) seen.add(normal[1]);
      });
    }
    expect(violations).toEqual([]);
    // 真实路由面确实覆盖了这几族（防止"扫不到任何东西"的假绿）
    expect([...seen].sort()).toEqual(['Delete', 'Get', 'Patch', 'Post', 'Put']);
  });
});

/**
 * decorator 模块的**引用者白名单**（2026-10-16 code-review M1）。
 *
 * 为什么需要：豁免面的双向相等断言只认 `@AgentScope(` 字面写法，而 guard 的真源是
 * `Reflect.getMetadata`。别名 import（`AgentScope as S`）、直写
 * `SetMetadata(AGENT_SCOPE_KEY, …)`、以及写在 `src/modules` 之外/非 controller 文件里的
 * 标注，都能"对 guard 生效但对扫描隐形"。本断言改为按**模块说明符**（而非局部名）收集
 * 引用者，从而对上述三种形态一律敏感——任何新引用者都必须在此显式登记。
 *
 * 关于"decorator 自身"：定义处不 import 自己，故不在本集合内；它的**定义唯一性**由下一条
 * 断言单独钉死（`AGENT_SCOPE_KEY` 的赋值与 `SetMetadata(AGENT_SCOPE_KEY` 调用各只允许一处）。
 * 关于本 spec 自引用：本 spec 走纯文本扫描，**不 import** 该模块（也就没有自引用）；
 * 若将来改为 import 形态，本集合断言会强制把自身登记进来。
 */
const DECORATOR_REFERENCING_FILES: readonly string[] = [
  // 执行面：读 handler 元数据
  'apps/backend/src/common/guards/api-key-scope.guard.ts',
  // 判定矩阵单测（要拿到 AGENT_SCOPE_KEY 才能给替身 handler 挂元数据）
  'apps/backend/src/common/guards/api-key-scope.guard.spec.ts',
  // 5 个读语义豁免端点（清单单源见 agent-scope-exemptions.ts）
  'apps/backend/src/modules/memory/memory.controller.ts',
  'apps/backend/src/modules/docspace/diagram.controller.ts',
  'apps/backend/src/modules/attachments/attachment.controller.ts',
  'apps/backend/src/modules/topic/topic.controller.ts',
  'apps/backend/src/modules/usage-stats/usage-events.controller.ts',
  // 真 PG e2e：用真实 controller 原型方法的元数据驱动守卫（断言豁免真的挂上了）
  'apps/backend/test/api-key-scopes.e2e-spec.ts',
];

/** import / require 的模块说明符（按说明符匹配 ⇒ 别名 import 同样命中） */
const MODULE_SPECIFIER_RE = /(?:from\s*|require\(\s*)['"]([^'"]+)['"]/g;

describe('decorator 引用者集合 — 新增引用者必须显式登记（M1 兜底）', () => {
  it('引用 agent-scope.decorator 的文件集合 === 白名单', () => {
    const found: Array<{ file: string; locator: string }> = [];
    for (const file of collectBackendTsFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = toRepoRelative(file);
      for (const match of content.matchAll(MODULE_SPECIFIER_RE)) {
        if (!match[1].endsWith('agent-scope.decorator')) continue;
        const line = content.slice(0, match.index ?? 0).split('\n').length;
        found.push({ file: rel, locator: `${rel}:${line}` });
        break; // 同一文件只记一次
      }
    }

    // 扫描器自身的健全性：必须真的扫到文件（防"目录写错 → 恒空集合 → 断言恒绿"）
    expect(collectBackendTsFiles().length).toBeGreaterThan(100);

    const foundFiles = new Set(found.map((f) => f.file));
    const expected = new Set(DECORATOR_REFERENCING_FILES);

    const unregistered = found
      .filter((f) => !expected.has(f.file))
      .map(
        (f) =>
          `${f.locator} 引用了 agent-scope.decorator 但未登记——若是有意为之，请加入本 spec 的 ` +
          `DECORATOR_REFERENCING_FILES 并说明理由；若是笔误，请删掉该引用`,
      );
    const stale = DECORATOR_REFERENCING_FILES.filter((f) => !foundFiles.has(f)).map(
      (f) => `${f} 已不再引用 agent-scope.decorator——请从白名单删除`,
    );

    expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] });
  });

  it('定义唯一性：AGENT_SCOPE_KEY 的赋值与 SetMetadata 调用各只允许一处（decorator 自身）', () => {
    const assignmentSites: string[] = [];
    const setMetadataSites: string[] = [];
    for (const file of collectBackendTsFiles()) {
      const rel = toRepoRelative(file);
      fs.readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          // 排除注释行（避免误伤文档里的示例写法）
          const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
          if (/\bAGENT_SCOPE_KEY\s*=/.test(code)) assignmentSites.push(`${rel}:${index + 1}`);
          if (/SetMetadata\(\s*AGENT_SCOPE_KEY/.test(code)) setMetadataSites.push(`${rel}:${index + 1}`);
        });
    }
    // 只断言"处数与归属文件"，不钉行号（行号随注释增减漂移，钉死会让断言变成噪音源）
    const filesOf = (sites: string[]): string[] => [...new Set(sites.map((s) => s.split(':')[0]))];
    expect(assignmentSites).toHaveLength(1);
    expect(filesOf(assignmentSites)).toEqual([DECORATOR_MODULE_PATH]);
    expect(setMetadataSites).toHaveLength(1);
    expect(filesOf(setMetadataSites)).toEqual([DECORATOR_MODULE_PATH]);
  });
});
