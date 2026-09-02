/**
 * diagram-renderer.service.ts 单测（plan §6.1）：jest.spyOn 私有 runProcess 注入分支——
 * 422 receipt 映射 / 非 JSON stderr 兜底 / ENOENT·超时 500 / 临时目录 finally 清理 /
 * env 合并语义（M-a）/ quality_profile 缺省注入（R4）/ composition.summary 门（R2 回归）。
 *
 * 进程层全部为 mock（真实渲染器链路归 docspace-diagram e2e 覆盖）；写盘真实
 * （mock 的 render 成功路径会真写 output.html，验证 finally 清理真实发生）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnprocessableEntityException, InternalServerErrorException } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { DiagramRendererService, type DiagramProcResult } from './diagram-renderer.service';

/** 真实 packages/diagram 根（existsSync 前置检查要过；不会真 spawn——runProcess 已 mock） */
const DIAGRAM_ROOT = path.resolve(__dirname, '../../../../../packages/diagram');

const VALID_IR: Record<string, unknown> = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'T' },
  components: [],
  connections: [],
};

/** checker 报告工厂（形状对齐 check-render-output.mjs stdout 主输出） */
function checkerReport(overrides: {
  checks?: { name: string; ok: boolean; details?: string[] }[];
  summary?: { errors: number; warnings: number };
  issues?: Record<string, unknown>[];
}) {
  return {
    ok: true,
    file: 'output.html',
    checks: overrides.checks ?? [{ name: 'single_svg', ok: true, details: [] }],
    composition: {
      schemaVersion: 1,
      profile: 'standard',
      status: (overrides.summary?.errors ?? 0) > 0 ? 'fail' : 'pass',
      summary: overrides.summary ?? { errors: 0, warnings: 0 },
      metrics: {},
      suggestedLimits: {},
      issues: overrides.issues ?? [],
    },
  };
}

function okResult(stdout = ''): DiagramProcResult {
  return { code: 0, killed: false, signal: null, stdout, stderr: '' };
}

