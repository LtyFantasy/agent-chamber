/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `filterCustomTools`：profile.excludeCustomTools 的唯一执行点
 *
 * [关键不变量]
 *   - 精确名匹配（不做正则/前缀）：`delete_doc` 与 `delete_doc_route` 必须能分别排除
 *   - 未知名 → 抛错（配置事故 fail fast），不做静默忽略
 * =============================================================================
 */

import { filterCustomTools } from './custom-tool-filter';
import type { CustomTool } from '../types';

/**
 * 构造最小可用的 custom tool（仅 name 参与过滤逻辑）
 *
 * @param name - 工具名
 * @returns 形状合法的 CustomTool
 */
function makeTool(name: string): CustomTool {
  return {
    tool: {
      name,
      description: `${name} stub`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

describe('filterCustomTools', () => {
  const tools = [makeTool('delete_doc'), makeTool('delete_doc_route'), makeTool('read_doc')];

  it('未配置排除表时原样返回', () => {
    expect(filterCustomTools(tools)).toBe(tools);
    expect(filterCustomTools(tools, [])).toBe(tools);
  });

  it('按精确名排除，保留其余顺序', () => {
    const result = filterCustomTools(tools, ['delete_doc']);

    expect(result.map((ct) => ct.tool.name)).toEqual(['delete_doc_route', 'read_doc']);
  });

  it('同前缀工具不会被误伤（精确匹配而非正则/前缀）', () => {
    const result = filterCustomTools(tools, ['delete_doc']);

    // `delete_doc_route` 仍存在：正则 `^delete_doc$` 与 includes 都不会命中它
    expect(result.map((ct) => ct.tool.name)).toContain('delete_doc_route');
  });

  it('排除表引用未知工具名 → 抛错（含未知名与可用名）', () => {
    expect(() => filterCustomTools(tools, ['delete_doc', 'no_such_tool'])).toThrow(
      /unknown custom tool\(s\): no_such_tool.*Available custom tools:/s,
    );
  });

  it('未知名字校验先于过滤：失败时不返回部分结果', () => {
    let returned: unknown;
    try {
      returned = filterCustomTools(tools, ['delete_doc', 'no_such_tool']);
    } catch {
      // 预期路径
    }
    expect(returned).toBeUndefined();
  });
});
