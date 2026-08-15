/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 的厂商实现——单飞行/BusyError)
 *   - 补充: docs/roundtable-design.md §8e (claude-code ACP 行为档案, 桥 0.23.1 + Claude Code
 *           2.1.232 实测 2026-08-15——C1 模型双保险 / C2 档位五值 / C3 认证纯 env key /
 *           审批 toolCall 自带全套元数据 / 反向 RPC id 从 0 起 / cancel 5ms / resume 无损)
 *
 * [踩坑索引] ④(resume 失败无降级→楔死) ⑤(fs caps 声明→turn 静默死亡)
 *              ⑥(RT-PERM-1: kind 命名不可信→optionId 直透) ⑦(RT-PERM-2: tool 元数据在 update 本体非 content)
 *              R1(审批缓存裸 requestId 跨座位撞键——codex/claude 反向 RPC id 均从 0 起)
 *              C1(claude session/new currentModelId 恒 default + ANTHROPIC_MODEL env 注册保险)
 *              C2(claude 档位五值 default/acceptEdits/plan/dontAsk/bypassPermissions)
 *              C3(claude 认证纯 env key：key/token/~/.claude 登录态皆无 → start 失败带引导)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   C1: claude session/new 响应的 currentModelId 恒为 'default'（=Sonnet），且自定义
 *       模型必须经 ANTHROPIC_MODEL env 才会进入 availableModels 注册表——缺该 env 时
 *       set_config_option model=<自定义模型> 报 -32603 Invalid value；env 设了但没
 *       set_config_option 钉死，会话照样跑 default 模型。修复：seat config 带 model 时
 *       spawn env 注入 ANTHROPIC_MODEL=config.model（注册用）+ 基座既有
 *       set_config_option model 钉死（acp-driver.ts ensureSession，双保险缺一不可）。
 *   C3: claude 认证纯 env key（initialize 返回 authMethods=[]，无登录流）；2.1.232
 *       实测必须设 ANTHROPIC_API_KEY（只设 ANTHROPIC_AUTH_TOKEN 会 401 Missing API
 *       key），兼容端点走 ANTHROPIC_BASE_URL。修复：start 预检 key/token 皆无且
 *       ~/.claude 登录态目录不存在 → 直接失败带引导（R3 同规，不静默兜底）。
 *   C2: claude 档位五值（default/acceptEdits/plan/dontAsk/bypassPermissions）与平台
 *       四档语义近似非等价映射：default→default、plan→plan、auto→acceptEdits、
 *       yolo→bypassPermissions；dontAsk 不用。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * ClaudeAcpDriver —— Claude Code ACP 座位的 SeatDriver 实现（profile 薄壳）
 *
 * 传输层 = AcpDriver 基座（acp-driver.ts），本文件只承载 claude-code 厂商差异：
 *
 * 1. spawn：`node <@zed-industries/claude-agent-acp 桥 bin 绝对路径>`（钉为 runner
 *    依赖 0.23.1，不走 npx；桥基于官方 Claude Agent SDK 0.2.83，SDK 内嵌 claude CLI，
 *    **不依赖系统 claude 二进制**）。bin 路径从包 package.json 的 bin 字段解析
 *    （键名 claude-agent-acp）。
 * 2. 认证预检（C3）：initialize 返回 authMethods=[]（纯 env key，无登录流）。start 时
 *    ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 皆无且 ~/.claude 登录态目录不存在 →
 *    直接失败带引导（R3 同规：不静默兜底，错误信息成为座位 offline 的 detail）。
 * 3. 模型双保险（C1）：session/new 的 currentModelId 恒为 'default'（=Sonnet），
 *    自定义模型必须经 ANTHROPIC_MODEL env 才进 availableModels 注册表（缺 env 时
 *    set_config_option model=<自定义模型> 报 -32603 Invalid value）。seat.assign 带
 *    model → spawn env 注入 ANTHROPIC_MODEL=config.model（注册）+ 基座
 *    set_config_option model 钉死（实际在跑），双保险缺一不可。
 * 4. 档位映射（C2，平台四档 → claude 五值原语，语义近似非等价）：
 *      default → default（危险操作提请审批）
 *      plan    → plan（只读规划）
 *      auto    → acceptEdits（自动接受编辑类操作，危险操作仍提请审批）
 *      yolo    → bypassPermissions（全放行）
 *      dontAsk 不用。
 * 5. 行为档案（§8e，桥 0.23.1 + Claude Code 2.1.232 实测）：审批 request_permission
 *    的 toolCall 自带 title/kind/content/locations 全套元数据（基座 toolMeta 缓存
 *    只补缺省不覆盖，天然兼容）；反向 RPC id 从 0 起（runner-core `${seatId}:${requestId}`
 *    复合键已覆盖）；cancel 通知 5ms resolve cancelled、同 session 续聊（优雅取消）；
 *    resume 同 session id 复活、补上模型双保险后记忆无损；usage_update 带
 *    cost.{amount,currency}（基座透传不消费）；available_commands_update 暴露
 *    bundled skills 为 slash 命令（codex quirk⑧ 同款红利）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig } from '@agent-chamber/roundtable-protocol';
