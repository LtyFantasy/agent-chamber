#!/usr/bin/env tsx

/**
 * =============================================================================
 * automcp 端到端验证脚本
 * =============================================================================
 * 用途：验证 automcp server 从 platform Swagger 自动生成 tools 并正确转发请求。
 *
 * 运行前提：
 *   1. platform backend 已启动（localhost:8743）
 *   2. 在 packages/automcp/ 目录下执行：pnpm tsx scripts/e2e-test.ts
 *
 * 验证步骤：
 *   1. 检查 backend 健康状态
 *   2. 启动 automcp serve（随机端口）
 *   3. initialize 握手
 *   4. tools/list — 验证 102 个 tools
 *   5. tools/call — topic_controller_find_all（实际调用 platform API）
 *   6. tools/call — board_controller_find_all（实际调用 platform API）
 *   7. tools/call — 不存在的 tool（验证 isError）
 *   8. 停止 server，打印摘要
 * =============================================================================
 */

import axios from 'axios';
import { runServe } from '../src/serve-runner';

// ─── 配置 ───
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8743';
const SPEC_URL = `${BACKEND_URL}/api/docs-json`;
const BASE_URL = `${BACKEND_URL}/api/v1`;
/** 测试用 API Key：必须从环境变量注入，禁止在源码中硬编码真实 Key（开源红线） */
const API_KEY = process.env.E2E_API_KEY ?? '';
if (!API_KEY) {
  console.error('[ERROR] 请先设置环境变量 E2E_API_KEY（任意有效 Agent API Key）');
  process.exit(1);
}
const EXPECTED_TOOL_COUNT = 102;

// ─── 颜色输出辅助 ───
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

// ─── 测试状态 ───
const results: Array<{ step: string; passed: boolean; detail?: string }> = [];

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function logError(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function runTest<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    results.push({ step, passed: true });
    log(green(`  ✓ ${step}`));
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ step, passed: false, detail });
    log(red(`  ✗ ${step}`));
    log(red(`    → ${detail}`));
    return undefined;
  }
}

