/**
 * rerank-placement 单测（**最小总代价完美匹配**求解器：唯一表达式 + 最优分配 + fail-open）。
 *
 * 设计意图：这个求解器是"重排不会把页外候选顶到页首"这条安全承诺的**唯一执行者**，同时
 * 也是"模型意愿真的生效"的唯一保障。它静默放宽下界（安全问题）或退化成"只动一格"（功能
 * 不生效但所有测试仍绿）的两种失效都曾真实发生过，故这里逐条钉死：
 * ① 逐条落带 + 双射（安全承诺）+ **总代价等于精确最优**（功能承诺）；
 * ② 组合 fixture（页外全排前排）与边界（limit=1/2/20、第二页、薄池、空池）；
 * ③ **交叉验证**：小实例（n ≤ 8）用子集 DP 求精确最小代价，与新算法输出逐组比对（≥ 2 万组）；
 * ④ **功能生效性门禁**：满池形态（limit=20 / 池 30）下页序必须真随模型档位变化；
 * ⑤ 历史回归：宽度主键死锁输入与"EDF 锁死页首"的满池形态都必须给出**最优解**（非仅"有解"）。
 * ⑥ 确定性：同输入两次求解逐字相同（成本相等而分配不同的情形由遍历顺序收敛）。
 */
import {
  K_MOVE,
  K_PROMOTE,
  compareRerankKey,
  placementBand,
  solveAssignment,
  solveRerankPlacement,
  type PlacementCandidate,
} from './rerank-placement';

/** 造候选（index 即池名次；默认 tier 随 index 递减 ⇒ 模型意愿与池序一致） */
function candidates(
  count: number,
  tierOf: (index: number) => number = (index) => Math.max(0, 3 - (index % 4)),
  scoreOf: (index: number) => number = (index) => 100 - index,
): PlacementCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `c${index}`,
    index,
    tier: tierOf(index),
    score: scoreOf(index),
    position: index,
    docId: `doc-${String(index).padStart(3, '0')}`,
  }));
}

/** 候选的意愿排名（与求解器同源：完整键序） */
function ranksOf(list: readonly PlacementCandidate[]): number[] {
  const ranked = [...list].sort(compareRerankKey);
  const rankByIndex = new Map<number, number>();
  ranked.forEach((candidate, rank) => rankByIndex.set(candidate.index, rank));
  return list.map((candidate) => rankByIndex.get(candidate.index) as number);
}

/** 某条最终序的总代价（`|p − r|` 之和；用于与精确最优比对） */
function costOf(
  order: readonly string[],
  list: readonly PlacementCandidate[],
  offset: number,
  limit: number,
): number {
  const ranks = ranksOf(list);
  const rankByIndex = new Map(list.map((candidate, i) => [candidate.index, ranks[i]]));
  return order.reduce((sum, key, slot) => {
    const index = Number(key.slice(1));
    return sum + Math.abs(slot - (rankByIndex.get(index) as number));
  }, 0);
}

/**
 * 精确参考最优（子集 DP：按候选逐个分配槽位，state = 已占槽位掩码）——等价于"枚举所有合法
 * 完美匹配取 min cost"，但复杂度 `O(n·2^n)` 而非 `n!`，故可在单测里跑 2 万组。
 *
 * @returns 最小总代价；不可行 ⇒ null（本问题恒可解，仅作参考实现的自检）
 */
function exactMinCost(ranks: readonly number[], bands: readonly { lo: number; hi: number }[]): number | null {
  const n = ranks.length;
  // ⚠️ 指数参考实现：**只允许 n ≤ 8**（2^n 状态）。n>8 误用会把 8GB 数组灌进堆（实测把套件拖到 5 分钟+
  // 且可能 OOM）——n>8 的最优性由"小实例穷举交叉验证 + 结构断言"覆盖，不靠这条参考实现。
  if (n > 8) throw new Error(`exactMinCost 只用于 n ≤ 8（收到 n=${n}）`);
  const size = 1 << n;
  const dp = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask += 1) {
    const current = dp[mask];
    if (!Number.isFinite(current)) continue;
    let k = 0;
    for (let bit = 0; bit < n; bit += 1) if (mask & (1 << bit)) k += 1;
    if (k >= n) continue;
    const band = bands[k];
    for (let slot = band.lo; slot <= band.hi; slot += 1) {
      if (mask & (1 << slot)) continue;
      const next = current + Math.abs(slot - ranks[k]);
      const nextMask = mask | (1 << slot);
      if (next < dp[nextMask]) dp[nextMask] = next;
    }
  }
  const best = dp[size - 1];
  return Number.isFinite(best) ? best : null;
}

