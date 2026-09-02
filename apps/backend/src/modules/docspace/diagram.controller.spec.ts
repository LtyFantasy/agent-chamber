/**
 * diagram.controller.ts 单测：REST 装配层——权限接线（ensureCan read/write 分区）、
 * HTML 直出端点的 CSP/nosniff 头、doc 级路由的 space 反查权限链。
 * 业务语义全在 diagram.service.spec.ts / doc.service.spec.ts，本套件只测装配。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DiagramController } from './diagram.controller';
import { DiagramService } from './diagram.service';
import { DocService } from './doc.service';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ActorType, UserRole, Visibility } from '@agent-chamber/shared';
import { ForbiddenException } from '@nestjs/common';

describe('DiagramController', () => {
  let controller: DiagramController;

  const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
  const space = {
    id: 'space-1',
    name: 'Space',
    settings: { visibility: Visibility.OPEN },
    creatorId: 'user-1',
  };
  const doc = { id: 'doc-1', spaceId: 'space-1', docType: 'diagram' };

  const mockDiagramService = {
    upsertDiagram: jest.fn(),
    readDiagram: jest.fn(),
    getDiagramHtml: jest.fn(),
    patchDiagram: jest.fn(),
    validateDiagram: jest.fn(),
  };
  const mockDocService = { findById: jest.fn() };
  const mockDocSpaceService = { findById: jest.fn() };
  const mockPermService = { ensureCan: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDocSpaceService.findById.mockResolvedValue(space);
    mockDocService.findById.mockResolvedValue(doc);
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DiagramController],
      providers: [
        { provide: DiagramService, useValue: mockDiagramService },
        { provide: DocService, useValue: mockDocService },
        { provide: DocSpaceService, useValue: mockDocSpaceService },
        { provide: PermissionService, useValue: mockPermService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get<DiagramController>(DiagramController);
  });

  it('PUT diagrams：write 权限 + 委托 upsertDiagram', async () => {
    mockDiagramService.upsertDiagram.mockResolvedValue({ id: 'doc-1' });
    const dto = { path: 'docs/a.diagram.json', ir: { diagram_type: 'architecture' } };
    const result = await controller.upsertDiagram('space-1', dto as never, actor as never);
    expect(mockPermService.ensureCan).toHaveBeenCalledWith(space, actor, 'write');
    expect(mockDiagramService.upsertDiagram).toHaveBeenCalledWith('space-1', dto, actor);
    expect(result).toEqual({ id: 'doc-1' });
  });

  it('POST diagrams/validate：read 权限即可（dry-run 零副作用）', async () => {
    mockDiagramService.validateDiagram.mockResolvedValue({ ok: true });
    const dto = { ir: { diagram_type: 'workflow' } };
    await controller.validateDiagram('space-1', dto as never, actor as never);
    expect(mockPermService.ensureCan).toHaveBeenCalledWith(space, actor, 'read');
    expect(mockDiagramService.validateDiagram).toHaveBeenCalledWith('space-1', dto);
  });

  it('GET diagram：doc→space 反查后 read 权限', async () => {
    mockDiagramService.readDiagram.mockResolvedValue({ docId: 'doc-1' });
    await controller.readDiagram('doc-1', actor as never);
    expect(mockDocService.findById).toHaveBeenCalledWith('doc-1');
    expect(mockDocSpaceService.findById).toHaveBeenCalledWith('space-1');
    expect(mockPermService.ensureCan).toHaveBeenCalledWith(space, actor, 'read');
  });

  it('GET diagram.html：直出 text/html + CSP + nosniff 头', async () => {
    mockDiagramService.getDiagramHtml.mockResolvedValue({ html: '<html><svg/></html>', doc });
    const res = {
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    await controller.getDiagramHtml('doc-1', actor as never, {} as never, res as never);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:",
        'X-Content-Type-Options': 'nosniff',
      }),
    );
    expect(res.send).toHaveBeenCalledWith('<html><svg/></html>');
  });

  it('GET diagram.html：lang 透传 service；降级时带 X-Diagram-Lang-Fallback 头', async () => {
    mockDiagramService.getDiagramHtml.mockResolvedValue({
      html: '<html><svg/></html>',
      doc,
      langFallback: true,
    });
    const res = {
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    await controller.getDiagramHtml(
      'doc-1',
      actor as never,
      { lang: 'zh-CN' } as never,
      res as never,
    );
    expect(mockDiagramService.getDiagramHtml).toHaveBeenCalledWith('doc-1', 'zh-CN');
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'X-Diagram-Lang-Fallback': '1' }),
    );
  });

  it('GET diagram.html：正常重渲染（无降级）不带 fallback 头', async () => {
    mockDiagramService.getDiagramHtml.mockResolvedValue({ html: '<html/>', doc });
    const res = {
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    await controller.getDiagramHtml(
      'doc-1',
      actor as never,
      { lang: 'zh-CN' } as never,
      res as never,
    );
    const headers = res.set.mock.calls[0][0] as Record<string, string>;
    expect(headers['X-Diagram-Lang-Fallback']).toBeUndefined();
  });

  it('PATCH diagram：write 权限（doc→space 反查）', async () => {
    mockDiagramService.patchDiagram.mockResolvedValue({ id: 'doc-1', appliedPatches: 1 });
    const dto = {
      patches: [{ op: 'replace', path: '/meta/title', value: 'x' }],
      expectedContentHash: 'a'.repeat(64),
    };
    await controller.patchDiagram('doc-1', dto as never, actor as never);
    expect(mockPermService.ensureCan).toHaveBeenCalledWith(space, actor, 'write');
    expect(mockDiagramService.patchDiagram).toHaveBeenCalledWith('doc-1', dto, actor);
  });

  it('权限拒绝透传（铁律 #9：403 不包装成 500）', async () => {
    mockPermService.ensureCan.mockRejectedValue(new ForbiddenException('forbidden'));
    await expect(
      controller.upsertDiagram('space-1', {} as never, actor as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockDiagramService.upsertDiagram).not.toHaveBeenCalled();
  });
});
