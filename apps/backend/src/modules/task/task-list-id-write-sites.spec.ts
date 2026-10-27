import * as fs from 'fs';
import * as path from 'path';

/**
 * =============================================================================
 * task.list_id 写入点白名单（源码扫描，F4-2 / V2-N2 / S-N2）
 * =============================================================================
 * [存在理由]
 *   「跨板写族」的安全性靠**穷举**成立：task.list_id 每多一个写入点，就多一条
 *   "把任务搬进/搬出某个 board"的通道；漏掉任何一处，其余各处的权限门就形同虚设。
 *   代码里没有类型系统能表达"list_id 只许这几处写"，故此处用**源码扫描 + 双向相等**
 *   把集合钉死：已知形态下新增/删除任何一处都会让本 spec 变红，强制走一次显式审计。
 *
 * [覆盖形态 —— 如实边界，**不要读成"任何写入都会变红"**（复审 C2）]
 *   ① 实体赋值：`<receiver>.listId = …`（receiver 白名单见 ASSIGN/EXCLUDED）
 *   ② 任务仓库写调用同族：`taskRepo.(update|save|insert|upsert)( … 实参含 listId/list_id … )`
 *      （复审 C2 前只认 `update(`，`save({...task, listId})` 这类同族形态会漏 ⇒ 已补齐；
 *       `this.` 前缀可选，含事务内 `const taskRepo = manager.getRepository(Task)` 的别名形态）
 *   ③ QueryBuilder 写：`.set(…)` 调用——实参与 ② 同走**平衡括号全文读取**（复审 MINOR：
 *      原实现逐行 `[^)]*` 会漏掉多行的 `.set({⏎ listId ⏎})`），命中判据是**键位**形态
 *      （对象字面量 `{ listId: … }` / 简写 `{ …, listId }` / 字符串键 `.set('list_id', …)`）。
 *      现实测 **0 真实站点**（登记为防未来分支；合成源码正向断言防它被写坏成死代码——
 *      空集合的"相等"本身无法区分"没有写入点"与"扫描器坏了"）。
 *      ⚠️ 刻意**不用裸 token 判定**：`Map.set(row.list_id, …)`（search.service.ts:638）的实参
 *      也含 `list_id`，但那不是列写入——裸 token 会凭空造出一个假写入点。键位判据天然排除它。
 *   ④ raw SQL：`SET list_id =`（守卫拒绝，migrations 除外）
 *   **未覆盖（已知盲区 B1-B3，见下）**：键为运行时字符串的动态赋值、经 DTO 展开进入
 *   `create()` 的 INSERT 载荷、以及**不叫 `taskRepo`** 的仓库变量。因此本 spec 的结论是
 *   「**已知形态**的写入点被钉死」，而不是「任何一处写入都会变红」。
 *
 * [白名单 = 四个写入流（与方案决策表 item12 一一对应）]
 *   ① update 路径（`applyTaskUpdate`）——字面站点是 status→mappedStatus 自动吸附
 *      （`task.listId = targetList.id`）；同一方法里的 DTO 合并循环属盲区 B1。
 *   ② move（`task.listId = dto.listId`）
 *   ③ removeList 的 moveTasksTo（`taskRepo.update(id, { listId })`）
 *   ④ reorderTasks（`taskRepo.update(id, { position, listId })`）
 *
 * [不变量：每个写入点都必须过跨板门]
 *   ①②③④ 都走 `TaskService.assertCrossBoardPlacement`（调用点注释写明门的方向：防注入
 *   落目标板 / reorder 防取出落当前列，且门判据集合必须覆盖写入集合——复审 C1）。
 *   本 spec 只钉"写入点集合"，门的**行为**由 task.policy.spec / task.service.spec /
 *   board.service.spec / task-permission.e2e / task-policy-soft-delete.e2e 覆盖。
 *
 * [已知盲区（刻意记录，不假装覆盖）]
 *   B1 `applyTaskUpdate` 的 `(task as unknown as Record<string, unknown>)[key] = value`
 *      DTO 合并循环：键是运行时字符串，字面扫描不可达 → 用 BLIND_SPOT_RE 钉住"它还在"，
 *      并靠 handler 归属把它算进 ① 的审计范围；
 *   B2 **create / INSERT 路径**：`taskRepo.create({ ...taskDto })` + `save(task)`——
 *      listId 经 `...taskDto` 展开进入实体，实参里没有字面 `listId` ⇒ 本扫描看不见。
 *      该路径的门**不在跨板族**，而在 controller 层：`task.controller.ts:185-186`（单建）
 *      与 `:206-212`（batch，按去重后的目标板逐个 `ensureCan(board,'write')`），
 *      目标板由 `TaskService.resolveCreateBoard` 解析（list/board 缺失 → 404）。
 *      ⇒ **改动 create 的目标板解析或写入路径时，必须回来审这一条**（跨板族门管不到它）；
 *   B3 仓库变量不叫 `taskRepo`（如 `repo` / `this.tasks`）时的写调用不被 ② 覆盖。
 *     缓解：ASSIGN_RE 覆盖"先赋值再 save"的形态；纯 QB UPDATE 形态另有 ③ 兜底。
 *   B4 `dto.listId = resolved.listId`（statusName 解析回填）**不是**任务写入（写的是 DTO），
 *      显式排除但断言其数量，防止"顺手改语义"时被当成无关代码删掉。
 *
 * [铁律关联] #10(工具优先) #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 * =============================================================================
 */

