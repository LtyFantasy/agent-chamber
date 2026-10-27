/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - task **纪律族 hint 的文案与元数据单源**（阶段三决策 9 + v1.94.0-dev 依赖引导 +
 *     v1.95.0-dev 撞重提示）：
 *     四条码（`task_done_without_report` / `task_dependents_pending` /
 *     `comment_on_done_task` / `task_near_duplicate_suspected`）的**唯一真源**——机器码、
 *     文案、族、优先级序、内核 profile 全部在这里；provider 只做判定与构造。
 *   - 形态 = task 响应的**运行期附挂** hints（TaskDetailDto **不声明** hints 键，形状与
 *     `DocHint` 同构）——与 memory 侧 `MEMORY_NOMINATION_HINT_*` 同款先例。
 *   - `task_dependents_pending` / `task_near_duplicate_suspected` 是**模板插值文案**
 *     （本批起声明的新惯例，见 `hints/hint-template.ts`）：模板常量单源 + 结构性取值由
 *     `data` 注入，渲染安全。
 *
 * [代码职责]
 *   - `TASK_HINT` / `TASK_HINT_CODES` / `TaskHintCode`：机器码（与
 *     `hints/hint-registry.ts` 的 `TASK_HYGIENE_DEFINITIONS` 同源，由
 *     `task-hint.constants.spec.ts` 双向守卫——注册表侧是**字面量内联**，因为它不能
 *     import 领域模块）。
 *   - `TASK_HINT_MESSAGES`：code → 文案（**禁在 provider 手写字面量**）。
 *   - `renderTaskHintMessage`：**与模板同居于本文件**的渲染 helper（薄包装，安全语义
 *     单源 = `hints/hint-template.ts`）——profile 与 provider 都只能经它出文案，
 *     不得各自拼串（拼串 = 模板常量失去单源地位）。
 *   - `TASK_HINT_PRIORITY` / `TASK_HINT_PROFILE`：交给 `hint-emit.emitHints` 的领域侧
 *     配置（内核不认识任何 code）。
 *   - `TASK_HINT_SURFACE`：埋点 `surface` 值（开放词表，见 `hints/hint-log.ts`）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.2（board 纪律族：触发判据 / 触发人群小的刻意性）
 *   - 补充: 线上 docs/api-definition.md §2.7（hints 信封消费契约）
 *
 * [关键不变量]
 *   - **文案只说「发现了什么 + 下一步做什么」**：不承诺结果、不描述内部实现；
 *     结构化信息走 `data`，消费方**不解析 message**（与 docspace `DOC_HINT_MESSAGES` 同款形态纪律）。
 *     ⚠️ `task_done_without_report` 的**改写禁令**（v1.94.0-dev）：禁写本平台内部机制叙述
 *     （如「同事务」「一步调用即回填 X」的因果承诺）——`task.service.ts` 的 `reportResult`
 *     JSDoc 明写它**不做跨步骤事务**，文案承诺事务性会变成事实错误。
 *   - **`report` 豁免是文案的一部分**（decision 9）：`comment_on_done_task` 的文案必须
 *     自带「验收补证请忽略本提示」——触发人群里最大的一类（report_task_result 补证）
 *     只能靠文案化解，不能靠 code 分家。
 *   - **模板文案必须经 `renderTaskHintMessage` 渲染**：模板里的 `{key}` 与 `data` 的键
 *     必须一一对应（缺键 → 空串兜底，不泄 `undefined`/残留 `{`）；守卫 =
 *     `task-hint.constants.spec.ts` 的「占位符齐全 + 空 data 安全」。
 *   - **改码名 = 观测断裂**：code 是稳定标识（日志按 code 聚合）；改名同步
 *     `hints/hint-registry.ts` + 本文件 + 两侧守卫 spec。
 *
 * [关联代码]
 *   - ./task-hygiene-hint.provider.ts — 唯一生产消费者（判定 + 构造候选）
 *   - ./task-title-normalize.ts — 撞重检测器（纯函数：tier1 + 白名单 tier2a）
 *   - ./task.service.ts — 三个事实挂点（`task.created` / `task.status_changed` /
 *     `task.comment_added`）
 *   - ../hints/hint-registry.ts — `TASK_HYGIENE_DEFINITIONS`（元数据登记，字面量内联）
 *   - ../hints/hint-template.ts — 占位符渲染的安全语义单源（本文件的 helper 调它）
 *   - ../hints/hint-emit.ts — `HintEmitProfile`（本文件装配的接口来源）
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（kill switch 键 `task_hygiene`）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 code ⇒ 本文件四件套（码表 / 文案 / 优先级 / profile）+ 注册表 + 守卫 spec 齐步
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { HintCandidate } from '../hints/hint-core';
import type { HintEmitProfile } from '../hints/hint-emit';
import { renderHintTemplate } from '../hints/hint-template';

