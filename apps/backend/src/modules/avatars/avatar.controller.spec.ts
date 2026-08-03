/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Avatars（Wave 3 补充契约）
 *
 * [踩坑索引]
 *
 * [铁律关联] #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UnifiedActor } from '../../common/types/actor.types';
import { ActorType } from '@agent-chamber/shared';

describe('AvatarController', () => {
  let controller: AvatarController;
  let service: typeof mockService;

  const mockService = {
    uploadSvg: jest.fn(),
    getSvg: jest.fn(),
  };

  const mockActor: UnifiedActor = {
    id: '9f8e7d6c-0000-4000-8000-000000000001',
    type: ActorType.AGENT,
    name: 'Test Agent',
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AvatarController],
      providers: [{ provide: AvatarService, useValue: mockService }],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<AvatarController>(AvatarController);
    service = moduleRef.get<AvatarService>(AvatarService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadSvg', () => {
    it('should call service.uploadSvg with current actor id and dto.svg', async () => {
      const result = { avatarUrl: `/api/v1/avatars/${mockActor.id}.svg` };
      service.uploadSvg.mockResolvedValue(result);

      const dto = { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
      expect(await controller.uploadSvg(mockActor, dto)).toBe(result);
      expect(service.uploadSvg).toHaveBeenCalledWith(mockActor.id, dto.svg);
    });
  });

  describe('serveSvg', () => {
    it('should send raw SVG with image/svg+xml content type and cache header', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
      service.getSvg.mockResolvedValue(svg);

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      await controller.serveSvg(mockActor.id, res);

      expect(service.getSvg).toHaveBeenCalledWith(mockActor.id);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
      expect(res.send).toHaveBeenCalledWith(svg);
      // 不得走 JSON 包装路径
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should propagate NotFoundException when actor has no SVG avatar', async () => {
      service.getSvg.mockRejectedValue(new NotFoundException('Avatar not found'));

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;

      await expect(controller.serveSvg(mockActor.id, res)).rejects.toThrow(NotFoundException);
      expect(res.send).not.toHaveBeenCalled();
    });
  });

  describe('JwtOrApiKeyGuard — 未认证路径', () => {
    /**
     * 直接实例化真实 Guard（mock 其全部依赖），验证无 Authorization / X-API-Key
     * 时抛出 401，确保 PUT 端点的认证语义来自 Guard 而非偶然。
     */
    it('should throw 401 UnauthorizedException when no credentials are provided', async () => {
      const guard = new JwtOrApiKeyGuard(
        { verify: jest.fn() } as never,
        { get: jest.fn() } as never,
        { findOne: jest.fn() } as never,
        { findOne: jest.fn() } as never,
        { findOne: jest.fn() } as never,
      );
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {} }),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });
});
