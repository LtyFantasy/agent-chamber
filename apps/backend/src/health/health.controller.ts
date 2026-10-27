/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Health（探针契约）+ §19.2（`optional.memoryEngine` =
 *     引擎**告警态视图**五 token；不参与就绪判定、不得作为自动摘流判据）
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
import { Controller, Get, Inject, Logger, Optional } from '@nestjs/common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
// ⚠️ 值导入（token 用作 @Inject 参数）+ 类型导入（端口形状）。方向单向：health → memory
import { ENGINE_HEALTH_VIEW, type EngineHealthView } from '../modules/memory/memory.module';

/**
 * readiness（就绪探针）限流阈值（F4 项1 / 依据 S-N4）：120 次/分钟/IP。
 *
 * 依据：探针节律激进到 0.5s（120 次/分钟）仍放行，正常编排器 / K8s / 脚本探测永不触顶；
 * 拦的是「匿名端点被脚本高频刷」的滥用面。测试环境放宽到极大值防 e2e 误伤
 * （isTestEnv 范式同 modules/auth/auth.controller.ts 的 A6 常量）；
 * `THROTTLE_HEALTH_READY_LIMIT` 是软回滚逃生口（线上探针节律若低于 0.5s 可临时放宽）。
 *
 * ⚠️ **只挂 readiness()，/health（liveness）永不限流**（P-C6）：scripts/deploy.sh 的健康门
 * 以 2s 节律轮询 /health，给 liveness 加限流会把**健康部署**打成 429 → 自动回滚
 * （限流误伤的是部署流程本身，不是攻击者）。
 *
 * ⚠️ **耦合点（复审 MINOR-6）**：上面「/health 永不限流」当前**等价成立**是靠 app.module.ts
 * 的全局默认被设成实质关闭（`THROTTLE_GLOBAL_LIMIT` 默认 100000）。/health 没有自己的
 * @Throttle，走的就是那个全局桶——运维一旦把 THROTTLE_GLOBAL_LIMIT 调小（或改成有意义的
 * 限流），/health 立刻变成有限流的端点，deploy.sh 健康门会在高节律部署/重试时吃 429 →
 * **自动回滚健康版本**（P-C6 的另一种触发方式）。要动那个环境变量，必须先给 /health 显式
 * 加一条宽松 @Throttle（或加 @SkipThrottle 语义），不能只改全局值。
 */
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
const READY_THROTTLE_LIMIT = isTestEnv
  ? 100_000
  : parseInt(process.env.THROTTLE_HEALTH_READY_LIMIT || '120', 10);
const READY_THROTTLE_TTL_MS = 60_000;

/**
 * 公开就绪详情字段白名单（F4-1 教训）：info 桶**只**输出这些 details 键。
 *
 * 为什么必须白名单、不能裸 spread `...cur.details`：裸 spread 会把**未来**新增的 details
 * 字段自动公开到匿名端点——一次「无害的观测字段增强」就静默变成一次信息泄露。
 * 前科：checkDiskSpace 曾把 `process.cwd()`（= 部署绝对路径）随 details 公开。
 * 新增可公开字段必须显式登记于此，并同步 health.controller.spec.ts 的白名单用例。
 */
