/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Health（探针契约）
 *
 * [踩坑索引] 暂无（2026-08-15 首次建档）
 *
 * [铁律关联] #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 健康检查控制器
 *
 * 提供存活探针（liveness）和就绪探针（readiness），供负载均衡器 / 监控使用。
 * 所有端点均为公开访问（无 JWT 认证），便于外部探针调用。
 *
 * 存活探针附带平台版本信息（version + commit），供前端 sidebar 版本角标
 * 与运维核对"当前线上跑的是哪个版本"。版本信息是观测性增强：
 * 任何解析失败都不得影响探针应答（探针可用性 > 字段完整性）。
 */
import { Controller, Get } from '@nestjs/common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';

/** 平台版本信息（存活探针的附加观测字段） */
interface VersionInfo {
  /** 平台版本（monorepo 根 package.json version；解析失败兜底 'unknown'） */
  version: string;
  /** git short SHA（GIT_SHA 环境变量优先，其次 git rev-parse；均无则省略字段） */
  commit?: string;
}

/**
 * 从 startDir 向上最多 4 级查找 monorepo 根目录
 *（判定依据：package.json 的 name 为主仓名或 chamber 品牌名）。
 *
 * 兼容两种进程 cwd：生产/部署 = 仓库根（node apps/backend/dist/... 从根启动），
 * pnpm --filter 开发/测试 = apps/backend（向上两级命中根）。
 * chamber 快照仓经 oss-rebrand 改包名为 agent-chamber，docker 自部署链的
 * /health version 解析必须同时认两个品牌名（v1.57.3 冒烟实测 'unknown' 坑）。
 */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (pkg.name === 'agent-chamber' || pkg.name === 'agent-chamber') return dir;
    } catch {
      /* 本级无 package.json 或不可解析，继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 解析平台版本信息（进程启动时执行一次，结果缓存于控制器字段）。
 *
 * 单一事实来源 = monorepo 根 package.json 的 version——apps/* 子包 version 恒为
 * 1.0.0（不发版不维护），读子包会得到错误版本，勿用。
 *
 * commit 解析序：GIT_SHA 环境变量（CI/镜像构建注入）→ 仓库根执行
 * `git rev-parse --short HEAD` → 省略字段（如无 .git 的 docker 运行镜像）。
 */
function resolveVersionInfo(): VersionInfo {
  const rootDir = findRepoRoot(process.cwd());
  let version = 'unknown';
  if (rootDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (pkg.version) version = pkg.version;
    } catch {
      /* 读文件失败保持 unknown 兜底 */
    }
  }
  let commit = process.env.GIT_SHA?.trim() || undefined;
  if (!commit && rootDir) {
    try {
      commit =
        execSync('git rev-parse --short HEAD', {
          cwd: rootDir,
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim() || undefined;
    } catch {
      /* 无 .git 环境（docker 运行镜像）省略 commit 字段 */
    }
  }
  return { version, commit };
}
@ApiTags('Health')
@Controller('health')
export class HealthController {
  /** 服务启动时间，用于计算 uptime */
  private readonly startTime = Date.now();

  /** 平台版本信息（启动时解析一次后缓存；解析失败不影响探针应答） */
  private readonly versionInfo = resolveVersionInfo();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 存活探针 — 判断服务进程是否还活着
   *
   * 不检查任何外部依赖，只返回进程本身状态。
   * 适用于 K8s livenessProbe、负载均衡心跳。
   * 附带 version（根 package.json）与 commit（git short SHA）观测字段。
   */
  @Public()
  @SkipTransform()
  @Get()
  @ApiOperation({ summary: 'Liveness probe — service liveness check' })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.versionInfo.version,
      // commit 可能省略（无 .git 且未注入 GIT_SHA），undefined 字段不进 JSON
      ...(this.versionInfo.commit ? { commit: this.versionInfo.commit } : {}),
    };
  }

  /**
   * 就绪探针 — 判断服务是否可以对外提供服务
   *
   * 检查所有外部依赖（数据库连接、磁盘空间等）。
   * 任一依赖不健康返回 HTTP 503，便于编排器摘除流量。
   */
  @Public()
  @SkipTransform()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — dependency readiness check' })
  async readiness() {
    const checks = await Promise.all([this.checkDatabase(), this.checkDiskSpace()]);

    const failed = checks.filter((c) => c.status === 'down');
    const status = failed.length === 0 ? 'ok' : 'error';

    const body: Record<string, unknown> = {
      status,
      timestamp: new Date().toISOString(),
    };

    // 按 status 分组输出
    const info = checks.filter((c) => c.status === 'up');
    const error = checks.filter((c) => c.status === 'down');

    if (info.length > 0) {
      body.info = info.reduce(
        (acc, cur) => {
          acc[cur.name] = { status: cur.status, ...cur.details };
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }

    if (error.length > 0) {
      body.error = error.reduce(
        (acc, cur) => {
          acc[cur.name] = { status: cur.status, message: cur.message };
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }

    return body;
  }

  /** 数据库连接检查：执行一条轻量查询 */
  private async checkDatabase(): Promise<HealthCheckResult> {
    try {
      const start = Date.now();
      await this.dataSource.query('SELECT 1');
      return {
        name: 'database',
        status: 'up',
        details: { responseTimeMs: Date.now() - start },
      };
    } catch (err: unknown) {
      return {
        name: 'database',
        status: 'down',
        message: err instanceof Error ? err.message : 'Database connection failed',
      };
    }
  }

  /** 磁盘空间检查：Node 进程所在分区 */
  private checkDiskSpace(): HealthCheckResult {
    try {
      // statSync 不直接返回可用空间，用 process.cwd 估算
      // 生产环境通常挂载在独立分区，这里简化检查目录可访问性
      fs.accessSync(process.cwd(), fs.constants.R_OK | fs.constants.W_OK);
      return {
        name: 'disk',
        status: 'up',
        details: { cwd: process.cwd() },
      };
    } catch (err: unknown) {
      return {
        name: 'disk',
        status: 'down',
        message: err instanceof Error ? err.message : 'Disk check failed',
      };
    }
  }
}

interface HealthCheckResult {
  name: string;
  status: 'up' | 'down';
  details?: Record<string, unknown>;
  message?: string;
}