/** 本 spec 位于 apps/backend/src/modules/task → 上溯两级 = apps/backend/src */
const SRC_ROOT = path.join(__dirname, '..', '..');
/** monorepo 根（清单键用 `apps/backend/src/...` 形状）：task → modules → src → backend → apps → 根 */
const MONOREPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

/** 任务实体上的 list_id 赋值锚点（行首锚定；`==` 不算赋值，用 `[^=]` 排除） */
const ASSIGN_RE = /^[ \t]*([A-Za-z_$][\w$]*)\.listId[ \t]*=[^=]/;
/**
 * 任务仓库写调用锚点（**同族全形态**）：update / save / insert / upsert。
 * `this.` 前缀可选（事务内别名 `const taskRepo = manager.getRepository(Task)` 的调用形态
 * 是裸 `taskRepo.save(task)`，必须同被覆盖）。
 */
const REPO_WRITE_RE = /(?:this\.)?taskRepo\.(update|save|insert|upsert)\s*\(/g;
/** 实参里的 list_id 键名（属性名 `listId` 与列名 `list_id` 都算） */
const LIST_ID_TOKEN_RE = /\b(?:listId|list_id)\b/;
/**
 * QueryBuilder 写锚点：`.set(` 调用（**全文**扫描，实参由 readCallArguments 平衡读取）。
 *
 * 为什么锚点是裸 `.set(` 而不是带实参的正则：`.set({⏎ listId: x ⏎})` 这类**多行**写法
 * 逐行正则必然漏（复审 MINOR），而实参形状（对象/字符串/简写）又太多样——故拆成
 * 「锚点 + 平衡读取 + 键位判据」三步，与 ② 同口径。
 */
const QB_SET_CALL_RE = /\.set\s*\(/g;
/**
 * list_id 的**键位**判据（不是裸 token，见文件头 ③ 的 Map.set 说明）：
 * - 对象字面量的起始位或逗号后：`.set({ listId: x })` / `.set({ position, listId })`
 * - 字符串键位（首实参）：`.set('list_id', x)` / `.set("listId", x)`
 * 键名后的 `[,}:]` 是必要的边界（`listIds:` 这类近似名不得命中）。
 */
const QB_LIST_ID_KEY_RE = /(?:^|[{,])\s*['"]?(?:listId|list_id)['"]?\s*[,}:]/;
/** 宿主方法声明（2 空格缩进的类方法；允许修饰符） */
const HANDLER_RE = /^ {2}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\(/;
/**
 * 盲区守卫 B1：DTO 合并循环那行必须还在（键是运行时字符串 ⇒ 任何字面扫描都看不见它）。
 * 这行一旦被删/改写，说明 update 路径的写入形态变了，必须重新审计本白名单。
 */
const BLIND_SPOT_RE = /\(task as unknown as Record<string, unknown>\)\[key\] = value;/;

/** 写入点种类（与锚点形态一一对应，写进清单键便于一眼看出是哪种写法） */
type WriteKind = 'assign' | 'taskRepo.write' | 'qb.set';

interface WriteSite {
  /** 仓库相对路径 */
  source: string;
  /** 宿主方法名 */
  handler: string;
  kind: WriteKind;
  /** file:line（失败消息用） */
  locator: string;
}

/**
 * 白名单：`<source>::<handler>::<kind>`。
 * 每个条目都必须能对上源码里的一个具体站点（双向相等，多一个少一个都红）。
 */
const WHITELIST: readonly string[] = [
  // ① update 路径（status→mappedStatus 吸附；同板受限，见 task.service 注释）
  'apps/backend/src/modules/task/task.service.ts::applyTaskUpdate::assign',
  // ② move
  'apps/backend/src/modules/task/task.service.ts::move::assign',
  // ③ removeList 的 moveTasksTo（批量转移）
  'apps/backend/src/modules/board/board.service.ts::removeList::taskRepo.write',
  // ④ reorderTasks（批量改列，兼跨板搬运通道）
  'apps/backend/src/modules/board/board.service.ts::reorderTasks::taskRepo.write',
];

/** B4：DTO 回填站点（不是任务写入）：receiver=dto，显式排除但计数守卫 */
const EXPECTED_DTO_ASSIGN_SITES = 2;

/** 递归收集目录下全部生产 `.ts`（排除 `.d.ts` 与 spec） */
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

function toRepoRelative(file: string): string {
  return path.relative(MONOREPO_ROOT, file).split(path.sep).join('/');
}

/** 自锚点向上找最近的 2 空格缩进方法声明（上限 200 行，找不到即**判失败**防锚点漂移） */
function findHandler(lines: string[], lineIndex: number, locator: string): string {
  for (let i = lineIndex; i >= 0 && lineIndex - i <= 200; i--) {
    const m = lines[i]?.match(HANDLER_RE);
    if (m) return m[1];
  }
  throw new Error(
    `${locator} 前 200 行内找不到宿主方法声明——扫描器需要修正（不要放宽断言，否则归属失效）`,
  );
}

/**
 * 从 `(` 位置读取**平衡括号内**的调用实参原文（复审 C2：`save({...task, listId})` 这类
 * 嵌套对象的实参用朴素 `[^)]*` 会截断，必须平衡计数）。
 *
 * 简化假设：字符串/模板字面量内的括号在现有调用点里是配平的；若不配平则返回 null，
 * 调用处**判失败**而不是静默跳过（防锚点漂移变成假绿）。
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

/** 行级注释判定（`*` / `//` / `/*` 开头）——注释里的锚点提及不算写入点 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/**
 * 抽出源码全文里的 `.set(…)` 调用及其**平衡括号实参**（③ 分支的唯一实现点）。
 *
 * 独立成函数是为了让"防死代码"的合成断言走**同一条代码路径**：现实测 0 真实站点，
 * 若只在真树上断言，本分支被写坏（正则改错/判据反转）时集合相等仍然绿。
 *
 * @param content 源码全文
 * @returns 每个 `.set(` 的 `{ index, args }`；`args` 为 null 表示括号不配平（调用处判失败）
 */
function findQbSetCalls(content: string): Array<{ index: number; args: string | null }> {
  const calls: Array<{ index: number; args: string | null }> = [];
  for (const match of content.matchAll(QB_SET_CALL_RE)) {
    const index = match.index ?? 0;
    calls.push({ index, args: readCallArguments(content, index + match[0].length - 1) });
  }
  return calls;
}

interface ScanResult {
  /** 任务 list_id 写入点 */
  sites: WriteSite[];
  /** DTO 回填站点（receiver 不是 task） */
  dtoSites: string[];
  /** 其它未知 receiver 的赋值（白名单外 = 必须人工审计） */
  unknownAssign: string[];
  /** 盲区守卫命中次数 */
  blindSpotHits: number;
  /** 仓库写调用被扫描过的总次数（含未命中 listId 的调用——覆盖度证据） */
  repoWriteCallsScanned: number;
  /** `.set(` 调用被扫描过的总次数（③ 分支的覆盖度证据，同上） */
  qbSetCallsScanned: number;
  filesScanned: number;
}

function scan(): ScanResult {
  const files = collectProductionTsFiles(SRC_ROOT);
  const result: ScanResult = {
    sites: [],
    dtoSites: [],
    unknownAssign: [],
    blindSpotHits: 0,
    repoWriteCallsScanned: 0,
    qbSetCallsScanned: 0,
    filesScanned: files.length,
  };

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const rel = toRepoRelative(file);
    const lines = content.split('\n');
    const locatorAt = (index: number) => `${rel}:${content.slice(0, index).split('\n').length}`;

    // ① 实体赋值（行级锚点足够）
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      if (BLIND_SPOT_RE.test(line)) result.blindSpotHits += 1;

      const assign = line.match(ASSIGN_RE);
      if (assign && !isCommentLine(line)) {
        const receiver = assign[1];
        const locator = `${rel}:${lineNo}`;
        if (receiver === 'task') {
          result.sites.push({
            source: rel,
            handler: findHandler(lines, idx, locator),
            kind: 'assign',
            locator,
          });
        } else if (receiver === 'dto') {
          result.dtoSites.push(locator);
        } else {
          result.unknownAssign.push(`${locator} (receiver=${receiver})`);
        }
      }
    });

    // ③ QueryBuilder 写：与 ② 同口径——全文锚点 + 平衡括号读实参（复审 MINOR：逐行
    // `[^)]*` 会漏多行 `.set({⏎ listId ⏎})`），再按键位判命中（排除 Map.set 的假阳性）。
    for (const call of findQbSetCalls(content)) {
      const lineNo = content.slice(0, call.index).split('\n').length;
      const locator = `${rel}:${lineNo}`;
      if (isCommentLine(lines[lineNo - 1] ?? '')) continue;
      result.qbSetCallsScanned += 1;
      if (call.args === null) {
        throw new Error(`${locator} .set( 括号不配平——扫描器无法读取实参原文`);
      }
      if (!QB_LIST_ID_KEY_RE.test(call.args)) continue;
      result.sites.push({
        source: rel,
        handler: findHandler(lines, lineNo - 1, locator),
        kind: 'qb.set',
        locator,
      });
    }

    // ② 任务仓库写调用同族（实参需平衡括号读取 → 走全文索引而非逐行）
    for (const match of content.matchAll(REPO_WRITE_RE)) {
      const index = match.index ?? 0;
      const lineNo = content.slice(0, index).split('\n').length;
      const locator = `${rel}:${lineNo}`;
      if (isCommentLine(lines[lineNo - 1] ?? '')) continue;
      result.repoWriteCallsScanned += 1;
      const openParenIndex = index + match[0].length - 1;
      const args = readCallArguments(content, openParenIndex);
      if (args === null) {
        throw new Error(`${locator} 写调用括号不配平——扫描器无法读取实参原文`);
      }
      if (!LIST_ID_TOKEN_RE.test(args)) continue;
      result.sites.push({
        source: rel,
        handler: findHandler(lines, lineNo - 1, locator),
        kind: 'taskRepo.write',
        locator,
      });
    }
  }

  return result;
}

describe('task.list_id 写入点白名单（源码扫描，F4-2 / V2-N2）', () => {
  const result = scan();

  it('扫描到生产源码（防锚点失效导致的假绿）', () => {
    expect(result.filesScanned).toBeGreaterThan(100);
  });

  it('仓库写调用锚点确实扫到了调用（覆盖度证据：同族形态被真的读过实参）', () => {
    // 复审 C2：原实现只认 update(，`save(` 不进扫描面 ⇒ "扫描器比它声称的窄"。
    // 本断言保证同族锚点在工作（**实测 9 次：save 7 + update 2**），否则下面的白名单
    // 相等只是"没扫到东西"的空绿。**8 是按当前树实测 9 取的地板：缩减须复核后下调**
    // （真下调 = 同族写入被删/改名，那是要审的事，不是随手改数字）。
    expect(result.repoWriteCallsScanned).toBeGreaterThanOrEqual(8);
    expect(result.repoWriteCallsScanned).toBeGreaterThan(result.sites.length);
  });

  it('QB .set 锚点确实扫到了调用（覆盖度证据：③ 分支不是没扫到东西）', () => {
    // 现实测 114 处 `.set(`（排除注释行后的计数）；非 0 才说明 ③ 分支真的在跑。
    expect(result.qbSetCallsScanned).toBeGreaterThan(0);
  });

  it('QB .set 分支可判：合成源码正向/负向匹配（防该分支被写坏成死代码）', () => {
    // 现实测 0 真实站点 ⇒ 真树上的"集合相等"无法区分"没有写入点"与"扫描器坏了"。
    // 故用合成源码打**同一条代码路径**（findQbSetCalls + QB_LIST_ID_KEY_RE）。
    const positive = [
      'await this.repo.createQueryBuilder()',
      '  .update(Task)',
      '  .set({',
      '    position: 0,',
      '    listId: targetListId,',
      '  })',
      "  .where('id = :id', { id })",
      '  .execute();',
      // 字符串键形态（首实参）
      "await this.repo.createQueryBuilder().update(Task).set('list_id', listId).execute();",
    ].join('\n');

    const calls = findQbSetCalls(positive);
    expect(calls).toHaveLength(2);
    // 多行对象形态：逐行 `[^)]*` 会漏——平衡括号读取必须命中（本用例的核心回归点）
    expect(calls[0].args).toContain('listId');
    expect(QB_LIST_ID_KEY_RE.test(calls[0].args as string)).toBe(true);
    // 字符串键形态
    expect(QB_LIST_ID_KEY_RE.test(calls[1].args as string)).toBe(true);

    // 负向：Map.set（实参含 list_id 但非键位）、近似键名、无 list_id 的 .set 都不得命中
    const negative = [
      'result.set(row.list_id, { size: 1 });', // Map.set（search.service.ts:638 的真实形态）
      'await qb.update(Task).set({ position: 0 }).execute();',
      'const listIds = [];',
    ].join('\n');
    for (const call of findQbSetCalls(negative)) {
      expect(QB_LIST_ID_KEY_RE.test(call.args as string)).toBe(false);
    }
  });

  it('写入点集合 == 白名单（双向相等：多一处少一处都红）', () => {
    const actual = result.sites
      .map((site) => `${site.source}::${site.handler}::${site.kind}`)
      .sort();
    const expected = [...WHITELIST].sort();
    // 失败时两侧原文都打出来，便于直接定位是"新增了写入点"还是"挪了方法"
    expect(actual).toEqual(expected);
  });

  it('每个写入点都归属到预期方法（防方法重命名后归属漂移）', () => {
    const byHandler = new Map(result.sites.map((site) => [site.handler, site.kind]));
    expect(byHandler.get('applyTaskUpdate')).toBe('assign');
    expect(byHandler.get('move')).toBe('assign');
    expect(byHandler.get('removeList')).toBe('taskRepo.write');
    expect(byHandler.get('reorderTasks')).toBe('taskRepo.write');
  });

  it('DTO 回填（dto.listId = …）不是任务写入：数量守卫防"顺手改语义"', () => {
    // statusName → listId 解析后回填 DTO（resolveCreateBoard / create 两处）；写的是 DTO，
    // 不碰 tasks 表。数量变了说明解析路径被改动，必须重新审视本白名单。
    expect(result.dtoSites).toHaveLength(EXPECTED_DTO_ASSIGN_SITES);
  });

  it('不存在未知 receiver 的 .listId 赋值（新写法必须显式入账）', () => {
    expect(result.unknownAssign).toEqual([]);
  });

  it('盲区守卫 B1：DTO 合并循环（动态键赋值）仍在，且仅一处', () => {
    // 键是运行时字符串（`[key] = value`），字面扫描不可达——它落在 ①(applyTaskUpdate)
    // 的审计范围内。这行消失/改写 = update 路径的写入形态变了 ⇒ 必须重审白名单。
    expect(result.blindSpotHits).toBe(1);
  });

  it('不存在 raw SQL 直写 list_id（UPDATE tasks SET list_id）', () => {
    const files = collectProductionTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = toRepoRelative(file);
      // migrations 是历史 DDL（含 list_id 回填脚本），本守卫只管运行期代码
      if (rel.includes('/database/migrations/')) continue;
      if (/SET\s+list_id\s*=/i.test(content)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