const PUBLIC_READY_DETAIL_KEYS: readonly string[] = ['responseTimeMs'];

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

  /**
   * 探针失败的服务端日志（F4 项1）：响应面只给固定文案，**原始错误只进这里**，
   * 统一带 `[health/ready]` 前缀便于 grep 排障（响应面不回显 PG 原文 / 部署路径）。
   */
  private readonly logger = new Logger(HealthController.name);

  /** 平台版本信息（启动时解析一次后缓存；解析失败不影响探针应答） */
  private readonly versionInfo = resolveVersionInfo();

  /**
   * @param dataSource 数据库检查用（readiness 的两项依赖检查之一）
   * @param engineHealthView 引擎**告警态视图**（可选注入：单测隔离、或部署没装 memory 模块时
   *   缺席）。缺席 ⇒ `/health/ready` **省略** `optional.memoryEngine` 桶——观测面的缺失
   *   不得影响探针本身（探针可用性 > 字段完整性）。
   */
  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject(ENGINE_HEALTH_VIEW)
    private readonly engineHealthView?: EngineHealthView,
  ) {}

  /**
   * 存活探针 — 判断服务进程是否还活着
   *
   * 不检查任何外部依赖，只返回进程本身状态。
   * 适用于 K8s livenessProbe、负载均衡心跳。
   * 附带 version（根 package.json）与 commit（git short SHA）观测字段。
   *
   * ⚠️ **本端点绝不加 @Throttle**（P-C6）：scripts/deploy.sh 的健康门以 2s 节律轮询它，
   * 限流会把**健康部署**打成 429 → 自动回滚。限流只落在 readiness()。
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
   *
   * **HTTP 状态语义（F4 项1 如实描述）**：本端点**恒返回 200**——依赖不健康只体现为 body
   * 的 `status: 'error'` 与 `error` 桶（固定文案），**不是** 503。
   * 真实 503 语义（编排器按状态码摘流）零消费者且改探针契约风险不抵收益，已另立登记卡⑥；
   * 因此**请勿把本端点的 HTTP 码当摘流/健康判据**——判据是 `status` 字段。
   *
   * 限流：120/min/IP（常量见 READY_THROTTLE_LIMIT）。探针节律 ≥2s 永不触顶；
   * 429 ≠ 不健康（被限流时 body 不可读，按 Retry-After 重试即可）。
   *
   * **附加桶 `optional.memoryEngine`（卡 5e6cb000）**：引擎**告警态视图**（五 token：
   * disabled / down / degraded / unknown / up），**不参与上面的 `status` 判定**——
   * 它回答"引擎此刻是否在告警"，不回答"本站能不能服务"（`degraded` 可被任何登录用户诱发，
   * 禁作自动摘流判据）。视图不可用（未装配 memory 模块 / 读取抛错）时整桶省略。
   */
  @Public()
  @SkipTransform()
  @Throttle({ default: { limit: READY_THROTTLE_LIMIT, ttl: READY_THROTTLE_TTL_MS } })
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
          // 白名单渲染（F4-1）：只输出 PUBLIC_READY_DETAIL_KEYS 里显式登记的键。
          // ⚠️ 禁止改回 `...cur.details` 裸 spread——它会把未来新增的 details 字段
          // 自动公开到本匿名端点（泄露方式见 PUBLIC_READY_DETAIL_KEYS 头注）。
          const publicDetails: Record<string, unknown> = {};
          for (const key of PUBLIC_READY_DETAIL_KEYS) {
            if (cur.details && key in cur.details) publicDetails[key] = cur.details[key];
          }
          acc[cur.name] = { status: cur.status, ...publicDetails };
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }

    if (error.length > 0) {
      // message 是各 check 自己给的**固定文案**（见 checkDatabase / checkDiskSpace），
      // 原始错误只进服务端日志——本端点是匿名可达的，不回显 PG/路径原文（F4 项1）
      body.error = error.reduce(
        (acc, cur) => {
          acc[cur.name] = { status: cur.status, message: cur.message };
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }

    // 引擎**告警态视图**（卡 5e6cb000）：固定映射、**禁止 spread 快照**（裸 spread 会把未来
    // 新增的引擎内部字段自动公开到这个匿名端点——同 F4-1 白名单教训）。
    // ⚠️ 不参与整体就绪判定（`status` 只看 database/disk）：`degraded` 可被任何登录用户诱发，
    // 不得作为自动摘流/自动重启判据；读取抛错 ⇒ **省略**该桶（观测面不得拖垮探针）。
    try {
      if (this.engineHealthView) {
        body.optional = { memoryEngine: { status: this.engineHealthView.read() } };
      }
    } catch {
      /* 视图不可读：省略 optional 桶（探针照常应答） */
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
      // F4 项1：响应面只给固定文案（PG 原文含 host/port/dbname 等部署指纹，匿名端点不公开），
      // 原始错误只进服务端日志（[health/ready] 前缀便于 grep 排障）
      this.logger.error(
        `[health/ready] database check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { name: 'database', status: 'down', message: 'database check failed' };
    }
  }

  /** 磁盘空间检查：Node 进程所在分区 */
  private checkDiskSpace(): HealthCheckResult {
    const start = Date.now();
    try {
      // statSync 不直接返回可用空间，用 process.cwd 估算
      // 生产环境通常挂载在独立分区，这里简化检查目录可访问性
      fs.accessSync(process.cwd(), fs.constants.R_OK | fs.constants.W_OK);
      return {
        name: 'disk',
        status: 'up',
        // F4 项1：不再把 process.cwd()（= 部署绝对路径）放进 details——匿名端点不公开部署指纹；
        // 与 database check 同形（responseTimeMs），两个 up 桶的字段形状保持一致
        details: { responseTimeMs: Date.now() - start },
      };
    } catch (err: unknown) {
      this.logger.error(
        `[health/ready] disk check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { name: 'disk', status: 'down', message: 'disk check failed' };
    }
  }
}

interface HealthCheckResult {
  name: string;
  status: 'up' | 'down';
  /** up 时的观测细节；**只有 PUBLIC_READY_DETAIL_KEYS 白名单内的键会被输出**（F4-1） */
  details?: Record<string, unknown>;
  /**
   * down 时的**固定对外文案**（F4 项1）：恒为字面量，绝不回显原始错误——
   * 本端点匿名可达，PG 原文 / 部署路径属于泄露面；原始错误只进 Logger（[health/ready]）。
   */
  message?: string;
}
