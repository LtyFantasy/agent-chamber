/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：docType='diagram' 的图文档（content = 规范化 IR JSON
 *     文本），渲染产物 HTML 快照 + render_meta 落 docs 表三列
 *
 * [代码职责]
 *   - 本文件 = diagram 领域的共享类型/常量契约：5 图类型、patch 操作、渲染元数据、
 *     REST 响应形状（backend / platform-mcp / web 三端共用）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— REST/错误码契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §2（validator/门规则）§4（API 面）
 *
 * [关键不变量]
 *   - docType='diagram' ⟺ docs.diagram_type/rendered_html 非空（铁律 #18 断言点）
 *   - render_meta.composition 取自 checker 输出的 composition.summary 子对象
 *     （errors/warnings 在 summary 下，顶层没有——取错层级会让 showcase 门静默失灵）
 *   - DIAGRAM_TYPES 顺序即文档/工具描述中的选型路由顺序，只增不改
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/diagram-renderer.service.ts — 渲染门（spawn vendor CLI）
 *   - apps/backend/src/modules/docspace/diagram-patch.ts — RFC 6901/6902 子集纯函数
 *   - apps/backend/src/modules/docspace/doc.service.ts upsertCore — diagram 写分支（唯一门位）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

// 引用 UpsertDocResult（同包 docspace-response.dto.ts；UpsertDiagramResult extends 需要）
import type { UpsertDocResult } from './docspace-response.dto';

/**
 * 支持的 5 种图类型（vendored archify 渲染器一一对应：
 * packages/diagram/renderers/<type>/render-<type>.mjs）
 */
export const DIAGRAM_TYPES = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
] as const;

/** 图类型联合（'architecture' | 'workflow' | 'sequence' | 'dataflow' | 'lifecycle'） */
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

/**
 * diagram 文档的 docType 值（开放字符串词表中的保留词，不枚举化、不动 DB——
 * docs.doc_type 是用户自定义开放字符串，见 doc.entity.ts docType 注释）
 */
export const DOC_TYPE_DIAGRAM = 'diagram';

/** patch_diagram 支持的 RFC 6902 子集操作（原子应用，全或无） */
export const DIAGRAM_PATCH_OPS = ['replace', 'add', 'remove'] as const;

/** patch 操作类型联合 */
export type DiagramPatchOpKind = (typeof DIAGRAM_PATCH_OPS)[number];

/**
 * 单条 JSON patch 操作（RFC 6901 pointer + RFC 6902 子集）。
 * - path：RFC 6901 指针（'/components/2/label'；'~0'→'~'、'~1'→'/' 转义；
 *   数组下标 0-based，add 允许 '−' 追加语义的 '-' 尾段）；根路径 '' / '/' 拒绝。
 * - value：replace/add 必填（remove 忽略）。
 */
export interface DiagramPatchOp {
  op: DiagramPatchOpKind;
  path: string;
  value?: unknown;
}

/**
 * 渲染元数据（docs.render_meta jsonb 落库形状，~1KB 紧凑）。
 * composition 取 checker stdout JSON 的 composition.summary 子对象（plan §2.2 R2 钉死）。
 */
export interface DiagramRenderMeta {
  /** 渲染引擎标识（恒 'archify'，vendored 引擎） */
  engine: 'archify';
  /** vendored 渲染器版本（上游 archify 版本，同步 NOTICE） */
  rendererVersion: string;
  /** 服务端注入后的生效 quality_profile（缺省/非法 → 'standard'，plan §2.2 R4） */
  qualityProfile: string;
  /** artifact checker 逐条检查结果 */
  checks: { name: string; ok: boolean }[];
  /** 组合质量摘要（checker composition.summary：errors/warnings 计数，profile 感知归类） */
  composition: { errors: number; warnings: number };
  /** 渲染完成时刻 ISO 8601（服务端时钟） */
  renderedAt: string;
  /** HTML 快照字节数（utf8） */
  htmlBytes: number;
  /** HTML 快照 SHA-256 hex（确定性编译产物的内容指纹） */
  htmlSha256: string;
}

/** 写响应中携带的渲染信息（upsert_diagram / patch_diagram 响应的 render 槽） */
export interface DiagramWriteRenderInfo {
  renderedAt: string;
  rendererVersion: string;
  qualityProfile: string;
  htmlBytes: number;
  htmlSha256: string;
  composition: { errors: number; warnings: number };
}

/** GET /docs/:id/diagram 响应形状（read_diagram MCP 工具同形） */
export interface DiagramDetail {
  docId: string;
  path: string;
  title: string;
  summary?: string | null;
  tags?: string[];
  docType: string | null;
  /** 图类型（反正范化列直读） */
  diagramType: string | null;
  /** 解析后的 IR 对象（非字符串——Agent 直接消费结构；patch 指针下标以此为准） */
  ir: Record<string, unknown>;
  /** 乐观锁 token（patch/upsert 的 expectedContentHash 一律用本值，禁止自算） */
  contentHash?: string | null;
  /** 渲染信息（无 checks 明细——详情级摘要；checks 在 validate_diagram 响应给出） */
  render: DiagramWriteRenderInfo;
  updatedAt: Date;
}

/** upsert_diagram / patch_diagram 写响应（通用 upsert 结果 + 图专有字段） */
export interface UpsertDiagramResult extends UpsertDocResult {
  /** 图类型（新建/更新/unchanged 均携带；非 diagram 不可能出现） */
  diagramType?: string | null;
  /** 渲染信息：重渲染时 = 本次渲染产物元数据；unchanged 早退 = 库存快照元数据 */
  render?: DiagramWriteRenderInfo;
  /** patch_diagram 专有：本次应用的 patch 条数 */
  appliedPatches?: number;
}

/**
 * validate_diagram dry-run 响应（零写入零事件）。
 * ok=false 时 stage 指示失败阶段，diagnostics 携带修复凭据
 * （schema/geometry 阶段按 supportedFixes 修；composition 阶段按 checks[].details 散文指引修）。
 */
export interface DiagramValidationResult {
  ok: boolean;
  /** 失败阶段：'parse' | 'schema' | 'render' | 'composition'（ok=true 时省略） */
  stage?: string;
  /** 结构化诊断（renderer JSON receipt 透传 / 平台前置拒绝合成） */
  diagnostics: DiagramDiagnostic[];
  /** artifact checker 逐条检查（含 details 散文指引） */
  checks: { name: string; ok: boolean; details?: string[] }[];
  /** 组合质量摘要 */
  composition: { errors: number; warnings: number };
  /** 生效 quality_profile（注入后值） */
  profile: string;
}

/**
 * 单条结构化诊断（vendored renderer JSON receipt 的诊断形状，
 * 见 packages/diagram/renderers/shared/validator.mjs / diagnostics.mjs）
 */
export interface DiagramDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  subject?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  supportedFixes?: string[];
}
