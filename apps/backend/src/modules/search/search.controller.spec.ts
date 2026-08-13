import { Test, TestingModule } from '@nestjs/testing';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchQueryDto, SearchType } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UnifiedActor } from '../../common/types/actor.types';
import { ActorType } from '@agent-chamber/shared';

describe('SearchController', () => {
  let controller: SearchController;
  let service: jest.Mocked<SearchService>;

  const mockService = {
    search: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [{ provide: SearchService, useValue: mockService }],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<SearchController>(SearchController);
    service = moduleRef.get(SearchService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('search', () => {
    it('should call service.search with DTO and return result', async () => {
      const result = {
        messages: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
        tasks: null,
        docs: null,
      };
      service.search.mockResolvedValue(result);

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };

      expect(await controller.search(dto, actor)).toBe(result);
      expect(service.search).toHaveBeenCalledWith(dto, actor);
      expect(service.search).toHaveBeenCalledTimes(1);
    });

    it('should default type to all when omitted', async () => {
      service.search.mockResolvedValue({ messages: null, tasks: null, docs: null });

      const dto: SearchQueryDto = {
        q: 'test',
        type: SearchType.ALL,
        page: 1,
        pageSize: 20,
      };

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };

      await controller.search(dto, actor);
      expect(service.search).toHaveBeenCalledWith(
        expect.objectContaining({ type: SearchType.ALL }),
        actor,
      );
    });
  });
});
