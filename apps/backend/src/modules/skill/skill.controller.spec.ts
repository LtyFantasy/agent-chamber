/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §13. Skill 模块
 *   - 补充: ./agents/skills/agent-chamber/SKILL.md
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
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { SkillController } from './skill.controller';
import { SkillService } from './skill.service';
import { SkillDetailDto, SkillListItemDto } from './skill.dto';

describe('SkillController', () => {
  let controller: SkillController;
  let service: typeof mockService;

  const mockService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findSubSkill: jest.fn(),
    findSubSkills: jest.fn(),
    getRaw: jest.fn(),
    getSubRaw: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SkillController],
      providers: [{ provide: SkillService, useValue: mockService }],
    }).compile();

    controller = moduleRef.get<SkillController>(SkillController);
    service = moduleRef.get<SkillService>(SkillService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll and return result', async () => {
      const result: SkillListItemDto[] = [
        {
          name: 'agent-chamber',
          description: 'Agent collaboration platform guide.',
          version: '1.3.1',
          updatedAt: '2026-06-16',
        },
      ];
      service.findAll.mockResolvedValue(result);

      expect(await controller.findAll()).toBe(result);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return JSON detail when format is not raw', async () => {
      const detail: SkillDetailDto = {
        name: 'agent-chamber',
        description: 'Main skill.',
        version: '1.0.0',
        updatedAt: '2026-06-17',
        content: '# Main Skill\n',
      };
      service.findOne.mockResolvedValue(detail);

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      // JSON 分支返回 detail 由全局 ResponseInterceptor 包装（review-0831 任务
      // bbd175dc 子项 3：手工信封已删，controller 不再写 res.json）
      const result = await controller.findOne('agent-chamber', undefined as unknown as string, res);

      expect(service.findOne).toHaveBeenCalledWith('agent-chamber');
      expect(service.getRaw).not.toHaveBeenCalled();
      expect(result).toBe(detail);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should return raw markdown when format=raw', async () => {
      const rawContent = '# Raw Skill Content\n';
      service.getRaw.mockResolvedValue(rawContent);

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      await controller.findOne('agent-chamber', 'raw', res);

      expect(service.getRaw).toHaveBeenCalledWith('agent-chamber');
      expect(service.findOne).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith(rawContent);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should propagate NotFoundException from service', async () => {
      service.findOne.mockRejectedValue(new NotFoundException('Skill not found'));

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      await expect(
        controller.findOne('missing-skill', undefined as unknown as string, res),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findSubSkills', () => {
    it('should call service.findSubSkills and return result', async () => {
      const result: SkillListItemDto[] = [
        {
          name: 'taskboard',
          description: 'Task board skill.',
          version: '1.1.0',
          updatedAt: '2026-06-10',
        },
      ];
      service.findSubSkills.mockResolvedValue(result);

      expect(await controller.findSubSkills('agent-chamber')).toBe(result);
      expect(service.findSubSkills).toHaveBeenCalledWith('agent-chamber');
    });

    it('should propagate NotFoundException from service', async () => {
      service.findSubSkills.mockRejectedValue(new NotFoundException('Skill not found'));

      await expect(controller.findSubSkills('missing-skill')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findSubSkill', () => {
    it('should return JSON detail when format is not raw', async () => {
      const detail: SkillDetailDto = {
        name: 'taskboard',
        description: 'Task board skill.',
        version: '1.1.0',
        updatedAt: '2026-06-10',
        content: '# Taskboard\n',
      };
      service.findSubSkill.mockResolvedValue(detail);

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      // JSON 分支返回 detail 由全局 ResponseInterceptor 包装（review-0831 任务
      // bbd175dc 子项 3：手工信封已删，controller 不再写 res.json）
      const result = await controller.findSubSkill(
        'agent-chamber',
        'taskboard',
        undefined as unknown as string,
        res,
      );

      expect(service.findSubSkill).toHaveBeenCalledWith('agent-chamber', 'taskboard');
      expect(service.getSubRaw).not.toHaveBeenCalled();
      expect(result).toBe(detail);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should return raw markdown when format=raw', async () => {
      const rawContent = '# Raw Taskboard\n';
      service.getSubRaw.mockResolvedValue(rawContent);

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      await controller.findSubSkill('agent-chamber', 'taskboard', 'raw', res);

      expect(service.getSubRaw).toHaveBeenCalledWith('agent-chamber', 'taskboard');
      expect(service.findSubSkill).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith(rawContent);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should propagate NotFoundException from service', async () => {
      service.findSubSkill.mockRejectedValue(new NotFoundException('Skill not found'));

      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        json: jest.fn(),
      } as unknown as Response;

      await expect(
        controller.findSubSkill('agent-chamber', 'missing', undefined as unknown as string, res),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
