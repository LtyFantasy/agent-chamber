#!/usr/bin/env node

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §4 (契约②: runner 拨号/hello 上报/心跳/对账——本进程运行时契约)
 *   - 补充: packages/roundtable-runner/README.md (启动参数/三分钟上手)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * roundtable-runner CLI（commander，照 packages/automcp/src/cli.ts 范本）
 *
 * 用法：
 *   roundtable-runner --platform-url http://localhost:8743 --api-key <key> --runner-name <name>
 *
 * 选项：
 *   --platform-url <url>   平台地址（http(s)://host:port，自动换算 ws(s)://host:port/ws/runner）
 *   --api-key <key>        平台 API Key（X-API-Key 握手认证；对应 agent bindActorId 的座位被绑定）
 *   --runner-name <name>   runner 名称（hello 上报，chamber 展示）
 *   --state-dir <dir>      状态目录（默认 ~/.roundtable-runner：会话映射/对账游标/未确认队列）
 *   --log-level <level>    日志级别 debug | info | warn | error（默认 info）
 *
 * 生命周期：启动 → 连接循环（指数退避重连 + 心跳 + 对账重放）→ 座位绑定/注入/回复
 * 关键事件打 info 日志；SIGINT/SIGTERM 优雅退出（停全部 driver、落盘状态）。
 */

import { Command } from 'commander';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunnerCore } from './runner-core';
import { ConsoleLogger } from './logger';
import type { LogLevel } from './logger';
import { DRIVER_VERSION } from './drivers/acp-driver';

/** 本包版本（hello.version / initialize clientInfo.version 上报；与基座 DRIVER_VERSION 单一常量同源，R5） */
const VERSION = DRIVER_VERSION;

const program = new Command();

program
  .name('roundtable-runner')
  .description('圆桌模式 runner：控制面 WebSocket 拨号 + ACP 座位驱动（kimi/codex，SeatDriver）')
  .version(VERSION);

program
  .requiredOption(
    '--platform-url <url>',
    '平台地址（如 http://localhost:8743 或 https://platform.example.com）',
  )
  .requiredOption('--api-key <key>', '平台 API Key（X-API-Key 认证；对应 agent 的座位会被绑定）')
  .requiredOption('--runner-name <name>', 'runner 名称（hello 上报，chamber 展示）')
  .option(
    '--state-dir <dir>',
    '状态目录（座位会话映射/对账游标/未确认队列持久化，默认 ~/.roundtable-runner）',
    path.join(os.homedir(), '.roundtable-runner'),
  )
  .option('--log-level <level>', '日志级别：debug | info | warn | error（默认 info）', 'info')
  .action(
    async (opts: {
      platformUrl: string;
      apiKey: string;
      runnerName: string;
      stateDir: string;
      logLevel: LogLevel;
    }) => {
      const logger = new ConsoleLogger({ level: opts.logLevel, prefix: '[runner]' });
      logger.info(
        `roundtable-runner ${VERSION} starting (platform=${opts.platformUrl} runner=${opts.runnerName} stateDir=${opts.stateDir})`,
      );
      const core = new RunnerCore({
        platformUrl: opts.platformUrl,
        apiKey: opts.apiKey,
        runnerName: opts.runnerName,
        version: VERSION,
        stateDir: opts.stateDir,
        logger,
        onFatal: (reason: string) => {
          // 认证失败 / 被同 key 新 runner 顶替：重试无意义，退出让运维介入
          logger.error(`fatal: ${reason}`);
          process.exit(1);
        },
      });
      core.start();

      // SIGINT/SIGTERM 优雅退出：停全部座位驱动（会话已落盘可复活）+ 落盘状态
      const shutdown = async (signal: string): Promise<void> => {
        logger.info(`received ${signal}, shutting down...`);
        try {
          await core.stop();
        } catch (err) {
          logger.error(`shutdown error: ${String(err)}`);
        }
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    },
  );

// 使用 parseAsync 确保 Promise rejection 被捕获（automcp cli 同款模式）
void program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`[roundtable-runner] ${String(err)}\n`);
  process.exit(1);
});
