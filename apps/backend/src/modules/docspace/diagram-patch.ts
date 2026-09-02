/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：patch_diagram 的 JSON patch 语义层
 *     （RFC 6901 pointer 解析 + RFC 6902 子集 replace/add/remove，原子应用）
 *
 * [代码职责]
 *   - 本文件 = 纯函数模块（无 NestJS/ORM 依赖，照 markdown-chunker 可独立单测先例）：
 *     pointer 解析、深拷贝原子应用、失败携带 pointer+reason 的 DiagramPatchError
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— patch_diagram 契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §0 D8（patch 语义拍板）§2.3（错误码）
 *
 * [关键不变量]
 *   - 原子性：任一 op 失败 → 抛错，输入对象零变更（深拷贝上应用，成功才返回新对象）
 *   - 根路径（'' 或 '/'）恒拒绝——整文档替换走 upsert_diagram，不走 patch
 *   - replace/add 必须携带 value（undefined = 缺失；显式 null 是合法值）
 *   - 数组下标 0-based；add 允许 index == length（追加）与 '-' 尾段（RFC 6902 追加语义）
 *
 * [关联代码]
 *   - diagram.service.ts — 调用方（DiagramPatchError → 422 DIAGRAM_PATCH_FAILED 映射）
 *   - diagram-patch.spec.ts — 纯函数全边界单测
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import type { DiagramPatchOp } from '@agent-chamber/shared';

/**
 * patch 应用失败（纯错误类型，不带 HTTP 语义——由 DiagramService 映射为
 * 422 DIAGRAM_PATCH_FAILED + data {pointer, reason, supportedOps}）。
 */
export class DiagramPatchError extends Error {
  constructor(
    /** 失败的 RFC 6901 指针原文（修复定位锚） */
    public readonly pointer: string,
    /** 人类可读失败原因（指针不存在/类型不符/根操作等） */
    public readonly reason: string,
  ) {
    super(`JSON patch failed at '${pointer}': ${reason}`);
    this.name = 'DiagramPatchError';
  }
}

/**
 * 解析 RFC 6901 JSON pointer 为段数组。
 * ''（空串 = 整文档根）与越界写法在此不拒绝——根操作在 apply 层统一拒绝（语义错误，
 * 不是解析错误）；本函数只管 '~0'→'~'、'~1'→'/' 转义与 '/' 前缀形态。
 */
export function parseJsonPointer(pointer: string): string[] {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new DiagramPatchError(
      String(pointer),
      `invalid JSON pointer: must be a string starting with '/' (RFC 6901)`,
    );
  }
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * 深拷贝（结构化克隆语义）。IR 为纯 JSON（校验门保证），JSON round-trip 即可——
 * 不引第三方 clone 依赖。undefined 值在 JSON 语义下会被丢弃：IR 是 JSON.parse 产物，
 * 不含 undefined/function，安全。
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 数组下标段解析：'-' 仅 add 合法（追加）；其余必须是非负整数字面量 */
function resolveArrayIndex(seg: string, length: number, op: string, pointer: string): number {
  if (seg === '-') {
    if (op === 'add') return length;
    throw new DiagramPatchError(pointer, `'-' array append marker is only valid for op 'add'`);
  }
  if (!/^\d+$/.test(seg)) {
    throw new DiagramPatchError(
      pointer,
      `array index must be a non-negative integer, got '${seg}'`,
    );
  }
  const index = Number(seg);
  // replace/remove 必须命中既有元素；add 允许 == length（尾插）
  const upper = op === 'add' ? length : length - 1;
  if (index > upper) {
    throw new DiagramPatchError(
      pointer,
      `array index ${index} out of bounds (length ${length}, op '${op}' allows 0..${upper})`,
    );
  }
  return index;
}

/**
 * 原子应用 RFC 6902 子集（replace/add/remove）到 IR 对象。
 *
 * 在输入的深拷贝上顺序应用全部 op；任一失败抛 DiagramPatchError，输入对象零变更
 * （全或无）。返回新对象（调用方拿去 canonicalize 后入 upsert 管线）。
 *
 * 拒绝面（全部带 pointer+reason）：
 * - 根路径（'' 解析为 []）——整文档替换语义属于 upsert_diagram；
 * - replace/remove 目标不存在；add 的父容器不存在；
 * - 路径穿越非容器（string/number 等标量）；
 * - replace/add 缺 value（undefined）。
 */
export function applyDiagramPatch(ir: unknown, patches: DiagramPatchOp[]): unknown {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    throw new DiagramPatchError('/', 'base IR must be a JSON object');
  }
  const root = deepClone(ir);

  for (const patch of patches) {
    const segments = parseJsonPointer(patch.path);
    if (segments.length === 0) {
      throw new DiagramPatchError(
        patch.path,
        `root-level operations are not allowed; replace the whole document via upsert_diagram instead`,
      );
    }
    if ((patch.op === 'replace' || patch.op === 'add') && patch.value === undefined) {
      throw new DiagramPatchError(patch.path, `op '${patch.op}' requires a 'value' field`);
    }

    // 逐段下行到父容器（最后一段由 op 语义处理）
    let container: Record<string, unknown> | unknown[] = root as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (Array.isArray(container)) {
        const index = resolveArrayIndex(seg, container.length, 'replace', patch.path);
        const next = container[index];
        if (!next || typeof next !== 'object') {
          throw new DiagramPatchError(
            patch.path,
            `path segment '${seg}' does not address a container`,
          );
        }
        container = next as Record<string, unknown> | unknown[];
      } else {
        const next = container[seg];
        if (next === undefined) {
          throw new DiagramPatchError(patch.path, `path segment '${seg}' does not exist`);
        }
        if (!next || typeof next !== 'object') {
          throw new DiagramPatchError(
            patch.path,
            `path segment '${seg}' is a scalar, cannot descend further`,
          );
        }
        container = next as Record<string, unknown> | unknown[];
      }
    }

    const last = segments[segments.length - 1];
    if (Array.isArray(container)) {
      const index = resolveArrayIndex(last, container.length, patch.op, patch.path);
      if (patch.op === 'remove') {
        container.splice(index, 1);
      } else if (patch.op === 'add') {
        container.splice(index, 0, patch.value);
      } else {
        container[index] = patch.value;
      }
    } else {
      // 对象容器：replace/remove 要求键已存在；add 允许新键（RFC 6902：对象 add = upsert 语义）
      const exists = Object.prototype.hasOwnProperty.call(container, last);
      if ((patch.op === 'replace' || patch.op === 'remove') && !exists) {
        throw new DiagramPatchError(
          patch.path,
          `target key '${last}' does not exist (op '${patch.op}' requires an existing target)`,
        );
      }
      if (patch.op === 'remove') {
        delete container[last];
      } else {
        container[last] = patch.value;
      }
    }
  }

  return root;
}
