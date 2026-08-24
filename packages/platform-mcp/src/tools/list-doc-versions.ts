/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Doc Version（doc history MVP，GET /docs/:id/versions）
 *   - 补充: docs/spec.md §DocVersionSummary/DocVersionDetail/DocVersionDiff（shared DTO）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #21(双层校验：格式错误在 MCP 层拦截)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import type { DocVersionSummary } from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

/**
 * UUID 格式（与后端 ParseUUIDPipe 同口径：v4 标准格式，大小写不敏感）
 *
 * 铁律 #21 层 1（格式正确性）：docId 在 MCP 层就校验拒绝，
 * 不把格式错误透传到后端——后端也会 400，但工具侧及时报错
 * 省一次 HTTP 往返且错误信息对 Agent 更友好。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * list_doc_versions — 文档版本历史（元数据清单，doc history MVP）
 *
 * 包装 GET /docs/:id/versions（读权限与 read_doc 一致：无权限的私密空间 404
 * DOC_NOT_FOUND，透传不包装）。返回版本元数据数组，version DESC（最新在前）：
 * version / contentHash / authorActorId / source（upsert|patch|import）/
 * createdAt / contentSize（字节数，评估拉取成本）。
 *
 * **给 LLM 读者的场景指引**：查「这篇文档被改过几次、谁改的、什么时候、多大」——
 * 定位可疑误写发生在哪个版本区间 → 再用 read_doc_version 拉该版全文+diff 回溯内容。
 * 版本号单调递增（剪枝跳号不回填）；source 可区分 upsert（full 回写）/patch（局部写）/
 * import（批量导入通道），判断误写入口。
 */
export const listDocVersionsTool: CustomTool = {
  tool: {
    name: 'list_doc_versions',
    description:
      'List the version history of a document as metadata only (wrapper of GET /docs/:id/versions). ' +
      'Returns newest-first version metadata array: version / contentHash / authorActorId / ' +
      'source ("upsert"|"patch"|"import") / createdAt / contentSize (bytes, gauges fetching cost) — ' +
      'NO content body. Version numbers are monotonically increasing, never reset after pruning. ' +
      'Same read permission as read_doc: private space without access → 404 DOC_NOT_FOUND. ' +
      'USE WHEN: checking how many times / by whom / when a doc was modified, or locating which ' +
      'version range an unwanted edit landed in — then read_doc_version to fetch full content + diff ' +
      'for rollback forensics.',
    inputSchema: {
      type: 'object',
      properties: {
        docId: {
          type: 'string',
          description: 'Document ID (UUID, required)',
        },
      },
      required: ['docId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const docId = args.docId as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 格式校验（铁律 #21 层 1）：docId 必须 UUID，非法值 MCP 层直接拒绝，不发 HTTP
    if (docId === undefined || !UUID_PATTERN.test(docId)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'docId must be a valid UUID (e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6)',
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const versions = await client.request<DocVersionSummary[]>('GET', `/docs/${docId}/versions`);

      // 投影：docId 回显（Agent 无需从调用参数反查）+ 版本数组原样透传
      return {
        content: [{ type: 'text', text: JSON.stringify({ docId, versions }) }],
      };
    } catch (err: unknown) {
      // 404 DOC_NOT_FOUND（文档不存在/无权限私密空间）→ 透传 status/code，
      // 禁止包装成 500（铁律 #9）
      return handlePlatformError(err, 'list_doc_versions');
    }
  },
};
