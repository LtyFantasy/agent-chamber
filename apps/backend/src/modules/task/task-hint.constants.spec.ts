/**
 * task 纪律族常量 ↔ 平台 hint 注册表 **同源守卫**（阶段三，决策 12）
 *
 * 覆盖：`TASK_HINT` 的每个码值都能在 `hints/hint-registry.ts` 的
 * `TASK_HYGIENE_DEFINITIONS` 里查到；反向，注册表里 `family='board'` 的条目 = 本文件码表
 * 之并（无幽灵码、数量相等）；元数据（family / ownerSurface / 优先级不参与 / 文案指针）
 * 与注册表一致；文案单源齐备且自带「可忽略」出口。
 *
 * 为什么必须有：注册表侧的 task 元数据是**字面量内联**的（依赖方向纪律禁止
 * `modules/hints` import `modules/task`——见 hint-registry.ts 的 [持久踩坑] HINT-REG-1），
 * 一旦码值改名/新增而注册表没跟上，provider 会**静默查不到定义**（ttlOf → 6h 缺省、
 * 家族维度失真）且无报错。守卫方向合规（task → hints）。
 */
import { getHintDefinition, listHintDefinitions } from '../hints/hint-registry';
import {
  renderTaskHintMessage,
  TASK_DEPENDENTS_PENDING_PLACEHOLDERS,
  TASK_HINT,
  TASK_HINT_CODES,
  TASK_HINT_MESSAGES,
  TASK_HINT_PRIORITY,
  TASK_HINT_PROFILE,
  TASK_HINT_SURFACE,
  TASK_NEAR_DUPLICATE_PLACEHOLDERS,
} from './task-hint.constants';

/** 模板里的占位符（`{key}`） */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
}

