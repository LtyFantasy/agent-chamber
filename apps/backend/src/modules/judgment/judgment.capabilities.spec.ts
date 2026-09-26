/**
 * judgment.capabilities 单测（**已注册能力的遍历断言**）。
 *
 * 设计意图：`JudgmentCapability` 的"三必填"（`rubricVersion` / `egressAllow` / `toLogPayload`）
 * 是安全复核（security）拍下的硬约束——缺 `egressAllow` 就是"默认放行出境"，缺 `toLogPayload`
 * 就是"默认把发包体原文落库"。类型层能挡大部分，但 `as never` / `as any` 之类的强转骗得过
 * 编译器、骗不过**遍历**：这里逐个能力逐条断言成员存在且可调用（编译期 + 运行时双保险）。
 *
 * 同时钉住"声明表 ↔ 注册表"一致：启动 INFO、`.env.example`、生产 fail-fast 三处都读声明表，
 * 漏一条 ⇒ 该能力的出境行为对用户不可见（而它正在发数据）。
 */
import {
  JUDGMENT_CAPABILITY_NAMES,
  type JudgmentCapability,
} from './judgment-capability.interface';
import { JUDGMENT_CAPABILITY_REGISTRY, findJudgmentCapability } from './judgment.capabilities';
import { JUDGMENT_CAPABILITY_DECLARATIONS } from '../../config/judgment.config';
import { experienceRecordCheckCapability } from '../experience/judgment/judgment-rubric';

describe('JUDGMENT_CAPABILITY_REGISTRY（遍历断言）', () => {
  it('非空且经验库能力在其中（内核不是空壳）', () => {
    expect(JUDGMENT_CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
    expect(findJudgmentCapability('record_check')).toBe(experienceRecordCheckCapability);
  });

  it('每个能力的 `name` ∈ operation 值域（自造名字会写出下游解析不了的行）', () => {
    for (const capability of JUDGMENT_CAPABILITY_REGISTRY) {
      expect(JUDGMENT_CAPABILITY_NAMES).toContain(capability.name);
    }
  });

  it('能力名唯一（重名让按名查找静默取到错的那个）', () => {
    const names = JUDGMENT_CAPABILITY_REGISTRY.map((capability) => capability.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // 逐能力跑同一套断言：新增能力自动被覆盖，无需手写新用例
  for (const capability of JUDGMENT_CAPABILITY_REGISTRY) {
    describe(`能力 ${capability.name}`, () => {
      it('三必填齐备且形状正确（rubricVersion / egressAllow / toLogPayload）', () => {
        expect(typeof capability.rubricVersion).toBe('string');
        expect(capability.rubricVersion.length).toBeGreaterThan(0);
        expect(typeof capability.egressAllow).toBe('function');
        expect(typeof capability.toLogPayload).toBe('function');
      });

      it('发问/归一化三件套都是函数（buildQuestions / buildState / normalize）', () => {
        expect(typeof capability.buildQuestions).toBe('function');
        expect(typeof capability.buildState).toBe('function');
        expect(typeof capability.normalize).toBe('function');
      });

      it('`redactionPatterns` 是数组（能力只追加；内核基线恒跑，不可被清空）', () => {
        expect(Array.isArray(capability.redactionPatterns)).toBe(true);
      });

      it('`egressAllow` 返回布尔（可选=默认放行不可接受，故必须显式决策）', () => {
        // 入参形状各能力不同 ⇒ 用一个"任意属性都返回空串"的 Proxy 当泛化输入（`input.query` 等
        // 字段读取不炸），只验**返回值类型**；真实闸门语义由各能力自己的 spec 覆盖
        const anyInput = new Proxy({} as Record<string, unknown>, { get: () => '' });
        expect(typeof capability.egressAllow(anyInput as never)).toBe('boolean');
      });

      it('声明表里有对应条目（出境字段 + 触发者对用户可见）', () => {
        const declaration = JUDGMENT_CAPABILITY_DECLARATIONS.find(
          (entry) => entry.name === capability.name,
        );
        expect(declaration).toBeDefined();
        expect(declaration?.egressFields.length).toBeGreaterThan(0);
        expect(declaration?.trigger.length).toBeGreaterThan(0);
      });
    });
  }

  it('反向一致性：声明表里**每个受管辖能力都必须在注册表里有实现**（终审 MAJOR-4）', () => {
    // 单向检查（注册 → 声明）管不住"声明表加了 governs:true 但忘了登记" —— 那正是 rerank 曾经的
    // 缺口：启动 INFO / .env.example / fail-fast 都会宣称该能力出境，而运行时三必填遍历根本不覆盖它。
    const registryNames = new Set<string>(
      JUDGMENT_CAPABILITY_REGISTRY.map((capability) => String(capability.name)),
    );
    const governedDeclarations = JUDGMENT_CAPABILITY_DECLARATIONS.filter((entry) => entry.governs);
    expect(governedDeclarations.length).toBeGreaterThan(0);
    for (const declaration of governedDeclarations) {
      expect(registryNames.has(declaration.name)).toBe(true);
    }
    // 且注册表里的受管辖能力数量与声明表一致（防"登记了却忘了声明"）
    const governedInRegistry = JUDGMENT_CAPABILITY_REGISTRY.filter((capability) =>
      governedDeclarations.some((entry) => entry.name === String(capability.name)),
    );
    expect(governedInRegistry.map((capability) => capability.name).sort()).toEqual(
      governedDeclarations.map((entry) => entry.name).sort(),
    );
  });

  it('经验库能力的四要素取值锚定（改名/改闸门即红）', () => {
    const capability: JudgmentCapability<never, unknown> =
      experienceRecordCheckCapability as JudgmentCapability<never, unknown>;
    expect(capability.name).toBe('record_check');
    expect(capability.rubricVersion).toBe('v2');
    // 既有录入闸门在 400 层（同正则先于判定执行）⇒ 本能力恒放行（内核仍跑 redaction 基线）
    expect(capability.egressAllow(undefined as never)).toBe(true);
    // 语料不变量：日志载荷 = 实际发包体（内核"不落原文"规则的唯一例外，必须显式一行）
    const request = { questions: {}, state: { content: 'c' }, model: 'jev-latest' };
    expect(
      capability.toLogPayload(undefined as never, {
        status: 'error',
        request,
        response: { error: 'x' },
        latencyMs: 1,
      }),
    ).toBe(request);
  });
});
