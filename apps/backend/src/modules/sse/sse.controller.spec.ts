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
      const result = controller.stream();
      expect(result).toBeInstanceOf(Observable);
    });
  });
});