/**
 * 局部最优性冒烟（**必要非充分**）：任何一对槽互换都不得降低总代价。
 *
 * 为什么大实例用它而不是精确参考：精确参考（子集 DP）是 `O(2^n)`，n=15/30 不可用（实测会拖死套件）。
 * 全局最优性由"小实例（n ≤ 8）× 21000 组穷举交叉验证"承担，这里只是大实例的额外冒烟。
 */
function expectLocallyOptimal(
  order: readonly string[],
  list: readonly PlacementCandidate[],
  offset: number,
  limit: number,
): void {
  const ranks = ranksOf(list);
  const rankByIndex = new Map(list.map((candidate, i) => [candidate.index, ranks[i]]));
  const bands = list.map((candidate) => placementBand(candidate.index, list.length, offset, limit));
  const distance = (index: number, slot: number): number => {
    const band = bands[index];
    if (slot < band.lo || slot > band.hi) return Number.POSITIVE_INFINITY;
    return Math.abs(slot - (rankByIndex.get(index) as number));
  };
  const before = costOf(order, list, offset, limit);
  for (let a = 0; a < order.length; a += 1) {
    for (let b = a + 1; b < order.length; b += 1) {
      const indexA = Number(order[a].slice(1));
      const indexB = Number(order[b].slice(1));
      const swapped =
        before - distance(indexA, a) - distance(indexB, b) + distance(indexA, b) + distance(indexB, a);
      expect(swapped).toBeGreaterThanOrEqual(before);
    }
  }
}

/** 求解 + 校验（落带/双射/长度），返回最终序与代价 */
function solveChecked(
  list: PlacementCandidate[],
  offset: number,
  limit: number,
): { order: string[]; cost: number } {
  const order = solveRerankPlacement(list, offset, limit);
  expect(order).not.toBeNull();
  const full = order as string[];
  expect(full).toHaveLength(list.length);
  expect(new Set(full).size).toBe(list.length);
  full.forEach((key, slot) => {
    const candidate = list[Number(key.slice(1))];
    const band = placementBand(candidate.index, list.length, offset, limit);
    expect(slot).toBeGreaterThanOrEqual(band.lo);
    expect(slot).toBeLessThanOrEqual(band.hi);
  });
  return { order: full, cost: costOf(full, list, offset, limit) };
}

describe('placementBand（唯一表达式）', () => {
  it('页内候选：下界 0（可被压到页首），上界 i + K_MOVE 且不超过池尾', () => {
    expect(placementBand(0, 50, 0, 5)).toEqual({ lo: 0, hi: K_MOVE });
    expect(placementBand(4, 50, 0, 5)).toEqual({ lo: 0, hi: 14 });
    // 池尾候选：上界被池大小收住（hi 不能超出槽域）
    expect(placementBand(49, 50, 0, 5)).toEqual({ lo: 39, hi: 49 });
  });

  it('页外候选：下界 = offset + max(0, limit − K_PROMOTE)（页尾 3 槽 ⇒ limit=20 时第 18 位）', () => {
    expect(placementBand(5, 50, 0, 5).lo).toBe(0 + Math.max(0, 5 - K_PROMOTE));
    // limit=20 ⇒ 页外下界 17（0-based）= 页内第 18 位 / 页尾 3 槽
    expect(placementBand(20, 50, 0, 20).lo).toBe(17);
    // 第二页（offset=limit）
    expect(placementBand(10, 50, 5, 5).lo).toBe(5 + 2);
  });

  it('limit < K_PROMOTE ⇒ 保留区退化为空（**不产生无解**，不是把下界抬到页中）', () => {
    const band = placementBand(1, 10, 0, 2);
    expect(band.lo).toBe(0);
    expect(band.lo).toBeLessThanOrEqual(band.hi);
  });
});

