/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **判别能力内核的契约面**：把"一次判别 = 谁问、问什么、答案怎么验、什么能出境"
 *     收敛成一个显式的、可遍历、可断言的接口——判别从"经验库专属"升格为平台共享能力
 *
 * [代码职责]
 *   - `JudgmentCapability<I, O>`：能力定型接口（三必填：`egressAllow` / `toLogPayload` /
 *     `rubricVersion`——见 [关键不变量]）
 *   - `JudgmentQuestion(s)`：发问题面（score / choice 两型，与上游 REST 的 `questions`
 *     映射同形）
 *   - `JudgmentProvider` / `JudgmentOutcome<O>` / `JudgmentMeta`：传输与结果契约
 *     （判别式联合：ok 带 `value` + `meta`；失败带分类原因与日志载荷）
 *   - DI token `JUDGMENT_PROVIDER`（字符串值不变——e2e `overrideProvider` 的替换点）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域 / 失败标签 /
 *     "启用 = 文本出境"声明）
 *   - 补充: 线上 DocSpace `docs/spec.md` — `JudgmentCapability` 终稿形状
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（内核抽取边界：可抽 =
 *     transport / 纯函数 / 配额三窗口 / redaction 基线；留经验库 = pipeline 编排 / 判权 /
 *     七维 rubric）
 *
 * [关键不变量]
 *   - **三必填不可降级为可选**（plan 批次 2 终稿，security 复核结论）：
 *     · `egressAllow` 必填——"可选 = 默认放行"是不可接受的默认值（出境是单向动作，
 *       一旦发出去没有补救）；返回 false ⇒ 调用点跳过 + 落 `egress_blocked` 标量行。
 *     · `toLogPayload` 必填——缺省实现只能落"发包体原文"，那是把正文/查询词原样入库的
 *       最坏形态；每个能力必须显式声明"这一行日志到底记什么"（经验库 = `return outcome.request`）。
 *     · `rubricVersion` 必填——日志与快照据此分代，缺了就没有纵向可比性。
 *     `judgment.capabilities.ts` 的注册表 + 单测做**运行时遍历断言**（编译期类型 + 运行时
 *     双保险：`as never` / `as any` 的强转能骗过编译器，骗不过遍历）。
 *   - **`name` ≡ operation 值域成员**（锚 `EXPERIENCE_JUDGMENT_OPERATIONS`）：日志表
 *     `experience_judgments.operation` 列就是它——自造名字会写出一列"下游解析不了"的行。
 *   - **本接口不认识"经验库"**：`I`/`O` 由能力自持（经验库 = `ExperienceCheckInput` /
 *     七维快照；搜索重排 = 候选集 / 逐候选档位）。内核**不得**反向依赖任何具体能力的类型。
 *   - **`normalize(raw, input)` 收 input 是刻意的**（不止 `raw`）：逐字段白名单的**值域来源**
 *     常常在输入里（经验库的 `availableDomains` 词表快照就是），只给 `raw` 会让能力被迫
 *     把值域塞进 state 再读回来——那是把校验依据和出境数据搅在一起。
 *   - **`checkEntry` 永不再 throw、也永不抛**：一切失败（transport / HTTP 非 200 / 超时 /
 *     解析失败 / 白名单失败）都映射成 `status: 'error' | 'timeout'` 的**结果对象**，由调用点
 *     落日志并继续主流程（fail-open——判别是 observe 期增强，任何故障都不得阻断主业务）。
 *   - **`enabled: false`（provider=none）⇒ 调用点短路**：不调用、不写日志、不占额度。
 *   - **结果自带日志载荷**（`request` / `response` / `latencyMs`）：日志是事实源，
 *     必须由**真正发包的人**提供；调用点事后重造 = 语料与实际发包体漂移。
 *
 * [关联代码]
 *   - judgment.transport.ts — 唯一传输实现（TypeSafe 官方云 REST；唯一联网点）
 *   - typesafe.judgment-provider.ts — 通用 provider（能力无关；组合传输 + 归一化 + 元数据）
 *   - noop.judgment-provider.ts — 关闭态实现（provider=none）
 *   - judgment-runner.service.ts — 通用编排（闸门 → 调用 → 独立日志行；非事务调用点用）
 *   - judgment.capabilities.ts — 已注册能力清单（遍历断言与启动 INFO 的数据源）
 *   - modules/experience/judgment/judgment-rubric.ts — 经验库能力（`record_check`）实现
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增失败分类必须同时给出 `status` 映射（timeout vs error）与"不进日志"的敏感信息边界
 *   □ 改本接口 = 改所有能力的实现面：同步 `judgment.capabilities.ts`、能力实现与遍历断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  EXPERIENCE_JUDGMENT_OPERATIONS,
  type ExperienceJudgmentOperation,
} from '@agent-chamber/shared';

