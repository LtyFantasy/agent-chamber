/**
 * search-tuning.ts 解析防御契约单测。
 *
 * 旋钮在**模块加载期**求值（attachment.constants.ts 先例），故 env 覆盖用例必须
 * `jest.resetModules()` + `require` 重载模块才能观察到新值（downloads.controller.spec.ts
 * 的 process.env 操控先例的模块级变体）。
 */
describe('search-tuning 解析防御', () => {
  const ENV_KEYS = ['SEARCH_TS_W1', 'SEARCH_KGATE_K_OVERRIDE', 'SEARCH_DF_DEGRADE_THRESHOLD', 'SEARCH_TRGM_HEADING_W'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** 重载模块取最新常量（模块加载期求值 ⇒ 必须 resetModules） */
  function loadTuning(): typeof import('./search-tuning') {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./search-tuning');
  }

  it('缺省值：W1=3.0 / K override=undefined / df 阈值=20000 / heading 权重=0.5（批次 1-c 与 1-d1 终值）', () => {
    const tuning = loadTuning();
    expect(tuning.SEARCH_TS_W1).toBe(3.0);
    expect(tuning.SEARCH_KGATE_K_OVERRIDE).toBeUndefined();
    expect(tuning.SEARCH_DF_DEGRADE_THRESHOLD).toBe(20000);
    expect(tuning.SEARCH_TRGM_HEADING_W).toBe(0.5);
  });

  it('合法覆盖生效', () => {
    process.env.SEARCH_TS_W1 = '1.0';
    process.env.SEARCH_KGATE_K_OVERRIDE = '2';
    process.env.SEARCH_DF_DEGRADE_THRESHOLD = '5000';
    process.env.SEARCH_TRGM_HEADING_W = '0.3';
    const tuning = loadTuning();
    expect(tuning.SEARCH_TS_W1).toBe(1.0);
    expect(tuning.SEARCH_KGATE_K_OVERRIDE).toBe(2);
    expect(tuning.SEARCH_DF_DEGRADE_THRESHOLD).toBe(5000);
    expect(tuning.SEARCH_TRGM_HEADING_W).toBe(0.3);
  });

  it.each([
    ['NaN 字符串', 'abc'],
    ['空串（compose ${VAR:-} 注空）', ''],
    ['非正数', '0'],
    ['负数', '-3'],
    ['非有限', 'Infinity'],
  ])('SEARCH_TS_W1 非法值 %s 回落 3.0', (_label, raw) => {
    process.env.SEARCH_TS_W1 = raw;
    expect(loadTuning().SEARCH_TS_W1).toBe(3.0);
  });

  it.each([
    ['浮点（1.5 视为写错，防 chooseKGateK 静默 floor）', '1.5'],
    ['非正数', '0'],
    ['NaN 字符串', 'abc'],
  ])('SEARCH_KGATE_K_OVERRIDE 非法值 %s 视为未配置', (_label, raw) => {
    process.env.SEARCH_KGATE_K_OVERRIDE = raw;
    expect(loadTuning().SEARCH_KGATE_K_OVERRIDE).toBeUndefined();
  });

  it.each([
    ['≥1（击穿地板三角：0.6+W 与阈值之积须 < 地板 0.08 ⇒ W<1）', '1'],
    ['>1（同上）', '1.5'],
    ['非正数', '0'],
    ['负数', '-0.5'],
    ['NaN 字符串', 'abc'],
    ['非有限', 'Infinity'],
  ])('SEARCH_TRGM_HEADING_W 非法值 %s 回落 0.5', (_label, raw) => {
    process.env.SEARCH_TRGM_HEADING_W = raw;
    expect(loadTuning().SEARCH_TRGM_HEADING_W).toBe(0.5);
  });

  it.each([
    ['非整数', '10000.5'],
    ['非正数', '0'],
    ['NaN 字符串', 'abc'],
  ])('SEARCH_DF_DEGRADE_THRESHOLD 非法值 %s 回落 20000', (_label, raw) => {
    process.env.SEARCH_DF_DEGRADE_THRESHOLD = raw;
    expect(loadTuning().SEARCH_DF_DEGRADE_THRESHOLD).toBe(20000);
  });

  // ── 派生阈值：DOC_SEARCH_WEAK_HIT_SCORE = 基准 0.3 × W1（主脑裁决 R4）─────────
  // 这是"刻度跟随旋钮"的守卫：任何让基准线不再随 W1 缩放的重构（例如有人把
  // doc-search 改回直读 DOC_SEARCH_STRONG_HIT_SCORE 基准常量）都会让第一条红。
  it('DOC_SEARCH_WEAK_HIT_SCORE 随 SEARCH_TS_W1 现构（不是固定 0.3）', () => {
    expect(loadTuning().DOC_SEARCH_WEAK_HIT_SCORE).toBeCloseTo(0.3 * 3.0, 10);

    process.env.SEARCH_TS_W1 = '1.0';
    expect(loadTuning().DOC_SEARCH_WEAK_HIT_SCORE).toBeCloseTo(0.3, 10);

    process.env.SEARCH_TS_W1 = '2.5';
    expect(loadTuning().DOC_SEARCH_WEAK_HIT_SCORE).toBeCloseTo(0.75, 10);
  });

  it('DOC_SEARCH_WEAK_HIT_SCORE 在 W1 非法回落时跟随回落值（3.0 ⇒ 0.9）', () => {
    process.env.SEARCH_TS_W1 = 'abc';
    expect(loadTuning().SEARCH_TS_W1).toBe(3.0);
    expect(loadTuning().DOC_SEARCH_WEAK_HIT_SCORE).toBeCloseTo(0.9, 10);
  });
});