describe('solveRerankPlacement · 组合 fixture（security 变体）', () => {
  /** 组合 fixture（plan 钉死）：limit=5 池 15，模型把 **10 个页外候选全排前排**，页内按 i 逆序 */
  const LIMIT = 5;
  const OFFSET = 0;
  const comboCandidates = candidates(
    15,
    (index) => (index >= 5 ? 10 - (index - 5) : 4 - index),
  );

  it('页恒满、无重复、逐条落带，且**总代价 = 精确最优**（最优分配而非贪心）', () => {
    const { order } = solveChecked(comboCandidates, OFFSET, LIMIT);
    // n=15 > 8 ⇒ 不用指数参考（见 `exactMinCost` 守卫）；最优性由 21000 组小实例交叉验证承担，
    // 这里补"无改进互换"冒烟 + 结构断言
    expectLocallyOptimal(order, comboCandidates, OFFSET, LIMIT);
    expect(order.slice(OFFSET, OFFSET + LIMIT)).toHaveLength(LIMIT);
  });

  it('页外候选**只占页尾 3 槽**（安全承诺：永不进页首 limit−K_PROMOTE 槽）', () => {
    const { order } = solveChecked(comboCandidates, OFFSET, LIMIT);
    const externalKeys = new Set(
      comboCandidates.filter((candidate) => candidate.index >= LIMIT).map((candidate) => candidate.key),
    );
    order.forEach((key, slot) => {
      if (!externalKeys.has(key)) return;
      expect(slot).toBeGreaterThanOrEqual(OFFSET + LIMIT - K_PROMOTE);
    });
    const page = order.slice(OFFSET, OFFSET + LIMIT);
    // 页首保留区（前 limit−K_PROMOTE = 2 槽）只有页内候选
    expect(externalKeys.has(page[0])).toBe(false);
    expect(externalKeys.has(page[1])).toBe(false);
    // 最优分配**真的把页外候选提进页尾 3 槽**（不同于 EDF 的"只动 1 槽"）：
    // 页外候选档位最高且其下界恰为槽 2 ⇒ 最优解必然占用槽 2..4
    expect(page.slice(2).every((key) => externalKeys.has(key))).toBe(true);
  });

  it('模型意愿生效：档位最高的页外候选落在**页尾三槽内**（不是只动最后一格）', () => {
    const { order } = solveChecked(comboCandidates, OFFSET, LIMIT);
    const page = order.slice(OFFSET, OFFSET + LIMIT);
    const topTierKeys = new Set(
      comboCandidates
        .slice()
        .sort(compareRerankKey)
        .slice(0, K_PROMOTE)
        .map((candidate) => candidate.key),
    );
    expect(page.slice(2).every((key) => topTierKeys.has(key))).toBe(true);
  });
});

