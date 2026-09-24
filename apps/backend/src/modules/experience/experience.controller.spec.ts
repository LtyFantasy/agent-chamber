import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ExperienceController } from './experience.controller';
import { ExperienceService } from './experience.service';
import { ExperienceMemberService } from './experience-member.service';
import { ExperienceJudgmentService } from './experience-judgment.service';
import type { AddExperienceMemberDto, QueryExperienceDto, UpdateExperienceMemberRoleDto } from './dto';
import type { Request, Response } from 'express';

/**
 * 端点权限契约（plan §2.2「守卫布局」+ §8「controller spec：新守卫链 + 字面量路由顺序」）。
 *
 * ⚠️ **覆盖变更记录（第二期批 2）**：旧版这里有一整块"真实 RolesGuard 实例（终审端点）"
 * 用例（admin 放行 / 非 admin 403 / agent 403-1009）。终审端点拆除三元组后**该覆盖被放弃**，
 * 由 `experience-member.service.spec.ts` 的八态矩阵 + e2e 的角色矩阵等价替代——终审资格
 * 现在是**数据驱动**的（成员表 + 四态矩阵），RolesGuard 那套"身份类别"语义已不存在。
 * 保留的断言 = ① 元数据反射证明逐方法声明了守卫；② 所有端点守卫组合一致（无 @Roles 残留）。
 */
