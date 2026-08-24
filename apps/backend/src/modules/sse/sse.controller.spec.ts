import { Test, TestingModule } from '@nestjs/testing';
import { Observable } from 'rxjs';
import { SseController } from './sse.controller';
import { SseService } from './sse.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

describe('SseController', () => {
  let controller: SseController;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SseController],
      providers: [
        {
          provide: SseService,
          useValue: {
            subscribe: jest.fn().mockReturnValue(new Observable()),
            emit: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<SseController>(SseController);
  });

  describe('stream', () => {
    it('should return an Observable', () => {
      const result = controller.stream(null as never);
      expect(result).toBeInstanceOf(Observable);
    });

    it('应将 actor 与解析后的 types/topics 偏好过滤传入 SseService.subscribe', () => {
      const actor = { id: 'u1', type: 'human', role: 'editor' } as never;
      controller.stream(actor, 'new_message, task_update', 't1,t2');
      const subscribe = jest.mocked(controller['sseService'].subscribe);
      expect(subscribe).toHaveBeenCalledWith(actor, {
        types: ['new_message', 'task_update'],
        topics: ['t1', 't2'],
      });
    });

    it('空/缺省查询参数解析为 undefined（不构造空数组过滤器）', () => {
      controller.stream(null as never, '', undefined);
      const subscribe = jest.mocked(controller['sseService'].subscribe);
      expect(subscribe).toHaveBeenCalledWith(null, { types: undefined, topics: undefined });
    });
  });
});
