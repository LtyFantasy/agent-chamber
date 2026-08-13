/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 的厂商实现——单飞行/BusyError)
 *   - 补充: docs/roundtable-design.md §8 (kimi ACP 行为档案 8 条: resume 复活/审批/用量/fs caps,
 *           0.34.0 实测——本文件设计输入；M4a 起传输层在 acp-driver.ts 基座，本文件为
 *           profile 薄壳：spawn 命令 + mode 单条钉死)
 *
 * [踩坑索引] ③(message_complete 无 text) ④(resume 失败无降级→楔死) ⑤(fs caps 声明→turn 静默死亡)
 *              ⑥(RT-PERM-1: kind 命名不可信→optionId 直透) ⑦(RT-PERM-2: tool 元数据在 update 本体非 content)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   ④: session/resume 失败（缓存 sessionId 失效）无降级 → 座位启动卡死、turn 楔死。
 *      修复：resume 失败降级 session/new 并落盘新 id + warn。见 memory/2026-08-07.md §6
 *   ③: message_complete 不带 turn 全文 text → chamber 重启清内存 buffer 后回复正文丢失。
 *      修复：driver 累积 message_chunk 全文，complete 携带全文 text。见 memory/2026-08-07.md §6
 *   ⑤: client 声明 fs caps 后 turn 静默死亡（Write 成功但完成路径无响应）→ 一律不声明
 *      fs caps（clientCapabilities 仅 terminal:false）。见 memory/2026-08-07.md §4
 *   ⑥: RT-PERM-1 —— ACP 审批选项的 kind 是厂商自由命名（真机为 allow_once/
 *      allow_always/reject_once），旧代码按猜测的 approve_* 双重映射把 approve 吞成
 *      reject。根治：answerPermission 收 optionId（与 request_permission params 同源），
 *      在挂起选项里精确匹配 String(o.optionId) === optionId，不做 kind 猜测。
 *   ⑦: RT-PERM-2 —— ACP tool_call/tool_response 更新的工具元数据（toolCallId/title/
 *      kind/status/locations/rawInput）挂在 update 本体上，content 是内容块数组（或
 *      缺失）；旧代码取 update.content ?? {} 当 tool 载荷 → chamber 校验丢弃。
 *      根治：tool 透传整个 update 对象（浅拷贝后剥离 sessionUpdate 键），保证永远是对象。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * KimiAcpDriver —— kimi ACP 座位的 SeatDriver 实现（profile 薄壳）
 *
 * M4a 重构：ACP 传输层已整体提取至 acp-driver.ts 基座（AcpDriver），本文件只保留
 * kimi 的厂商差异：
 * - spawn：`kimi acp`（bin 默认 KIMI_BIN 环境变量，缺省 PATH 的 'kimi'；测试注入
 *   假子进程脚本用 spawnArgs 覆盖）；
 * - 权限档位钉死：单条 `mode=permissionMode`（kimi 原语，config.toml yolo 泄漏防护）；
 * - 行为档案 8 条（docs/roundtable-design.md §8，kimi 0.34.0 实测）全部由基座承载，
 *   见 acp-driver.ts 顶部注释。
 */
import type { Logger } from '../logger';
import { AcpDriver, MalformedResponseError } from './acp-driver';
export { MalformedResponseError };

/** KimiAcpDriver 构造选项 */
export interface KimiAcpDriverOptions {
  /** kimi 可执行文件（默认 KIMI_BIN 环境变量，缺省 PATH 的 'kimi'） */
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
 * kimi ACP 座位驱动（契约① SeatDriver 的实现；传输基座 AcpDriver + kimi profile）
 */
export class KimiAcpDriver extends AcpDriver {
  constructor(options: KimiAcpDriverOptions = {}) {
    super({
      profile: {
        vendorName: 'kimi',
        spawnCommand: () => ({
          bin: options.bin ?? process.env.KIMI_BIN ?? 'kimi',
          args: options.spawnArgs ?? ['acp'],
          env: process.env,
        }),
        // kimi 原语：平台档位直接透传（default/plan/auto/yolo 即 kimi 会话 mode）
        modeConfigEntries: (permissionMode) => [{ configId: 'mode', value: permissionMode }],
      },
      getSessionId: options.getSessionId,
      onSessionId: options.onSessionId,
      logger: options.logger,
      cancelKillTimeoutMs: options.cancelKillTimeoutMs,
    });
  }
}
