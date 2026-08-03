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

import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';
import { runServe } from './serve-runner';
import type { ServeOptions } from './types';

const fixturesDir = path.join(__dirname, 'parser', '__fixtures__');

/**
 * 辅助函数：创建默认 ServeOptions
 */
function makeOptions(
  spec: string,
  overrides: Partial<ServeOptions> = {},
): ServeOptions {
  return {
    spec,
    baseUrl: 'http://localhost:8743/api/v1',
    port: 0,
    ...overrides,
  };
}

describe('runServe', () => {
  describe('本地 fixture spec 正常启动', () => {
    it('should start server and return toolCount > 0', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json')),
      );

      expect(result.toolCount).toBe(2);
      expect(result.url).toMatch(/^http:\/\/localhost:\d+$/u);
      expect(result.stop).toBeInstanceOf(Function);

      await result.stop();
    });

    it('should handle JSON-RPC requests end-to-end', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json')),
      );

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.jsonrpc).toBe('2.0');
      expect(res.data.id).toBe(1);
      expect(res.data.result.tools).toHaveLength(2);
      expect(res.data.result.tools[0].name).toBe('get_current_user');
      expect(res.data.result.tools[1].name).toBe('create_user');

      await result.stop();
    });
  });

  describe('空 spec（0 operations）', () => {
    it('should return toolCount = 0', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'empty-paths.json')),
      );

      expect(result.toolCount).toBe(0);

      await result.stop();
    });
  });

  describe('无效 spec 路径', () => {
    it('should throw error for non-existent spec file', async () => {
      await expect(
        runServe(makeOptions('/non/existent/path.json')),
      ).rejects.toThrow();
    });
  });

  describe('认证配置传递', () => {
    it('should inject API Key header via proxy', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          apiKey: 'test-api-key-123',
        }),
      );

      // 通过健康检查端点验证服务器正常运行
      const healthRes = await axios.get(`${result.url}/health`, {
        timeout: 5_000,
      });
      expect(healthRes.status).toBe(200);
      expect(healthRes.data).toEqual({ status: 'ok' });

      await result.stop();
    });
  });

  describe('profile 过滤', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-serve-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should apply profile include filter and reduce tool count', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({ include: ['get_current_user'] }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          profilePath,
        }),
      );

      expect(result.toolCount).toBe(1);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.data.result.tools).toHaveLength(1);
      expect(res.data.result.tools[0].name).toBe('get_current_user');

      await result.stop();
    });

    it('should merge CLI exclude with profile exclude', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({ include: ['get_current_user', 'create_user'] }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          profilePath,
          exclude: ['create_user'],
        }),
      );

      expect(result.toolCount).toBe(1);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.data.result.tools[0].name).toBe('get_current_user');

      await result.stop();
    });
  });

  describe('agent profile milestone tools 回归测试', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-milestones-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should expose all 5 milestone tools when agent profile is applied', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({
          include: [
            '^task_controller_find_milestones$',
            '^task_controller_create_milestone$',
            '^task_controller_find_milestone$',
            '^task_controller_update_milestone$',
            '^task_controller_remove_milestone$',
          ],
        }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-milestones.json'), {
          profilePath,
        }),
      );

      expect(result.toolCount).toBe(5);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      const names = res.data.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual([
        'task_controller_create_milestone',
        'task_controller_find_milestone',
        'task_controller_find_milestones',
        'task_controller_remove_milestone',
        'task_controller_update_milestone',
      ]);

      await result.stop();
    });
  });

  describe('--custom-tools 扩展', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-custom-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('⑧ 指向合法模块 → 注册成功且 toolCount 正确', async () => {
      // 写入合法的 custom tools 模块（导出 customTools 数组）
      const modulePath = path.join(tmpDir, 'valid-custom-tools.cjs');
      fs.writeFileSync(
        modulePath,
        [
          `module.exports = {`,
          `  customTools: [{`,
          `    tool: {`,
          `      name: 'my_custom_tool',`,
          `      description: 'A custom tool',`,
          `      inputSchema: { type: 'object', properties: {}, additionalProperties: false },`,
          `    },`,
          `    handler: async () => ({ content: [{ type: 'text', text: 'hello' }] }),`,
          `  }],`,
          `};`,
        ].join('\n'),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          customTools: modulePath,
        }),
      );

      // 2 个自动映射 tool + 1 个 custom tool = 3
      expect(result.toolCount).toBe(3);

      // 验证 tools/list 包含 custom tool
      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      const names = res.data.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(['get_current_user', 'create_user', 'my_custom_tool']);

      await result.stop();
    });

    it('⑨ 模块不存在 → runServe reject 明确错误', async () => {
      const badPath = path.join(tmpDir, 'does-not-exist.cjs');

      await expect(
        runServe(
          makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
            customTools: badPath,
          }),
        ),
      ).rejects.toThrow(/Failed to load custom tools module/);
    });

    it('⑩ 导出形状非法（缺少 handler）→ 明确报错', async () => {
      const modulePath = path.join(tmpDir, 'bad-shape.cjs');
      fs.writeFileSync(
        modulePath,
        [
          `module.exports = {`,
          `  customTools: [{`,
          `    tool: {`,
          `      name: 'bad_tool',`,
          `      description: 'Missing handler',`,
          `      inputSchema: { type: 'object', properties: {}, additionalProperties: false },`,
          `    },`,
          `    // 故意不提供 handler`,
          `  }],`,
          `};`,
        ].join('\n'),
        'utf-8',
      );

      await expect(
        runServe(
          makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
            customTools: modulePath,
          }),
        ),
      ).rejects.toThrow(/must have a "handler" function/);
    });
  });
});
