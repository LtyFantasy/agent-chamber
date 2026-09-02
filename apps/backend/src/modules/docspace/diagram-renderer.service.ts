/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：渲染门（fail-closed）——IR 经 vendored archify
 *     全量管线（schema 校验 + 渲染器几何校验 + artifact checker）后产出 HTML 快照
 *
 * [代码职责]
 *   - 本服务 = 唯一渲染入口（D5 子进程形态）：runProcess(render-<type>.mjs) →
 *     runProcess(check-render-output.mjs) → 门规则判定 → {html, meta, checks, composition}
 *   - 被 doc.service.ts upsertCore diagram 分支（写门）与 diagram.service.ts
 *     validate dry-run 共用——门规则只此一份
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §2.2（门规则）§3.2（调用形态）
 *   - 补充: packages/diagram/NOTICE — vendored 声明 + 补丁清单（上游同步流程）
 *
 * [关键不变量]
 *   - R2：门判定读 checker 输出的 composition.summary.errors/warnings（顶层无此字段，
 *     错取顶层会让 showcase 门静默失灵——评审双路发现，spec 有回归断言）
 *   - R4：quality_profile 缺省/非法 → 显式注入 'standard' 且 spawn env 恒设置
 *     （geometry.mjs:639 profile 双缺时 border-run 检查族静默跳过，门会出现计划外缺口）；
 *     生效值记录进 render_meta.qualityProfile
 *   - M-a：spawn env = {...process.env, ARCHIFY_DIAGNOSTIC_FORMAT:'json',
 *     ARCHIFY_QUALITY_PROFILE: profile, ARCHIFY_REPO_ROOT: undefined}——env 选项是整体
 *     替换必须合并宿主环境，且显式剔除 ARCHIFY_REPO_ROOT（安全收口：否则
 *     verifyRepositoryEvidence 会读仓库文件；meta.repository/components[].sources
 *     由 upsertCore R3 前置拒绝，根本到不了这里）
 *   - 失败分层：IR 内容问题 → 422 DIAGRAM_VALIDATION_FAILED（data {stage, diagnostics}）；
 *     渲染器基础设施问题（ENOENT/超时/契约漂移）→ 500 INTERNAL_ERROR（不新增 code，
 *     Agent 必须能区分"我的 IR 错了"与"平台坏了"）
 *   - 两次 spawn 均 30s timeout；临时目录 finally 清理（覆盖 spawn 异常路径）
 *
 * [关联代码]
 *   - packages/diagram/renderers/<type>/render-<type>.mjs — CLI 渲染器（顶层执行）
 *   - packages/diagram/scripts/check-render-output.mjs — 静态 artifact 检查（stdout JSON）
 *   - diagram-renderer.service.spec.ts — mock runProcess 全分支单测
 *
 * [持久踩坑]
 *   - 渲染器不是库（render-*.mjs 顶层 await 即执行，import 即渲染）：禁止 import
 *     vendored 代码，只能 spawn 子进程；库化 = 永久 fork 活跃上游（plan §0 D12 拍板）
 *   - runProcess 是**私有方法包装**而非 promisify(execFile) 模块级常量——jest.mock
 *     模块替换会丢 execFile 的 util.promisify.custom（{stdout,stderr} 聚合），
 *     单测用 jest.spyOn(service, 'runProcess') 注入分支
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  ErrorCode,
  DIAGRAM_TYPES,
  type DiagramType,
  type DiagramRenderMeta,
  type DiagramDiagnostic,
} from '@agent-chamber/shared';

/**
 * 单次 spawn 超时（渲染器与 checker 相同）。
 *
 * rationale：渲染器是 CPU 纯计算（无网络/无子进程），正常渲染 <2s；30s 杀进程兜底
 * 防畸形 IR 触发病态布局循环。Node spawn timeout（≥v15）到点 SIGTERM；渲染器无孙
 * 进程，无孤儿风险（plan §3.2）。
 */
const SPAWN_TIMEOUT_MS = 30_000;

/** execFile stdout/stderr 缓冲上限（renderer stdout = 输出路径单行；checker stdout = JSON 报告，KB 级） */
const SPAWN_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * vendored 渲染器版本（render_meta.rendererVersion 的取值）。
 * 与 packages/diagram/NOTICE 的「版本」行同源——上游同步（重拷+重打补丁）时
 * 必须同步本常量；读 side 用它识别存量快照的新旧（plan §3.4：版本升级不主动重渲染）。
 */