describe('TASK_HINT ↔ hint-registry 同源守卫', () => {
  it('TASK_HINT 的每个码值都在注册表登记（改名/新增未同步 ⇒ 这里红）', () => {
    for (const code of TASK_HINT_CODES) {
      expect(getHintDefinition(code)).toBeDefined();
    }
  });

  it("注册表 family='board' 条目 = TASK_HINT 码表之并（无幽灵码、无遗漏）", () => {
    const declared = new Set<string>(TASK_HINT_CODES);
    const registryCodes = listHintDefinitions({ family: 'board' }).map((d) => d.code);

    // ⚠️ **已知代价**：这里按 `family='board'` **全集**比较——将来若有别的域也声明
    // `family: 'board'` 的码（如 board 自身新增纪律族），本断言会**假红**。届时的处置 =
    // 把比较面收窄到 `ownerSurface: TASK_HINT_SURFACE`（本文件码表的真实归属键），
    // 而不是把别人的码塞进 TASK_HINT_CODES。
    expect(registryCodes.length).toBe(declared.size);
    for (const code of registryCodes) expect(declared.has(code)).toBe(true);
  });

  it('注册表元数据：族 board / 产出面 task_hygiene / 不参与 docspace 排序 / 6h 窗口', () => {
    for (const code of TASK_HINT_CODES) {
      const definition = getHintDefinition(code);
      expect(definition).toMatchObject({
        family: 'board',
        priorityRank: null,
        ttlMs: 6 * 60 * 60 * 1000,
        ownerSurface: TASK_HINT_SURFACE,
        messageSource: 'modules/task/task-hint.constants.ts TASK_HINT_MESSAGES[code]',
      });
    }
  });

  it('文案单源齐备：每个码都有非空文案（禁 provider 手写字面量）', () => {
    for (const code of TASK_HINT_CODES) {
      expect(typeof TASK_HINT_MESSAGES[code]).toBe('string');
      expect(TASK_HINT_MESSAGES[code].length).toBeGreaterThan(0);
    }
    // 三条都自带「可忽略 / 验收补证忽略」出口（纪律提醒不是闸门）
    expect(TASK_HINT_MESSAGES[TASK_HINT.COMMENT_ON_DONE_TASK]).toContain('忽略');
    expect(TASK_HINT_MESSAGES[TASK_HINT.DEPENDENTS_PENDING]).toContain('忽略本提示即可');
  });

  it('`task_done_without_report` 文案锚点（v1.94.0-dev 改写后必须仍在）', () => {
    const message = TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT];
    // 三个锚点 = 改写禁令的守护对象：下一步指引 / 证据形态 / 忽略出口
    expect(message).toContain('report_task_result');
    expect(message).toContain('commit SHA');
    expect(message).toContain('忽略');
    expect(message).toContain('未附结果证据');
    // **禁内部机制叙述**：`reportResult` 不做跨步骤事务（见 task.service.ts JSDoc），
    // 文案承诺事务性 = 事实错误
    expect(message).not.toContain('同事务');
    expect(message).not.toContain('事务');
  });

  it('`task_dependents_pending` 是模板：占位符与契约表完全一致（少一个 ⇒ 数据填不进去）', () => {
    expect(placeholdersOf(TASK_HINT_MESSAGES[TASK_HINT.DEPENDENTS_PENDING]).sort()).toEqual(
      [...TASK_DEPENDENTS_PENDING_PLACEHOLDERS].sort(),
    );
    for (const other of [
      TASK_HINT.DONE_WITHOUT_REPORT,
      TASK_HINT.COMMENT_ON_DONE_TASK,
    ]) {
      expect(placeholdersOf(TASK_HINT_MESSAGES[other])).toEqual([]);
    }
  });

  // v1.95.0-dev 撞重码：**方向相反**的两条断言（architect P2-1）——
  // ① 它**是**模板（占位符必须与 TASK_NEAR_DUPLICATE_PLACEHOLDERS 一一对应，少一个即渲染残缺）；
  // ② 因此它**不得**进上面那份「零占位符」清单（进了 = 把模板误声明成静态文案）。
  it('`task_near_duplicate_suspected` 是模板：占位符与契约表一致，且**不在**零占位符清单里', () => {
    expect(placeholdersOf(TASK_HINT_MESSAGES[TASK_HINT.NEAR_DUPLICATE_SUSPECTED]).sort()).toEqual(
      [...TASK_NEAR_DUPLICATE_PLACEHOLDERS].sort(),
    );
    // 文案里的 `{type: 'duplicates'}` 是**字面示例**（不是占位符）：占位符语法只认标识符
    expect(placeholdersOf(TASK_HINT_MESSAGES[TASK_HINT.NEAR_DUPLICATE_SUSPECTED])).not.toContain(
      'type',
    );
  });

  it('`task_near_duplicate_suspected` 文案锚点（三条纪律：不提删除 / 不写「既有」/ 有忽略出口）', () => {
    const message = TASK_HINT_MESSAGES[TASK_HINT.NEAR_DUPLICATE_SUSPECTED];
    // 出路是 `duplicates` 依赖 + 判断权交回人（assignee 可能是别人，删卡会 403）
    expect(message).toContain('duplicates');
    expect(message).toContain('relates_to');
    expect(message).not.toContain('删除');
    // 批内互撞时撞的是**本请求刚建**的卡 ⇒ 禁写「既有」
    expect(message).not.toContain('既有');
    expect(message).toContain('忽略本提示即可');
  });

  it('渲染 helper 全域安全：空 data / 缺键 data 都不泄 undefined / null / **未替换的占位符**', () => {
    for (const code of TASK_HINT_CODES) {
      for (const data of [undefined, {}, { toStatus: undefined }, { total: null }]) {
        const rendered = renderTaskHintMessage(code, data);
        expect(rendered).not.toContain('undefined');
        expect(rendered).not.toContain('null');
        // ⚠️ 判据是「**未替换的占位符**」而不是「任何 `{`」：`hint-template.ts` 的契约明写
        // 「只认 `{` + 标识符 + `}`，文案里其它花括号**原样保留**」——撞重文案里的字面示例
        // `{type: 'duplicates'}` 正属后者（含 `:` 与引号，不是占位符形态）。
        expect(rendered).not.toMatch(/\{[A-Za-z0-9_]+\}/);
      }
    }
  });

  it('渲染同源：渲染结果 = 模板 + 取值（不是第二份手写文案）', () => {
    const data = { toStatus: 'review', total: 2, titles: 'A、B', overflow: '' };
    expect(renderTaskHintMessage(TASK_HINT.DEPENDENTS_PENDING, data)).toBe(
      TASK_HINT_MESSAGES[TASK_HINT.DEPENDENTS_PENDING]
        .replace('{toStatus}', 'review')
        .replace('{total}', '2')
        .replace('{titles}', 'A、B')
        .replace('{overflow}', ''),
    );
  });

  it('priority 序列覆盖全部码且无重复（同响应多条候选的确定性排序）', () => {
    expect([...TASK_HINT_PRIORITY].sort()).toEqual([...TASK_HINT_CODES].sort());
    expect(new Set(TASK_HINT_PRIORITY).size).toBe(TASK_HINT_PRIORITY.length);
    // 撞重码排**首位**是「声明性」的（它只出现在 task.created 的响应里，与另三条永不共现，
    // 见 task-hint.constants.ts 的注记）；其余三条：完工缺证据 > 依赖引导 > 已完工任务评论
    expect(TASK_HINT_PRIORITY).toEqual([
      TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
      TASK_HINT.DONE_WITHOUT_REPORT,
      TASK_HINT.DEPENDENTS_PENDING,
      TASK_HINT.COMMENT_ON_DONE_TASK,
    ]);
  });

  it('TASK_HINT_PROFILE：priority 单源 / familyOf 恒 board / resolveMessage 走单源模板', () => {
    expect(TASK_HINT_PROFILE.priority).toBe(TASK_HINT_PRIORITY);
    expect(TASK_HINT_PROFILE.familyOf?.(TASK_HINT.DONE_WITHOUT_REPORT)).toBe('board');
    const candidate = {
      code: TASK_HINT.DONE_WITHOUT_REPORT,
      status: 'suggestion' as const,
      resourceKey: 'task-1',
    };
    expect(TASK_HINT_PROFILE.resolveMessage(candidate)).toBe(
      TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT],
    );
    // 模板码：profile 用候选的 data 渲染（不手写文案）
    expect(
      TASK_HINT_PROFILE.resolveMessage({
        code: TASK_HINT.DEPENDENTS_PENDING,
        status: 'suggestion',
        resourceKey: 'task-1:review',
        data: { toStatus: 'review', total: 1, titles: '下游任务', overflow: '' },
      }),
    ).toContain('仍有 1 个未完成下游任务依赖它');
  });
});
