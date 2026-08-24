#!/usr/bin/env node

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §4 (契约②: runner 拨号/hello 上报/心跳/对账——本进程运行时契约)
 *   - 补充: packages/roundtable-runner/README.md (启动参数/三分钟上手)
 *
 * [踩坑索引] R3STATE(裸CLI共享stateDir)
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   R3STATE: 裸 CLI 缺省 state-dir 曾固定 ~/.roundtable-runner，同机多 runner 共享
 *         目录互相覆盖对账游标（真实事故）。修复：缺省按 runner 名派生
 *         ~/.roundtable-runner-<name>（`/` 转 `-`，与 install-runner.sh 同规则），
 *         旧目录存在时打 mv 迁移 warn；派生逻辑在 src/state-dir.ts（可单测）。
 *         见 docs/roundtable-design.md §4 R3
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
 *   --state-dir <dir>      状态目录（缺省按 runner 名派生 ~/.roundtable-runner-<name>：
 *                          会话映射/对账游标/未确认队列；显式传参仍最优先）
 *   --log-level <level>    日志级别 debug | info | warn | error（默认 info）
 *
 * 生命周期：启动 → 连接循环（指数退避重连 + 心跳 + 对账重放）→ 座位绑定/注入/回复
 * 关键事件打 info 日志；SIGINT/SIGTERM 优雅退出（停全部 driver、落盘状态）。
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { RunnerCore } from './runner-core';
import { ConsoleLogger } from './logger';
import type { LogLevel } from './logger';
import { DRIVER_VERSION } from './drivers/acp-driver';
import { LEGACY_DEFAULT_STATE_DIR, resolveStateDir } from './state-dir';

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
    '状态目录（座位会话映射/对账游标/未确认队列持久化；缺省按 runner 名派生 ~/.roundtable-runner-<name>，`/` 替换为 `-`）',
  )
  .option('--log-level <level>', '日志级别：debug | info | warn | error（默认 info）', 'info')
  .action(
    async (opts: {
      platformUrl: string;
      apiKey: string;
      runnerName: string;
      stateDir?: string;
      logLevel: LogLevel;
    }) => {
      const logger = new ConsoleLogger({ level: opts.logLevel, prefix: '[runner]' });
      // 状态目录解析（r25 R3）：显式传参 > 按 runner 名派生（与 install-runner.sh 同规则）。
      // 裸 CLI 且旧固定默认目录仍有状态时打迁移 warn（方案 A：总是派生新目录，
      // 老用户状态换新一次——会话重建、重放失效一次，换取消灭共享目录隐患）
      const { stateDir, usedLegacyDefault } = resolveStateDir(
        opts.runnerName,
        opts.stateDir,
        () => existsSync(LEGACY_DEFAULT_STATE_DIR),
      );
      if (usedLegacyDefault) {
        logger.warn(
          `检测到旧默认状态目录 ${LEGACY_DEFAULT_STATE_DIR}；本版本起裸 CLI 缺省按 runner 名 ` +
            `派生独立目录 ${stateDir}（旧共享目录会被多 runner 互相覆盖对账游标）。` +
            `如需沿用旧状态请手动迁移：mv ${LEGACY_DEFAULT_STATE_DIR} ${stateDir}`,
        );
      }
      logger.info(
        `roundtable-runner ${VERSION} starting (platform=${opts.platformUrl} runner=${opts.runnerName} stateDir=${stateDir})`,
      );
      const core = new RunnerCore({
        platformUrl: opts.platformUrl,
        apiKey: opts.apiKey,
        runnerName: opts.runnerName,
        version: VERSION,
        stateDir,
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
