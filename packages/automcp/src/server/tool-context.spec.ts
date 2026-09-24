/**
 * tool-context 单测（usage stats D4）：ALS 传播链与工具名归一化
 *
 * 覆盖 plan §4 批 3.6 的两条：ALS 传播不断链 / 头名常量的单一定义。
 */

import {
  INVALID_TOOL_NAME,
  MCP_SURFACE_HEADER,
  MCP_TOOL_HEADER,
  TOOL_NAME_MAX_LENGTH,
  getToolContext,
  normalizeToolName,
  runWithToolContext,
} from './tool-context';

/** 让出事件循环，用于验证异步续体里上下文是否仍在 */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('tool-context（ALS 工具调用上下文）', () => {
  describe('runWithToolContext / getToolContext', () => {
    it('上下文外读取为 undefined（非 MCP 场景是正常态，注入点据此跳过注头）', () => {
      expect(getToolContext()).toBeUndefined();
    });

    it('同步执行体内可读到上下文', () => {
      const seen = runWithToolContext({ toolName: 'read_doc', surface: 'mcp' }, () =>
        getToolContext(),
      );

      expect(seen).toEqual({ toolName: 'read_doc', surface: 'mcp' });
    });

    it('await 之后的续体仍可见（异步不断链——头在 I/O 前同步算出的前提）', async () => {
      const seen = await runWithToolContext({ toolName: 'read_doc', surface: 'mcp' }, async () => {
        await tick();
        return getToolContext();
      });

      expect(seen).toEqual({ toolName: 'read_doc', surface: 'mcp' });
    });

    it('定时器回调内仍可见', async () => {
      const captured: Array<ReturnType<typeof getToolContext>> = [];

      await runWithToolContext(
        { toolName: 'send_message', surface: 'mcp' },
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              captured.push(getToolContext());
              resolve();
            }, 0);
          }),
      );

      expect(captured[0]).toEqual({ toolName: 'send_message', surface: 'mcp' });
    });

    it('返回值原样透传（同步值与 Promise 的语义都不变）', async () => {
      expect(runWithToolContext({ toolName: 'x', surface: 'mcp' }, () => 42)).toBe(42);
      await expect(
        runWithToolContext({ toolName: 'x', surface: 'mcp' }, async () => 'done'),
      ).resolves.toBe('done');
    });

    it('嵌套 run：内层覆盖、退出后恢复外层', () => {
      const observed: Array<string | undefined> = [];

      runWithToolContext({ toolName: 'outer', surface: 'mcp' }, () => {
        observed.push(getToolContext()?.toolName);

        runWithToolContext({ toolName: 'inner', surface: 'mcp-full' }, () => {
          observed.push(getToolContext()?.toolName);
        });

        observed.push(getToolContext()?.toolName);
      });

      expect(observed).toEqual(['outer', 'inner', 'outer']);
    });

    it('并发调用互不串味（每次调用各读各的 toolName/surface）', async () => {
      const results = await Promise.all([
        runWithToolContext({ toolName: 'slow', surface: 'mcp' }, async () => {
          await tick(5);
          return getToolContext();
        }),
        runWithToolContext({ toolName: 'fast', surface: 'mcp-full' }, async () => {
          await tick(1);
          return getToolContext();
        }),
      ]);

      expect(results).toEqual([
        { toolName: 'slow', surface: 'mcp' },
        { toolName: 'fast', surface: 'mcp-full' },
      ]);
    });
  });

  describe('normalizeToolName', () => {
    it('普通工具名原样返回', () => {
      expect(normalizeToolName('read_doc')).toBe('read_doc');
    });

    it('剔除控制字符（含 CR/LF——非法 header value 会让 axios 抛错）', () => {
      expect(normalizeToolName('read\r\ndoc\t')).toBe('readdoc');
    });

    it(`超长名截断到 ${TOOL_NAME_MAX_LENGTH}（对齐上报 DTO 的 @MaxLength(128)）`, () => {
      const long = 'x'.repeat(TOOL_NAME_MAX_LENGTH + 50);

      expect(normalizeToolName(long)).toHaveLength(TOOL_NAME_MAX_LENGTH);
    });

    it('清洗后为空 → __invalid__ 哨兵（不能用空串：空串 = 非 MCP 流量）', () => {
      expect(normalizeToolName('\r\n')).toBe(INVALID_TOOL_NAME);
      expect(normalizeToolName('')).toBe(INVALID_TOOL_NAME);
    });
  });

  describe('头名常量', () => {
    it('厂商中立（随 oss 导出包发布，改名会新增 rebrand 映射）', () => {
      expect(MCP_TOOL_HEADER).toBe('X-MCP-Tool');
      expect(MCP_SURFACE_HEADER).toBe('X-MCP-Surface');
    });
  });
});
