/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - dsh ACP 座位接入（厂商 profile 薄壳：spawn 命令 / 档位→spawn env 钉死 / model 值包装）
 *
 * [代码职责]
 *   - 承载 dsh（`dsh acp` 子命令）相对 ACP 传输基座的**全部**厂商差异
 *   - 提供 DshAcpDriver（契约① SeatDriver 的实现）；传输行为一律由 AcpDriver 基座承担
 *
 * [权威文档]
 *   - 主文档: docs/roundtable-design.md §3 — 契约① SeatDriver 的厂商实现约定
 *   - 补充: docs/roundtable-design.md §8f — dsh ACP 行为档案（0.2.0-rc.1 四环实测）
 *
 * [关键不变量]
 *   - 档位 → DSH_PERMISSION_MODE 的映射是**唯一**权限钉死通道：dsh 握手不暴露 mode 面
 *     （configOptions 仅 model + reasoning_effort），故 modeConfigEntries 必须保持 `[]`
 *   - 权限钉死只影响「越界写硬拒/升级审批」；danger-full-access 不等于放行开关
 *     （sandbox 无边界故不产生 ask，approval=never 仅让残余 ask 确定性拒绝，防楔死）
 *   - 沙箱根 = session/new 的 cwd（= 座位 cwd）：改座位 cwd 后再唤醒会让 resume 失败并
 *     静默降级 session/new → 记忆丢失（详见 §8f）
 *   - model 值必须是 dsh 认识的 JSON 两段数组串（`["<provider>","<model>"]`）；裸名直接
 *     下发报 unknown model → 整座 offline（fail-closed，不做 warn 降级）
 *
 * [关联代码]
 *   - packages/roundtable-runner/src/drivers/acp-driver.ts — 传输基座（本文件只注入 profile）
 *   - packages/roundtable-runner/src/runner-core.ts — vendor→驱动工厂（'dsh' 分支）
 *   - packages/roundtable-runner/src/drivers/dsh-acp.spec.ts — 行为契约的验证入口
 *
 * [持久踩坑]
 *   - DSH-PERM-1(档位语义反直觉): dsh 的 DSH_PERMISSION_MODE 与平台四档字面同义不同语义
 *     （default=workspace-write 工作区内放行；auto/yolo=danger-full-access 零审批）。
 *     安全方向：不要按平台档位字面推断 dsh 行为，以本文件映射表为准。详情: §8f 档位表
 *   - DSH-MODEL-1(model 非裸名): dsh configOptions 的 model 值是 JSON 数组串。安全方向：
 *     下发前必须经 modelConfigValue 包装（已 `[` 开头视为已包装 → 幂等）。详情: §8f
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
/**
 * DshAcpDriver —— dsh ACP 座位的 SeatDriver 实现（profile 薄壳）
 *
 * 传输层 = AcpDriver 基座（acp-driver.ts），本文件只承载 dsh 厂商差异：
 *
 * 1. spawn：`dsh acp`（= dsh 自带的 `--profile acp`，shipped profile 首次使用时自动
 *    初始化，运维零配置）。bin 解析优先级：构造选项 bin > DSH_BIN env > PATH 探测；
 *    探测不到 → start 直接失败带引导（沿用 opencode R3 教训：不静默兜底，错误信息成为
 *    座位 offline 的 detail）。
 * 2. 权限钉死（D2）：dsh 握手**不暴露 mode 面**（configOptions 仅 model +
 *    reasoning_effort），故档位差异全部由 spawn env `DSH_PERMISSION_MODE` 承载
 *    （dsh-base 同时把它消费进 sandbox-policy 与 user-approval 两侧）：
 *      default → workspace-write（工作区内放行；越界硬拒且带一次性升级审批）
 *      plan    → read-only（只读规划，与四家 plan 档同语义）
 *      auto    → danger-full-access（sandbox 无边界 → 不产生 ask，零审批）
 *      yolo    → danger-full-access
 *    由此 modeConfigEntries 恒为 `[]`——不发任何 set_config_option（dsh 无 mode 可设）。
 * 3. model 值包装（D3）：dsh 的 configOptions model 值是 JSON 两段数组串
 *    （真机 `["deepseek-official","deepseek-v4-flash"]`），裸名下发报 unknown model →
 *    整座 offline。seat.assign 下发的 model 经 modelConfigValue 包装：
 *      `provider/model` → `["provider","model"]`；裸名 → `["deepseek-official","<model>"]`；
 *      已 `[` 开头 → 原样（幂等，允许运维直接写 JSON 串）。
 * 4. 行为档案（§8f，dsh 0.2.0-rc.1 实测）：initialize protocolVersion=1 兼容、
 *    caps 含 session{close,list,resume} + mcp{http}、authMethods=[]（凭据不在握手期
 *    失败，首个 prompt 才炸）；审批 options 是 optionId 连字形态（allow-once /
 *    reject-once，带 name）；审批 toolCall 只带 toolCallId（title 靠基座 toolMeta
 *    缓存补缺）；反向 RPC id 从 0 起（基座 RT-ID-1 判定序已覆盖撞键）；cancel 最快
 *    （5ms）、resume 记忆无损（响应不带 sessionId，基座按 persisted 兜底）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig } from '@agent-chamber/roundtable-protocol';
import type { Logger } from '../logger';
import { AcpDriver } from './acp-driver';

/**
 * 平台档位 → DSH_PERMISSION_MODE 钉死值（D2，dsh 唯一权限通道）。
 * ⚠️ 语义与平台档位字面**同名不同义**：default 在 dsh 侧是「工作区内放行 + 越界审批」，
 * auto/yolo 侧是「sandbox 无边界 → 零审批」。不要按平台档位字面推断 dsh 行为。
 */
