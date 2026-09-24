/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务提供方抽象：把"谁来判、判什么、失败怎么表达"与调用点解耦
 *
 * [代码职责]
 *   - `JudgmentProvider` 接口 + `ExperienceCheckInput`（判定输入）/ `JudgmentOutcome`
 *     （判定结果，**判别式联合**：ok 带快照、失败带分类原因与日志载荷）
 *   - DI token `JUDGMENT_PROVIDER`（service 注入点；e2e 用 overrideProvider 换成内存 stub）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §3.2（provider 抽象 + 失败分类）/
 *     §3.5（调用点与写入纪律）
 *
 * [关键不变量]
 *   - **`checkEntry` 永不 throw**：一切失败（transport / HTTP 非 200 / JSON-RPC error /
 *     超时 / 解析失败 / 白名单校验失败）都必须映射成 `status: 'error' | 'timeout'` 的结果
 *     对象，由调用点落日志并**继续主流程**（fail-open，plan §3.5 全景）。
 *     rationale：经验库录入是主业务，判别是 observe 期增强——增强项故障绝不能阻断录入。
 *   - **`JudgmentOutcome` 自带日志载荷**（`request` / `response` / `latencyMs`）：日志是
 *     事实源（训练语料），必须由**真正发包的人**提供，而不是调用点事后猜测重造。
 *   - `enabled: false`（provider=none）⇒ 调用点**短路**：不调用、不写日志、不占额度。
 *
 * [关联代码]
 *   - judgment-rubric.ts — 固定问题集与逐字段白名单归一化（本接口产出的形状定义者）
 *   - typesafe.judgment-provider.ts — 唯一真实现（官方云 REST 客户端，唯一联网点）
 *   - noop.judgment-provider.ts — 关闭态实现（provider=none；调用点据 enabled 短路）
 *   - judgment-provider.factory.ts — 按 config 选择实现（含 dev 缺 key 降级 + 退役值 warn）
 *   - modules/experience/experience-judgment.service.ts — 唯一调用方（额度/落库/快照）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增失败分类必须同时给出 `status` 映射与"不进日志"的敏感信息边界
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type {
  ExperienceIntent,
  ExperienceJudgment,
  ExperienceJudgmentStatus,
} from '@agent-chamber/shared';

/** DI token（service 注入；e2e/fake provider 的替换点） */
export const JUDGMENT_PROVIDER = 'JUDGMENT_PROVIDER';

/**
 * 判定输入（service 组装，provider 只做"截节选 + 发问 + 解析"）。
 *
 * 注意 `content` 是**正文全文**：截成节选（≤2000 字符 + 截断标记）是 provider 的职责
 * ——节选长度属于"发给模型什么"的语义，与日志体积纪律同一处定义，避免两处各自截。
 */
export interface ExperienceCheckInput {
  /** 条目标题 */
  title: string;
  /** 条目摘要 */
  summary: string;
  /** 正文全文（provider 负责截节选） */
  content: string;
  /** 症状信号（归一化后的小写 token） */
  signals: string[];
  /** 领域标签 */
  domains: string[];
  /** 环境指纹（键受控值开放） */
  env: Record<string, string>;
  /** 当前 intent（用于 intentSuggestion 的 keep 判断） */
  intent: ExperienceIntent;
  /** 录入时的疑似重复候选（top-3，供 duplicate 维度判断） */
  duplicateCandidates: { id: string; title: string; quality: string }[];
  /** 当次可用领域词表快照（domainSuggestion 的候选值域**必须**取自它） */
  availableDomains: string[];
}

/** 判定成功的结果（`judgment` 已过逐字段白名单归一化） */
export interface JudgmentOkOutcome {
  status: 'ok';
  /** 归一化后的七维快照 + provider 元数据（provider/model/judgedAt/rubricVersion，可落 entries.judgment） */
  judgment: ExperienceJudgment;
  /** 实际发出的判定输入（`{questions, state}`；日志表事实源） */
  request: Record<string, unknown>;
  /** 未截断的原始输出摘要（归一化结果 + raw） */
  response: Record<string, unknown>;
  /** provider 往返耗时（毫秒） */
  latencyMs: number;
}

/** 判定失败的结果（error / timeout 两类，统一形状） */
export interface JudgmentFailedOutcome {
  status: Exclude<ExperienceJudgmentStatus, 'ok' | 'skipped'>;
  /** 实际发出的判定输入（失败也要留档：语料要能复现"问了什么"） */
  request: Record<string, unknown>;
  /**
   * 失败摘要：`{ error: <分类文案 ≤2000> }`。
   * ⚠️ **绝不含 API Key、绝不含上游错误体原文**（401 的裸 JSON body 只用于内部分类）。
   */
  response: Record<string, unknown>;
  /** provider 往返耗时（毫秒；超时也记实际等待时长） */
  latencyMs: number;
}

/** 判定结果（判别式联合：调用点按 status 分派落库/置 NULL 逻辑） */
export type JudgmentOutcome = JudgmentOkOutcome | JudgmentFailedOutcome;

/**
 * 判别服务提供方接口。
 *
 * 实现方：`TypeSafeJudgmentProvider`（真联网，provider=typesafe）/ `NoopJudgmentProvider`
 * （provider=none）。
 */
export interface JudgmentProvider {
  /** 提供方名（落 `experience_judgments.provider`；与 config 的 provider 值同域） */
  readonly name: string;
  /** 是否可用（false ⇒ 调用点短路：不调用、不写日志、不占额度） */
  readonly enabled: boolean;
  /**
   * 执行一次录入判定。
   *
   * @param input 条目内容 + 当次词表快照（截节选由实现方负责）
   * @returns ok（带快照）或 error/timeout（带分类原因）；**永不 throw**
   */
  checkEntry(input: ExperienceCheckInput): Promise<JudgmentOutcome>;
}