/**
 * 能力名值域（**单一事实源转发**：锚在 shared 的 `EXPERIENCE_JUDGMENT_OPERATIONS`）。
 *
 * 导出它是为了遍历断言能在运行时也验一遍（编译期类型 + 运行时列表双保险：
 * `as never` 之类的强转能骗过编译器，骗不过遍历）。
 */
export const JUDGMENT_CAPABILITY_NAMES: readonly ExperienceJudgmentOperation[] =
  EXPERIENCE_JUDGMENT_OPERATIONS;

/**
 * 单题（发问题面）。
 *
 * `score` 型 = 有序档位标尺（`criteria` 为档位标签数组，取档靠
 * `legend[argmax(probabilities)]` 反查，**禁止 `round(score)`**）；`choice` 型 = 单选
 * 分类（`criteria` 为 `值 → 说明` 映射）。
 */
export interface JudgmentQuestion {
  /** 题型（与上游 REST 契约同域） */
  type: 'score' | 'choice';
  /** 固定写在代码侧的题面（条目/候选内容**只进 state**，见能力实现的注入面纪律） */
  instructions: string;
  /** 选项：score = 档位标签数组；choice = `值 → 说明` 映射 */
  criteria: readonly string[] | Record<string, string>;
}

/**
 * 问题集（`id → 题`）。
 *
 * 形状 = 上游 REST `questions` 字段本身（**不是数组**）：一问一答按 id 对齐，answers 的键
 * 就是这里的 id——这正是"逐 id 白名单剔除"的实现基础。
 */
export type JudgmentQuestions = Record<string, JudgmentQuestion>;

/**
 * 判别能力定型接口（内核唯一的"能力"概念）。
 *
 * @typeParam I 能力输入（调用点组装：经验库 = 条目内容 + 词表快照；重排 = 查询 + 候选集）
 * @typeParam O 能力输出（归一化产物；经验库 = 七维快照，重排 = 逐候选档位）
 */
export interface JudgmentCapability<I, O> {
  /**
   * 能力名（落日志表 `operation` 列）。
   *
   * 类型锚在 `EXPERIENCE_JUDGMENT_OPERATIONS` 值域上（不是裸 `string`）：能力自造名字在**编译期**
   * 即红，同时让"能力名 → `operation` 列"的写入无需任何强转（见文件头不变量）。
   */
  readonly name: ExperienceJudgmentOperation;
  /** rubric 代际标记（落快照 `rubricVersion`；日志与校准数据据此分代） */
  readonly rubricVersion: string;
  /**
   * 组装问题集。
   *
   * @param input 能力输入
   * @returns `id → 题`（id 即 answers 的键，白名单剔除按它对齐）
   */
  buildQuestions(input: I): JudgmentQuestions;
  /**
   * 组装 `state`（发出去的数据位）。
   *
   * @param input 能力输入
   * @returns state 对象（**出境面 = 本函数的返回值**，启动 INFO 的"出境字段"声明必须与它一致）
   */
  buildState(input: I): Record<string, unknown>;
  /**
   * 逐字段白名单归一化（注入面的收口点）。
   *
   * @param raw 上游返回的**已解析响应体**（完整对象；由能力自行取 `answers` 等字段）
   * @param input 能力输入（值域来源，如词表快照；见文件头不变量）
   * @returns 合法产物；**整体形状破损返回 null**（调用点据此落 error 且不落半真快照）
   */
  normalize(raw: unknown, input: I): O | null;
  /**
   * 能力追加的 redaction 模式（可空数组）。
   *
   * ⚠️ 内核基线（两表并集）**恒跑**且不可被清空——本字段只做**追加**。
   */
  readonly redactionPatterns: readonly RegExp[];
  /**
   * 出境闸门（**必填**，见文件头不变量）。
   *
   * @param input 能力输入
   * @returns false ⇒ 本次**不发包**：调用点跳过 + 落 `egress_blocked` 标量行（不落输入原文）
   */
  egressAllow(input: I): boolean;
  /**
   * 日志载荷（**必填**，见文件头不变量）。
   *
   * @param input 能力输入
   * @param outcome 本次结果（ok 带 `value`/`meta`；失败带分类原因）
   * @returns 落 `experience_judgments.request` 的载荷（**不得落原文**——只落标量与 id；
   *   经验库是既有例外，显式 `return outcome.request` 以保语料不变量）
   */
  toLogPayload(input: I, outcome: JudgmentOutcome<O>): Record<string, unknown>;
}

