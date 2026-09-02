/**
 * diagram.service.ts 单测（plan §6.1）：
 * - patchDiagram 入口幂等指纹 = patch payload（首成功 + 同 key 重试 → idempotentReplay，
 *   不因基准漂移误 409；同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT）
 * - expectedContentHash 必填缺失 → 400（service 层防御，DTO 之外的直调拦截）
 * - patch/validate 命中非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED（nit#5，不得报 422 parse）
 * - validate dry-run：ok/ok:false 两态 + 零副作用断言
 *
 * DocService 为方法级 mock（parseDiagramIr 用轻量真实实现：JSON.parse + diagram_type 读取，
 * 前置门本身的全分支由 doc.service.spec.ts 覆盖）；DiagramRendererService mock；
 * 幂等 repo 用内存对象模拟（findOne/save 捕获——helper 逻辑是真实代码）。
 */
import {
  BadRequestException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode, DOC_TYPE_DIAGRAM } from '@agent-chamber/shared';
import { DiagramService } from './diagram.service';
import type { DocService } from './doc.service';
import type { DiagramRendererService } from './diagram-renderer.service';
import type { Doc } from '../../database/entities/doc.entity';
import type { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import type { Repository } from 'typeorm';
import { ActorType } from '@agent-chamber/shared';

const IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Web App' },
  components: [
    { id: 'web', label: 'Web Frontend', pos: [0, 0] },
    { id: 'api', label: 'API Server', pos: [200, 0] },
    { id: 'db', label: 'PostgreSQL', pos: [400, 0] },
  ],
  connections: [],
};
const CANONICAL = JSON.stringify(IR, null, 2);

const testActor = { id: '00000000-0000-4000-8000-0000000000a2', type: ActorType.HUMAN };

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'doc-1',
    spaceId: 'space-1',
    path: 'docs/app.diagram.json',
    title: 'Web App',
    summary: 'architecture 图：Web App',
    docType: DOC_TYPE_DIAGRAM,
    diagramType: 'architecture',
    contentHash: 'a'.repeat(64),
    source: 'native',
    renderMeta: {
      engine: 'archify',
      rendererVersion: '2.16.0-dev.0',
      qualityProfile: 'standard',
      composition: { errors: 0, warnings: 0 },
      renderedAt: '2026-08-30T00:00:00.000Z',
      htmlBytes: 100,
      htmlSha256: 'b'.repeat(64),
    },
    ...overrides,
  } as Doc;
}

/** 轻量 parseDiagramIr：对齐真实实现的返回形状（前置门分支在 doc.service.spec 覆盖） */
function fakeParseDiagramIr(content: string) {
  const irObj = JSON.parse(content) as Record<string, unknown>;
  return {
    irObj,
    diagramType: irObj.diagram_type,
    canonical: JSON.stringify(irObj, null, 2),
  };
}