// ─── 主流程 ───
async function main(): Promise<void> {
  log('\n========================================');
  log('  automcp 端到端验证 (E2E Test)');
  log('========================================\n');

  // ── Step 0: 检查 backend 是否在线 ──
  log('[Step 0] 检查 backend 状态...');
  try {
    await axios.get(`${BACKEND_URL}/api/v1/health`, { timeout: 3000 });
    log(green('  ✓ Backend is running'));
  } catch {
    try {
      await axios.get(SPEC_URL, { timeout: 3000 });
      log(green('  ✓ Backend Swagger JSON accessible'));
    } catch {
      logError(red(`\nBackend not running at ${BACKEND_URL}, please start it first.`));
      logError(`  cd agent-chamber && pnpm dev\n`);
      process.exit(1);
    }
  }

  // ── Step 1: 启动 automcp server ──
  log('\n[Step 1] 启动 automcp serve...');
  const server = await runTest('启动 automcp server', async () => {
    const result = await runServe({
      spec: SPEC_URL,
      baseUrl: BASE_URL,
      port: 0, // 随机端口
      apiKey: API_KEY,
    });
    log(`  → ${result.toolCount} tools registered at ${result.url}`);
    return result;
  });

  if (server === undefined) {
    logError(red('\nServer failed to start. Aborting.\n'));
    process.exit(1);
  }

  const mcpUrl = `${server.url}/mcp`;

  // ── Step 2: initialize ──
  log('\n[Step 2] initialize 握手...');
  await runTest('initialize 返回正确结构', async () => {
    const res = await axios.post(mcpUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    const result = res.data.result as {
      protocolVersion: string;
      capabilities: unknown;
      serverInfo: { name: string; version: string };
    };

    if (result.protocolVersion !== '2025-06-18') {
      throw new Error(`protocolVersion mismatch: ${result.protocolVersion}`);
    }
    if (result.serverInfo.name !== 'automcp') {
      throw new Error(`serverInfo.name mismatch: ${result.serverInfo.name}`);
    }
    if (typeof result.capabilities !== 'object') {
      throw new Error('capabilities missing');
    }
    return result;
  });

  // ── Step 3: tools/list ──
  log('\n[Step 3] tools/list — 验证 tool 数量...');
  const toolListResult = await runTest(
    `tools/list 返回 ${EXPECTED_TOOL_COUNT} 个 tools`,
    async () => {
      const res = await axios.post(mcpUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const tools = (res.data.result as { tools: Array<{ name: string }> }).tools;
      if (tools.length !== EXPECTED_TOOL_COUNT) {
        throw new Error(`Expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
      }
      return tools;
    },
  );

  // ── Step 4: tools/call — topic_controller_find_all ──
  log('\n[Step 4] tools/call — topic_controller_find_all...');
  await runTest('调用 topic_controller_find_all 成功', async () => {
    const res = await axios.post(mcpUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'topic_controller_find_all',
        arguments: {},
      },
    });

    const result = res.data.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { code: number; data: unknown };
      isError?: boolean;
    };

    if (result.isError === true) {
      throw new Error(`Tool call returned error: ${JSON.stringify(result.content)}`);
    }
    // v1.66 新契约：JSON 成功响应收敛为单载荷——数据在 structuredContent，
    // content 为 '[structured]' 占位（不再 parse text）
    const data = result.structuredContent;
    if (!data || data.code !== 200) {
      throw new Error(`Platform API returned code ${data?.code}`);
    }
    return data;
  });

  // ── Step 5: tools/call — agent_controller_get_me ──
  log('\n[Step 5] tools/call — agent_controller_get_me...');
  await runTest('调用 agent_controller_get_me 成功', async () => {
    const res = await axios.post(mcpUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'agent_controller_get_me',
        arguments: {},
      },
    });

    const result = res.data.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { code: number; data: unknown };
      isError?: boolean;
    };

    if (result.isError === true) {
      throw new Error(`Tool call returned error: ${JSON.stringify(result.content)}`);
    }
    // 同 Step 4：读 structuredContent（唯一数据载荷）
    const data = result.structuredContent;
    if (!data || data.code !== 200) {
      throw new Error(`Platform API returned code ${data?.code}`);
    }
    return data;
  });

  // ── Step 6: tools/call — 不存在的 tool ──
  log('\n[Step 6] tools/call — 不存在的 tool...');
  await runTest('调用不存在的 tool 返回 isError', async () => {
    const res = await axios.post(mcpUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'non_existent_tool_xyz_12345',
        arguments: {},
      },
    });

    const result = res.data.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    if (result.isError !== true) {
      throw new Error(`Expected isError=true, got isError=${String(result.isError)}`);
    }
    return result;
  });

  // ── 清理 ──
  log('\n[Cleanup] 停止 automcp server...');
  try {
    await server.stop();
    log(green('  ✓ Server stopped'));
  } catch (error) {
    logError(red(`  ✗ Failed to stop server: ${String(error)}`));
  }

  // ── 摘要 ──
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  log('\n========================================');
  log('  测试结果摘要');
  log('========================================');
  log(`  总测试数 : ${results.length}`);
  log(`  通过     : ${green(String(passed))}`);
  log(`  失败     : ${failed > 0 ? red(String(failed)) : green(String(failed))}`);

  if (toolListResult !== undefined) {
    log(`  Tools 数 : ${toolListResult.length}`);
  }
  log('');

  if (failed > 0) {
    logError(red('E2E 验证失败，请检查上述错误。\n'));
    process.exit(1);
  }

  log(green('所有测试通过！automcp 集成验证完成。\n'));
}

// ─── 启动 ───
void main().catch((err: unknown) => {
  logError(red(`Unhandled error: ${String(err)}`));
  process.exit(1);
});
