import { Test, TestingModule } from '@nestjs/testing';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

describe('DashboardController', () => {
  let controller: DashboardController;
  let service: typeof mockService;

  const mockService = {
    stats: jest.fn(),
    agentActivity: jest.fn(),
    leaderboard: jest.fn(),
    recentTopics: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: mockService }],
    }).compile();

    controller = moduleRef.get<DashboardController>(DashboardController);
    service = moduleRef.get<DashboardService>(DashboardService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('stats', () => {
    it('should call service.stats and return result', async () => {
      const result = { totalAgents: 5, totalTopics: 10 };
      service.stats.mockResolvedValue(result);

      expect(await controller.stats()).toBe(result);
      expect(service.stats).toHaveBeenCalled();
    });
  });

  describe('agentActivity', () => {
    it('should call service.agentActivity and return result', async () => {
      const result = [{ id: 'a1' }];
      service.agentActivity.mockResolvedValue(result);

      expect(await controller.agentActivity()).toBe(result);
      expect(service.agentActivity).toHaveBeenCalled();
    });
  });

  describe('leaderboard', () => {
    it('should call service.leaderboard and return result', async () => {
      const result = [{ id: 'a1', name: 'Agent One', messageCount: 0, activityScore: 0 }];
      service.leaderboard.mockResolvedValue(result);

      expect(await controller.leaderboard()).toBe(result);
      expect(service.leaderboard).toHaveBeenCalled();
    });
  });

  describe('recentTopics', () => {
    it('should call service.recentTopics and return result', async () => {
      const result = [{ id: 't1' }];
      service.recentTopics.mockResolvedValue(result);

      expect(await controller.recentTopics()).toBe(result);
      expect(service.recentTopics).toHaveBeenCalled();
    });
  });
});
