/**
 * security 族常量守卫单测（v1.94.0-dev）
 *
 * 覆盖（计划 §五 单测矩阵）：
 * - **字面量内联同源**：`SECURITY_HINT` 的每个码值都能在 `hint-registry.ts` 的
 *   `SECURITY_HINT_DEFINITIONS` 里查到，反向 `family='security'` 条目 = 本文件码表之并
 *   （注册表侧是**字面量内联**——它不 import 领域文件；漂移会让 provider 静默查不到定义）；
 * - **占位符齐全**：模板里的 `{key}` 与 `SECURITY_HINT_PLACEHOLDERS` 完全一致；
 * - **渲染安全**：空 data / 缺键 data 都不泄 `undefined` / `null` / 残留 `{`；
 * - profile 委托：priority 无 / familyOf 恒 security / ttlOf 走注册表。
 */
import {
  getHintDefinition,
  hintTtlOf,
  listHintDefinitions,
} from './hint-registry';
import {
  renderSecurityHintMessage,
  SECURITY_HINT,
  SECURITY_HINT_CODES,
  SECURITY_HINT_MESSAGES,
  SECURITY_HINT_PLACEHOLDERS,
  SECURITY_HINT_PROFILE,
  SECURITY_HINT_SURFACE,
  type SecurityHintCode,
} from './security-hint.constants';
import { SENSITIVE_PATTERNS } from '../../common/utils/sensitive-patterns';

/** 模板里的占位符（`{key}`） */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
}

describe('SECURITY_HINT ↔ hint-registry 同源守卫', () => {
  it('每个码值都在注册表登记（改名/新增未同步 ⇒ 这里红）', () => {
    for (const code of SECURITY_HINT_CODES) {
      expect(getHintDefinition(code)).toBeDefined();
    }
  });

  it("注册表 family='security' 条目 = 本文件码表之并（无幽灵码、无遗漏）", () => {
    const declared = new Set<string>(SECURITY_HINT_CODES);
    const registryCodes = listHintDefinitions({ family: 'security' }).map((d) => d.code);
    expect(registryCodes.length).toBe(declared.size);
    for (const code of registryCodes) expect(declared.has(code)).toBe(true);
  });

  it('注册表元数据：族 security / 产出面 credential_scan / 不参与 docspace 排序 / 6h 显式窗口', () => {
    for (const code of SECURITY_HINT_CODES) {
      expect(getHintDefinition(code)).toMatchObject({
        family: 'security',
        priorityRank: null,
        ttlMs: 6 * 60 * 60 * 1000,
        ownerSurface: SECURITY_HINT_SURFACE,
        messageSource: 'modules/hints/security-hint.constants.ts SECURITY_HINT_MESSAGES[code]',
      });
      expect(hintTtlOf(code)).toBe(6 * 60 * 60 * 1000);
    }
  });
});

describe('SECURITY_HINT_MESSAGES（模板单源）', () => {
  it('每个码都有非空模板（禁 provider 手写字面量）', () => {
    for (const code of SECURITY_HINT_CODES) {
      expect(typeof SECURITY_HINT_MESSAGES[code]).toBe('string');
      expect(SECURITY_HINT_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it('模板占位符与 SECURITY_HINT_PLACEHOLDERS 完全一致（少一个 ⇒ 数据填不进去）', () => {
    for (const code of SECURITY_HINT_CODES) {
      expect(placeholdersOf(SECURITY_HINT_MESSAGES[code]).sort()).toEqual(
        [...SECURITY_HINT_PLACEHOLDERS].sort(),
      );
    }
  });

  it('文案自带误报出口与轮换指引（已接受的 known-FP 靠它化解，删掉即变成纯噪音）', () => {
    const message = SECURITY_HINT_MESSAGES[SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED];
    expect(message).toContain('轮换');
    expect(message).toContain('忽略本提示即可');
    expect(message).toContain('reset-key');
  });

  it('**渲染同源**：渲染结果 = 模板 + 取值（不是第二份手写文案）', () => {
    const labels = 'sk- 前缀 key';
    const rendered = renderSecurityHintMessage(SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED, {
      labels,
    });
    expect(rendered).toBe(
      SECURITY_HINT_MESSAGES[SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED].replace(
        '{labels}',
        labels,
      ),
    );
    expect(rendered).toContain(labels);
  });

  it('**空 data 安全**：不泄 `undefined` / `null` / 残留 `{`（渲染全域安全）', () => {
    for (const code of SECURITY_HINT_CODES) {
      for (const data of [undefined, {}, { labels: undefined }, { labels: null }]) {
        const rendered = renderSecurityHintMessage(code, data);
        expect(rendered).not.toContain('undefined');
        expect(rendered).not.toContain('null');
        expect(rendered).not.toContain('{');
      }
    }
  });
});

describe('SECURITY_HINT_PROFILE（领域侧配置）', () => {
  it('无 priority（单码不参与族内排序）/ familyOf 恒 security / ttlOf 走注册表', () => {
    expect(SECURITY_HINT_PROFILE.priority).toBeUndefined();
    expect(SECURITY_HINT_PROFILE.familyOf?.(SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED)).toBe(
      'security',
    );
    expect(SECURITY_HINT_PROFILE.ttlOf?.(SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED)).toBe(
      6 * 60 * 60 * 1000,
    );
    expect(
      SECURITY_HINT_PROFILE.ttlOf?.('nope_not_a_code' as SecurityHintCode),
    ).toBeUndefined();
  });

  it('resolveMessage：候选自带 message 时覆盖优先，否则走模板渲染', () => {
    const candidate = {
      code: SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED,
      status: 'suggestion' as const,
      resourceKey: 'doc:doc-1',
      data: { labels: '平台 agent key（ask_ 前缀）' },
    };
    expect(SECURITY_HINT_PROFILE.resolveMessage(candidate)).toContain('平台 agent key');
    expect(SECURITY_HINT_PROFILE.resolveMessage({ ...candidate, message: '覆盖文案' })).toBe(
      '覆盖文案',
    );
  });
});

describe('模式表与文案的联动', () => {
  it('data.matchedPatterns 的 label 来源 = 模式表（文案里出现的短名必须能在表里找到）', () => {
    const labels = SENSITIVE_PATTERNS.map((entry) => entry.label);
    // 表非空且 label 互不相同（重复 label 会让「（A, A）」这种文案出现）
    expect(new Set(labels).size).toBe(labels.length);
  });
});
