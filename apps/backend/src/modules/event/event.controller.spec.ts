import { Test, TestingModule } from '@nestjs/testing';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { UnifiedActor } from '../../common/types/actor.types';

describe('EventController', () => {
  let controller: EventController;
  let service: typeof mockService;

  const mockService = {
    poll: jest.fn(),
  };

  const mockActor: UnifiedActor = {
    id: 'actor-1',
    type: ActorType.HUMAN,
    role: UserRole.EDITOR,
    name: 'Test Actor',
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventController],
      providers: [{ provide: EventService, useValue: mockService }],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<EventController>(EventController);
    service = moduleRef.get<EventService>(EventService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('poll', () => {
    it('should call service.poll with query and actor and return result', async () => {
      const result = { events: [{ id: 'e1' }], nextCursor: '123' };
      service.poll.mockResolvedValue(result);

      const query = { cursor: 'abc', limit: 50 };
      expect(await controller.poll(query, mockActor)).toBe(result);
      expect(service.poll).toHaveBeenCalledWith(query, mockActor);
    });

    it('should pass null actor when decorator returns null', async () => {
      const result = { events: [{ id: 'e2' }], nextCursor: '456' };
      service.poll.mockResolvedValue(result);

      const query = { cursor: 'abc', limit: 50 };
      const nullActor = null as unknown as UnifiedActor;
      expect(await controller.poll(query, nullActor)).toBe(result);
      expect(service.poll).toHaveBeenCalledWith(query, nullActor);
    });
  });
});