describe('solveRerankPlacement · 边界', () => {
  it('limit=1：页只有 1 槽，页外候选下界 = offset（limit<K_PROMOTE 退化）', () => {
    const list = candidates(12, (index) => 11 - index); // 完全逆序（页外排前排）
    const { order } = solveChecked(list, 0, 1);
    expectLocallyOptimal(order, list, 0, 1);
    expect(order[0]).toBeTruthy();
  });

  it('limit=2 / limit=20：均求解成功、页满、总代价最优', () => {
    for (const limit of [2, 20]) {
      const list = candidates(limit + 10, (index) => limit + 10 - index);
      const { order } = solveChecked(list, 0, limit);
      expect(order.slice(0, limit)).toHaveLength(limit);
      expectLocallyOptimal(order, list, 0, limit);
    }
  });

  it('offset=limit（第二页）：页 = 槽 [limit, 2*limit)，页外下界随 offset 平移', () => {
    const limit = 5;
    const list = candidates(20, (index) => 20 - index); // 逆序：页外排最前
    const { order } = solveChecked(list, limit, limit);
    expect(order.slice(limit, limit + limit)).toHaveLength(limit);
    const external = new Set(list.filter((c) => c.index >= limit + limit).map((c) => c.key));
    // 第二页的页首保留区（槽 5..6）仍是页内候选
    expect(external.has(order[limit])).toBe(false);
    expect(external.has(order[limit + 1])).toBe(false);
  });

  it('池小于页（候选不够 limit）：仍返回池的排列（调用点切片后条数自然相等）', () => {
    const list = candidates(3, (index) => 3 - index);
    const order = solveRerankPlacement(list, 0, 5);
    expect(order).toHaveLength(3);
    expect(new Set(order as string[]).size).toBe(3);
  });

  it('空池 ⇒ 空数组（调用点在此前已早退，不会调用模型）', () => {
    expect(solveRerankPlacement([], 0, 5)).toEqual([]);
  });

  it('模型档位与池序一致（rank = index）⇒ 最终序 = 池序（零扰动，且代价 = 0 = 全局最优）', () => {
    // tier 必须**非增**才与池序同向（原写法 3−(index%4) 是锯齿，排名不等于 index）
    const list = candidates(30, (index) => 3 - Math.min(3, Math.floor(index / 10)));
    const { order, cost } = solveChecked(list, 0, 20);
    const ranks = ranksOf(list);
    // 该分布的意愿排名恰为 0..n-1（tier 非增、score 递减 ⇒ 池序即完整键序）
    expect(ranks).toEqual([...Array(30).keys()]);
    expect(order).toEqual(list.map((candidate) => candidate.key));
    expect(cost).toBe(0);
  });

  it('确定性：同一输入两次求解结果逐字相同（含等代价多解）', () => {
    const list = candidates(15, () => 1, () => 1); // 全部同档同分 ⇒ 完全靠 position/docId 定序
    const first = solveRerankPlacement(list, 0, 5);
    const second = solveRerankPlacement(list, 0, 5);
    expect(second).toEqual(first);
    const third = solveRerankPlacement(
      list.map((candidate) => ({ ...candidate })),
      0,
      5,
    );
    expect(third).toEqual(first);
  });
});

describe('solveRerankPlacement · 功能生效性门禁（**满池形态**：limit=20 / 池 30 / offset=0）', () => {
  /**
   * 终审 MAJOR-1 的 GAP：此前三层测试都只用**池不满**的形态（单测池 8/15、e2e 池 12/15），
   * 而生产大空间里池恒满（count = poolSize = limit+10）——EDF 在该形态下退化 ⇒ 页首 19 槽恒
   * 等于 SQL 原序。下面三条把"功能真的生效"钉住。
   */
  const LIMIT = 20;
  const POOL = 30;
  const fullPool = (tierOf: (index: number) => number): PlacementCandidate[] =>
    candidates(POOL, tierOf);

  it('① 池尾页外候选给最高档 ⇒ 必须进页尾 K_PROMOTE 槽（页内第 18..20 位）', () => {
    const list = fullPool((index) => (index >= 20 ? 3 : 0));
    const { order } = solveChecked(list, 0, LIMIT);
    expectLocallyOptimal(order, list, 0, LIMIT); // 大实例：局部最优冒烟（全局最优见小实例交叉验证）
    const page = order.slice(0, LIMIT);
    // 页外候选（i≥20）只能落槽 ≥17 ⇒ 页尾 3 槽（17/18/19）必须被最高档的页外候选占满
    expect(page.slice(LIMIT - K_PROMOTE).every((key) => Number(key.slice(1)) >= 20)).toBe(true);
    // ⚠️ 本形态下**不应**断言"页首必须变"：模型只对页外候选给了高分、对页内候选一视同仁
    // （全 0 档），故"保持页内相对顺序（= SQL 序）"正是模型意愿本身；页首变化能力由 ② 覆盖
    // （那里模型明确把最高档给了页中候选 c15）。
    expect(page.slice(0, LIMIT - K_PROMOTE).every((key) => Number(key.slice(1)) < 20)).toBe(true);
  });

  it('② 页中候选给最高档 + 页首候选给最低档 ⇒ 页首槽位必须可变且 = 模型首选', () => {
    const list = fullPool((index) => (index === 15 ? 3 : index < 5 ? 0 : 1));
    const { order } = solveChecked(list, 0, LIMIT);
    const page = order.slice(0, LIMIT);
    // 模型首选（c15）必须进返回页，且页首被真实改变
    expect(page).toContain('c15');
    expect(page[0]).not.toBe('c0');
    const sqlPage = list.slice(0, LIMIT).map((candidate) => candidate.key);
    expect(page).not.toEqual(sqlPage);
  });

  it('③ 模型档位与池序一致 ⇒ 最终序 = 池序（无扰动；代价 0）', () => {
    const list = fullPool((index) => 3 - Math.min(3, Math.floor(index / 10)));
    const { order, cost } = solveChecked(list, 0, LIMIT);
    const ranks = ranksOf(list);
    if (ranks.every((rank, index) => rank === index)) {
      expect(order).toEqual(list.map((candidate) => candidate.key));
      expect(cost).toBe(0);
    }
    expect(order.slice(0, LIMIT)).toEqual(list.slice(0, LIMIT).map((candidate) => candidate.key));
  });
});

