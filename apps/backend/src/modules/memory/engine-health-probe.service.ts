/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 引擎运行时健康观测的**定时脉搏**（卡 26c43f52）：每 120s 做一次「就绪探测 + 时间窗求值」。
 *     零业务流量的部署里，本文件是"引擎挂了"的唯一证据来源（业务流量判据此时永远不动）。
 *
 * [代码职责]
 *   - `@Cron`（每 2 分钟；表达式在 `MEMORY_HEALTH_PROBE_INTERVAL`）的 `tick()`：
 *     ① 引擎未装配 ⇒ 立刻返回；② 探针开关开 ⇒
 *     `engine.healthCheck()` → `tracker.noteProbeOutcome`；③ **无论开关** ⇒ `tracker.tick()`
 *     （双臂时间窗求值 + 分臂心跳）
 *   - 测试环境**不注册 cron**（`disabled` 范式），探针逻辑由 `tick()` 的直调单测覆盖
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/architecture.md` — memory 小节「引擎运行时健康观测
 *     （双臂状态机 + ready 探针 + 三通道告警 = notify `system_alert` / `ENGINE_HEALTH_VIEW` /
 *     日志 + 单实例假设 + 重启语义）」
 *     ⚠️ **闭环缺口（已知）**：文档由主脑在卡收尾时落线上。
 *   - 补充: `../engine-health-tracker.service.ts` 文件头的「事件转移表」
 *
 * [关键不变量]
 *   - **首行判据是 `this.engine`（token），不是配置**：`MEMORY_CONFIG` 与 `MEMORY_ENGINE`
 *     可以是分叉的（`MEMORY_ENGINE=none` 而 config 仍写着 hument；e2e 甚至 override 成
 *     fake 引擎）。以 token 为准 = "没装配就绝不探测"（未配置引擎结构性零告警）。
 *   - **探针开关只管探测，不管时间窗**：关掉探针 ≠ 关掉告警。否则 `healthProbeEnabled=false`
 *     的部署连"业务连续失败 5 次已告警"的恢复/心跳都发不出去（状态机会卡在 alerted=true）。
 *   - **`ScheduleModule.forRoot()` 全应用只注册一次**（现注册点 = `attachment.module.ts`）：
 *     本模块**不得**再 `forRoot`（重复注册 = 同一个 cron 被调度两次 = 2 倍探测）。
 *   - **单实例假设**：多实例部署时每个实例都会独立探测并独立告警（N 倍探测 + N 条消息，
 *     各自的 `clientRequestId` 不同故不会互相幂等吞掉）。当前部署是单实例；多实例需要
 *     外部去重（卡边界外，见文件头权威文档）。
 *   - **cron 与探针都不得 throw**：`tick()` 里全部 try/catch（cron 抛错会被调度器吞掉并
 *     变成 unhandled rejection，观测面反而瞎了）。
 *   - **测试环境默认不注册**（`MEMORY_HEALTH_PROBE_CRON_ENABLED`）：e2e 是长驻进程，
 *     120s 的定时器会在用例中途探测（还打真 Hub/替身）——不确定性 > 覆盖面。
 *     逃生口：`MEMORY_HEALTH_PROBE_ENABLED=true`（仅测试环境用它把 cron 打开）。
 *
 * [关联代码]
 *   - ../engine-health-tracker.service.ts — `noteProbeOutcome` / `tick`（状态机与投递）
 *   - ../engines/memory-engine.interface.ts — `healthCheck()` 的契约（免鉴权、never-throw）
 *   - ../engines/hument.engine.ts — 真实现（5s 短超时 + ready 合同校验）
 *   - ../engine-health-probe.service.spec.ts — 直调 `tick()` 的单测（本文件的主要验证入口）
 *
 * [持久踩坑]
 *   MEMORY-CRON-DOUBLE-REGISTER(重复 forRoot): 在 memory.module 再写一次
 *     `ScheduleModule.forRoot()` ⇒ 探针每分钟跑两次、告警计数翻倍（而单测看不出）。
 *     安全方向: cron 注册只挂在 AttachmentModule（既有先例），本文件只加 @Cron 方法。
 *
 * [修改检查]
 *   □ 已读 [权威文档] 与 tracker 的「事件转移表」
 *   □ 改 cron 周期必须同步更新阈值注释（探针阈值 3 × 120s ≈ 6 分钟）与文档
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MEMORY_CONFIG, type MemoryConfig } from '../../config/memory.config';
import { EngineHealthTracker } from './engine-health-tracker.service';
import { MEMORY_ENGINE, type MemoryEngine } from './engines/memory-engine.interface';

/** 测试环境判定（与 `attachment.constants.ts` / `memory.controller.ts` 同口径） */
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/**
 * cron 是否注册（**测试环境默认不注册**；见文件头不变量）。
 *
 * ⚠️ 这是**注册期**开关（装饰器参数），与运行期探针开关（`MemoryConfig.healthProbeEnabled`）
 * 是两件事：前者决定"这个进程有没有定时器"，后者决定"每次定时该不该真的打引擎"。
 */
export const MEMORY_HEALTH_PROBE_CRON_ENABLED =
  !isTestEnv || process.env.MEMORY_HEALTH_PROBE_ENABLED === 'true';

/** 探针周期（每 2 分钟；与 tracker 的 `MEMORY_PROBE_FAILURE_THRESHOLD` 共同给出 ≈6 分钟首告警） */
const MEMORY_HEALTH_PROBE_INTERVAL = '*/2 * * * *';

/**
 * 引擎健康探针（app-scoped 单例；见文件头）。
 *
 * 只依赖两个 token：`MEMORY_ENGINE`（观测层包装；null = 引擎未装配）与 `MEMORY_CONFIG`
 * （探针开关）。**不注入裸引擎**——探针必须与业务调用看同一个引擎实例（同一 `name`、
 * 同一失败分类学）。
 */
@Injectable()
export class EngineHealthProbeService {
  private readonly logger = new Logger(EngineHealthProbeService.name);

  constructor(
    /** 观测层引擎（`MEMORY_ENGINE`；**可能为 null** = 未配置引擎） */
    @Inject(MEMORY_ENGINE) private readonly engine: MemoryEngine | null,
    /** 健康状态机（探针结果与时间窗的唯一消费方） */
    private readonly tracker: EngineHealthTracker,
    /** 只读配置（探针开关；`@Inject(MEMORY_CONFIG)` 而非 ConfigService——e2e override 才生效） */
    @Inject(MEMORY_CONFIG) private readonly config: MemoryConfig,
  ) {}

  /**
   * 每 120s 一次：就绪探测（开关开时）+ 双臂时间窗求值（**总是**）。
   *
   * 三段顺序不可换：先短路（未装配引擎 = 零探测零告警的**结构保证**），再探测，
   * 最后求值——时间窗求值要用到本轮探测的结果。
   */
  @Cron(MEMORY_HEALTH_PROBE_INTERVAL, {
    name: 'memoryEngineHealthProbe',
    disabled: !MEMORY_HEALTH_PROBE_CRON_ENABLED,
  })
  async tick(): Promise<void> {
    // ① 首行短路：**以 token 为准**（config 与 token 可分叉，见文件头不变量）
    if (!this.engine) return;

    try {
      // ② 探针（开关开才打引擎）
      if (this.config.healthProbeEnabled) {
        const result = await this.engine.healthCheck();
        this.tracker.noteProbeOutcome(result);
      }

      // ③ 时间窗求值 + 心跳（**无论探针开关**：关掉探针不等于关掉告警）
      this.tracker.tick();
    } catch (err: unknown) {
      // cron 里抛错 = unhandled rejection / 被调度器吞掉（观测面反而瞎了）——只记日志
      this.logger.error(
        `memory engine health probe failed (ignored): ${
          err instanceof Error ? err.name : typeof err
        }`,
      );
    }
  }
}