/**
 * DI token（调用点注入；e2e/fake provider 的替换点）。
 *
 * ⚠️ **字符串值不可改**：e2e/单测按它 `overrideProvider`，改名 = 静默换回真实现
 * （判别会真的联网打计费 API，而测试全绿）。
 */
export const JUDGMENT_PROVIDER = 'JUDGMENT_PROVIDER';

/** 判别结果的**观测元数据**（由传输侧产出，不由能力自造） */
export interface JudgmentMeta {
  /** 适配器名（落日志表 `provider` 列；历史值 `jev` 已退役） */
  provider: string;
  /** 上游**自报**模型标识（⚠️ 请求模型只是请求参数，不得顶替它） */
  model: string;
  /** 本次判定时刻（ISO 8601） */
  judgedAt: string;
  /** rubric 代际 = 能力的 `rubricVersion`（传输侧写入，能力不自产） */
  rubricVersion: string;
}

/**
 * 判定成功的结果（`value` 已过能力的逐字段白名单归一化）。
 *
 * `O` 有缺省（`unknown`）：**兼容垫片与 e2e fake 会写不带类型参数的 `JudgmentOutcome`**
 * （它们只关心 status/latency 这些与能力无关的字段）。
 */
export interface JudgmentOkOutcome<O = unknown> {
  status: 'ok';
  /** 能力归一化产物（经验库 = 七维；重排 = 逐候选档位） */
  value: O;
  /** 观测元数据（provider / model / judgedAt / rubricVersion） */
  meta: JudgmentMeta;
  /** 实际发出的判定输入（`{questions, state}` + 请求模型；日志表事实源） */
  request: Record<string, unknown>;
  /** 未截断的原始输出摘要（归一化结果 + raw） */
  response: Record<string, unknown>;
  /** provider 往返耗时（毫秒） */
  latencyMs: number;
}

/** 判定失败的结果（error / timeout 两类，统一形状） */
export interface JudgmentFailedOutcome {
  status: 'error' | 'timeout';
  /** 实际发出的判定输入（失败也要留档：语料要能复现"问了什么"） */
  request: Record<string, unknown>;
  /**
   * 失败摘要：`{ error: <分类文案 ≤2000 字符> }`。
   * ⚠️ **绝不含 API Key、绝不含上游错误体原文**（401 的裸 JSON body 只用于内部分类）。
   */
  response: Record<string, unknown>;
  /** provider 往返耗时（毫秒；超时也记实际等待时长） */
  latencyMs: number;
}

/** 判定结果（判别式联合：调用点按 status 分派落库/置 NULL 逻辑；`O` 缺省见 `JudgmentOkOutcome`） */
export type JudgmentOutcome<O = unknown> = JudgmentOkOutcome<O> | JudgmentFailedOutcome;

/**
 * 判别提供方接口（实现方：`TypeSafeJudgmentProvider` 真联网 / `NoopJudgmentProvider` 关闭态）。
 *
 * **能力无关**：同一个 provider 实例服务所有能力——能力由调用点作为参数传入，
 * provider 只负责"截节选 + 发问 + 收答 + 归一化 + 补元数据"。
 */
export interface JudgmentProvider {
  /** 提供方名（落 `experience_judgments.provider`；与 config 的 provider 值同域） */
  readonly name: string;
  /** 是否可用（false ⇒ 调用点短路：不调用、不写日志、不占额度） */
  readonly enabled: boolean;
  /**
   * 执行一次判别（**永不 throw**）。
   *
   * @param capability 能力（问题集 / state / 归一化 / 出境闸门 / 日志载荷的提供方）
   * @param input 能力输入
   * @returns ok（带归一化 `value` + 观测 `meta`）或 error/timeout（带分类原因）
   */
  run<I, O>(capability: JudgmentCapability<I, O>, input: I): Promise<JudgmentOutcome<O>>;
}