describe('DiagramService', () => {
  let service: DiagramService;
  let docService: {
    findById: jest.Mock;
    getContent: jest.Mock;
    upsertCore: jest.Mock;
    upsert: jest.Mock;
    parseDiagramIr: jest.Mock;
  };
  let renderer: { validateAndRender: jest.Mock };
  let idempotencyRepo: { findOne: jest.Mock; save: jest.Mock };
  let docRepo: { createQueryBuilder: jest.Mock };

  const artifacts = {
    html: '<html><svg></svg></html>',
    meta: {
      engine: 'archify' as const,
      rendererVersion: '2.16.0-dev.0',
      qualityProfile: 'standard',
      checks: [{ name: 'single_svg', ok: true }],
      composition: { errors: 0, warnings: 0 },
      renderedAt: '2026-08-30T01:00:00.000Z',
      htmlBytes: 26,
      htmlSha256: 'c'.repeat(64),
    },
    checks: [{ name: 'single_svg', ok: true, details: [] }],
    composition: { errors: 0, warnings: 0 },
  };

  beforeEach(() => {
    docService = {
      findById: jest.fn(),
      getContent: jest.fn().mockResolvedValue({ content: CANONICAL }),
      upsertCore: jest.fn(),
      upsert: jest.fn(),
      parseDiagramIr: jest.fn(fakeParseDiagramIr),
    };
    renderer = { validateAndRender: jest.fn().mockResolvedValue(artifacts) };
    idempotencyRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    docRepo = { createQueryBuilder: jest.fn() };
    service = new DiagramService(
      docService as unknown as DocService,
      renderer as unknown as DiagramRendererService,
      idempotencyRepo as unknown as Repository<IdempotencyRecord>,
      docRepo as unknown as Repository<Doc>,
    );
  });

  // ─── patchDiagram ──────────────────────────────────────────

  describe('patchDiagram', () => {
    const patches = [{ op: 'replace' as const, path: '/components/2/label', value: 'API 网关' }];

    function mockDiagramDocAndUpsert() {
      docService.findById.mockResolvedValue(makeDoc());
      docService.upsertCore.mockResolvedValue({
        id: 'doc-1',
        path: 'docs/app.diagram.json',
        sectionCount: 1,
        tokenEstimate: 200,
        created: false,
        contentHash: 'd'.repeat(64),
        diagramType: 'architecture',
        render: {
          renderedAt: artifacts.meta.renderedAt,
          rendererVersion: artifacts.meta.rendererVersion,
          qualityProfile: 'standard',
          htmlBytes: 26,
          htmlSha256: 'c'.repeat(64),
          composition: { errors: 0, warnings: 0 },
        },
      });
    }

    it('合法 patch → 应用后委托 upsertCore（versionSource=patch + 内部乐观锁），响应含 appliedPatches/diagramType/render', async () => {
      mockDiagramDocAndUpsert();
      const result = await service.patchDiagram(
        'doc-1',
        { patches, expectedContentHash: 'a'.repeat(64) },
        testActor,
      );

      // upsertCore 收到的 content = patch 后规范化 IR（label 已替换）
      const callArg = docService.upsertCore.mock.calls[0][1] as {
        content: string;
        versionSource: string;
        expectedContentHash: string;
      };
      const writtenIr = JSON.parse(callArg.content) as typeof IR;
      expect(writtenIr.components[2].label).toBe('API 网关');
      expect(callArg.versionSource).toBe('patch');
      expect(callArg.expectedContentHash).toBe('a'.repeat(64));
      expect(result.appliedPatches).toBe(1);
      expect(result.diagramType).toBe('architecture');
      expect(result.render?.htmlSha256).toBe('c'.repeat(64));
    });

    it('expectedContentHash 缺失 → 400 VALIDATION_ERROR（不得退化为无前提盲写）', async () => {
      await expect(
        service.patchDiagram(
          'doc-1',
          { patches, expectedContentHash: undefined as unknown as string },
          testActor,
        ),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
      expect(docService.findById).not.toHaveBeenCalled();
    });

    it('非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED（nit#5：不得撞 422 parse）', async () => {
      docService.findById.mockResolvedValue(makeDoc({ docType: 'note', diagramType: null }));
      await expect(
        service.patchDiagram('doc-1', { patches, expectedContentHash: 'a'.repeat(64) }, testActor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED },
      });
      expect(docService.getContent).not.toHaveBeenCalled();
    });

    it('坏 pointer → 422 DIAGRAM_PATCH_FAILED 带 {pointer, reason, supportedOps}', async () => {
      docService.findById.mockResolvedValue(makeDoc());
      await expect(
        service.patchDiagram(
          'doc-1',
          {
            patches: [{ op: 'replace' as const, path: '/components/9/label', value: 'x' }],
            expectedContentHash: 'a'.repeat(64),
          },
          testActor,
        ),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DIAGRAM_PATCH_FAILED,
          data: { pointer: '/components/9/label', supportedOps: ['replace', 'add', 'remove'] },
        },
      });
      expect(docService.upsertCore).not.toHaveBeenCalled();
    });

    it('入口幂等：指纹 = patch payload——首成功 + 同 key 重试 → idempotentReplay（不因基准漂移误 409）', async () => {
      mockDiagramDocAndUpsert();
      const dto = {
        patches,
        expectedContentHash: 'a'.repeat(64),
        clientRequestId: 'patch-001',
      };
      const first = await service.patchDiagram('doc-1', dto, testActor);
      expect(first.appliedPatches).toBe(1);
      expect(docService.upsertCore).toHaveBeenCalledTimes(1);
      // 捕获登记的幂等记录（快照 = 本入口响应含 appliedPatches）
      const record = idempotencyRepo.save.mock.calls[0][0] as {
        requestHash: string;
        responseSnapshot: Record<string, unknown>;
      };
      expect(record.responseSnapshot.appliedPatches).toBe(1);

      // 重试：基准已漂移（首次成功后 doc hash 已变），若指纹 = 派生全文会误 409——
      // 指纹 = patch payload，同 key 同 payload 必须干净重放
      idempotencyRepo.findOne.mockResolvedValue({
        entityType: 'doc',
        requestHash: record.requestHash,
        responseSnapshot: record.responseSnapshot,
      });
      const replay = await service.patchDiagram('doc-1', dto, testActor);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.appliedPatches).toBe(1);
      // 零副作用：不再进 upsertCore
      expect(docService.upsertCore).toHaveBeenCalledTimes(1);
    });

    it('同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      mockDiagramDocAndUpsert();
      await service.patchDiagram(
        'doc-1',
        { patches, expectedContentHash: 'a'.repeat(64), clientRequestId: 'patch-002' },
        testActor,
      );
      const record = idempotencyRepo.save.mock.calls[0][0] as { requestHash: string };
      idempotencyRepo.findOne.mockResolvedValue({
        entityType: 'doc',
        requestHash: record.requestHash,
        responseSnapshot: {},
      });
      await expect(
        service.patchDiagram(
          'doc-1',
          {
            patches: [{ op: 'replace' as const, path: '/components/0/label', value: '别的' }],
            expectedContentHash: 'a'.repeat(64),
            clientRequestId: 'patch-002',
          },
          testActor,
        ),
      ).rejects.toMatchObject({ response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT } });
    });
  });

  // ─── validateDiagram ──────────────────────────────────────

  describe('validateDiagram', () => {
    it('mode (a) 裸 IR：渲染门通过 → ok:true + checks/composition/profile；零副作用', async () => {
      const result = await service.validateDiagram('space-1', { ir: IR });
      expect(result.ok).toBe(true);
      expect(result.checks).toEqual(artifacts.checks);
      expect(result.composition).toEqual({ errors: 0, warnings: 0 });
      expect(result.profile).toBe('standard');
      // 零副作用断言：不写库、不登记幂等、不发版本
      expect(docService.upsert).not.toHaveBeenCalled();
      expect(docService.upsertCore).not.toHaveBeenCalled();
      expect(idempotencyRepo.save).not.toHaveBeenCalled();
    });

    it('mode (a) 渲染门 422 → ok:false + stage/diagnostics 修复凭据（仍零副作用）', async () => {
      renderer.validateAndRender.mockRejectedValue(
        new UnprocessableEntityException({
          message: 'gate failed',
          code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
          data: {
            stage: 'composition',
            diagnostics: [{ code: 'composition/proper-crossing', severity: 'error', message: 'x' }],
            checks: [{ name: 'single_svg', ok: true }],
            composition: { errors: 1, warnings: 0 },
            profile: 'showcase',
          },
        }),
      );
      const result = await service.validateDiagram('space-1', { ir: IR });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('composition');
      expect(result.diagnostics[0].code).toBe('composition/proper-crossing');
      expect(result.profile).toBe('showcase');
      expect(docService.upsertCore).not.toHaveBeenCalled();
    });

    it('mode (b) docId+patches：模拟 patch 后送渲染门（渲染器收到 patch 后 IR）', async () => {
      docService.findById.mockResolvedValue(makeDoc());
      const result = await service.validateDiagram('space-1', {
        docId: '00000000-0000-4000-8000-0000000000d1',
        patches: [{ op: 'replace' as const, path: '/components/0/label', value: 'CDN' }],
      });
      expect(result.ok).toBe(true);
      const renderedIr = renderer.validateAndRender.mock.calls[0][0] as typeof IR;
      expect(renderedIr.components[0].label).toBe('CDN');
    });

    it('mode (b) 命中非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED（nit#5）', async () => {
      docService.findById.mockResolvedValue(makeDoc({ docType: 'note', diagramType: null }));
      await expect(
        service.validateDiagram('space-1', { docId: '00000000-0000-4000-8000-0000000000d2' }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED } });
      expect(renderer.validateAndRender).not.toHaveBeenCalled();
    });

    it('模式互斥/缺失：ir+path 同传 → 400；全缺 → 400', async () => {
      await expect(
        service.validateDiagram('space-1', { ir: IR, path: 'docs/x.md' }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
      await expect(service.validateDiagram('space-1', {})).rejects.toMatchObject({
        response: { code: ErrorCode.VALIDATION_ERROR },
      });
      await expect(
        service.validateDiagram('space-1', {
          path: 'docs/x.md',
          docId: '00000000-0000-4000-8000-0000000000d3',
        }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
    });

    it('mode (b) path 通道：findDocByPath 定位（QB by space+path），坏 patch → 422 DIAGRAM_PATCH_FAILED', async () => {
      const doc = makeDoc();
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(doc),
      };
      docRepo.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.validateDiagram('space-1', {
          path: 'docs/app.diagram.json',
          patches: [{ op: 'remove' as const, path: '/nope' }],
        }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DIAGRAM_PATCH_FAILED } });
    });
  });

  // ─── readDiagram / getDiagramHtml 守卫 ─────────────────────

  describe('readDiagram 守卫', () => {
    function mockDocRepoGetOne(doc: Doc | null) {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(doc),
      };
      docRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED 指路 read_doc', async () => {
      mockDocRepoGetOne(makeDoc({ docType: 'note' }));
      await expect(service.readDiagram('doc-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED },
      });
    });

    it('diagram 但无快照（存量）→ 409 DIAGRAM_SNAPSHOT_MISSING 指路 re-upsert', async () => {
      mockDocRepoGetOne(makeDoc({ renderedHtml: null }));
      await expect(service.readDiagram('doc-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DIAGRAM_SNAPSHOT_MISSING },
      });
    });

    it('正常读取：返回解析后 IR 对象 + contentHash + render（addSelect 取隐藏列）', async () => {
      const qb = mockDocRepoGetOne(makeDoc({ renderedHtml: '<html><svg/></html>' }));
      const result = await service.readDiagram('doc-1');
      expect(qb.addSelect).toHaveBeenCalledWith('d.renderedHtml');
      expect(result.ir).toEqual(IR);
      expect(result.contentHash).toBe('a'.repeat(64));
      expect(result.render.qualityProfile).toBe('standard');
      expect(result.diagramType).toBe('architecture');
    });

    it('不存在 → 404 DOC_NOT_FOUND', async () => {
      mockDocRepoGetOne(null);
      await expect(service.readDiagram('doc-x')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── getDiagramHtml lang（读时视图语言，2026-08-30） ──────────

  describe('getDiagramHtml lang（读时视图语言）', () => {
    function mockSnapshotDoc(overrides: Partial<Doc> = {}) {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue(makeDoc({ renderedHtml: '<html>stored</html>', ...overrides })),
      };
      docRepo.createQueryBuilder.mockReturnValue(qb);
    }

    it('无 lang → 直出存储快照，渲染器零调用', async () => {
      mockSnapshotDoc();
      const result = await service.getDiagramHtml('doc-1');
      expect(result.html).toBe('<html>stored</html>');
      expect(result.langFallback).toBeUndefined();
      expect(renderer.validateAndRender).not.toHaveBeenCalled();
      expect(docService.getContent).not.toHaveBeenCalled();
    });

    it("lang 与存储 locale 一致（IR meta 无 locale 键视为 'en'）→ 直出存储快照", async () => {
      mockSnapshotDoc();
      const result = await service.getDiagramHtml('doc-1', 'en');
      expect(result.html).toBe('<html>stored</html>');
      expect(renderer.validateAndRender).not.toHaveBeenCalled();
    });

    it('lang 不同 → 覆盖 meta.locale 走写通道同门重渲染（qualityProfile 透传）', async () => {
      mockSnapshotDoc();
      const result = await service.getDiagramHtml('doc-1', 'zh-CN');
      expect(renderer.validateAndRender).toHaveBeenCalledWith(
        { ...IR, meta: { ...IR.meta, locale: 'zh-CN' } },
        { qualityProfile: 'standard' },
      );
      expect(result.html).toBe(artifacts.html);
      expect(result.langFallback).toBeUndefined();
    });

    it('重渲染门拒绝（422）→ 降级直出存储快照 + langFallback 标记', async () => {
      mockSnapshotDoc();
      renderer.validateAndRender.mockRejectedValue(
        new UnprocessableEntityException({ message: 'gate rejected' }),
      );
      const result = await service.getDiagramHtml('doc-1', 'zh-CN');
      expect(result.html).toBe('<html>stored</html>');
      expect(result.langFallback).toBe(true);
    });

    it('渲染基础设施故障（500）→ 同样降级（语言匹配失败 ≠ 图不可见）', async () => {
      mockSnapshotDoc();
      renderer.validateAndRender.mockRejectedValue(
        new InternalServerErrorException('renderer unavailable'),
      );
      const result = await service.getDiagramHtml('doc-1', 'zh-CN');
      expect(result.html).toBe('<html>stored</html>');
      expect(result.langFallback).toBe(true);
    });

    it('业务错误不吞（铁律 #9）：非 422/500 异常原样透出', async () => {
      mockSnapshotDoc();
      renderer.validateAndRender.mockRejectedValue(new BadRequestException('biz'));
      await expect(service.getDiagramHtml('doc-1', 'zh-CN')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
