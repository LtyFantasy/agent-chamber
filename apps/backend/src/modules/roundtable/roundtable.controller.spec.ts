/**
 * RoundtableController 单测：REST 端点 → service 调用参数透传（权限/存在性在 service 层）。
 * M3 阶段 1 追加：审批裁决 / 审批列表 / pending 计数三个端点的透传断言。
 * M4b-1 追加：POST /roundtable/seats/:id/cancel 端点透传断言。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ActorType } from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { RoundtableController } from './roundtable.controller';
import { RoundtableService } from './roundtable.service';
import { UnifiedActor } from '../../common/types/actor.types';

describe('RoundtableController', () => {
  let controller: RoundtableController;
  let service: {
    createSeat: jest.Mock;
    listSeats: jest.Mock;
    verdictPermissionRequest: jest.Mock;
    listPermissionRequests: jest.Mock;
    pendingPermissionRequestCount: jest.Mock;
    removeSeat: jest.Mock;
    cancelSeat: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      createSeat: jest.fn(),
      listSeats: jest.fn(),
      verdictPermissionRequest: jest.fn(),
      listPermissionRequests: jest.fn(),
      pendingPermissionRequestCount: jest.fn(),
      removeSeat: jest.fn(),
      cancelSeat: jest.fn(),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RoundtableController],
      providers: [{ provide: RoundtableService, useValue: service }],
    })
      // @UseGuards(JwtOrApiKeyGuard) 的依赖（JwtService/ConfigService/UserRepo/ApiKeyAuthService）
      // 不在本单测模块内，override 为恒放行（guard 行为由 jwt-or-api-key.guard.spec 覆盖）
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(RoundtableController);
  });

  const AGENT_ACTOR: UnifiedActor = { id: 'agent-1', type: ActorType.AGENT, name: 'Test Agent' };

  it('POST /roundtable/seats → service.createSeat(dto, actor)', async () => {
    const dto = {
      topicId: 'topic-1',
      label: 'kimi-1',
      vendor: 'kimi',
      cwd: '/tmp',
      permissionMode: 'auto',
    };
    service.createSeat.mockResolvedValue({ id: 'seat-1' });
    const result = await controller.createSeat(AGENT_ACTOR, dto);
    expect(service.createSeat).toHaveBeenCalledWith(dto, AGENT_ACTOR);
    expect(result).toEqual({ id: 'seat-1' });
  });

  it('GET /roundtable/seats?topicId= → service.listSeats(topicId, actor)', async () => {
    service.listSeats.mockResolvedValue([]);
    const result = await controller.listSeats({ topicId: 'topic-1' }, AGENT_ACTOR);
    expect(service.listSeats).toHaveBeenCalledWith('topic-1', AGENT_ACTOR);
    expect(result).toEqual([]);
  });

  it('GET /roundtable/permission-requests/pending-count → { count }', async () => {
    service.pendingPermissionRequestCount.mockResolvedValue(3);
    const result = await controller.pendingCount(AGENT_ACTOR);
    expect(service.pendingPermissionRequestCount).toHaveBeenCalledWith(AGENT_ACTOR);
    expect(result).toEqual({ count: 3 });
  });

  it('GET /roundtable/permission-requests?topicId=&status= → service.listPermissionRequests(query, actor)', async () => {
    const query = { topicId: 'topic-1', status: 'pending', page: 1, pageSize: 20 };
    service.listPermissionRequests.mockResolvedValue({ items: [], total: 0 });
    const result = await controller.listPermissionRequests(query, AGENT_ACTOR);
    expect(service.listPermissionRequests).toHaveBeenCalledWith(query, AGENT_ACTOR);
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('POST /roundtable/permission-requests/:id/verdict → service.verdictPermissionRequest(id, dto, actor)', async () => {
    const dto = { optionId: 'approve_once' };
    service.verdictPermissionRequest.mockResolvedValue({ id: 'pr-1', status: 'approved' });
    const result = await controller.verdictPermissionRequest('pr-1', dto, AGENT_ACTOR);
    expect(service.verdictPermissionRequest).toHaveBeenCalledWith('pr-1', dto, AGENT_ACTOR);
    expect(result).toEqual({ id: 'pr-1', status: 'approved' });
  });

  it('DELETE /roundtable/seats/:id → service.removeSeat(id, actor)', async () => {
    service.removeSeat.mockResolvedValue({ id: 'seat-1', status: 'removed' });
    const result = await controller.removeSeat('seat-1', AGENT_ACTOR);
    expect(service.removeSeat).toHaveBeenCalledWith('seat-1', AGENT_ACTOR);
    expect(result).toEqual({ id: 'seat-1', status: 'removed' });
  });

  it('POST /roundtable/seats/:id/cancel → service.cancelSeat(id, actor)', async () => {
    service.cancelSeat.mockResolvedValue({ accepted: true, seatId: 'seat-1' });
    const result = await controller.cancelSeat('seat-1', AGENT_ACTOR);
    expect(service.cancelSeat).toHaveBeenCalledWith('seat-1', AGENT_ACTOR);
    expect(result).toEqual({ accepted: true, seatId: 'seat-1' });
  });
});