/**
 * task 纪律族机器码（命名 = 领域前缀 + snake_case；**稳定标识，禁改名**）。
 */
export const TASK_HINT = {
  /** 任务已完工但未附结果证据（评论数 0 ∧ 无未软删关联文档） */
  DONE_WITHOUT_REPORT: 'task_done_without_report',
  /** 任务进入 review/done 但仍有**未完成的下游 blocks 依赖** */
  DEPENDENTS_PENDING: 'task_dependents_pending',
  /** 对**已完工**任务追加评论（可能意味着新增未完成工作；`via='report'` 豁免） */
  COMMENT_ON_DONE_TASK: 'comment_on_done_task',
  /** 新建任务与**同板其他 open 任务**撞题（tier1 归一化等值 ∪ 白名单 tier2a） */
  NEAR_DUPLICATE_SUSPECTED: 'task_near_duplicate_suspected',
} as const;

/** 码值联合（`TASK_HINT` 派生——不手写第二份字面量） */
export type TaskHintCode = (typeof TASK_HINT)[keyof typeof TASK_HINT];

/** 全部码（数组序 = 注册表同源守卫的比较基准） */
export const TASK_HINT_CODES: readonly TaskHintCode[] = Object.values(TASK_HINT);

/** 埋点产出面（开放词表值；注册表 `ownerSurface` 同值） */
export const TASK_HINT_SURFACE = 'task_hygiene';

/**
 * 优先级序（同响应多条候选时的排序）。
 *
 * **同一 `task.status_changed` 事实可能同时产出两条**（`done` 且下游在办 ⇒
 * 完工缺证据 + 依赖引导），故序列不只是形式：它决定这两条在候选池里的先后。
 * （口径与 `hints/hint-registry.ts` 的 `TASK_HYGIENE_DEFINITIONS` 注释对齐——
 * 那里写的是「四条之间的相对顺序由 provider 自己的 priority 数组钉」。）
 *
 * 完工缺证据排在前面：它是「任务已经走完了流程但没留痕」的直接纠正，比「你在已完工
 * 任务上评论」更需要立刻看到；依赖引导居中——它是**下游影响面**提示，比「补交证据」
 * 缓一档，但比「已完工任务上评论」的知悉型提醒更值得先看到。
 *
 * ⚠️ **撞重码（`task_near_duplicate_suspected`）排在首位是「声明性」的，不是排序决策**：
 * 既有排序轴是**紧迫度**，而撞重码只可能出现在 `task.created` 事实的响应里（POST
 * /tasks、POST /tasks/batch），与 status/comment 系三条码**走不同端点、永不共现**
 * ——故它排第几在这张表里实际不生效。写在首位只为让「新建时最该先看到的是撞题提醒」
 * 这个立场在单源常量里可见（守卫 spec 会钉住整条序列）。
 */
export const TASK_HINT_PRIORITY: readonly TaskHintCode[] = [
  TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
  TASK_HINT.DONE_WITHOUT_REPORT,
  TASK_HINT.DEPENDENTS_PENDING,
  TASK_HINT.COMMENT_ON_DONE_TASK,
];

/**
 * `task_dependents_pending` 的模板占位符 → 结构化 `data` 键的**契约表**。
 *
 * 用途 = 守卫 spec 的「占位符齐全」断言（模板里的每个 `{key}` 都必须在这里登记，
 * 且必须在 provider 的 `data` 里被真的填上）；本表**不参与渲染**（渲染只读 data）。
 */
export const TASK_DEPENDENTS_PENDING_PLACEHOLDERS = [
  'toStatus',
  'total',
  'titles',
  'overflow',
] as const;

/**
 * `task_near_duplicate_suspected` 的模板占位符契约表（同 {@link TASK_DEPENDENTS_PENDING_PLACEHOLDERS}
 * 的角色：只给守卫 spec 做「占位符齐全」断言，不参与渲染）。
 *
 * ⚠️ **两个键集是分开的**（architect P2-1，别混）：
 * - **模板占位符**（本表）= `{total}` / `{titles}` / `{overflow}` —— 渲染取值对象；
 * - **信封 `data` 键集** = `{taskId, boardId, matches, totalCount}` —— 结构化消费只读这里。
 *
 * 之所以不是一一对应：`titles` 是**预拼串**（`renderHintTemplate` 对数组只会
 * `String()` 成逗号串，故标题必须在 provider 侧先 join 成「、」），而 `data.matches`
 * 承载的是**逐条结构化命中**（含 id/status/sameBatch/matchedBy）——两者同源不同形。
 */
