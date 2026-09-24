/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务的**关闭态实现**（`provider=none`：config 未启用 / dev 缺 key 降级）
 *
 * [代码职责]
 *   - 提供 `JudgmentProvider` 的 noop 实现：`enabled=false` 让调用点短路，`checkEntry` 仅作
 *     契约兜底（理论不可达时返回 error 结果而**不是抛错**）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域 = `none|typesafe`）
 *   - 补充: .kimi/plans/plan-experience-base-p2.md §3.2（provider 抽象 + 失败分类）
 *
 * [关键不变量]
 *   - **`name` 恒为 `'none'`**：它与 config 的 provider 值域同域（`experience_judgments.provider`
 *     列语义）——不要改成别的字面量。
 *   - **`enabled=false` 与"被限流跳过"是两种状态**：前者是**短路**（不调用、不写日志、不占额度），
 *     后者写 `skipped` 占位行**且计额度**；调用点靠 `enabled` 区分，不得混用。
 *   - **`checkEntry` 永不 throw**（全 provider 统一契约）：理论不可达（调用点先看 `enabled`），
 *     真被误调时返回 `status='error'` 结果对象。
 *
 * [关联代码]
 *   - judgment-provider.interface.ts — 接口与 `JudgmentOutcome` 契约
 *   - judgment-provider.factory.ts — 本类的唯一装配点（`none` / 缺 key 降级均落到这里）
 *   - typesafe.judgment-provider.ts — 唯一真联网实现（`provider=typesafe`）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改动本类语义（name / enabled）必须同步工厂分派与两份 spec 的矩阵用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { JudgmentOutcome, JudgmentProvider } from './judgment-provider.interface';

/**
 * provider=none 的实现（config 未启用 / dev 缺 key 降级）。
 *
 * `enabled: false` ⇒ 调用点**短路**：不调用、不写日志、不占额度——这与"被限流跳过"
 * （写 skipped 占位行且计额度）是两种不同状态，必须靠 enabled 区分，不能混。
 */
export class NoopJudgmentProvider implements JudgmentProvider {
  readonly name = 'none';
  readonly enabled = false;

  async checkEntry(): Promise<JudgmentOutcome> {
    // 理论不可达（调用点先看 enabled）；返回 error 而非抛，保持"永不 throw"契约
    return {
      status: 'error',
      request: {},
      response: { error: 'judgment provider is disabled (provider=none)' },
      latencyMs: 0,
    };
  }
}