const VENDORED_ARCHIFY_VERSION = '2.16.0-dev.0';

/** 合法 quality_profile 值域（packages/diagram/schemas/*.schema.json enum） */
const VALID_QUALITY_PROFILES = new Set(['standard', 'showcase']);

/**
 * 渲染产物（validateAndRender 成功返回）。
 * meta 即 docs.render_meta 落库对象；checks/composition 同时供 validate dry-run 响应。
 */
export interface DiagramRenderArtifacts {
  /** 自包含 HTML 快照全文（utf8） */
  html: string;
  /** 落库渲染元数据（docs.render_meta jsonb） */
  meta: DiagramRenderMeta;
  /** checker 逐条检查（含 details 散文指引——composition 阶段失败的修复依据） */
  checks: { name: string; ok: boolean; details?: string[] }[];
  /** 组合质量摘要（checker composition.summary） */
  composition: { errors: number; warnings: number };
}

/**
 * 子进程运行结果（永不 reject 的归一化形态——exit code / 超时杀 / spawn 错误
 * 全部落在字段上，调用点按字段分类，不在 catch 里猜 err 形状）。
 */
export interface DiagramProcResult {
  /** 进程退出码（正常退出/非零退出）；spawn 失败或被信号杀死时为 null */
  code: number | null;
  /** true = 超时被 SIGTERM 杀（execFile timeout 触发） */
  killed: boolean;
  /** 终止信号（如有） */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** spawn 级错误的字符串 code（如 'ENOENT'——node 二进制/脚本不可达） */
  spawnErrorCode?: string;
}

/**
 * 渲染门服务：IR → spawn vendored archify 渲染器 + checker → HTML 快照 + render_meta。
 *
 * 单写两次 spawn（plan §3.2）：直接调 render-<type>.mjs（绕过 bin 免一层进程），
 * 成功后跑 check-render-output.mjs 静态检查。调用方负责 IR parse/canonicalize/R3
 * 前置拒绝（upsertCore diagram 分支）；本服务拿到的 ir 必为合法 JSON 对象。
 */
@Injectable()
export class DiagramRendererService {
  /** packages/diagram 根目录（惰性解析缓存；解析失败 = 部署缺陷 → 500） */
  private diagramRoot: string | null = null;

  /**
   * 无构造参数（NestJS DI 纪律）：可选 string 参数的 design:paramtypes=[String] 会被
   * Nest 当 provider token 解析（mock e2e 全量 AppModule 编译期实测触发
   * cloneStaticInstance 无限递归崩栈）——特殊部署用 DIAGRAM_RENDERER_DIR env，
   * 单测用该 env 或 resolveDiagramRoot 探测。
   */
  constructor() {}

