#!/usr/bin/env node

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 6
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §运行模式
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
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

import { Command } from 'commander';
import { runServe } from './serve-runner';
import type { ServeOptions, GenerateOptions } from './types';

const program = new Command();

program.name('automcp').description('从 OpenAPI 规范自动生成 MCP Server').version('0.1.0');

/**
 * 将逗号分隔的字符串转换为字符串数组
 *
 * @param value - 逗号分隔的字符串，或 undefined
 * @returns 分割后的数组（去重），或 undefined
 */
function splitCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length > 0 ? parts : undefined;
}

program
  .command('serve')
  .description('启动 MCP Server（运行时动态模式）')
  .requiredOption('-s, --spec <path>', 'OpenAPI spec URL 或文件路径')
  .requiredOption('-b, --base-url <url>', '目标 API 的基础 URL')
  .option(
    '-p, --port <number>',
    'MCP server 端口（默认 8745，与 web 8742/backend 8743 同族）',
    '8745',
  )
  .option('--api-key <key>', 'API Key 认证')
  .option('--bearer-token <token>', 'Bearer Token 认证')
  .option('--tags <tags>', '只包含指定 tags 的 operation（逗号分隔）')
  .option('--include <patterns>', '包含匹配 operationId 的 pattern（逗号分隔）')
  .option('--exclude <patterns>', '排除匹配 operationId 的 pattern（逗号分隔）')
  .option('--profile <name>', '使用预设 profile（如 agent）')
  .option('--profile-path <path>', '直接指定 profile JSON 文件路径')
  .option('--base-path <path>', 'MCP JSON-RPC endpoint 的 base path（默认 /mcp）', '/mcp')
  .option('--custom-tools <path>', '自定义 tools 模块路径（须导出 customTools 数组）')
  .action(
    async (rawOptions: {
      spec: string;
      baseUrl: string;
      port: string;
      apiKey?: string;
      bearerToken?: string;
      tags?: string;
      include?: string;
      exclude?: string;
      profile?: string;
      profilePath?: string;
      basePath?: string;
      customTools?: string;
    }) => {
      // ─── 1. 验证互斥选项 ───
      if (rawOptions.apiKey !== undefined && rawOptions.bearerToken !== undefined) {
        process.stderr.write(
          '[automcp] ERROR: --api-key and --bearer-token are mutually exclusive\n',
        );
        process.exit(1);
      }

      if (rawOptions.profile !== undefined && rawOptions.profilePath !== undefined) {
        process.stderr.write(
          '[automcp] ERROR: --profile and --profile-path are mutually exclusive\n',
        );
        process.exit(1);
      }

      // ─── 2. 构造 ServeOptions（转换类型）───
      const port = parseInt(rawOptions.port, 10);
      if (Number.isNaN(port) || port < 0 || port > 65535) {
        process.stderr.write(`[automcp] ERROR: Invalid port number "${rawOptions.port}"\n`);
        process.exit(1);
      }

      const options: ServeOptions = {
        spec: rawOptions.spec,
        baseUrl: rawOptions.baseUrl,
        port,
        apiKey: rawOptions.apiKey,
        bearerToken: rawOptions.bearerToken,
        tags: splitCommaList(rawOptions.tags),
        include: splitCommaList(rawOptions.include),
        exclude: splitCommaList(rawOptions.exclude),
        profile: rawOptions.profile,
        profilePath: rawOptions.profilePath,
        basePath: rawOptions.basePath,
        customTools: rawOptions.customTools,
      };

      // ─── 3. 执行 serve pipeline ───
      try {
        const result = await runServe(options);

        if (result.toolCount === 0) {
          process.stdout.write('[automcp] WARNING: No tools mapped. Check your filters.\n');
        }
        process.stdout.write(`[automcp] ${result.toolCount} tools registered\n`);
        process.stdout.write(`[automcp] Server running at ${result.url}\n`);

        // ─── 4. 优雅关闭 ───
        const shutdown = async (signal: string): Promise<void> => {
          process.stdout.write(`\n[automcp] Received ${signal}, shutting down...\n`);
          try {
            await result.stop();
            process.stdout.write('[automcp] Server stopped.\n');
          } catch {
            // ignore shutdown errors
          }
          process.exit(0);
        };

        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[automcp] ERROR: ${message}\n`);
        process.exit(1);
      }
    },
  );

program
  .command('generate')
  .description('生成独立 MCP Server 项目（静态生成模式，Phase 2）')
  .requiredOption('-s, --spec <path>', 'OpenAPI spec URL 或文件路径')
  .requiredOption('-o, --output <dir>', '输出目录')
  .action(async (_options: GenerateOptions) => {
    process.stderr.write('automcp generate is planned for Phase 2.\n');
    throw new Error('Not implemented yet — Phase 2');
  });

// 使用 parseAsync 确保 Promise rejection 被正确捕获，避免 floating promises
void program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
