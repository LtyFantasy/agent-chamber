/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §4 r25 R3（每 runner 独占状态目录）
 *   - 补充: packages/roundtable-runner/README.md（启动参数表 --state-dir 行）
 *
 * [踩坑索引] R3STATE(裸CLI共享stateDir)
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   R3STATE: 裸 CLI 缺省 state-dir 固定 ~/.roundtable-runner，同机多 runner 共享目录
 *         互相覆盖对账游标（集成指南「三个不要」记录过真实事故）。修复：缺省按
 *         runner 名派生 ~/.roundtable-runner-<name>（`/` 全部转 `-`，与
 *         scripts/install-runner.sh 派生规则严格一致）；显式 --state-dir 仍最优先。
 *         见 docs/roundtable-design.md §4 R3
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 旧版固定缺省目录（本修复前裸 CLI 的 state-dir）：仅用于「旧目录仍有状态」的
 * 迁移提示检测，不再是合法缺省值。
 */
export const LEGACY_DEFAULT_STATE_DIR = path.join(os.homedir(), '.roundtable-runner');

/**
 * 解析 runner 状态目录（r25 R3 语义落地）。
 *
 * 优先级：显式 --state-dir > 按 runner 名派生。派生规则与 scripts/install-runner.sh
 * 的 `${RUNNER_NAME//\//-}` 严格一致：`~/.roundtable-runner-<runner-name>`，
 * runner 名中的 `/` 全部替换为 `-`（防御性——名字进路径）。
 *
 * @param runnerName runner 名称（--runner-name，必传）
 * @param explicitStateDir 显式传入的 --state-dir（undefined = 未传）
 * @param legacyDirExists 旧默认目录存在性探测（仅测试注入用；生产由 cli.ts 传
 *        `() => existsSync(LEGACY_DEFAULT_STATE_DIR)`）
 * @returns stateDir 最终状态目录；usedLegacyDefault=true 表示「裸 CLI 且旧默认目录
 *          探测命中」——调用方应打迁移提示 warn（方案 A：总是派生新目录，一次性
 *          斩断共享目录隐患，代价是裸 CLI 老用户状态换新一次）
 */
export function resolveStateDir(
  runnerName: string,
  explicitStateDir: string | undefined,
  legacyDirExists: () => boolean = () => false,
): { stateDir: string; usedLegacyDefault: boolean } {
  // 显式传参最优先（install-runner.sh / start-runner.sh 显式传参路径行为不变）
  if (explicitStateDir) {
    return { stateDir: explicitStateDir, usedLegacyDefault: false };
  }
  // `/` 全部转 `-`：与 install-runner.sh 同规则，同名 runner 在两条启动路径下
  // 落到同一状态目录
  const derived = path.join(
    os.homedir(),
    `.roundtable-runner-${runnerName.replaceAll('/', '-')}`,
  );
  return { stateDir: derived, usedLegacyDefault: legacyDirExists() };
}
