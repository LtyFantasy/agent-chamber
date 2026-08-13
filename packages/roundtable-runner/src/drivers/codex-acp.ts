/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 的厂商实现——单飞行/BusyError)
 *   - 补充: docs/roundtable-design.md §8 (codex ACP 行为档案: 桥 1.1.14 / codex 0.147.0
 *           实测 2026-08-10——quirk① approvals_reviewer 钉死、quirk② model 钉死、
 *           configOptions {id,currentValue} 形状、审批 options 带 _meta、反向 RPC id 从 0 起)
 *
 * [踩坑索引] ④(resume 失败无降级→楔死) ⑤(fs caps 声明→turn 静默死亡)
 *              ⑥(RT-PERM-1: kind 命名不可信→optionId 直透) ⑦(RT-PERM-2: tool 元数据在 update 本体非 content)
 *              R1(审批缓存裸 requestId 跨座位撞键——codex 反向 RPC id 从 0 起) R2(reasoning_effort 解析)
 *              R3(CODEX_PATH 探测不到不静默兜底)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   R3: 桥内嵌 codex 唯一实测 = 起不来（npm 可选依赖 @openai/codex-linux-x64 缺失 bug，
 *       pnpm 环境未验证）→ CODEX_PATH 探测不到系统 CLI 时 start 直接失败带明确 detail
 *       （codex CLI not found: install + login first），不走未验证路径。
 *   R1: codex 桥反向 RPC id 从 0 自增、kimi 小整数自增——双座位并发审批 requestId
 *       撞键会互相覆盖。修复：runner-core 审批缓存 key 改 `${seatId}:${requestId}`。
 *       见 memory/2026-08-10.md §R1
 *   R2: codex 思考等级键名是 reasoning_effort（category thought_level）而非 thinking
 *       → 基座 extractConfigSnapshot 统一映射到 thinking，否则 codex 座位 seat_info
 *       三件套缺一角。见 memory/2026-08-10.md §R2
 *   ⑤: client 声明 fs caps 后 turn 静默死亡 → 基座一律不声明 fs caps（kimi 0.34.0 实测；
 *       codex 沿用同一安全线）。见 memory/2026-08-07.md §4
 *   ⑥: RT-PERM-1 —— 审批 optionId 才是稳定键（与 request_permission params 同源），
 *       kind 是厂商自由命名不可信；codex 审批 options 与 kimi 同命名空间
 *       （allow_once/allow_always/reject_once，带 _meta），精确匹配逻辑基座直接复用。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * CodexAcpDriver —— codex ACP 座位的 SeatDriver 实现（quirk 薄壳）
 *
 * 传输层 = AcpDriver 基座（acp-driver.ts），本文件只承载 codex 厂商差异：
 *
 * 1. spawn：`node <@agentclientprotocol/codex-acp 桥 bin 绝对路径>`（钉为 runner 依赖，
 *    不走 npx 网络；bin 路径从包 package.json 的 bin 字段解析）。
 * 2. quirk①（审批钉死）：env 恒注入 `CODEX_CONFIG='{"approvals_reviewer":"user"}'`——
 *    用户 config.toml 的 approvals_reviewer=auto_review/guardian_subagent 会让 agent
 *    内部自动批准、审批到不了平台；永远钉死人工审批（合法值 user/auto_review/guardian_subagent）。
 * 3. CODEX_PATH：运行时从 PATH 探测系统 `codex` CLI；探测不到 → start 直接失败
 *    （R3：桥内嵌 codex 实测起不来，不做静默兜底）。
 * 4. quirk②（模型钉死）：seat.assign 带 model（如 gpt-5.6-luna）时基座
 *    set_config_option 钉死（PoC 实测生效；quota model_usage 含模型名，成本审计证据）。
 * 5. 权限档位映射（平台档位 → codex 配置，语义近似非等价——codex plan = 规划后请求
 *    批准再执行，kimi plan 偏只读规划；非 plan 档 collaboration_mode 复位默认）：
 *      default → mode=read-only
 *      plan    → mode=read-only + collaboration_mode=plan
 *      auto    → mode=agent
 *      yolo    → mode=agent-full-access
 * 6. configOptions 形状差异（{id, currentValue} 数组 + reasoning_effort 思考等级键）
 *    由基座 extractConfigSnapshot 双形态兼容（R2），本文件无需处理。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionMode } from '@agent-chamber/roundtable-protocol';
import type { Logger } from '../logger';
import { AcpDriver } from './acp-driver';

/** codex ACP 桥 npm 包名（官方 ACP 组织维护，底层是官方 app-server；精确钉版 1.1.14） */
const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp';
/** 桥包 bin 入口名（bin 字段的键） */
const CODEX_ACP_BIN_NAME = 'codex-acp';

