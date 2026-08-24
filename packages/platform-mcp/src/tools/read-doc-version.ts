/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Doc Version（doc history MVP，GET /docs/:id/versions/:version）
 *   - 补充: docs/spec.md §DocVersionDetail/DocVersionDiff（shared DTO）
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
import type { DocVersionDetail } from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

/**
 * UUID 格式（与后端 ParseUUIDPipe 同口径：v4 标准格式，大小写不敏感）
 *
 * 铁律 #21 层 1（格式正确性）：docId 在 MCP 层就校验拒绝，
 * 不把格式错误透传到后端（后端也会 400，但工具侧及时报错省一次 HTTP 往返）。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * read_doc_version — 单个文档版本详情（全文快照 + 与前一版 diff，doc history MVP）
 *
 * 包装 GET /docs/:id/versions/:version（读权限与 read_doc 一致）。返回版本元数据 +
 * 该版本全文快照 content + 与前一版本的 diff（读时现算不落库）：
 *   diff.fromVersion = 对比基准版号（剪枝跳号时不是 version-1）；
 *   diff.added / diff.removed = 行级增删计数；diff.unified = hunk 文本（' '/'+'/'-' 前缀行）；
 *   diff = null → 该文档最早一版（无对比基准，与「有前版但内容一致 added=0/removed=0」区分）。
 *
 * **给 LLM 读者的场景指引**：回溯误写——先 list_doc_versions 定位可疑版本区间，
 * 再本工具拉目标版全文 + 与前一版的 unified diff（一眼看出哪几行被改）；需要恢复
 * 旧内容时直接取本响应 content 字段全文。版本/文档不存在 → 404 DOC_NOT_FOUND；
 * version < 1 → 400 VALIDATION_ERROR（格式错误在 MCP 层已拦截，不会触发）。
 */
export const readDocVersionTool: CustomTool = {
  tool: {
    name: 'read_doc_version',
    description:
      'Read a single document version: metadata + FULL content snapshot + line-level diff vs ' +
      'the previous version (wrapper of GET /docs/:id/versions/:version; diff computed on read, not stored). ' +
      'Response: {version, contentHash, authorActorId, source, createdAt, contentSize, content, diff} ' +
      'where diff = {fromVersion, added, removed, unified} (hunk text with " "/"+"-" prefix lines) ' +
      'or null when this is the earliest kept version (earlier-but-identical gives added=0/removed=0, ' +
      'not null). fromVersion is the largest version below the requested one — pruning may skip numbers. ' +
      'USE WHEN: rollback forensics after an unwanted edit — combined with list_doc_versions, fetch ' +
      'the exact content + unified diff to see which lines changed and recover the old content from ' +
      'the content field. Version or doc not found → 404 DOC_NOT_FOUND (same read permission as read_doc).',
    inputSchema: {
      type: 'object',
      properties: {
        docId: {
          type: 'string',
          description: 'Document ID (UUID, required)',
        },
        version: {
          type: 'integer',
          description: 'Version number, positive integer ≥ 1 (required)',
        },
      },
      required: ['docId', 'version'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const docId = args.docId as string | undefined;
    const version = args.version as number | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 格式校验（铁律 #21 层 1）：docId 必须 UUID、version 必须正整数 ≥1，
    // 非法值 MCP 层直接拒绝，不发 HTTP（后端对 version<1 返回 400 code 9000，
    // 此处前置拦截给 Agent 更明确的工具侧错误）
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
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'version must be a positive integer (≥ 1)',
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const detail = await client.request<DocVersionDetail>(
        'GET',
        `/docs/${docId}/versions/${version}`,
      );

      // 全量投影：content（全文快照）+ diff + 元数据原样透传
      // （unified diff 文本留在 diff.unified，Agent 可直接消费）
      return {
        content: [{ type: 'text', text: JSON.stringify(detail) }],
      };
    } catch (err: unknown) {
      // 404 DOC_NOT_FOUND（文档/版本不存在、无权限私密空间）→ 透传 status/code，
      // 禁止包装成 500（铁律 #9）
      return handlePlatformError(err, 'read_doc_version');
    }
  },
};
