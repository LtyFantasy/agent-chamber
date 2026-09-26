/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 已注册判别能力的**清单单一事实源**：遍历断言与"声明 ↔ 实现"一致性检查的数据源
 *
 * [代码职责]
 *   - 导出 `JUDGMENT_CAPABILITY_REGISTRY`（能力对象数组）与按名查找的辅助函数
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/spec.md` — `JudgmentCapability` 终稿形状
 *   - 线上 DocSpace `docs/experience-base.md` — 判别服务章（能力清单与出境字段）
 *
 * [关键不变量]
 *   - **新增能力必须在此登记**：注册表是"平台上有哪些判别能力"的唯一清单——漏登记的症状是
 *     能力悄悄可用而没人做过遍历断言（三必填缺失、名字不在 operation 值域都可能溜过去）。
 *   - **本文件只做装配、不含逻辑**：它可以 import 各能力的实现文件（那些是叶子模块，不反向
 *     import 本文件），但**不得** import 任何 Nest 模块——否则内核 → 能力的依赖会变成
 *     内核模块 → 业务模块的环。
 *   - **声明表与注册表必须对齐**（每个注册能力都要有一条 `JUDGMENT_CAPABILITY_DECLARATIONS`
 *     声明，出境字段与触发者写在声明表里）：启动 INFO、`.env.example`、生产 fail-fast 三处
 *     都读声明表，漏一条 ⇒ 该能力的出境行为对用户不可见。单测钉住这条一致性。
 *
 * [关联代码]
 *   - judgment-capability.interface.ts — 被登记对象实现的契约
 *   - ../../config/judgment.config.ts — 声明表（出境字段 / 触发者）与管辖面
 *   - ../experience/judgment/judgment-rubric.ts — 经验库能力（`record_check`）
 *   - ./judgment.module.ts — 内核模块（不 import 本文件；本文件仅供断言与诊断消费）
 *
 * [修改检查]
 *   □ 新增能力：在 `JUDGMENT_CAPABILITY_DECLARATIONS` 补声明 + 在此登记 + 补 `.env.example`
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { JudgmentCapability } from './judgment-capability.interface';
import { experienceRecordCheckCapability } from '../experience/judgment/judgment-rubric';
import { docSearchRerankCapability } from '../docspace/rerank/doc-search-rerank';

/**
 * 已注册判别能力（顺序 = 文档与诊断呈现顺序）。
 *
 * 类型用 `JudgmentCapability<never, unknown>` 的宽化视图：注册表要能同时容纳不同输入/输出
 * 类型的能力，而"调用它"只发生在调用点（那里有精确类型）——注册表只用于**遍历与断言**。
 */
export const JUDGMENT_CAPABILITY_REGISTRY: readonly JudgmentCapability<
  never,
  unknown
>[] = [
  experienceRecordCheckCapability as JudgmentCapability<never, unknown>,
  // 文档搜索重排（v1.85.0 批次 3）：登记后才能被"三必填遍历断言"覆盖
  docSearchRerankCapability as JudgmentCapability<never, unknown>,
];

/**
 * 按名查找已注册能力（未注册 → undefined）。
 *
 * @param name 能力名（≡ operation 值域成员）
 * @returns 能力对象或 undefined
 */
export function findJudgmentCapability(
  name: string,
): JudgmentCapability<never, unknown> | undefined {
  return JUDGMENT_CAPABILITY_REGISTRY.find((capability) => capability.name === name);
}
