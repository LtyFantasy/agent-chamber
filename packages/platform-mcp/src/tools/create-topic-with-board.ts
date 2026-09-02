/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ④
 *   - 补充: 看板任务 fdc1851b（Batch F：紧凑序列化）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
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
import { PlatformApiClient, PlatformApiError } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import { TaskStatus, Visibility } from '@agent-chamber/shared';

/** 默认看板列（当 lists 参数未提供时） */
const DEFAULT_LISTS = [{ name: 'backlog' }, { name: 'in_progress' }, { name: 'done' }];

/**
 * create_topic_with_board — 一站式立项
 *
 * 创建话题 + 创建关联看板（含初始列），保证关联正确。
 *
 * 特殊错误语义：
 * - topic 步骤失败 → isError + failedStep:'create_topic'（无部分结果）
 * - board 步骤失败 → isError + failedStep:'create_board' + 已建 topic 信息（Agent 可补救）
 */
export const createTopicWithBoardTool: CustomTool = {
  tool: {
    name: 'create_topic_with_board',
    description:
      'One-stop project setup: create a topic and an associated board (with initial lists). ' +
      'Built-in default of three lists: backlog / in_progress / done. Customizable.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Topic title (required)',
        },
        description: {
          type: 'string',
          description: 'Topic description (optional)',
        },
        visibility: {
          type: 'string',
          // 枚举值从 shared Visibility 单源取值（防 backend DTO 加值后此处漂移）
          enum: Object.values(Visibility),
          description:
            'Topic visibility, default "private" (intentionally stricter than the server default of "open", ' +
            'following the principle of least exposure for autonomous agents)',
        },
        boardName: {
          type: 'string',
          description: 'Board name, defaults to the topic title',
        },
        lists: {
          type: 'array',
          description:
            'Initial board list definitions, each item: { name: string, mappedStatus?: TaskStatus }. ' +
            'Default three lists: backlog / in_progress / done',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'List name' },
              mappedStatus: {
                type: 'string',
                // 枚举值从 shared TaskStatus 单源取值（防 backend DTO 加值后此处漂移）
                enum: Object.values(TaskStatus),
                description: 'Mapped task status (optional)',
              },
            },
            required: ['name'],
          },
        },
      },
      required: ['title'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const title = args.title as string;
    const description = args.description as string | undefined;
    const visibility = (args.visibility as string) ?? 'private';
    const boardName = (args.boardName as string) ?? title;
    const lists = (args.lists as Array<{ name: string; mappedStatus?: string }>) ?? DEFAULT_LISTS;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：创建话题
    let topic: Record<string, unknown>;
    try {
      topic = await client.request<Record<string, unknown>>('POST', '/topics', {
        body: {
          title,
          ...(description !== undefined ? { description } : {}),
          visibility, // 显式传值，不依赖服务端默认
        },
      });
    } catch (err: unknown) {
      return handlePlatformError(err, 'create_topic');
    }

    // 步骤 2：创建看板（关联话题）
    try {
      const board = await client.request<Record<string, unknown>>('POST', '/boards', {
        body: {
          name: boardName,
          topicId: topic.id,
          lists,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ topic, board }),
          },
        ],
      };
    } catch (err: unknown) {
      // 部分成功：topic 已创建，返回其 id 供 Agent 补救
      if (err instanceof PlatformApiError) {
        const body: Record<string, unknown> = {
          error: true,
          failedStep: 'create_board',
          topic,
          status: err.status,
          message: err.message,
          ...(err.code !== undefined ? { code: err.code } : {}),
          ...(err.details !== undefined ? { details: err.details } : {}),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(body) }],
          isError: true,
        };
      }

      // 未知异常也保留 topic
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              failedStep: 'create_board',
              topic,
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