  /**
   * 校验 + 渲染（fail-closed）：任一阶段不过 → 抛 422/500，零残留。
   *
   * @param ir 解析后的 IR 对象（调用方已保证是 object 且 diagram_type 合法）
   * @param opts.qualityProfile IR meta.quality_profile 原值（缺省/非法 → R4 注入 'standard'）
   * @returns 渲染产物（html + meta + checks + composition）
   * @throws UnprocessableEntityException 422 DIAGRAM_VALIDATION_FAILED（IR 内容问题，
   *   data={stage, diagnostics, checks, composition, profile}）
   * @throws InternalServerErrorException 500（渲染器基础设施问题，不新增错误码）
   */
  async validateAndRender(
    ir: Record<string, unknown>,
    opts: { qualityProfile?: unknown } = {},
  ): Promise<DiagramRenderArtifacts> {
    const diagramType = ir.diagram_type as DiagramType;
    if (!DIAGRAM_TYPES.includes(diagramType)) {
      // 防御兜底（正常到不了——upsertCore 分支已校验 diagram_type ∈ 5 型）
      throw new InternalServerErrorException(
        `diagram renderer miswired: unknown diagram_type '${String(ir.diagram_type)}'`,
      );
    }
    // R4：profile 缺省/非法 → 显式注入 'standard'（env 恒设置，杜绝 geometry.mjs:639
    // 双缺跳过检查族的静默缺口）；生效值随 render_meta 落库
    const profile =
      typeof opts.qualityProfile === 'string' && VALID_QUALITY_PROFILES.has(opts.qualityProfile)
        ? opts.qualityProfile
        : 'standard';

    const root = this.resolveDiagramRoot();
    const renderScript = path.join(root, 'renderers', diagramType, `render-${diagramType}.mjs`);
    const checkScript = path.join(root, 'scripts', 'check-render-output.mjs');
    if (!fs.existsSync(renderScript) || !fs.existsSync(checkScript)) {
      // vendor 文件缺失 = 部署缺陷（packages/diagram 随 git pull 到场），非用户 IR 问题 → 500
      throw new InternalServerErrorException(
        'diagram renderer unavailable: vendored packages/diagram scripts missing (platform deployment issue; retry after re-deploy or escalate)',
      );
    }

    // 每次渲染独立 mkdtemp（并发渲染零共享状态，plan §8 R5）
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diagram-render-'));
    try {
      const inputPath = path.join(tmpDir, 'input.json');
      const outputPath = path.join(tmpDir, 'output.html');
      // 渲染器输入写规范化形态（与落库 content 同形——hash/diff/快照口径一致）
      await fs.promises.writeFile(inputPath, JSON.stringify(ir, null, 2), 'utf8');

      // M-a：env 整体替换语义 → 合并宿主环境；ARCHIFY_REPO_ROOT 显式剔除
      // （防宿主环境变量泄漏进渲染进程触发仓库文件读取，安全收口 plan §2.2 R3/§8 R7）
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARCHIFY_DIAGNOSTIC_FORMAT: 'json',
        ARCHIFY_QUALITY_PROFILE: profile,
        ARCHIFY_REPO_ROOT: undefined,
      };

      // ── 第一次 spawn：渲染器（schema 校验 + 几何校验 + HTML 产出）──
      const renderRes = await this.runProcess(renderScript, [inputPath, outputPath], env);
      if (renderRes.spawnErrorCode || renderRes.killed || renderRes.signal) {
        this.throwInfraFailure('renderer', renderRes);
      }
      if (renderRes.code !== 0) {
        // exit≠0：stderr 末尾 JSON receipt（diagnostics.mjs:103-116 boundary 产物）
        // → 422 透传 diagnostics；无 receipt → 422 兜底单条 render/failed 诊断
        const receipt = this.parseStderrReceipt(renderRes.stderr);
        if (receipt) {
          const stage = receipt.diagnostics.some((d) => d.code.startsWith('schema/'))
            ? 'schema'
            : 'render';
          throw new UnprocessableEntityException({
            message: `Diagram validation failed at ${stage} stage: ${receipt.error ?? receipt.diagnostics[0]?.message ?? 'renderer rejected the IR'}`,
            code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
            data: {
              stage,
              diagnostics: receipt.diagnostics,
              checks: [],
              composition: { errors: 0, warnings: 0 },
              profile,
            },
          });
        }
        const stderrTail = (renderRes.stderr || 'renderer exited non-zero').trim().slice(-500);
        throw new UnprocessableEntityException({
          message: `Diagram render process failed: ${stderrTail}`,
          code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
          data: {
            stage: 'render',
            diagnostics: [
              {
                code: 'render/failed',
                severity: 'error',
                message: stderrTail,
                supportedFixes: ['inspect the IR against the diagram schema and retry'],
              } satisfies DiagramDiagnostic,
            ],
            checks: [],
            composition: { errors: 0, warnings: 0 },
            profile,
          },
        });
      }

      // ── 第二次 spawn：artifact checker（纯静态 HTML 分析，无 Chrome 依赖）──
      // checker 检查不过时 exit 1 但 stdout 仍带完整 JSON 报告
      // （check-render-output.mjs:275-276 先 console.log 再 exit）——不按退出码分流，
      // 直接解析 stdout；解析失败才是契约漂移（500）
      const checkRes = await this.runProcess(checkScript, [outputPath], env);
      if (checkRes.spawnErrorCode || checkRes.killed || checkRes.signal) {
        this.throwInfraFailure('checker', checkRes);
      }
      const report = this.parseCheckerReport(checkRes.stdout);
      const checks = Array.isArray(report.checks) ? report.checks : [];
      const composition = this.readCompositionSummary(report);
      const issues = Array.isArray(report.composition?.issues)
        ? (report.composition.issues as Record<string, unknown>[])
        : [];

      // ── 门规则（plan §2.2，D7 profile 感知 + R2 字段路径）──
      // 1. checker 静态检查失败（single_svg/finite_svg/legend_clearance 等）→ 拒
      const failedChecks = checks.filter((c) => !c.ok);
      if (failedChecks.length > 0) {
        this.throwGateFailure(
          'composition',
          [
            ...failedChecks.map((c) => ({
              code: `check/${c.name}`,
              severity: 'error' as const,
              message:
                c.details && c.details.length > 0
                  ? c.details.join('; ')
                  : `artifact check '${c.name}' failed`,
              supportedFixes: [],
            })),
            ...this.issueDiagnostics(issues, 'error'),
          ],
          checks,
          composition,
          profile,
        );
      }
      // 2. composition errors 恒拒（R2：读 composition.summary——顶层无此字段）
      if (composition.errors > 0) {
        this.throwGateFailure(
          'composition',
          this.issueDiagnostics(issues, 'error'),
          checks,
          composition,
          profile,
        );
      }
      // 3. showcase 专属：warnings 也拒（对齐 archify showcase 验收 "0 errors and 0 warnings"）
      if (profile === 'showcase' && composition.warnings > 0) {
        this.throwGateFailure(
          'composition',
          this.issueDiagnostics(issues, 'warning'),
          checks,
          composition,
          profile,
        );
      }
      // 4. standard：warnings 不拒写，随 render_meta.composition 落库 + 响应返回

      const html = await fs.promises.readFile(outputPath, 'utf8');
      const htmlBytes = Buffer.byteLength(html, 'utf8');
      const meta: DiagramRenderMeta = {
        engine: 'archify',
        rendererVersion: VENDORED_ARCHIFY_VERSION,
        qualityProfile: profile,
        checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
        composition,
        renderedAt: new Date().toISOString(),
        htmlBytes,
        htmlSha256: createHash('sha256').update(html, 'utf8').digest('hex'),
      };
      return { html, meta, checks, composition };
    } finally {
      // 临时目录清理覆盖所有出口（含 spawn 异常路径；archify 自身同款先例
      // bin/archify.mjs:1526、:1590-1592）。清理失败只吞掉——/tmp 由 OS 兜底
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── 内部 ────────────────────────────────────────────────────

  /**
   * 子进程包装（单测 mock 点）：execFile(node, [script, ...args])，归一化为
   * 永不 reject 的 DiagramProcResult。超时 → killed=true/signal=SIGTERM；
   * spawn 失败（ENOENT 等字符串 code）→ spawnErrorCode。
   */
  private runProcess(
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<DiagramProcResult> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [script, ...args],
        { env, timeout: SPAWN_TIMEOUT_MS, maxBuffer: SPAWN_MAX_BUFFER, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ code: 0, killed: false, signal: null, stdout, stderr });
            return;
          }
          const e = err as Error & {
            code?: number | string;
            killed?: boolean;
            signal?: string;
          };
          resolve({
            code: typeof e.code === 'number' ? e.code : null,
            killed: e.killed ?? false,
            signal: e.signal ?? null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            spawnErrorCode: typeof e.code === 'string' ? e.code : undefined,
          });
        },
      );
    });
  }

  /**
   * 解析 packages/diagram 根目录：DIAGRAM_RENDERER_DIR env 优先；缺省从
   * cwd/__dirname 逐级向上探测含 packages/diagram/renderers 的目录
   * （先例：downloads.service.ts resolveDownloadsDir 对 dist-assets 的向上探测——
   * dev 下 backend cwd=apps/backend，生产/docker 下 cwd=repo 根，单点 resolve 不可靠）。
   */
  private resolveDiagramRoot(): string {
    if (this.diagramRoot) return this.diagramRoot;
    const explicit = process.env.DIAGRAM_RENDERER_DIR;
    if (explicit) {
      this.diagramRoot = path.resolve(process.cwd(), explicit);
      return this.diagramRoot;
    }
    for (const start of [process.cwd(), __dirname]) {
      let dir = start;
      for (let depth = 0; depth < 8; depth++) {
        const candidate = path.join(dir, 'packages', 'diagram');
        if (fs.existsSync(path.join(candidate, 'renderers'))) {
          this.diagramRoot = candidate;
          return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // 兜底（必然在后续 existsSync 检查报 500——部署缺陷不透出 422）
    this.diagramRoot = path.resolve(process.cwd(), 'packages', 'diagram');
    return this.diagramRoot;
  }

  /** 基础设施失败 → 500（渲染器不可用/超时；平台问题，Agent 侧重试或升级，非 IR 内容问题） */
  private throwInfraFailure(surface: string, res: DiagramProcResult): never {
    const detail = res.spawnErrorCode
      ? `spawn error ${res.spawnErrorCode}`
      : res.killed || res.signal
        ? `killed by ${res.signal ?? 'SIGTERM'} (timeout ${SPAWN_TIMEOUT_MS}ms)`
        : `exit ${res.code}`;
    throw new InternalServerErrorException(
      `diagram renderer unavailable at ${surface} (${detail}); platform issue — retry or escalate, this is not an IR content problem`,
    );
  }

  /**
   * 解析渲染器 stderr 末尾的 JSON receipt（diagnostics.mjs:103-116 的 boundary 把
   * uncaughtException 以单行 JSON 写 stderr 后 exit 1）。从尾部逐行向上找第一个
   * 可解析且带 diagnostics 数组的对象；找不到 → null。
   */
  private parseStderrReceipt(
    stderr: string,
  ): { error?: string; diagnostics: DiagramDiagnostic[] } | null {
    if (!stderr) return null;
    const lines = stderr.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as { ok?: boolean; error?: string; diagnostics?: unknown };
        if (obj && Array.isArray(obj.diagnostics) && obj.diagnostics.length > 0) {
          return { error: obj.error, diagnostics: obj.diagnostics as DiagramDiagnostic[] };
        }
      } catch {
        // 非 JSON 行，继续向上找
      }
    }
    return null;
  }

  /** checker stdout JSON 解析（主输出恒为 JSON，:275-276）；解析失败 = checker 契约漂移 → 500 */
  private parseCheckerReport(stdout: string): {
    ok?: boolean;
    checks?: { name: string; ok: boolean; details?: string[] }[];
    composition?: { summary?: { errors?: unknown; warnings?: unknown }; issues?: unknown[] };
  } {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new InternalServerErrorException(
        'diagram artifact checker returned unparseable output (contract drift); platform issue — retry or escalate',
      );
    }
  }

  /**
   * R2 钉死：errors/warnings 只从 composition.summary 读（顶层没有这两个字段——
   * 错取顶层得到 undefined > 0 恒 false，showcase 门静默失灵）。
   * summary 缺失/非数 = checker 契约漂移 → 500（fail-closed，绝不静默放行）。
   */
  private readCompositionSummary(report: {
    composition?: { summary?: { errors?: unknown; warnings?: unknown } };
  }): { errors: number; warnings: number } {
    const summary = report.composition?.summary;
    if (!summary || typeof summary.errors !== 'number' || typeof summary.warnings !== 'number') {
      throw new InternalServerErrorException(
        'diagram artifact checker output missing composition.summary.errors/warnings (contract drift); platform issue — retry or escalate',
      );
    }
    return { errors: summary.errors, warnings: summary.warnings };
  }

  /** checker composition.issues → 诊断数组（issue 无 message 字段，结构化字段进 evidence） */
  private issueDiagnostics(
    issues: Record<string, unknown>[],
    severity: 'error' | 'warning',
  ): DiagramDiagnostic[] {
    const matched = issues.filter((i) => i.severity === severity);
    return matched.map((issue) => {
      const { code, severity: _sev, ...evidence } = issue;
      void _sev;
      return {
        code: String(code ?? 'composition/issue'),
        severity,
        message: `${String(code ?? 'composition/issue')} — see evidence for locations/measurements`,
        evidence,
        supportedFixes: [],
      };
    });
  }

  /** 门拒绝统一出口：422 DIAGRAM_VALIDATION_FAILED + 完整修复凭据（含 checks/composition 供 validate dry-run 透传） */
  private throwGateFailure(
    stage: string,
    diagnostics: DiagramDiagnostic[],
    checks: { name: string; ok: boolean; details?: string[] }[],
    composition: { errors: number; warnings: number },
    profile: string,
  ): never {
    throw new UnprocessableEntityException({
      message: `Diagram validation failed at ${stage} stage: ${diagnostics[0]?.message ?? 'composition gate rejected'}${diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : ''}`,
      code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
      data: { stage, diagnostics, checks, composition, profile },
    });
  }
}