describe('ExperienceController', () => {
  let controller: ExperienceController;
  const mockService = {
    create: jest.fn(),
    search: jest.fn(),
    facets: jest.fn(),
    findOne: jest.fn(),
    recordFeedback: jest.fn(),
    update: jest.fn(),
    reviewQuality: jest.fn(),
    remove: jest.fn(),
  };
  const mockMemberService = {
    listMembers: jest.fn(),
    addMember: jest.fn(),
    updateMemberRole: jest.fn(),
    removeMember: jest.fn(),
  };
  const mockJudgmentService = { listJudgments: jest.fn() };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ExperienceController],
      providers: [
        { provide: ExperienceService, useValue: mockService },
        { provide: ExperienceMemberService, useValue: mockMemberService },
        { provide: ExperienceJudgmentService, useValue: mockJudgmentService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<ExperienceController>(ExperienceController);
  });

  afterEach(() => jest.clearAllMocks());

  /** 取某方法上声明的守卫类名 */
  function guardNames(handler: unknown): string[] {
    const guards = (Reflect.getMetadata('__guards__', handler as object) ?? []) as Array<{
      name?: string;
      constructor?: { name?: string };
    }>;
    return guards.map((g) => g?.name ?? g?.constructor?.name ?? '');
  }

  /** 全部 12 个端点的方法名（少一个就是契约缺口） */
  const ALL_ENDPOINTS = [
    // 条目面（第一期 8）
    'create',
    'findAll',
    'facets',
    'findOne',
    'feedback',
    'update',
    'reviewQuality',
    'remove',
    // 成员面（第二期 4）
    'listMembers',
    'addMember',
    'updateMemberRole',
    'removeMember',
    // 判断日志（第二期批 3）
    'listJudgments',
  ] as const;

  // ─── ① 逐方法守卫链 ─────────────────────────────────────────────

  it('类级**不挂任何**守卫（否则后来新增的端点会静默继承不属于它的守卫组合）', () => {
    expect(Reflect.getMetadata('__guards__', ExperienceController)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, ExperienceController)).toBeUndefined();
  });

  it('全部 13 端点逐一声明 JwtOrApiKeyGuard（方法级，禁类级）', () => {
    const proto = ExperienceController.prototype as unknown as Record<string, unknown>;
    for (const name of ALL_ENDPOINTS) {
      expect(guardNames(proto[name])).toEqual(['JwtOrApiKeyGuard']);
    }
  });

  it('**没有任何端点残留 @Roles**（终审端点第二期已改为 service 判权，admin 三元组已拆除）', () => {
    const proto = ExperienceController.prototype as unknown as Record<string, object>;
    for (const name of ALL_ENDPOINTS) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[name])).toBeUndefined();
    }
  });

  // ─── 路由顺序（字面量段必须在 :id 之前）──────────────────────────

  it('路由声明顺序：字面量路由（facets / members×3）都在对应 :id 路由之前', () => {
    const methods = Object.getOwnPropertyNames(ExperienceController.prototype);
    const idx = (name: string) => methods.indexOf(name);
    // 冲突面只在"段数相同"时出现：GET /facets 与 GET /members 都会被 GET /:id 抢先匹配
    expect(idx('facets')).toBeGreaterThan(-1);
    expect(idx('facets')).toBeLessThan(idx('findOne'));
    expect(idx('listMembers')).toBeLessThan(idx('findOne'));
    // 段数不同的三对虽无匹配冲突，仍按"字面量在前"统一声明（防未来新增段数变化的端点踩坑）
    expect(idx('addMember')).toBeLessThan(idx('update'));
    expect(idx('updateMemberRole')).toBeLessThan(idx('update'));
    expect(idx('removeMember')).toBeLessThan(idx('remove'));
    // judgments 与 members 同族：字面量段必须先于 `GET /:id`（否则被当成 :id 值撞 ParseUUIDPipe）
    expect(idx('listJudgments')).toBeLessThan(idx('findOne'));
  });

  // ─── 参数形态守卫 + 透传 ────────────────────────────────────────

  it('findAll 拦下括号数组形态查询串（400，不静默忽略）', async () => {
    const req = { originalUrl: '/api/v1/experiences?signals[]=a' } as Request;
    await expect(
      controller.findAll({} as QueryExperienceDto, { id: 'u', type: 'human' } as never, req),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockService.search).not.toHaveBeenCalled();
  });

  it('facets 也拦下括号数组形态（评审 m1；同端点族两种形态口径会坑调用方）', async () => {
    const req = { originalUrl: '/api/v1/experiences/facets?signals[]=a' } as Request;
    await expect(
      controller.facets({} as QueryExperienceDto, { id: 'u', type: 'human' } as never, req),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockService.facets).not.toHaveBeenCalled();
  });

  it('facets 契约形态放行并透传 query/actor', async () => {
    mockService.facets.mockResolvedValue({ total: 0 });
    const query = { signals: ['a'] } as QueryExperienceDto;
    const actor = { id: 'u', type: 'human' };
    const req = { originalUrl: '/api/v1/experiences/facets?signals=a&signals=b' } as Request;
    await controller.facets(query, actor as never, req);
    expect(mockService.facets).toHaveBeenCalledWith(query, actor);
  });

  it('findAll 契约形态（重复参数）放行并把 query/actor 原样透传 service', async () => {
    const response = { items: [], total: 0, page: 1, pageSize: 20 };
    mockService.search.mockResolvedValue(response);
    const query = { signals: ['a'] } as QueryExperienceDto;
    const actor = { id: 'u', type: 'human' };
    const req = { originalUrl: '/api/v1/experiences?signals=a&signals=b' } as Request;

    await expect(controller.findAll(query, actor as never, req)).resolves.toBe(response);
    expect(mockService.search).toHaveBeenCalledWith(query, actor);
  });

  it('条目面各端点把 id / dto / actor 原样透传 service（controller 不含业务判断）', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const actor = { id: 'u', type: 'human' } as never;
    const createDto = { title: 't' } as never;
    const updateDto = { expectedUpdatedAt: 'x' } as never;
    const feedbackDto = { outcome: 'helped', clientRequestId: 'k' } as never;
    const qualityDto = { quality: 'verified', reason: 'r' } as never;
    const query = {} as QueryExperienceDto;

    mockService.create.mockResolvedValue({ id: 'new' });
    mockService.facets.mockResolvedValue({ total: 0 });
    mockService.findOne.mockResolvedValue({ id });
    mockService.recordFeedback.mockResolvedValue({ experienceId: id });
    mockService.update.mockResolvedValue({ id });
    mockService.reviewQuality.mockResolvedValue({ id, quality: 'verified' });
    mockService.remove.mockResolvedValue(undefined);

    await controller.create(createDto, actor);
    await controller.facets(query, actor, { originalUrl: '/api/v1/experiences/facets' } as Request);
    await controller.findOne(id, actor);
    await controller.feedback(id, feedbackDto, actor);
    await controller.update(id, updateDto, actor);
    await controller.reviewQuality(id, qualityDto, actor);
    await expect(controller.remove(id, actor)).resolves.toEqual({ deleted: true, id });

    expect(mockService.create).toHaveBeenCalledWith(createDto, actor);
    expect(mockService.facets).toHaveBeenCalledWith(query, actor);
    // 第二期：详情也要身份（viewer 字段的服务端单源在 service）
    expect(mockService.findOne).toHaveBeenCalledWith(id, actor);
    expect(mockService.recordFeedback).toHaveBeenCalledWith(id, feedbackDto, actor);
    expect(mockService.update).toHaveBeenCalledWith(id, updateDto, actor);
    expect(mockService.reviewQuality).toHaveBeenCalledWith(id, qualityDto, actor);
    expect(mockService.remove).toHaveBeenCalledWith(id, actor);
  });

  it('成员面四端点把路径参数 / dto / actor 原样透传成员服务（含幂等状态码映射）', async () => {
    const actorId = '22222222-2222-4222-8222-222222222222';
    const actor = { id: 'u', type: 'human' } as never;
    const addDto = { actorId, role: 'reviewer' } as AddExperienceMemberDto;
    const patchDto = { role: 'owner' } as UpdateExperienceMemberRoleDto;
    const memberRow = { actorId, role: 'reviewer' };

    mockMemberService.listMembers.mockResolvedValue({ items: [memberRow] });
    // 新建 → created=true（期望 201）；幂等分支 → created=false（期望 200）
    mockMemberService.addMember.mockResolvedValue({ member: memberRow, created: true });
    mockMemberService.updateMemberRole.mockResolvedValue(memberRow);
    mockMemberService.removeMember.mockResolvedValue({ deleted: true, actorId });

    const createdRes = { status: jest.fn() } as unknown as Response;
    await expect(controller.listMembers(actor)).resolves.toEqual({ items: [memberRow] });
    await expect(controller.addMember(addDto, actor, createdRes)).resolves.toBe(memberRow);
    expect(createdRes.status).toHaveBeenCalledWith(201);
    await expect(controller.updateMemberRole(actorId, patchDto, actor)).resolves.toBe(memberRow);
    await expect(controller.removeMember(actorId, actor)).resolves.toEqual({ deleted: true, actorId });

    // 幂等同角色 → 200（plan §2.2 码表：同角色 200 / 新建 201）
    mockMemberService.addMember.mockResolvedValue({ member: memberRow, created: false });
    const replayRes = { status: jest.fn() } as unknown as Response;
    await controller.addMember(addDto, actor, replayRes);
    expect(replayRes.status).toHaveBeenCalledWith(200);

    expect(mockMemberService.listMembers).toHaveBeenCalledWith(actor);
    expect(mockMemberService.addMember).toHaveBeenCalledWith(addDto, actor);
    expect(mockMemberService.updateMemberRole).toHaveBeenCalledWith(actorId, patchDto, actor);
    expect(mockMemberService.removeMember).toHaveBeenCalledWith(actorId, actor);
    // 条目服务不得被成员端点触达（两个 service 的职责边界）
    expect(mockService.update).not.toHaveBeenCalled();
  });

  it('判断日志端点把 query / actor 原样透传判别服务', async () => {
    const actor = { id: 'u', type: 'human' } as never;
    const query = { status: 'ok' } as never;
    const response = { items: [], total: 0, page: 1, pageSize: 20 };
    mockJudgmentService.listJudgments.mockResolvedValue(response);

    await expect(controller.listJudgments(query, actor)).resolves.toBe(response);
    expect(mockJudgmentService.listJudgments).toHaveBeenCalledWith(query, actor);
  });

  it('全部 13 个端点都在（少一个就是契约缺口）', () => {
    const proto = ExperienceController.prototype as unknown as Record<string, unknown>;
    for (const name of ALL_ENDPOINTS) {
      expect(typeof proto[name]).toBe('function');
    }
  });

  // ─── 错误码迁移（1009 → 13004 的文案面在 controller 层是否收口）──

  it('controller **代码面**不再引用旧守卫与 1009（源文本断言，非枚举值断言）', () => {
    // 为什么读源文件：枚举常量值恒真（`expect(ErrorCode.PERMISSION_DENIED).toBe(1009)` 永远通过），
    // 测不出"controller 里还留着 admin 三元组或旧码引用"这个真实风险。仓内先例 =
    // swagger-schema.spec.ts 用 fs 读 DTO 源文本断言占位符。
    const source = fs.readFileSync(path.join(__dirname, 'experience.controller.ts'), 'utf-8');
    // 只断言**代码面**：注释里记述"旧三元组（角色守卫 + Roles 装饰器）已拆除"是合法文档，
    // 故先剥掉块注释与行注释再断言（否则断言会逼我们把历史说明改写掉 = 测试倒逼文档失真）。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    for (const forbidden of ['PERMISSION_DENIED', 'RolesGuard', '@Roles', 'JwtAuthGuard']) {
      expect(code).not.toContain(forbidden);
    }
    // 正向对照：现役守卫必须还在（否则"不含旧守卫"可能是文件被清空造成的假绿）
    expect(code).toContain('JwtOrApiKeyGuard');
  });
});
