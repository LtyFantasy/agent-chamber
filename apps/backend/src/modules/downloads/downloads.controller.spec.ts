/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Downloads 分发端点
 *   - 补充: docs/roundtable-design.md §8c 最后一公里连接向导（P2 平台托管一键安装）
 *
 * [踩坑索引] D5(路径遍历)
 *
 * [铁律关联] #17(测试契约) #21(双层校验) #22(资源缺失 4xx)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: 文件名参数拼接路径 = 目录遍历。本 spec 覆盖 ../、绝对路径、白名单外
 *       三类攻击输入，断言一律 NotFoundException（见 downloads.service.ts）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, isAbsolute } from 'path';
import { DownloadsController } from './downloads.controller';
import { DownloadsService, resolveDownloadsDir } from './downloads.service';

/**
 * StreamableFile.getHeaders()（Nest 10.4）返回构造 options 的 { type, disposition,
 * length } 三元组（type 即 Content-Type，disposition 即 Content-Disposition 值，
 * length 即 Content-Length 数值）——用它验证响应头契约而不触碰私有字段。
 */
function headersOf(sf: StreamableFile): { type: string; disposition?: string; length?: number } {
  return sf.getHeaders() as unknown as { type: string; disposition?: string; length?: number };
}

/**
 * createReadStream 的 open 是异步的；jest 同步测试结束时若流尚未 open，
 * afterAll 删除临时目录会让 open 回调触发 ENOENT 崩溃。等待一个宏任务
 * 确保文件已打开（已 open 的流在文件被 unlink 后仍可正常读取）。
 */
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

