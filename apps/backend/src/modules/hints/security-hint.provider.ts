/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **security 族首个 hint provider**（v1.94.0-dev）：把域侧写路径扫描出的领域事实
 *     `security.credential_suspected` 翻译成一条 `sensitive_credential_suspected` 提示，
 *     由拦截器挂进响应 `data.hints[]`（advisory，绝不改变业务结果与状态码）。
 *   - **本 provider 只做纯映射**：零查库、零告警职责——扫描与**告警行**在写路径就地完成
 *     （`credential-scan.ts`），本文件只负责「事实 → 候选」。告警与送达因此各自可单独失效
 *     （送达被 kill switch 关掉时，告警照落；反之亦然）。
 *
 * [代码职责]
 *   - `build(facts)`：逐条事实映射（**不读 payload、不查库、不认识别的 code**）；
 *     `matchedPatterns`（逗号拼接的 patternId 串）→ 模式表 label 数组。
 *   - `resolveMessage` / `familyOf` / `ttlOf`：全部委托 `security-hint.constants.ts` 与
 *     `HintRegistry`（本文件不写任何文案字面量；窗口长度单源 = 注册表）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.6（挂点与判据）/ §5（告警与提示解耦、FP 观测口径）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **永不抛**：每条事实各自 try/catch（失败 warn 后跳过该事实）。抛 = 该挂面永久静默，
 *     也会白白牺牲同响应里后续 provider 的机会（拦截器的双层 catch 是最后防线，不是设计）。
 *   - **禁正文入日志 / 禁正文入 data / 禁正文入 message**：本 provider 只消费**标量**——
 *     `resourceKind` / `resourceId` / `matchedPatterns`（模式 id）。**它连传入的正文都看不到**
 *     （事实袋载荷里没有正文，见 `credential-scan.ts` 的不变量）——这是结构性保证，不靠自觉。
 *   - **非法 patternId 只跳过该条 + 落 debug**（只落 fact 名 + patternId，**禁正文**）：
 *     模式表变更后重放历史事实时，未知 id 不该让整条提示消失（安全方向 = 宁可多报）。
 *     ⚠️ 不可解析的 id 在**文案**里回落为 id 本身（而不是空串）——否则会渲染出「（…）」空括号。
 *   - **`data` 键集封闭**：`{ resourceKind, resourceId, matchedPatterns }` 三键，消费方读这里
 *     而不是解析 message（守卫 spec / e2e 断言键集合）。
 *   - **resourceKey = `{resourceKind}:{resourceId}`**：同一资源 6h 内提示一次（窗口长度显式
 *     声明在注册表）；`task_description:{taskId}` 与 `task_comment:{taskId}` 是**不同键**
 *     ⇒ 同请求两条都可达（本就是两件不同的事：描述里粘了密钥 vs 评论里粘了密钥）。
 *
 * [不覆盖清单]（**扫描面边界**；权威 = 线上 docs/modules/hint-system.md §7）
 *   - **未挂点的写口**：topic / board 的 description 更新、memory 提名 `contentOverride`、
 *     附件与图片等二进制内容；
 *   - **experience 正文**：由经验库自己的 **400 闸门**覆盖（`EXPERIENCE_SECRET_PATTERNS`），
 *     不重复扫；
 *   - **绕过形态**：拆写（分段拼接）、URL 编码、零宽字符等对抗手法**一律不处理**——检测器
 *     是「提醒」不是「闸门」，追求零漏报会牺牲全部精度；
 *   - **正文 > 256K 字符的尾部**（`SENSITIVE_SCAN_MAX_CHARS`；中文约 768KB 字节）：未被扫描——这件事由告警行的
 *     `truncated` 可观测（不是「尾部没有密钥」，是「我们没看完」）。
 *   ⚠️ **「无 hint ≠ 无密钥」**：本能力是 advisory 的提示层，不构成安全保证；真正的兜底是
 *   凭证轮换纪律与最小权限。
 *
 * [关联代码]
 *   - ./security-hint.constants.ts — 码 / 模板 / 产出面 / profile 的**唯一真源**
 *   - ./credential-scan.ts — 事实的产生点（扫描 + 告警；事实载荷形状与它对齐）
 *   - ./hint-registry.ts — `SECURITY_HINT_DEFINITIONS`（6h 显式窗口）
 *   - ../../common/utils/sensitive-patterns.ts — patternId → label 的解析源
 *   - ./hints.module.ts — 模块装配（provide + export；本文件是 **`modules/hints/` 内的
 *     领域语义实现**——放在这里而不是另开模块，是因为它零领域依赖、且需要与 hint 基建同装配）
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（kill switch 键 `security_scan`）
 *   - security-hint.provider.spec.ts — 映射 / 键集封闭 / 非法 id / 不抛 的单测矩阵
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增码 ⇒ `factNames` + `build` 分支 + 本族常量四件套 + 注册表 + 守卫 spec 六处齐步
 *   □ 改 `data` 键集 ⇒ 同步守卫 spec / e2e 的键集合断言与消费方文档
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { findSensitivePattern } from '../../common/utils/sensitive-patterns';
import { makeHintCandidate, type HintCandidate } from './hint-core';
// ⚠️ **值导入**：HintRegistry 是被注入的构造器参数（`import type` 会被 TS 擦除，
// emitDecoratorMetadata 退化成 Object ⇒ 启动期 "can't resolve dependencies"）
import { HintRegistry } from './hint-registry';
import {
  renderSecurityHintMessage,
  SECURITY_HINT,
  SECURITY_HINT_MESSAGES,
  SECURITY_HINT_SURFACE,
} from './security-hint.constants';
import { FACT_SECURITY_CREDENTIAL_SUSPECTED } from './credential-scan';
import type { HintFact } from './hint-facts';
import type { HintFactProvider, HintProviderContext } from './hint.interceptor';