describe('DiagramRendererService.validateAndRender', () => {
  let service: DiagramRendererService;
  // 私有方法 spyOn（jest 泛型与参数元组类型摩擦，用非参数化 SpyInstance + 实现内类型断言）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runProcess: jest.SpyInstance<any, any>;

  beforeEach(() => {
    // 渲染器根目录经 env 注入（服务无构造参数——NestJS DI 纪律，见服务头注释）
    process.env.DIAGRAM_RENDERER_DIR = DIAGRAM_ROOT;
    service = new DiagramRendererService();
    runProcess = jest.spyOn(service as never, 'runProcess' as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DIAGRAM_RENDERER_DIR;
  });

  /** render 成功（真写 output.html）+ checker 返回指定报告的 mock 组合 */
  function mockSuccess(checkerStdout: string) {
    const tmpDirs: string[] = [];
    runProcess.mockImplementation(async (script: string, args: string[]) => {
      // 先匹配 checker——'check-render-output.mjs' 同样含 'render-' 子串，顺序反了
      // 会把 checker 调用误进渲染分支（args 只有 1 元素，args[1] undefined）
      if (script.includes('check-render-output')) {
        return okResult(checkerStdout);
      }
      tmpDirs.push(path.dirname(args[0]));
      fs.writeFileSync(args[1], '<html><body><svg></svg></body></html>');
      return okResult(args[1]);
    });
    return { tmpDirs };
  }

  // ─── 成功路径 ─────────────────────────────────────────────

  it('成功：返回 html/meta/checks/composition，meta 含 engine/rendererVersion/注入后 profile/htmlSha256', async () => {
    mockSuccess(JSON.stringify(checkerReport({ summary: { errors: 0, warnings: 2 } })));
    const out = await service.validateAndRender(VALID_IR, { qualityProfile: 'standard' });
    expect(out.html).toContain('<svg>');
    expect(out.meta.engine).toBe('archify');
    expect(out.meta.rendererVersion).toBe('2.16.0-dev.0');
    expect(out.meta.qualityProfile).toBe('standard');
    // standard 下 warnings 不拒写，但随 render_meta.composition 落库（plan §2.2 门规则 5）
    expect(out.meta.composition).toEqual({ errors: 0, warnings: 2 });
    expect(out.meta.htmlBytes).toBe(Buffer.byteLength(out.html, 'utf8'));
    expect(out.meta.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.meta.checks).toEqual([{ name: 'single_svg', ok: true }]);
  });

  it('临时目录 finally 清理（成功路径）', async () => {
    const { tmpDirs } = mockSuccess(JSON.stringify(checkerReport({})));
    await service.validateAndRender(VALID_IR);
    expect(tmpDirs.length).toBe(1);
    expect(tmpDirs[0].startsWith(path.join(os.tmpdir(), 'diagram-render-'))).toBe(true);
    expect(fs.existsSync(tmpDirs[0])).toBe(false);
  });

  it('临时目录 finally 清理（渲染失败路径同样覆盖）', async () => {
    const tmpDirs: string[] = [];
    runProcess.mockImplementation(async (script: string, args: string[]) => {
      tmpDirs.push(path.dirname(args[0]));
      return { code: 1, killed: false, signal: null, stdout: '', stderr: 'boom (non-JSON)' };
    });
    await expect(service.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(fs.existsSync(tmpDirs[0])).toBe(false);
  });

  // ─── M-a env 合并语义 + R4 profile 注入 ────────────────────

  it('env 合并：{...process.env, ARCHIFY_DIAGNOSTIC_FORMAT:json, ARCHIFY_QUALITY_PROFILE:profile, ARCHIFY_REPO_ROOT 显式剔除}', async () => {
    // 宿主环境预埋一个泄漏源：必须被显式剔除，不得传进渲染进程
    process.env.ARCHIFY_REPO_ROOT = '/etc/passwd-ish';
    const envs: NodeJS.ProcessEnv[] = [];
    runProcess.mockImplementation(
      async (script: string, args: string[], env: NodeJS.ProcessEnv) => {
        envs.push(env);
        if (script.includes('check-render-output')) {
          return okResult(JSON.stringify(checkerReport({})));
        }
        fs.writeFileSync(args[1], '<html><svg></svg></html>');
        return okResult();
      },
    );
    try {
      await service.validateAndRender(VALID_IR, { qualityProfile: 'showcase' });
    } finally {
      delete process.env.ARCHIFY_REPO_ROOT;
    }
    expect(envs.length).toBe(2);
    for (const env of envs) {
      expect(env.ARCHIFY_DIAGNOSTIC_FORMAT).toBe('json');
      expect(env.ARCHIFY_QUALITY_PROFILE).toBe('showcase');
      // 显式剔除（M-a）：key 存在但值为 undefined（spawn 时不传子进程），而非透传宿主值
      expect('ARCHIFY_REPO_ROOT' in env).toBe(true);
      expect(env.ARCHIFY_REPO_ROOT).toBeUndefined();
      // 宿主环境其余变量合并保留（env 选项是整体替换，不合并会丢 PATH/HOME）
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  it.each([
    ['缺省（undefined）', undefined],
    ['非法值', 'ultra'],
  ])('R4：quality_profile %s → 注入 standard 且 env 恒设置', async (_label, profile) => {
    const envs: NodeJS.ProcessEnv[] = [];
    runProcess.mockImplementation(
      async (script: string, args: string[], env: NodeJS.ProcessEnv) => {
        envs.push(env);
        if (script.includes('check-render-output')) {
          return okResult(JSON.stringify(checkerReport({})));
        }
        fs.writeFileSync(args[1], '<html><svg></svg></html>');
        return okResult();
      },
    );
    const out = await service.validateAndRender(VALID_IR, { qualityProfile: profile });
    // render_meta 记录注入后的生效值（R4）
    expect(out.meta.qualityProfile).toBe('standard');
    for (const env of envs) {
      expect(env.ARCHIFY_QUALITY_PROFILE).toBe('standard');
    }
  });

  // ─── 渲染器失败分支 ───────────────────────────────────────

  it('exit≠0 + stderr JSON receipt → 422 逐字段透传 diagnostics，stage=schema（code 前缀 schema/）', async () => {
    const receipt = {
      schemaVersion: 1,
      ok: false,
      source: 'renderer',
      error: 'architecture schema validation failed',
      diagnostics: [
        {
          code: 'schema/type',
          severity: 'error',
          message: '/components/0/label must be string',
          subject: { diagramType: 'architecture', path: '/components/0/label', identity: 'x' },
          evidence: { keyword: 'type', type: 'string' },
          supportedFixes: ['use "string" at /components/0/label'],
        },
      ],
    };
    runProcess.mockResolvedValue({
      code: 1,
      killed: false,
      signal: null,
      stdout: '',
      stderr: `some noise line\n${JSON.stringify(receipt)}\n`,
    });
    try {
      await service.validateAndRender(VALID_IR);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const res = (err as UnprocessableEntityException).getResponse() as {
        code: number;
        data: { stage: string; diagnostics: unknown[] };
      };
      expect(res.code).toBe(ErrorCode.DIAGRAM_VALIDATION_FAILED);
      expect(res.data.stage).toBe('schema');
      // 逐字段透传（修复凭据零损耗）
      expect(res.data.diagnostics).toEqual(receipt.diagnostics);
    }
  });

  it('exit≠0 + receipt 无 schema/ 前缀 → stage=render', async () => {
    const receipt = {
      ok: false,
      error: 'layout failed',
      diagnostics: [
        { code: 'layout/constraint', severity: 'error', message: 'overlap', supportedFixes: [] },
      ],
    };
    runProcess.mockResolvedValue({
      code: 1,
      killed: false,
      signal: null,
      stdout: '',
      stderr: JSON.stringify(receipt),
    });
    await expect(service.validateAndRender(VALID_IR)).rejects.toMatchObject({
      response: { code: ErrorCode.DIAGRAM_VALIDATION_FAILED, data: { stage: 'render' } },
    });
  });

  it('exit≠0 + stderr 非 JSON → 422 兜底单条 render/failed 诊断', async () => {
    runProcess.mockResolvedValue({
      code: 1,
      killed: false,
      signal: null,
      stdout: '',
      stderr: 'Error: something exploded\n    at stack...',
    });
    try {
      await service.validateAndRender(VALID_IR);
      fail('should have thrown');
    } catch (err) {
      const res = (err as UnprocessableEntityException).getResponse() as {
        code: number;
        data: { stage: string; diagnostics: { code: string; message: string }[] };
      };
      expect(res.code).toBe(ErrorCode.DIAGRAM_VALIDATION_FAILED);
      expect(res.data.stage).toBe('render');
      expect(res.data.diagnostics).toHaveLength(1);
      expect(res.data.diagnostics[0].code).toBe('render/failed');
      expect(res.data.diagnostics[0].message).toContain('something exploded');
    }
  });

  it('spawn ENOENT → 500 INTERNAL（不带新 code）', async () => {
    runProcess.mockResolvedValue({
      code: null,
      killed: false,
      signal: null,
      stdout: '',
      stderr: '',
      spawnErrorCode: 'ENOENT',
    });
    try {
      await service.validateAndRender(VALID_IR);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect((err as InternalServerErrorException).getResponse()).not.toMatchObject({
        code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
      });
    }
  });

  it('超时被杀（killed/SIGTERM）→ 500', async () => {
    runProcess.mockResolvedValue({
      code: null,
      killed: true,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });
    await expect(service.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('checker 超时 → 500', async () => {
    runProcess.mockImplementation(async (script: string, args: string[]) => {
      if (script.includes('check-render-output')) {
        return { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' };
      }
      // render 成功（真写 output.html）
      fs.writeFileSync(args[1], '<html><svg></svg></html>');
      return okResult();
    });
    await expect(service.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  // ─── checker 门规则（R2 回归）──────────────────────────────

  it('R2 回归：composition.summary.errors>0 → 422 stage=composition（顶层无 errors/warnings 字段不得误判通过）', async () => {
    // 报告刻意只在 summary 下放 errors（真实 checker 形状），顶层不放——
    // 若实现错读 report.errors / report.composition.errors（undefined > 0 恒 false）会静默放行
    const report = checkerReport({
      summary: { errors: 2, warnings: 0 },
      issues: [
        { severity: 'error', code: 'composition/proper-crossing', point: [10, 20] },
        { severity: 'error', code: 'composition/container-border-run', side: 'left' },
      ],
    });
    mockSuccess(JSON.stringify(report));
    try {
      await service.validateAndRender(VALID_IR, { qualityProfile: 'showcase' });
      fail('should have thrown');
    } catch (err) {
      const res = (err as UnprocessableEntityException).getResponse() as {
        code: number;
        data: { stage: string; diagnostics: { code: string }[] };
      };
      expect(res.code).toBe(ErrorCode.DIAGRAM_VALIDATION_FAILED);
      expect(res.data.stage).toBe('composition');
      expect(res.data.diagnostics.map((d) => d.code)).toEqual([
        'composition/proper-crossing',
        'composition/container-border-run',
      ]);
    }
  });

  it('summary.errors=0 但 checker 静态检查失败（single_svg 等）→ 422 stage=composition', async () => {
    mockSuccess(
      JSON.stringify(
        checkerReport({
          checks: [{ name: 'single_svg', ok: false, details: ['found 0 <svg> block(s)'] }],
        }),
      ),
    );
    try {
      await service.validateAndRender(VALID_IR);
      fail('should have thrown');
    } catch (err) {
      const res = (err as UnprocessableEntityException).getResponse() as {
        data: { stage: string; diagnostics: { code: string; message: string }[] };
      };
      expect(res.data.stage).toBe('composition');
      expect(res.data.diagnostics[0].code).toBe('check/single_svg');
      expect(res.data.diagnostics[0].message).toContain('found 0');
    }
  });

  it('showcase 门：warnings>0 拒（standard 不拒——profile 感知，D7）', async () => {
    const report = JSON.stringify(
      checkerReport({
        summary: { errors: 0, warnings: 1 },
        issues: [{ severity: 'warning', code: 'composition/ambiguous-corridor' }],
      }),
    );
    // standard：通过
    mockSuccess(report);
    const ok = await service.validateAndRender(VALID_IR, { qualityProfile: 'standard' });
    expect(ok.meta.composition.warnings).toBe(1);
    // showcase：拒
    jest.restoreAllMocks();
    runProcess = jest.spyOn(service as never, 'runProcess' as never);
    mockSuccess(report);
    await expect(
      service.validateAndRender(VALID_IR, { qualityProfile: 'showcase' }),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
        data: { stage: 'composition', diagnostics: [{ code: 'composition/ambiguous-corridor' }] },
      },
    });
  });

  it('composition.summary 缺失（契约漂移）→ 500 fail-closed（绝不静默放行）', async () => {
    mockSuccess(JSON.stringify({ ok: true, checks: [{ name: 'single_svg', ok: true }] }));
    await expect(service.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('checker stdout 非 JSON（契约漂移）→ 500', async () => {
    mockSuccess('not json at all');
    await expect(service.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('vendored 脚本缺失（错误渲染器目录）→ 500 部署缺陷', async () => {
    process.env.DIAGRAM_RENDERER_DIR = path.join(os.tmpdir(), 'no-such-diagram-root');
    const broken = new DiagramRendererService();
    await expect(broken.validateAndRender(VALID_IR)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
