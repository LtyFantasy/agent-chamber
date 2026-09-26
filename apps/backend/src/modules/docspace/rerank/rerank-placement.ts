/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 搜索重排的**位置带求解器**：模型给的排序意图必须落在"每个候选能移动多远"的
 *     硬约束内——页外候选**只能进页尾 K_PROMOTE 个槽**（安全不可协商），页内候选可在 ±K_MOVE
 *     内上下移动
 *
 * [代码职责]
 *   - `solveAssignment`：**最小总代价完美匹配**（Kuhn–Munkres 匈牙利，手写无依赖）——
 *     在"每个候选的可行带 × 模型意愿排名"上求全局最优
 *   - `solveRerankPlacement`：组装（带 + 意愿排名）→ 求解 → 槽序即最终序
 *   - `placementBand` / `compareRerankKey`：约束与键序的单源
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/api-definition.md` — 文档搜索章（重排触发条件 / 翻页窗口 /
 *     页外候选承诺边界：limit=20 时页外最高**第 18 位**（= 页尾 3 槽；见下文口径修正））
 *   - plan `kate-bishop-moon-girl-sam-alexander.md` §批次 3（位置带唯一表达式 + 求解算法钉死）
 *
 * [关键不变量]
 *   - **唯一的位置带表达式**（改它 = 改安全承诺，必须同步文档与用例）：
 *     ```
 *     p ≥ max(i − K_MOVE, isPageExternal(x) ? offset + max(0, limit − K_PROMOTE) : 0)
 *     p ≤ i + K_MOVE
 *     isPageExternal(x) ⇔ i ≥ offset + limit      // i = 池内 0-based 序号
 *     ```
 *     语义：页外候选**只能占返回页的最后 K_PROMOTE 个槽位**（limit=5 → 槽 2..4；limit=20 → 17..19）；
 *     `max(0, limit − K_PROMOTE)` 让 limit < K_PROMOTE 时保留区退化为空（**不产生无解**）。
 *   - **求解算法 = 最小总代价完美匹配**（v1.85.0 终审 MAJOR-1 裁决；两个贪心已先后被证伪）：
 *     `cost(i, p) = |p − r_i|`，`r_i` = 候选按完整键序的**模型意愿排名**（0 = 最想放第一），
 *     `p ∈ [lo_i, hi_i]`；求总 cost 最小的完美匹配（Kuhn–Munkres，n ≤ 50，手写零依赖）。
 *     - **简史（为什么两个贪心都不够）**：
 *       ① **宽度主键贪心**（原稿）：跨宽度组的 `hi` 乱序可构造死锁（`hi` 只随 index 单调非降、
 *          宽度却能跳变）——实测 `limit=20` 满池 95.5% 无解。
 *       ② **EDF（`hi` 升序）贪心**（第一次修正）：不死了，但**满池形态下 `hi = min(i+K_MOVE, count−1)`
 *          随 index 单调 ⇒ 处理序 ≡ index 升序 ⇒ 归纳得每个候选落回自己的槽** ⇒ 页首
 *          `limit−1` 槽恒等于 SQL 原序、模型只影响最后 1 槽（"活着的死算法"：功能不生效，
 *          而所有"可解 + 落带"断言仍全绿）。根因是**放置顺序就是最终序的决定因素**，
 *          任何单主键贪心都会系统性牺牲某一类候选。
 *       ③ 因此本版**不求贪心、直接求约束最优**：最优分配没有"顺序自由度"问题，模型意愿与
 *          可行带在同一目标里同时被满足。
 *     - **恒可解**：identity（`i → 槽 i`）对每个候选都落在带内（`lo ≤ i ≤ hi`：`hi ≥ i` 显然；
 *       页内 `lo = max(i−K_MOVE, 0) ≤ i`；页外 `lo = offset+max(0, limit−K_PROMOTE) ≤ offset+limit
 *       ≤ i`）⇒ 完美匹配恒存在 ⇒ **正常参数下求解必成功**，`null` 只作参数被改坏时的保险丝。
 *     - **模型意愿真的生效**：`limit=20 / pool=30 / offset=0` 下把池尾页外候选给最高档 ⇒ 目标函数
 *       会把它们推进页尾 K_PROMOTE 槽（页外下界 17 ⇒ 页内最高**第 18 位**、页尾 3 槽），
 *       同时把被挤下去的页内候选压向靠后槽位 ⇒ 页首槽位随模型变化（功能生效性门禁见 spec）。
 *     - **确定性**：行列升序遍历 + 严格更优才松弛 ⇒ 同输入同输出（成本相等而分配不同的情形由
 *       遍历顺序收敛到唯一解；`rerank-placement.spec.ts` 有"两次求解逐字相同"锁定）。
 *   - **失败语义 = fail-open**：`solveAssignment` 返回 null（形状异常 / 禁配 / 未配满）⇒ 调用点
 *     **整段弃用模型序回 SQL 原序**（走原路径，非池切片）。**严禁放宽下界**——"永不进页首
 *     `limit−K_PROMOTE` 槽"是不可协商控制，不是可回退启发。
 *   - **`rerank-placement.ts:17` 的承诺边界口径**：页外候选最高到**页内第 `limit−K_PROMOTE+1` 位**
 *     （limit=20 → 第 18 位 / 页尾 3 槽；limit=5 → 第 3..5 位）。⚠️ 历史漂移：曾写"limit=20 最高
 *     第 11 位"——那是只按 `K_MOVE` 推的口径，漏了页外专属下界 `externalFloor`，已修正。
 * [关联代码]
 *   - doc-search-rerank.ts — 能力实现（把模型档位喂进本求解器）
 *   - modules/docspace/doc-search.service.ts — 调用点（池 / 页基序 / fail-open 落行）
 *   - modules/docspace/doc-search-constants.ts — SCORE_FLOOR 等既有常量（本文件不碰）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改 K_MOVE / K_PROMOTE 必须同步 api-definition 的承诺边界与组合 fixture 单测
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/** 池内可移动半径：候选最多上下移动这么多位（页内与页外同规） */
export const K_MOVE = 10;

/** 页外候选可占据的**页尾槽位数**（"页外投毒最高只到页内第 limit−K_PROMOTE+1 位"的硬约束） */
export const K_PROMOTE = 3;

/**
 * 禁配代价（`p ∉ [lo_i, hi_i]` 的边）。
 *
 * 必须**严格大于任何合法总代价**：合法单边 ≤ `(n−1)·PRIMARY_SCALE`（见 `costOfPair`），
 * 合法总代价 ≤ `n·(n−1)·(n³+1)`（n ≤ 50 ⇒ ≈ 3.1×10⁸），故取 10⁹ 留足一个数量级。
 * 恒可解 ⇒ 最优解绝不使用禁配边；万一用到（参数被改坏）由 `solveAssignment` 末端的禁配自检
 * 兜成 `null`（fail-open）。
 */
const FORBIDDEN_COST = 1_000_000_000;

/**
 * 单边编码代价 = **主目标 × 主尺度 − 次目标**（字典序两项，一次求最优）。
 *
 * - **主目标** `|p − r|`（模型意愿与落位的偏离）乘 `PRIMARY_SCALE = n³ + 1` ⇒ 任何 1 单位的主目标
 *   差异都压过次目标的最大可能摆幅（`Σ r·p ≤ n·(n−1)² < n³`）⇒ 主目标仍是"总偏离最小"，
 *   次目标只在**主目标完全相等的多个最优解之间**起作用。
 * - **次目标** `− r_i·p`（即**最大化 `Σ r_i·p_i`**）：由重排不等式，最大化和 = 把"模型排名更靠前
 *   （`r` 更小）的候选配到更小的槽"⇒ 在代价相等的前提下**保持模型相对顺序**（否则会出现
 *   "模型更好的候选被免费推到后面"这种平局副作用）。注意 `Σ p_i` 在完美匹配里是常数，
 *   故"偏好小槽"这类朴素写法**无效果**（这就是不用 `+p` 的原因）。
 *
 * ⚠️ **负元与零基 KM 的前提**（复审 NEW-6）：本编码在 `slot == rank` 处取到 `−r²`，最小
 * `−(n−1)²` ⇒ **矩阵存在负元**，而本实现的 Kuhn–Munkres 用零初始化对偶势（`u/v = 0`），其正确性
 * 前提是 `a_ij ≥ 0`。故填矩阵时**统一加常数 `(n−1)²`**：完美匹配恰好含 n 条边、每行每列各用一次
 * ⇒ 总代价恒加 `n·(n−1)²`（**常数**）⇒ argmin 与最优分配**逐字不变**（零行为变化），
 * 同时把全部合法元抬到非负。
 */
function costOfPair(slot: number, rank: number, primaryScale: number, negativeOffset: number): number {
  return Math.abs(slot - rank) * primaryScale - rank * slot + negativeOffset;
}

/**
 * 参与求解的候选（服务侧已按 SQL 池序编号；`index` 即"SQL 池名次"）。
 *
 * `key` 是出站候选键（`c0..cN`）——它同时是日志里的候选标识（不落 docId，避免日志成为文档清单）。
 */
export interface PlacementCandidate {
  /** 候选键（`c{i}`，≡ SQL 池名次的可读形式） */
  key: string;
  /** 池内 0-based 序号（位置带的输入 `i`） */
  index: number;
  /** 模型档位（0-3；越大越相关） */
  tier: number;
  /** boost 后的合成分（完整键序的第二段） */
  score: number;
  /** section position（完整键序的第三段） */
  position: number;
  /** docId（完整键序的末段，保全序/可复现） */
  docId: string;
}

/**
 * 位置带（闭区间 `[lo, hi]`，单位 = 最终序槽位 0-based）。
 *
 * @param index 池内 0-based 序号
 * @param count 池候选总数
 * @param offset 本次请求的 offset（页基序）
 * @param limit 本次请求的 limit
 * @returns 该候选允许落位的槽区间
 */
export function placementBand(
  index: number,
  count: number,
  offset: number,
  limit: number,
): { lo: number; hi: number } {
  const pageEnd = offset + limit;
  // 页外候选的下界：页尾 K_PROMOTE 槽（limit < K_PROMOTE 时退化为页首，不产生无解）
  const externalFloor = offset + Math.max(0, limit - K_PROMOTE);
  const lo = Math.max(index - K_MOVE, index >= pageEnd ? externalFloor : 0);
  return { lo, hi: Math.min(index + K_MOVE, count - 1) };
}

/**
 * 重排键（**完整键序**，唯一一处定义）：`tier DESC → score DESC → position ASC → docId ASC`。
 *
 * 语义：它同时是"模型意图的排名依据"（求解器用它算 `r_i`）与"同 cost 平局时的呈现依据"。
 * 末段 `docId` 保证全序（`doc_sections` 的 (doc, position) 唯一 ⇒ 键元组唯一），
 * 故比较结果可复现（`Array.sort` 稳定只是兜底，不承担正确性）。
 */
export function compareRerankKey(a: PlacementCandidate, b: PlacementCandidate): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.score !== b.score) return b.score - a.score;
  if (a.position !== b.position) return a.position - b.position;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

/**
 * **最小总代价完美匹配**（min-cost bipartite assignment；本文件的核心算法）。
 *
 * 契约：`ranks[i]` = 候选 `i` 按完整键序的排名（0 = 模型最想放第一）；`bands[i] = [lo_i, hi_i]`；
 * `cost(i, p) = |p − r_i|`（`p` ∈ 带内）；求**总 cost 最小**的完美匹配（每个候选恰好一个槽、
 * 每个槽恰好一个候选）。恒可解（identity `i → 槽 i` 恒合法，见文件头论据）⇒ 正常参数下必成功。
 *
 * 为什么必须"求最优"而不是"某个贪心"：放置顺序**就是**最终序的决定因素，而任何单主键贪心都会
 * 系统性牺牲某一类候选——宽度主键死锁（跨宽度组的 `hi` 乱序），EDF 主键则在满池形态下退化为
 * `index` 升序（`hi` 单调）从而锁死页首（模型档位影响不到页首 `limit−1` 槽）。最优分配没有这个
 * 自由度问题：它直接在"可行带 × 模型意愿排名"上求全局最优。
 *
 * 算法 = **Kuhn–Munkres（匈牙利）O(n³)**（n ≤ 50，常数可忽略；**零新依赖**，手写）：
 * 行 = 候选、列 = 槽；禁配（`p ∉ [lo_i, hi_i]`）代价记为 `FORBIDDEN_COST`（远大于任何合法总代价，
 * 恒可解 ⇒ 最优解绝不使用禁配边）。
 * **确定性**：主目标（总偏离最小）+ **次目标（`Σ r·p` 最大 ⇒ 平局时保持模型相对顺序）**
 * 已把"成本相等但分配不同"的多解空间压到最小；残余平局再由**行列升序固定遍历 + 严格更优才
 * 松弛**收敛到唯一解 ⇒ 同一输入恒得同一输出（单测"同输入两次求解逐字相同"锁定）。
 *
 * @param ranks 逐候选的模型意愿排名（长度 = 候选数；值域 0..n-1 的排列）
 * @param bands 逐候选的位置带（长度 = 候选数）
 * @returns `slotOwner[slot] = 候选下标`；形状异常 / 无可行完美匹配 ⇒ `null`（fail-open 保险丝）
 */
export function solveAssignment(
  ranks: readonly number[],
  bands: readonly { lo: number; hi: number }[],
): number[] | null {
  const count = ranks.length;
  if (count === 0) return [];
  if (bands.length !== count) return null;
  if (bands.some((band) => band.lo > band.hi)) return null;
  // 排名必须是 0..n-1 的排列（防御：非排列会让"意愿排名"失去意义）
  const seen = new Set(ranks);
  if (seen.size !== count || ranks.some((rank) => !Number.isInteger(rank) || rank < 0 || rank >= count)) {
    return null;
  }

  // 代价矩阵（1-based 内部索引，照 Kuhn–Munkres 的经典写法；行 = 候选，列 = 槽）
  const primaryScale = count * count * count + 1;
  // 负元补偿常数（见 `costOfPair` JSDoc）：完美匹配下总代价恒加 n·(n−1)² ⇒ 最优分配不变
  const negativeOffset = (count - 1) * (count - 1);
  const cost: number[][] = [];
  for (let row = 1; row <= count; row += 1) {
    const line: number[] = [FORBIDDEN_COST];
    const band = bands[row - 1];
    const rank = ranks[row - 1];
    for (let column = 1; column <= count; column += 1) {
      const slot = column - 1;
      line.push(
        slot < band.lo || slot > band.hi
          ? FORBIDDEN_COST
          : costOfPair(slot, rank, primaryScale, negativeOffset),
      );
    }
    cost.push(line);
  }

  const rowPotential = new Array<number>(count + 1).fill(0);
  const columnPotential = new Array<number>(count + 1).fill(0);
  /** `matchedRow[column]` = 该槽当前分配的候选（1-based 行号；0 = 未分配） */
  const matchedRow = new Array<number>(count + 1).fill(0);
  /** 交替树里每个列的前驱列（回溯增广路用） */
  const predecessor = new Array<number>(count + 1).fill(0);

  for (let row = 1; row <= count; row += 1) {
    matchedRow[0] = row;
    let column = 0;
    const minSlack = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(count + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= count; candidate += 1) {
        if (used[candidate]) continue;
        const slack =
          cost[currentRow - 1][candidate] - rowPotential[currentRow] - columnPotential[candidate];
        // 严格更优才更新 ⇒ 等代价时保留**更小的列号**（确定性来源之一）
        if (slack < minSlack[candidate]) {
          minSlack[candidate] = slack;
          predecessor[candidate] = column;
        }
        if (minSlack[candidate] < delta) {
          delta = minSlack[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= count; candidate += 1) {
        if (used[candidate]) {
          rowPotential[matchedRow[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minSlack[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);

    // 回溯增广路，把新行接进匹配
    do {
      const previousColumn = predecessor[column];
      matchedRow[column] = matchedRow[previousColumn];
      column = previousColumn;
    } while (column !== 0);
  }

  const slotOwner = new Array<number>(count).fill(-1);
  for (let column = 1; column <= count; column += 1) {
    const row = matchedRow[column];
    if (row === 0) return null; // 防御：未能配满（恒可解 ⇒ 理论不可达）
    slotOwner[column - 1] = row - 1;
  }
  // 禁配自检：最优解里出现禁配 ⇒ 说明恒可解前提被破坏（参数被改坏），fail-open
  for (let slot = 0; slot < count; slot += 1) {
    const band = bands[slotOwner[slot]];
    if (slot < band.lo || slot > band.hi) return null;
  }
  return slotOwner;
}

/**
 * 求解最终序（成功 = 池的一个排列；失败 = `null`，调用点 fail-open）。
 *
 * 流程：`placementBand` 逐候选算带 → `compareRerankKey` 排序得意愿排名 `r_i` →
 * `solveAssignment` 求最小总代价完美匹配 → 槽序即最终序。
 *
 * @param candidates 池候选（顺序任意；`index` 自持）
 * @param offset 本次请求的 offset
 * @param limit 本次请求的 limit
 * @returns `slotOwner[slot] = 候选的 key`（槽序即最终序）；无解 ⇒ null
 */
export function solveRerankPlacement(
  candidates: readonly PlacementCandidate[],
  offset: number,
  limit: number,
): string[] | null {
  const count = candidates.length;
  if (count === 0) return [];

  const bands = candidates.map((candidate) =>
    placementBand(candidate.index, count, offset, limit),
  );
  // 意愿排名：模型最想放第一的候选排名 0（完整键序；与呈现层的平局键同源）
  const ranked = [...candidates].sort(compareRerankKey);
  const rankByIndex = new Map<number, number>();
  ranked.forEach((candidate, rank) => rankByIndex.set(candidate.index, rank));
  const ranks = candidates.map((candidate) => rankByIndex.get(candidate.index) as number);

  const slotOwner = solveAssignment(ranks, bands);
  if (!slotOwner) return null;
  return slotOwner.map((candidateIndex) => candidates[candidateIndex].key);
}
