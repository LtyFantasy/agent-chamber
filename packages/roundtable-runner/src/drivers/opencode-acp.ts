/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 的厂商实现——单飞行/BusyError)
 *   - 补充: docs/roundtable-design.md §8 (opencode ACP 行为档案, 1.18.9 实测 2026-08-14——
 *           configOptions 地面真相 model+mode(build/plan) / 权限经 OPENCODE_CONFIG_CONTENT
 *           钉死 / authMethods=opencode-login / loadSession=true)
 *
 * [踩坑索引] ④(resume 失败无降级→楔死) ⑤(fs caps 声明→turn 静默死亡)
 *              ⑥(RT-PERM-1: kind 命名不可信→optionId 直透) ⑦(RT-PERM-2: tool 元数据在 update 本体非 content)
 *              O1(opencode 原生默认全放行≠平台 default 档语义，必须主动钉 ask)
 *              O2(opencode 无 auto/yolo 区分，两档同映射 build+allow，语义近似)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   O1: opencode 原生默认「allow all operations without approval」（官方 permissions
 *       文档原文）——与平台 default 档「审批到平台、人类裁决」语义相反；若只吃用户
 *       config 剩饭，default 座位永不上报审批（同 §8 档案 #5 kimi config.toml yolo
 *       泄漏的同构坑）。根治：spawn env 恒注入 OPENCODE_CONFIG_CONTENT 按档位钉死
 *       （default/plan → {"permission":{"*":"ask"}}；auto/yolo → allow），该 env
 *       优先级 6/8（仅 managed config 能压过），项目 opencode.json 翻不了盘。
 *   O2: opencode ACP（1.18.9 实测）configOptions 的 mode 只有 build/plan 两个选项
 *       （build/plan 之外的自定义 agent 才会出现更多），没有 auto/yolo 原语——
 *       平台 auto/yolo 档同映射 build + 权限全放行，语义近似非等价（与 codex
 *       档位映射同规）。差异：auto/yolo 在 opencode 侧完全同义。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * OpencodeAcpDriver —— opencode ACP 座位的 SeatDriver 实现（profile 薄壳）
 *
 * 传输层 = AcpDriver 基座（acp-driver.ts），本文件只承载 opencode 厂商差异：
 *
 * 1. spawn：`opencode acp`（原生 ACP 子命令，stdio JSON-RPC，无桥——与 kimi 同形态）。
 *    bin 解析优先级：构造选项 bin > OPENCODE_BIN env > PATH 探测；探测不到 →
 *    start 直接失败带明确引导（沿用 codex R3 教训：不静默兜底）。
 * 2. 权限钉死（O1）：spawn env 恒注入 OPENCODE_CONFIG_CONTENT——
 *      default/plan → {"permission":{"*":"ask"}}（审批全量上报平台，人类裁决）
 *      auto/yolo   → {"permission":{"*":"allow"}}（全放行，不问）
 *    已 `opencode debug config` 实测：env 内容并入最终解析配置（2026-08-14，1.18.9）。
 * 3. 档位映射（O2，平台档位 → opencode mode 原语，语义近似非等价）：
 *      default → mode=build（+ 权限 ask 钉死）
 *      plan    → mode=plan（opencode plan agent 只读规划）
 *      auto    → mode=build（+ 权限 allow 钉死）
 *      yolo    → mode=build（+ 权限 allow 钉死）
 * 4. 行为档案（§8，1.18.9 实测）：initialize 能力 loadSession=true（resume 复活可用）、
 *    authMethods=[opencode-login]（未登录时 prompt 会失败——install 向导负责引导
 *    `opencode auth login`）、configOptions={model 大列表, mode:[build,plan]}。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig } from '@agent-chamber/roundtable-protocol';
import type { Logger } from '../logger';
import { AcpDriver, MalformedResponseError } from './acp-driver';
export { MalformedResponseError };

/**
 * 平台档位 → opencode 权限钉死值（OPENCODE_CONFIG_CONTENT，O1）。
 * default/plan 钉 ask（opencode 原生默认全放行，不钉则审批永不上报平台）；
 * auto/yolo 钉 allow（防御用户 config 把 * 设成 ask/deny 导致 auto 座位楔死——
 * 对称「显式钉死，禁止吃用户 config 剩饭」原则，见 seat.ts PermissionMode 注释）。
 */
const OPENCODE_PERMISSION_PIN: Record<PermissionMode, string> = {
  default: '{"permission":{"*":"ask"}}',
  plan: '{"permission":{"*":"ask"}}',
  auto: '{"permission":{"*":"allow"}}',
  yolo: '{"permission":{"*":"allow"}}',
};

/**
 * 平台档位 → opencode mode 原语（O2：opencode 1.18.9 实测 configOptions mode 仅
 * build/plan；auto/yolo 无对应原语，同映射 build，差异全部由权限钉死承载）。
 */
const OPENCODE_MODE: Record<PermissionMode, string> = {
  default: 'build',
  plan: 'plan',
  auto: 'build',
  yolo: 'build',
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

/** OpencodeAcpDriver 构造选项 */
export interface OpencodeAcpDriverOptions {
  /**
   * 覆盖 opencode CLI 路径（跳过 OPENCODE_BIN env 与 PATH 探测；测试注入假二进制 /
   * 运维钉死非 PATH 安装位用）。不设则按 bin → OPENCODE_BIN → PATH 探测解析，
   * 探测不到 start 失败（R3 同规：不静默兜底）。
   */
  bin?: string;
  /** spawn 参数（默认 ['acp']；测试注入假子进程脚本用） */
  spawnArgs?: string[];
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
 * opencode ACP 座位驱动（契约① SeatDriver 的实现；传输基座 AcpDriver + opencode profile）
 */
export class OpencodeAcpDriver extends AcpDriver {
  constructor(options: OpencodeAcpDriverOptions = {}) {
    super({
      profile: {
        vendorName: 'opencode',
        spawnCommand: (config: SeatConfig) => {
          // bin 解析：构造选项 > OPENCODE_BIN env > PATH 探测；探测不到直接失败
          // 带引导（R3：不静默兜底，错误信息成为座位 offline 的 detail）
          const bin = options.bin ?? process.env.OPENCODE_BIN ?? findOnPath('opencode');
          if (!bin) {
            throw new Error(
              'opencode CLI not found: install (https://opencode.ai) + `opencode auth login` first',
            );
          }
          return {
            bin,
            args: options.spawnArgs ?? ['acp'],
            // O1：权限按座位档位显式钉死（不吃用户 config 剩饭）；OPENCODE_CONFIG_CONTENT
            // 优先级 6/8，仅 managed config 能压过，项目 opencode.json 翻不了盘
            env: {
              ...process.env,
              OPENCODE_CONFIG_CONTENT: OPENCODE_PERMISSION_PIN[config.permissionMode],
            },
          };
        },
        // O2：单条 mode 钉死（build/plan）；权限差异由 spawn env 承载，不走 configOptions
        modeConfigEntries: (permissionMode) => [
          { configId: 'mode', value: OPENCODE_MODE[permissionMode] },
        ],
      },
      getSessionId: options.getSessionId,
      onSessionId: options.onSessionId,
      logger: options.logger,
      cancelKillTimeoutMs: options.cancelKillTimeoutMs,
    });
  }
}