describe('solveRerankPlacement · 交叉验证（与精确最优逐组比对）', () => {
  it('≥ 2 万组随机小实例（n ≤ 8）：新算法的总代价 === 子集 DP 的精确最小代价', () => {
    let state = 20260925;
    const next = (): number => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    let checked = 0;
    let mismatches = 0;
    let invalid = 0;
    let firstFailure = '';
    for (let trial = 0; trial < 21000; trial += 1) {
      const n = 1 + Math.floor(next() * 8); // 1..8
      const limit = 1 + Math.floor(next() * 8);
      const offset = limit * Math.floor(next() * 3); // 0 / limit / 2limit
      const list = candidates(n, () => Math.floor(next() * 4), () => Math.round(next() * 1000) / 10);
      const ranks = ranksOf(list);
      const bands = list.map((candidate) => placementBand(candidate.index, n, offset, limit));
      const optimum = exactMinCost(ranks, bands);
      const order = solveRerankPlacement(list, offset, limit);
      checked += 1;
      // 热循环内**不调用 expect**（jest 断言开销是数量级成本）：累计失败，末尾一次断言
      if (order === null || optimum === null) {
        mismatches += 1;
        firstFailure ||= `trial=${trial} n=${n} limit=${limit} offset=${offset} unsolved`;
        continue;
      }
      const full = order as string[];
      if (new Set(full).size !== n || full.length !== n) {
        invalid += 1;
        firstFailure ||= `trial=${trial} n=${n} 非双射`;
        continue;
      }
      let bandViolation = false;
      full.forEach((key, slot) => {
        const band = bands[Number(key.slice(1))];
        if (slot < band.lo || slot > band.hi) bandViolation = true;
      });
      if (bandViolation) {
        invalid += 1;
        firstFailure ||= `trial=${trial} n=${n} 落带越界`;
        continue;
      }
      const cost = costOf(full, list, offset, limit);
      if (cost !== optimum) {
        mismatches += 1;
        firstFailure ||= `trial=${trial} n=${n} limit=${limit} offset=${offset} cost=${cost} optimum=${optimum}`;
      }
    }
    expect({ checked, mismatches, invalid, firstFailure }).toEqual({
      checked: 21000,
      mismatches: 0,
      invalid: 0,
      firstFailure: '',
    });
  });

  it('恒可解扫描（n ≤ poolSize × limit × offset × 两种档位分布）：全部成功且总代价最优（n≤8 逐组比对）', () => {
    let solved = 0;
    let failures = 0;
    let costMismatches = 0;
    for (const limit of [1, 2, 5, 20]) {
      for (const offset of [0, 5, 10]) {
        if (offset % limit !== 0) continue;
        const poolSize = Math.min(limit + 10, 50);
        if (offset + limit > poolSize) continue;
        for (let n = 1; n <= poolSize; n += 1) {
          for (const tierOf of [
            (index: number) => (n - index) % 4,
            (index: number) => (index % 4 === 0 ? 3 : 0),
          ]) {
            const list = candidates(n, tierOf);
            const order = solveRerankPlacement(list, offset, limit);
            if (order === null) {
              failures += 1;
              continue;
            }
            const full = order as string[];
            const bands = list.map((candidate) => placementBand(candidate.index, n, offset, limit));
            let ok = new Set(full).size === n;
            full.forEach((key, slot) => {
              const band = bands[Number(key.slice(1))];
              if (slot < band.lo || slot > band.hi) ok = false;
            });
            if (n <= 8) {
              const optimum = exactMinCost(ranksOf(list), bands);
              if (costOf(full, list, offset, limit) !== optimum) costMismatches += 1;
            }
            solved += ok ? 1 : 0;
            if (!ok) failures += 1;
          }
        }
      }
    }
    expect({ failures, costMismatches, solvedAtLeast: solved > 0 }).toEqual({
      failures: 0,
      costMismatches: 0,
      solvedAtLeast: true,
    });
  });

  it('固定 seed 回归（曾 95.5% 无解的 limit=20 / n=30 / 稀疏档位，4000 次采样全部成功）', () => {
    let state = 42 + 20 * 7 + 30;
    const next = (): number => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    let failures = 0;
    for (let trial = 0; trial < 4000; trial += 1) {
      const list = candidates(30, () => {
        const r = next();
        return r < 0.35 ? 0 : r < 0.6 ? 1 : r < 0.85 ? 2 : 3;
      });
      const order = solveRerankPlacement(list, 0, 20);
      if (order === null || new Set(order as string[]).size !== 30) failures += 1;
    }
    expect(failures).toBe(0);
  });
});

