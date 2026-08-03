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
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AvatarService } from './avatar.service';
import { Actor } from '../../database/entities/actor.entity';

describe('AvatarService', () => {
  let service: AvatarService;
  let mockActorRepo: jest.Mocked<Repository<Actor>>;

  /** 生成恰好 n 字节的合法 SVG（填充注释撑体积，用于 32KB 边界测试） */
  function makeSvgOfBytes(n: number): string {
    const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><!--';
    const suffix = '--></svg>';
    return prefix + 'a'.repeat(n - prefix.length - suffix.length) + suffix;
  }

  beforeEach(async () => {
    mockActorRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<Actor>>;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AvatarService,
        { provide: getRepositoryToken(Actor), useValue: mockActorRepo },
      ],
    }).compile();

    service = moduleRef.get<AvatarService>(AvatarService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadSvg — sanitize 拒绝路径', () => {
    it('should reject document not starting with <svg root', async () => {
      await expect(service.uploadSvg('a1', '<div>not svg</div>')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.uploadSvg('a1', '  <html><svg></svg></html>')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockActorRepo.save).not.toHaveBeenCalled();
    });

    it('should reject SVG containing <script', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      await expect(service.uploadSvg('a1', svg)).rejects.toThrow(BadRequestException);
    });

    it('should reject SVG containing foreignObject (case-insensitive)', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body/></foreignObject></svg>';
      await expect(service.uploadSvg('a1', svg)).rejects.toThrow(BadRequestException);
    });

    it('should reject SVG containing on*= event handler attributes', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
      await expect(service.uploadSvg('a1', svg)).rejects.toThrow(BadRequestException);
      const svg2 = '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick = "x()"/></svg>';
      await expect(service.uploadSvg('a1', svg2)).rejects.toThrow(BadRequestException);
    });

    it('should reject external href values (http/https)', async () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/x.png"/></svg>';
      await expect(service.uploadSvg('a1', svg)).rejects.toThrow(BadRequestException);
    });

    it('should reject javascript: and data: href values', async () => {
      const svgJs = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>';
      await expect(service.uploadSvg('a1', svgJs)).rejects.toThrow(BadRequestException);
      const svgData = '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href=\'data:text/html,x\'/></svg>';
      await expect(service.uploadSvg('a1', svgData)).rejects.toThrow(BadRequestException);
    });

    it('should reject SVG larger than 32KB and accept exactly 32KB', async () => {
      const actor = new Actor();
      actor.id = 'a1';
      mockActorRepo.findOne.mockResolvedValue(actor);

      const oversized = makeSvgOfBytes(32 * 1024 + 1);
      await expect(service.uploadSvg('a1', oversized)).rejects.toThrow(BadRequestException);

      const exact = makeSvgOfBytes(32 * 1024);
      await expect(service.uploadSvg('a1', exact)).resolves.toEqual({
        avatarUrl: '/api/v1/avatars/a1.svg',
      });
    });
  });

  describe('uploadSvg — 合法输入', () => {
    it('should accept SVG with leading whitespace and <?xml declaration', async () => {
      const actor = new Actor();
      actor.id = 'a1';
      mockActorRepo.findOne.mockResolvedValue(actor);

      const svg = '  <?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const result = await service.uploadSvg('a1', svg);
      expect(result).toEqual({ avatarUrl: '/api/v1/avatars/a1.svg' });
      expect(actor.avatarSvg).toBe(svg);
      expect(actor.avatarUrl).toBe('/api/v1/avatars/a1.svg');
      expect(mockActorRepo.save).toHaveBeenCalledWith(actor);
    });

    it('should accept internal fragment href (#...) in both href and xlink:href forms', async () => {
      const actor = new Actor();
      actor.id = 'a1';
      mockActorRepo.findOne.mockResolvedValue(actor);

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p"/></defs><use href="#p"/><use xlink:href="#p"/></svg>';
      await expect(service.uploadSvg('a1', svg)).resolves.toEqual({
        avatarUrl: '/api/v1/avatars/a1.svg',
      });
    });

    it('should update avatarUrl linkage on successful upload', async () => {
      const actor = new Actor();
      actor.id = 'actor-42';
      actor.avatarUrl = 'https://old.example.com/avatar.png';
      mockActorRepo.findOne.mockResolvedValue(actor);

      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
      const result = await service.uploadSvg('actor-42', svg);

      expect(result.avatarUrl).toBe('/api/v1/avatars/actor-42.svg');
      expect(actor.avatarUrl).toBe('/api/v1/avatars/actor-42.svg');
      expect(actor.avatarSvg).toBe(svg);
    });
  });

  describe('uploadSvg — 资源存在性', () => {
    it('should throw NotFoundException when actor does not exist', async () => {
      mockActorRepo.findOne.mockResolvedValue(null);

      await expect(
        service.uploadSvg('missing', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ).rejects.toThrow(NotFoundException);
      expect(mockActorRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('getSvg', () => {
    it('should return stored SVG source', async () => {
      const actor = new Actor();
      actor.id = 'a1';
      actor.avatarSvg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
      mockActorRepo.findOne.mockResolvedValue(actor);

      await expect(service.getSvg('a1')).resolves.toBe(actor.avatarSvg);
    });

    it('should throw NotFoundException when actor does not exist', async () => {
      mockActorRepo.findOne.mockResolvedValue(null);
      await expect(service.getSvg('missing')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when actor has no SVG avatar set', async () => {
      const actor = new Actor();
      actor.id = 'a1';
      actor.avatarSvg = null;
      mockActorRepo.findOne.mockResolvedValue(actor);
      await expect(service.getSvg('a1')).rejects.toThrow(NotFoundException);
    });
  });
});
