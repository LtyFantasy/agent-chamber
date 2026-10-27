/**
 * memory hint 码表 ↔ 平台 hint 注册表 **同源守卫**（阶段一抽核 / 阶段二扩展）
 *
 * 覆盖：`MEMORY_HINT`（formation 子态 13 码）与 `MEMORY_NOMINATION_HINT_CODE`（拦截器通道
 * 1 码）的每个码值都能在 `modules/hints/hint-registry.ts` 里查到；反向，注册表里
 * family='memory' 的条目 = 这两个真源之并（无幽灵码、数量 = |MEMORY_HINT| + 1）；
 * 且新码的 **10min** 去重窗口是**显式声明**（落成 6h 缺省 = 窗口静默放宽 36 倍）。
 *
 * 为什么必须有：注册表侧的 memory 元数据是**字面量内联**的（依赖方向纪律禁止
 * `modules/hints` import `modules/memory`——见 hint-registry.ts 的 [持久踩坑] HINT-REG-1），
 * 一旦码值改名/新增而注册表没跟上，provider 会**静默查不到定义**、不产出任何 hint 且无报错。
 * 本文件是这条链路上唯一的守卫，且方向合规（memory → hints）。
 */
import { getHintDefinition, listHintDefinitions } from '../hints/hint-registry';
import { MEMORY_HINT, MEMORY_NOMINATION_HINT_CODE, MEMORY_USAGE_HINT } from './memory.constants';

/** 期望的拦截器通道去重窗口（10min；与注册表内联值逐字一致，阶段三决策 1 由 24h 收紧） */
const EXPECTED_NOMINATION_TTL_MS = 10 * 60 * 1000;

describe('MEMORY_HINT ↔ hint-registry 同源守卫', () => {
  it('MEMORY_HINT 的每个码值都在注册表登记（改名/新增未同步 ⇒ 这里红）', () => {
    for (const code of Object.values(MEMORY_HINT)) {
      expect(getHintDefinition(code)).toBeDefined();
    }
  });

  it('拦截器通道的 MEMORY_NOMINATION_HINT_CODE 也在注册表登记', () => {
    expect(getHintDefinition(MEMORY_NOMINATION_HINT_CODE)).toBeDefined();
  });

  it("注册表 family='memory' 条目 = MEMORY_HINT ∪ {MEMORY_NOMINATION_HINT_CODE}（无幽灵码）", () => {
    const formationCodes = Object.values(MEMORY_HINT);
    const declared = new Set<string>([...formationCodes, MEMORY_NOMINATION_HINT_CODE]);
    const registryCodes = listHintDefinitions({ family: 'memory' }).map((d) => d.code);

    expect(registryCodes.length).toBe(declared.size);
    expect(registryCodes.length).toBe(formationCodes.length + 1);
    for (const code of registryCodes) expect(declared.has(code)).toBe(true);
  });

  it('新码元数据：10min 显式窗口 / 族 memory / 不参与排序 / 产出面与文案指针齐备', () => {
    expect(getHintDefinition(MEMORY_NOMINATION_HINT_CODE)).toMatchObject({
      code: MEMORY_NOMINATION_HINT_CODE,
      family: 'memory',
      priorityRank: null,
      ttlMs: EXPECTED_NOMINATION_TTL_MS,
      ownerSurface: 'memory_nomination',
      messageSource: 'modules/memory/memory.constants.ts MEMORY_NOMINATION_HINT_MESSAGE',
    });
  });

  it('usage 动作码 cursor_reset_required 登记在独立 memory_read family（不进 formation 表）', () => {
    expect(getHintDefinition(MEMORY_USAGE_HINT.CURSOR_RESET_REQUIRED)).toMatchObject({
      code: 'cursor_reset_required',
      family: 'memory_read',
      priorityRank: null,
      ownerSurface: 'memory_usage',
    });
    // shared_engine_binding 是错误动作码，不参与拦截器 hints[] 的元数据目录
    expect(getHintDefinition(MEMORY_USAGE_HINT.SHARED_ENGINE_BINDING)).toBeUndefined();
    // formation 的 family='memory' 双向相等守卫不被新码放宽
    expect(listHintDefinitions({ family: 'memory' })).toHaveLength(
      Object.values(MEMORY_HINT).length + 1,
    );
  });
});