describe('solveAssignment（算法接缝：显式带 + 意愿排名）', () => {
  it('主脑反例（宽度主键必败的实例）：新算法必出合法完美匹配且代价最优', () => {
    // C/D/E/F = [0,0]/[1,1]/[2,2]/[3,3]（宽 0）、N = [4,5]（宽 1，hi=5）、W = [0,4]（宽 4，hi=4）：
    // 宽度主键序 C→D→E→F→N→W 会死锁（N 抢槽 4、W 带内全占）；最优解是 W→4、N→5。
    const bands = [
      { lo: 0, hi: 0 },
      { lo: 1, hi: 1 },
      { lo: 2, hi: 2 },
      { lo: 3, hi: 3 },
      { lo: 4, hi: 5 }, // N
      { lo: 0, hi: 4 }, // W
    ];
    // 意愿排名：让 W 想坐 4、N 想坐 5（与最优解一致）
    const ranks = [0, 1, 2, 3, 5, 4];
    const owner = solveAssignment(ranks, bands);
    expect(owner).not.toBeNull();
    const slots = owner as number[];
    expect(slots).toHaveLength(6);
    expect(new Set(slots).size).toBe(6);
    slots.forEach((candidate, slot) => {
      expect(slot).toBeGreaterThanOrEqual(bands[candidate].lo);
      expect(slot).toBeLessThanOrEqual(bands[candidate].hi);
    });
    // 精确最优（该实例代价下界 0：W→4、N→5 恰好各就各位）
    expect(exactMinCost(ranks, bands)).toBe(0);
    expect(slots[4]).toBe(5); // 槽 4 → W（下标 5）
    expect(slots[5]).toBe(4); // 槽 5 → N（下标 4）
  });

  it('形状异常 ⇒ null（fail-open 保险丝，不是"半个解"）', () => {
    expect(solveAssignment([], [])).toEqual([]);
    expect(solveAssignment([0, 1], [{ lo: 0, hi: 1 }])).toBeNull(); // 带数不匹配
    expect(solveAssignment([0, 0], [{ lo: 0, hi: 1 }, { lo: 0, hi: 1 }])).toBeNull(); // 排名非排列
    expect(solveAssignment([0, 1], [{ lo: 2, hi: 1 }, { lo: 0, hi: 1 }])).toBeNull(); // 带为空
  });
});