export const TASK_NEAR_DUPLICATE_PLACEHOLDERS = ['total', 'titles', 'overflow'] as const;

/**
 * code → 文案（**单源**，禁在 provider 里手写）。
 *
 * 四条文案都自带「可忽略」出口——它们是纪律提醒，不是闸门；触发人群刻意的窄化
 * （见 docs/modules/hint-system.md §4.2）不能靠文案恐吓来补偿。
 *
 * `task_dependents_pending` / `task_near_duplicate_suspected` 是**模板**——渲染必须经
 * {@link renderTaskHintMessage}（缺键 → 空串兜底）。
 *
 * 撞重文案的三条纪律（改前必读）：
 * ① **不提「删除」**：assignee 可能是**别人**，写「删掉重复卡」会指向一个调用方多半
 *    无权执行的动作（delete 403）。给出的出路是 `duplicates` 依赖 + 「只保留一张」的
 *    判断权交回人。
 * ② **不写「既有」**：批内互撞时撞的是**同一请求刚建**的卡（`data.matches[].sameBatch`），
 *    说「既有任务」就是事实错误。
 * ③ 文案里的 `{type:'duplicates'}` 是**字面示例**（不是占位符——占位符语法只认
 *    `{` + 标识符 + `}`），渲染时原样保留。
 */
export const TASK_HINT_MESSAGES: Record<TaskHintCode, string> = {
  [TASK_HINT.DONE_WITHOUT_REPORT]:
    '任务已完工但未附结果证据——请用 report_task_result 一步补交（status 变更+结果评论' +
    '一次调用完成；附 commit SHA，纯文档/研究任务附文档指针），让下一位读者知道' +
    '「做完了什么」而不是「状态变了」。若你正打算随后补交结果评论，忽略本提示即可。',
  [TASK_HINT.DEPENDENTS_PENDING]:
    '任务已进入 {toStatus}，仍有 {total} 个未完成下游任务依赖它（blocks 类型）：' +
    '{titles}{overflow}。平台不自动解除依赖、不认定 review=已交付；若依赖已失效，' +
    '可经 task_controller_remove_dependency 解除，下游全貌见 task_controller_find_dependents' +
    '（该工具含已完成与各 type，口径比本提示宽）。若已知悉，忽略本提示即可。',
  [TASK_HINT.COMMENT_ON_DONE_TASK]:
    '本任务已完工——若此评论意味着新增未完成工作，请把任务挪回进行中复活；' +
    '若只是验收补证/复盘留言，忽略本提示即可。',
  [TASK_HINT.NEAR_DUPLICATE_SUSPECTED]:
    '疑似与本板其他 open 任务撞题：{titles}{overflow}（共 {total} 个）。' +
    "若这是同一件事的第二张卡 → task_controller_add_dependency {type: 'duplicates'}" +
    ' 并考虑只保留一张；只是相关而非同一件事 → relates_to；' +
    '确认非重复 → 忽略本提示即可。',
};

/**
 * **与模板同居**的渲染 helper（本批起声明的新惯例；安全语义单源 =
 * `hints/hint-template.ts` 的 {@link renderHintTemplate}）。
 *
 * 为什么必须有它而不是让调用方直接拼串：文案是模板常量单源——拼串会把「文案正文」
 * 复制到 provider / profile 里，两处一旦漂移，同一 code 在不同路径渲染出不同文字；
 * 且缺键拼串会输出字面量 `undefined`（对外污染）。
 *
 * @param code 本族码（未登记的码在类型层不可能传入）
 * @param data 结构化取值（缺省 → 占位符全部落空串）
 * @returns 渲染后的文案（永不抛）
 */
export function renderTaskHintMessage(code: TaskHintCode, data?: Record<string, unknown>): string {
  return renderHintTemplate(TASK_HINT_MESSAGES[code], data);
}

/**
 * task 纪律族给通用内核的**领域侧配置**（与 docspace `DOC_HINT_PROFILE` 同款角色）。
 *
 * `familyOf` 恒 `'board'`：族归属的单源仍是注册表（`TASK_HYGIENE_DEFINITIONS` 的
 * `family: 'board'`），此处只是把它喂给内核——两处同值由守卫 spec 钉。
 */
export const TASK_HINT_PROFILE: HintEmitProfile<TaskHintCode> = {
  priority: TASK_HINT_PRIORITY,
  resolveMessage: (candidate: HintCandidate<TaskHintCode>) =>
    candidate.message ?? renderTaskHintMessage(candidate.code, candidate.data),
  familyOf: () => 'board',
};