/**
 * quirk① 审批钉死值：永远人工审批（user）。
 * 防用户 config.toml approvals_reviewer=auto_review/guardian_subagent 泄漏吞审批——
 * 合法值 user/auto_review/guardian_subagent；自定义 env 时勿覆盖本键。
 */
const CODEX_CONFIG_PINNED = '{"approvals_reviewer":"user"}';

/**
 * 平台权限档位 → codex mode 原语映射（读档后按「语义近似非等价」理解，见类注释）。
 * plan 档的 collaboration_mode=plan 由 modeConfigEntries 追加（非 plan 不发送，
 * codex 保持默认）。
 */
const CODEX_MODE: Record<PermissionMode, string> = {
  default: 'read-only',
  plan: 'read-only',
  auto: 'agent',
  yolo: 'agent-full-access',
};

/** 从 PATH 探测可执行文件（POSIX 简单探测：目录下存在同名文件即可；找不到返回 undefined） */
function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 目录不存在/无权限：跳过继续探测
    }
  }
  return undefined;
}

/**
 * 解析 codex-acp 桥的 bin 绝对路径：require.resolve 包 package.json → 读 bin 字段 →
 * 拼绝对路径。不用 npx（网络/缓存不确定性），钉为 runner 依赖直接执行。
 */
function resolveAcpBinPath(): string {
  const pkgJsonPath = require.resolve(`${CODEX_ACP_PACKAGE}/package.json`);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[CODEX_ACP_BIN_NAME];
  if (!binEntry) {
    throw new Error(`${CODEX_ACP_PACKAGE} package.json has no "${CODEX_ACP_BIN_NAME}" bin entry`);
  }
  return path.resolve(path.dirname(pkgJsonPath), binEntry);
}

/** CodexAcpDriver 构造选项 */
export interface CodexAcpDriverOptions {
  /**
   * 覆盖 codex CLI 路径（跳过 PATH 探测；测试注入假二进制 / 运维钉死非 PATH 安装位用）。
   * 不设则每次 spawn 时从 PATH 探测，探测不到 start 失败（R3）。
   */
  codexBin?: string;
  /**
   * 覆盖 codex-acp 桥 bin 脚本路径（默认从依赖包 package.json bin 字段解析；
   * 测试注入假 ACP 子进程脚本用）。
   */
  acpBinPath?: string;
  /** 会话 id 读取回调（start 时 resume 用；runner-core 接 state-store） */
  getSessionId?: (seatId: string) => string | undefined;
  /** 会话 id 落盘回调（session/new 或 resume 后；runner-core 接 state-store） */
  onSessionId?: (seatId: string, sessionId: string) => void;
  /** 日志器（默认 ConsoleLogger info） */
  logger?: Logger;
  /** 优雅取消兜底超时（ms，默认 10_000；测试注入短值覆盖超时 kill 分支） */
  cancelKillTimeoutMs?: number;
}

/**
 * codex ACP 座位驱动（契约① SeatDriver 的实现；传输基座 AcpDriver + codex quirk profile）
 */
export class CodexAcpDriver extends AcpDriver {
  constructor(options: CodexAcpDriverOptions = {}) {
    super({
      profile: {
        vendorName: 'codex',
        spawnCommand: () => {
          // R3：桥内嵌 codex 唯一实测 = 起不来（@openai/codex-linux-x64 可选依赖缺失），
          // pnpm 环境未验证——探测不到系统 CLI 直接失败，明确引导安装登录，不静默兜底
          const codexBin = options.codexBin ?? findOnPath('codex');
          if (!codexBin) {
            throw new Error('codex CLI not found: install + login first');
          }
          return {
            bin: process.execPath,
            args: [options.acpBinPath ?? resolveAcpBinPath()],
            // quirk①：审批永远人工（钉死覆盖用户 env）；CODEX_PATH 显式传给桥（内嵌不可用）
            env: { ...process.env, CODEX_CONFIG: CODEX_CONFIG_PINNED, CODEX_PATH: codexBin },
          };
        },
        modeConfigEntries: (permissionMode) => {
          const entries: Array<{ configId: string; value: string }> = [
            { configId: 'mode', value: CODEX_MODE[permissionMode] },
          ];
          // plan 档追加 collaboration_mode=plan（codex 规划后请求批准再执行）；
          // 其余档不发送 collaboration_mode（codex 默认，语义近似非等价）
          if (permissionMode === 'plan') {
            entries.push({ configId: 'collaboration_mode', value: 'plan' });
          }
          return entries;
        },
      },
      getSessionId: options.getSessionId,
      onSessionId: options.onSessionId,
      logger: options.logger,
      cancelKillTimeoutMs: options.cancelKillTimeoutMs,
    });
  }
}