describe('DownloadsController', () => {
  let controller: DownloadsController;
  let downloadsDir: string;

  beforeAll(() => {
    // DOWNLOADS_DIR 覆盖（铁律：目录取 env，单测注入临时目录验证覆盖生效）
    downloadsDir = mkdtempSync(join(tmpdir(), 'downloads-spec-'));
    writeFileSync(join(downloadsDir, 'install-runner.sh'), '#!/usr/bin/env bash\necho hi\n');
    writeFileSync(join(downloadsDir, 'roundtable-runner.tar.gz'), Buffer.alloc(64, 7));
    // 指南按真实产物布局放 integrations/ 子目录（build-runner-bundle.sh 同款）
    mkdirSync(join(downloadsDir, 'integrations'));
    writeFileSync(join(downloadsDir, 'integrations', 'kimi.md'), '# Kimi Guide\n');
    writeFileSync(join(downloadsDir, 'integrations', 'codex.md'), '# Codex Guide\n');
    writeFileSync(join(downloadsDir, 'integrations', 'kimi.zh-CN.md'), '# Kimi 指南\n');
    writeFileSync(join(downloadsDir, 'integrations', 'codex.zh-CN.md'), '# Codex 指南\n');
  });

  afterAll(() => {
    rmSync(downloadsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DownloadsController],
      providers: [
        // 真实 service + 临时目录：白名单/遍历/缺文件逻辑全部真实执行（不 mock）
        { provide: DownloadsService, useValue: new DownloadsService(downloadsDir) },
      ],
    }).compile();

    controller = moduleRef.get<DownloadsController>(DownloadsController);
  });

  describe('install-runner.sh（固定路由）', () => {
    it('白名单命中 → StreamableFile，shell Content-Type + attachment disposition', async () => {
      const sf = controller.getInstallRunnerScript();
      await tick();
      expect(sf).toBeInstanceOf(StreamableFile);
      const h = headersOf(sf);
      expect(h.type).toBe('text/x-shellscript; charset=utf-8');
      expect(h.disposition).toContain('attachment');
      expect(h.disposition).toContain('filename="install-runner.sh"');
    });
  });

  describe('roundtable-runner.tar.gz（固定路由）', () => {
    it('白名单命中 → application/gzip + attachment', async () => {
      const sf = controller.getRunnerBundle();
      await tick();
      expect(sf).toBeInstanceOf(StreamableFile);
      const h = headersOf(sf);
      expect(h.type).toBe('application/gzip');
      expect(h.disposition).toContain('attachment');
      expect(h.disposition).toContain('filename="roundtable-runner.tar.gz"');
      // 64 字节 mock 文件 → Content-Length 必须等于实际字节数
      expect(h.length).toBe(64);
    });
  });

  describe('integrations/:file（白名单路由）', () => {
    it('kimi.md 命中 → markdown Content-Type + attachment', async () => {
      const sf = controller.getIntegrationGuide('kimi.md');
      await tick();
      expect(sf).toBeInstanceOf(StreamableFile);
      const h = headersOf(sf);
      expect(h.type).toBe('text/markdown; charset=utf-8');
      expect(h.disposition).toContain('filename="kimi.md"');
    });

    it('codex.zh-CN.md 命中（zh-CN 变体也在白名单）', async () => {
      const sf = controller.getIntegrationGuide('codex.zh-CN.md');
      await tick();
      expect(headersOf(sf).type).toBe('text/markdown; charset=utf-8');
    });

    it('路径遍历 ../ → 404（不允许出目录）', () => {
      expect(() => controller.getIntegrationGuide('../.env')).toThrow(NotFoundException);
      expect(() => controller.getIntegrationGuide('../../etc/passwd')).toThrow(NotFoundException);
    });

    it('路径遍历 嵌套路径 → 404', () => {
      expect(() => controller.getIntegrationGuide('sub/kimi.md')).toThrow(NotFoundException);
      expect(() => controller.getIntegrationGuide('a\\b\\kimi.md')).toThrow(NotFoundException);
    });

    it('白名单外文件名 → 404（不暴露目录内容）', () => {
      expect(() => controller.getIntegrationGuide('evil.sh')).toThrow(NotFoundException);
      expect(() => controller.getIntegrationGuide('README.md')).toThrow(NotFoundException);
    });

    it('白名单内但文件缺失 → 404（铁律 #22：不裸 500）', () => {
      // codex.md 在临时目录里已创建，这里删除后重试；同时白名单内从未创建的
      // 文件也应 404——用 service 直接验证缺失场景
      const service = new DownloadsService(downloadsDir);
      expect(() => service.resolve('codex.md')).not.toThrow();
      // 用另一个临时空目录模拟「未构建 dist-assets」的生产场景
      const emptyDir = mkdtempSync(join(tmpdir(), 'downloads-empty-'));
      try {
        const emptyService = new DownloadsService(emptyDir);
        expect(() => emptyService.resolve('install-runner.sh')).toThrow(NotFoundException);
        expect(() => emptyService.resolve('kimi.md')).toThrow(NotFoundException);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('service 对固定资产同样做白名单校验（install-runner.sh 在 service 白名单内）', () => {
      const service = new DownloadsService(downloadsDir);
      const asset = service.resolve('install-runner.sh');
      expect(asset.absPath).toBe(join(downloadsDir, 'install-runner.sh'));
      expect(asset.contentType).toBe('text/x-shellscript; charset=utf-8');
    });
  });

  describe('DownloadsService 目录解析', () => {
    it('DOWNLOADS_DIR 显式覆盖（相对路径相对 cwd 解析）', () => {
      const prev = process.env.DOWNLOADS_DIR;
      try {
        process.env.DOWNLOADS_DIR = downloadsDir;
        const service = new DownloadsService();
        expect(service.resolve('kimi.md').absPath).toBe(join(downloadsDir, 'integrations', 'kimi.md'));
      } finally {
        if (prev === undefined) delete process.env.DOWNLOADS_DIR;
        else process.env.DOWNLOADS_DIR = prev;
      }
    });

    it('无 DOWNLOADS_DIR → 缺省解析到以 dist-assets 结尾的路径（repo 根）', () => {
      const prev = process.env.DOWNLOADS_DIR;
      try {
        delete process.env.DOWNLOADS_DIR;
        // 从下载模块目录向上探测，应能找到 cwd 起点下的候选；至少路径形态正确
        const dir = resolveDownloadsDir();
        expect(dir.endsWith('dist-assets')).toBe(true);
        // 仓库根真实存在 dist-assets 时才断言绝对路径（CI/构建未跑时跳过存在性）
        if (existsSync(dir)) {
          expect(isAbsolute(dir)).toBe(true);
        }
      } finally {
        if (prev === undefined) delete process.env.DOWNLOADS_DIR;
        else process.env.DOWNLOADS_DIR = prev;
      }
    });
  });
});