import type { Logger } from '../logger';
import { AcpDriver } from './acp-driver';

/** Claude Code ACP 桥 npm 包名（基于官方 Claude Agent SDK，SDK 内嵌 claude CLI；精确钉版 0.23.1） */
const CLAUDE_ACP_PACKAGE = '@zed-industries/claude-agent-acp';
/** 桥包 bin 入口名（bin 字段的键） */
const CLAUDE_ACP_BIN_NAME = 'claude-agent-acp';

/**
 * 平台权限档位 → claude mode 原语映射（C2：claude 档位五值
 * default/acceptEdits/plan/dontAsk/bypassPermissions，读档后按
 * 「语义近似非等价」理解——dontAsk 不用，auto 落 acceptEdits）。
 */
const CLAUDE_MODE: Record<PermissionMode, string> = {
  default: 'default',
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
};

/**
 * 探测 claude 本地登录态目录（~/.claude 存在即认为有登录态，C3 预检第三分支）。
 * 为什么用 HOME env 而非 os.homedir()：os.homedir() 首次调用后缓存，测试需改
 * HOME env 隔离「无登录态」分支——HOME 优先，取不到再回退 os.homedir()。
 */
function hasClaudeLoginState(): boolean {
  const home = process.env.HOME ?? os.homedir();
  if (!home) return false;
  try {
    return fs.statSync(path.join(home, '.claude')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析 claude-agent-acp 桥的 bin 绝对路径：require.resolve 包 package.json → 读 bin
 * 字段 → 拼绝对路径。不用 npx（网络/缓存不确定性），钉为 runner 依赖直接执行。
 */
function resolveAcpBinPath(): string {
  const pkgJsonPath = require.resolve(`${CLAUDE_ACP_PACKAGE}/package.json`);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[CLAUDE_ACP_BIN_NAME];
  if (!binEntry) {
    throw new Error(`${CLAUDE_ACP_PACKAGE} package.json has no "${CLAUDE_ACP_BIN_NAME}" bin entry`);
  }
  return path.resolve(path.dirname(pkgJsonPath), binEntry);
}

/** ClaudeAcpDriver 构造选项 */
export interface ClaudeAcpDriverOptions {
  /**
   * 覆盖 claude-agent-acp 桥 bin 脚本路径（默认从依赖包 package.json bin 字段解析；
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
 * Claude Code ACP 座位驱动（契约① SeatDriver 的实现；传输基座 AcpDriver + claude profile）
 */
export class ClaudeAcpDriver extends AcpDriver {
  constructor(options: ClaudeAcpDriverOptions = {}) {
    super({
      profile: {
        vendorName: 'claude-code',
        spawnCommand: (config: SeatConfig) => {
          // C3 认证预检：key/token 皆无且无 ~/.claude 登录态 → 直接失败带引导
          // （R3 同规：不静默兜底——SDK 内嵌 claude CLI 无系统二进制可探测，认证态
          // 就是唯一前置；错误信息成为座位 offline 的 detail）
          const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
          const hasToken = Boolean(process.env.ANTHROPIC_AUTH_TOKEN);
          if (!hasKey && !hasToken && !hasClaudeLoginState()) {
            throw new Error(
              'claude-code auth not found: set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL+key for compatible gateway) or run `claude /login` first',
            );
          }
          return {
            bin: process.execPath,
            args: [options.acpBinPath ?? resolveAcpBinPath()],
            // C1 模型注册保险：自定义模型必须经 ANTHROPIC_MODEL env 才进 availableModels
            // 注册表（缺 env 时 set_config_option model 报 -32603）；实际在跑仍由基座
            // set_config_option model 钉死，两者缺一不可
            env: {
              ...process.env,
              ...(config.model ? { ANTHROPIC_MODEL: config.model } : {}),
            },
          };
        },
        // C2：单条 mode 钉死（default/plan/acceptEdits/bypassPermissions 四值映射）
        modeConfigEntries: (permissionMode) => [
          { configId: 'mode', value: CLAUDE_MODE[permissionMode] },
        ],
      },
      getSessionId: options.getSessionId,
      onSessionId: options.onSessionId,
      logger: options.logger,
      cancelKillTimeoutMs: options.cancelKillTimeoutMs,
    });
  }
}
