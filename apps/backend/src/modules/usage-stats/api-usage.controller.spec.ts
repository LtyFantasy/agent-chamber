import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@agent-chamber/shared';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ApiUsageController } from './api-usage.controller';
import { ApiUsageQueryService } from './api-usage-query.service';
import { ApiUsageQueryDto } from './dto/api-usage-query.dto';

/**
 * 查询端点单测：**权限契约**（admin-only 三元组）+ 参数透传。
 *
 * 聚合口径的断言在 api-usage-query.service.spec.ts；本文件只保证"谁能进来"。
 * 权限用**真实 RolesGuard 实例**验证（单元测试全局 overrideGuard 会把它换成放行桩，
 * 单靠元数据反射只证明"声明过"、不证明"真会拒"）。
 */
describe('ApiUsageController', () => {
  let controller: ApiUsageController;
  const mockService = { query: jest.fn() };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ApiUsageController],
      providers: [{ provide: ApiUsageQueryService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<ApiUsageController>(ApiUsageController);
  });

  afterEach(() => jest.clearAllMocks());

  it('类级声明 JwtAuthGuard + RolesGuard', () => {
    const guards = (Reflect.getMetadata('__guards__', ApiUsageController) ?? []) as Array<{
      name?: string;
      constructor?: { name?: string };
    }>;
    const names = guards.map((g) => g?.name ?? g?.constructor?.name);
    expect(names).toContain('JwtAuthGuard');
    expect(names).toContain('RolesGuard');
  });

  it('类级 @Roles(ADMIN)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ApiUsageController)).toContain(UserRole.ADMIN);
  });

  it('真实 RolesGuard：非 admin 用户 → 403', () => {
    const guard = new RolesGuard(new Reflector());
    const context = buildContext({ user: { role: 'observer' } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('真实 RolesGuard：Agent（API Key）→ 403（Agent 不能访问 admin 端点）', () => {
    const guard = new RolesGuard(new Reflector());
    const context = buildContext({ agent: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('真实 RolesGuard：无任何身份 → 403', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(buildContext({}))).toThrow(ForbiddenException);
  });

  it('真实 RolesGuard：admin 用户 → 放行', () => {
    const guard = new RolesGuard(new Reflector());
    const context = buildContext({ user: { role: UserRole.ADMIN } });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('查询参数原样透传 service（业务口径不在 controller 层）', async () => {
    const response = { items: [], meta: {} };
    mockService.query.mockResolvedValue(response);
    const query = { groupBy: 'tool' } as ApiUsageQueryDto;

    await expect(controller.getApiUsage(query)).resolves.toBe(response);
    expect(mockService.query).toHaveBeenCalledWith(query);
  });
});

/** 构造 RolesGuard 能消费的最小 ExecutionContext（handler/class 指向真实 controller） */
function buildContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ApiUsageController.prototype.getApiUsage,
    getClass: () => ApiUsageController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