const DSH_PERMISSION_MODE_PIN: Record<PermissionMode, string> = {
  default: 'workspace-write',
  plan: 'read-only',
  auto: 'danger-full-access',
  yolo: 'danger-full-access',
};

/**
 * 裸模型名的默认 provider（D3）：dsh 的 model 必须是 [provider, model] 二段，
 * 裸名包装时补 deepseek-official（本机 dsh 默认 provider）。
 * 硬编码 provider 是脆的（换 provider 需改代码）——这是本批的显式取舍，web 占位提示与
 * dsh.md 均写明格式；确需其他 provider 时用 `provider/model` 两段式显式下发。
 */
const DSH_DEFAULT_PROVIDER = 'deepseek-official';

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
 * seat.assign 的 model 原文 → set_config_option 实际写入值（D3）。
 * - 已 `[` 开头：视为调用方已给 JSON 数组串，trim 后透传（幂等——重复包装不会叠加；
 *   带空白入场时不修剪会把非法值原样下发，dsh 报 unknown model → fail-closed 整座 offline）
 * - 含 `/`：拆成 `provider/model` 两段后包成 JSON 数组串
 * - 裸名：补 DSH_DEFAULT_PROVIDER 后包成 JSON 数组串
 * JSON.stringify 产出的正是 dsh 认识的紧凑形态（无空格），与真机 configOptions 值一致。
 */
function dshModelConfigValue(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith('[')) return trimmed;
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return JSON.stringify([trimmed.slice(0, slash), trimmed.slice(slash + 1)]);
  }
  return JSON.stringify([DSH_DEFAULT_PROVIDER, trimmed]);
}

/** DshAcpDriver 构造选项 */
export interface DshAcpDriverOptions {
  /**
   * 覆盖 dsh CLI 路径（跳过 DSH_BIN env 与 PATH 探测；测试注入假二进制 / 运维钉死
   * 非 PATH 安装位用）。不设则按 bin → DSH_BIN → PATH 探测解析，探测不到 start 失败
   * （R3 同规：不静默兜底）。
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
 * dsh ACP 座位驱动（契约① SeatDriver 的实现；传输基座 AcpDriver + dsh profile）
 */
export class DshAcpDriver extends AcpDriver {
  constructor(options: DshAcpDriverOptions = {}) {
    super({
      profile: {
        vendorName: 'dsh',
        spawnCommand: (config: SeatConfig) => {
          // bin 解析：构造选项 > DSH_BIN env > PATH 探测；探测不到直接失败带引导
          // （R3：不静默兜底，错误信息成为座位 offline 的 detail；版本按 D7 钉死）
          const bin = options.bin ?? process.env.DSH_BIN ?? findOnPath('dsh');
          if (!bin) {
            throw new Error(
              'dsh CLI not found: npm i -g @deepseek-ai/dsh@0.2.0-rc.1 (or set DSH_BIN) first',
            );
          }
          return {
            bin,
            args: options.spawnArgs ?? ['acp'],
            // D2：档位唯一通道——dsh 无 mode 面，权限语义只经 DSH_PERMISSION_MODE 钉死
            env: {
              ...process.env,
              DSH_PERMISSION_MODE: DSH_PERMISSION_MODE_PIN[config.permissionMode],
            },
          };
        },
        // D2：dsh 握手不暴露 mode（configOptions 仅 model + reasoning_effort）→ 不发任何
        // set_config_option 档位钉死；档位全部由上面的 spawn env 承载。保持恒空数组
        modeConfigEntries: () => [],
        // D3：model 值包装（JSON 两段数组串）；基座据此写入 set_config_option
        modelConfigValue: dshModelConfigValue,
      },
      getSessionId: options.getSessionId,
      onSessionId: options.onSessionId,
      logger: options.logger,
      cancelKillTimeoutMs: options.cancelKillTimeoutMs,
    });
  }
}