/**
 * 事实载荷里的字符串读取（非字符串 / 空串 → `null`）。
 *
 * 事实袋载荷约定 = 扁平对象 + 标量优先（见 `hint-facts` 的 `HintFact` 注释）；
 * 一切非字符串形态 fail-closed（不抛、不猜）。
 */
function readText(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * security 族 provider（见文件头不变量）。
 *
 * 生命周期 = 进程（Nest 单例，由 `HintsModule` provide / export、
 * `AppModule` 经 provider chain 注入）。
 */
@Injectable()
export class SecurityHintProvider implements HintFactProvider<string> {
  private readonly logger = new Logger(SecurityHintProvider.name);

  /** 本 provider 关注的唯一事实名（与 `credential-scan.ts` 的 emitFact 字面量对齐） */
  readonly factNames: readonly string[] = [FACT_SECURITY_CREDENTIAL_SUSPECTED];

  /** 产出面（进埋点 `surface`；词表见 hint-log，本值是 security 侧新增项） */
  readonly surface = SECURITY_HINT_SURFACE;

  /**
   * **不声明 `priority`**：本族只有一个 code，同响应不存在本族内部的竞争；跨 provider 的
   * 候选序由链序（`HINT_PROVIDER_ENTRIES` 首位）决定——见该清单的注释。
   */
  constructor(private readonly registry: HintRegistry) {}

  /** 文案单源 = `SECURITY_HINT_MESSAGES`（模板经同居 helper 渲染；本文件不写字面量文案） */
  resolveMessage(candidate: HintCandidate<string>): string {
    if (candidate.message) return candidate.message;
    const template = SECURITY_HINT_MESSAGES[candidate.code as never];
    if (template === undefined) return candidate.code;
    return renderSecurityHintMessage(candidate.code as never, candidate.data);
  }

  /** 族归属：security 族统一 `'security'`（与注册表 `family` 字段同值） */
  familyOf(): string | null {
    return 'security';
  }

  /**
   * 去重窗口长度：**单源 = 注册表**（`HintDefinition.ttlMs`；本族 = 6h 显式声明）。
   */
  ttlOf(code: string): number | undefined {
    return this.registry.ttlOf(code);
  }

  /**
   * 事实 → 候选（**纯映射**：零查库、零告警，见文件头不变量）。
   *
   * @param facts 本请求事实袋快照（拦截器在响应封装前取出）
   * @param _payload handler 原始载荷（**本 provider 不读**——提示只依赖事实，与响应形状解耦；
   *   参数保留是为了满足 `HintFactProvider` 契约）
   * @param _ctx 请求身份（**本 provider 不消费**：扫描已经在写路径上用 actor 落了告警，
   *   提示侧不需要权限判定——能写这条资源的人本来就该看到自己粘了什么）
   * @returns 0..N 条候选（无命中 → 空数组，**不是**空占位）
   */
  async build(
    facts: readonly HintFact[],
    _payload?: unknown,
    _ctx?: HintProviderContext,
  ): Promise<readonly HintCandidate[]> {
    const out: HintCandidate[] = [];
    for (const fact of facts) {
      if (fact.name !== FACT_SECURITY_CREDENTIAL_SUSPECTED) continue;
      try {
        const candidate = this.mapFact(fact.payload);
        if (candidate) out.push(candidate);
      } catch (error) {
        // per-fact fail-open：日志只落 fact 名 + 错误摘要（**禁正文**——本 provider 看不到正文）
        this.logger.warn(
          `[SECURITY_HINT_FACT_FAILED] fact=${fact.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return out;
  }

  /**
   * 单条事实 → 候选（载荷畸形 → `null`，不抛）。
   *
   * @param payload `{ resourceKind, resourceId, matchedPatterns }`（**恒三键、扁平标量**，
   *   形状由 `credential-scan.ts` 保证）
   */
  private mapFact(payload: Record<string, unknown> | undefined): HintCandidate | null {
    const resourceKind = readText(payload, 'resourceKind');
    const resourceId = readText(payload, 'resourceId');
    const matchedPatterns = readText(payload, 'matchedPatterns');
    if (!resourceKind || !resourceId || !matchedPatterns) return null;

    const ids = matchedPatterns
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length === 0) return null;

    // patternId → label（未登记 id：debug 一行 + **回落为 id 本身**——理由见文件头不变量）
    const labels = ids.map((id) => {
      const entry = findSensitivePattern(id);
      if (entry) return entry.label;
      this.logger.debug(
        `[SECURITY_HINT_UNKNOWN_PATTERN] fact=${FACT_SECURITY_CREDENTIAL_SUSPECTED} patternId=${id}`,
      );
      return id;
    });

    return makeHintCandidate(
      SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED,
      'suggestion',
      // 去重键带 resourceKind：同 id 的两种资源（描述 vs 评论）是两个不同的提示对象
      `${resourceKind}:${resourceId}`,
      // 信封 data 键集**封闭**（守卫 spec / e2e 断言）：结构化消费只读这里
      { resourceKind, resourceId, matchedPatterns: labels },
      // 模板渲染（同居 helper；缺键 → 空串兜底，不泄 undefined）
      renderSecurityHintMessage(SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED, {
        labels: labels.join(', '),
      }),
    );
  }
}
