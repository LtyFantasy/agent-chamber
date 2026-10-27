/**
 * NotificationsController 单测（HTTP 层契约：状态码 / 429 三件套的头 / 鉴权 / 分页入参）。
 *
 * 设计意图：本文件用**最小 Nest 应用 + 真 AllExceptionsFilter + 真 ResponseInterceptor**
 * 跑真实 HTTP（supertest），因为这里要钉的三件事都只存在于 HTTP 层，模块单测看不见：
 * ① **`@HttpCode(200)` 真的生效**（Nest 的 `@Post` 缺省是 201）——直接调方法是测不出来的；
 * ② **`Retry-After` 头真的发出去了**：它在 controller 里 `throw` 之前 setHeader，之后由全局
 *    过滤器写 body——**过滤器从不 setHeader**（全仓零先例），所以这条路径只能端到端验；
 * ③ **admin 列表的角色闸**：`@Roles(ADMIN)` + `RolesGuard` 必须成对（缺 guard = 装饰器没人读）。
 *
 * ⚠️ 守卫用 `overrideGuard` 替换（本文件的关注点是"控制器与过滤器的接线"）：真实的
 * **401（无凭证）** 与真实 JWT/API Key 校验在 `test/notifications.e2e-spec.ts` 里用真守卫覆盖。
 */
import 'reflect-metadata';
import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { API_PREFIX, ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { NotificationsController } from './notifications.controller';
import { NotifyDirectService, NotifyRateLimitedException } from './notify-direct.service';
import { NotifyDeliveryRepository } from './notify-delivery.repository';

/** 守卫替身放什么身份：agent（API Key 面）/ human（JWT 面）/ none（未认证） */
let actorMode: 'agent' | 'human' | 'none' = 'agent';
/** human 面用的角色（admin 端点用它验 200/403） */
let humanRole: UserRole = UserRole.ADMIN;

const directService = { send: jest.fn() };
const deliveryRepo = { findAll: jest.fn() };

/** 分页信封桩（形状见 repository 的 `NotificationDeliveryPage`） */
const PAGE_STUB = {
  items: [{ id: 'd-1', category: 'direct', status: 'success' }],
  total: 1,
  page: 2,
  pageSize: 5,
  totalPages: 1,
  hasNext: false,
  hasPrev: true,
};

describe('NotificationsController（HTTP 层）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotifyDirectService, useValue: directService },
        { provide: NotifyDeliveryRepository, useValue: deliveryRepo },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate: (context: never) => {
          const req = (context as { switchToHttp(): { getRequest(): Record<string, unknown> } })
            .switchToHttp()
            .getRequest();
          if (actorMode === 'agent') req.agent = { id: 'agent-1', name: 'nightcrawler' };
          if (actorMode === 'human') {
            req.user = { userId: 'user-1', role: humanRole, name: 'Owner' };
          }
          return true;
        },
      })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: never) => {
          const req = (context as { switchToHttp(): { getRequest(): Record<string, unknown> } })
            .switchToHttp()
            .getRequest();
          // ⚠️ 与上面 JwtOrApiKeyGuard 替身**必须一致**：agent 面只挂 `req.agent`、**不挂**
          // `req.user`。否则 RolesGuard 会看到一个 role=admin 的 user，`@Roles(ADMIN)` 的
          // 闸门在测试里形同虚设（"agent 读 admin 端点 → 200"这种假绿）
          if (actorMode === 'agent') req.agent = { id: 'agent-1', name: 'nightcrawler' };
          if (actorMode === 'human') {
            req.user = { userId: 'user-1', role: humanRole, name: 'Owner' };
          }
          return true;
        },
      })
      // ⚠️ RolesGuard **不替换**：本文件要验的就是"@Roles(ADMIN) 真的会挡人"
      .compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 逐字对齐：校验管道 / 响应信封 / 异常过滤器 / 全局前缀
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor(new Reflector()));
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    // 缺省 = 人类 admin 面（GET 端点的正常态）；agent 面的用例自己切 `actorMode`
    actorMode = 'human';
    humanRole = UserRole.ADMIN;
    directService.send.mockReset().mockResolvedValue({ delivered: 1, channels: ['feishu'] });
    deliveryRepo.findAll.mockReset().mockResolvedValue(PAGE_STUB);
  });

  const post = () => request(app.getHttpServer()).post(`${API_PREFIX}/notifications/messages`);
  const get = () => request(app.getHttpServer()).get(`${API_PREFIX}/notifications/deliveries`);

  describe('POST /notifications/messages（直发）', () => {
    it('**@HttpCode(200)**：成功返回 200（不是 Nest `@Post` 的缺省 201）', async () => {
      const res = await post().send({ text: '需要你拍板' }).expect(200);

      expect(res.body.data).toEqual({ delivered: 1, channels: ['feishu'] });
      // 成功路径**不带** Retry-After（它只属于 429）
      expect(res.headers['retry-after']).toBeUndefined();
    });

    it('身份投影：API Key 分支的 actor 传给服务（agent 面）', async () => {
      actorMode = 'agent';

      await post().send({ text: 'x' }).expect(200);

      const [actor, dto] = directService.send.mock.calls[0];
      expect(actor).toEqual({ id: 'agent-1', type: ActorType.AGENT, name: 'nightcrawler' });
      expect(dto).toEqual({ text: 'x' });
    });

    it('429 三件套：状态码 + **Retry-After 头** + code 429 + data.retryAfterSeconds', async () => {
      directService.send.mockRejectedValue(
        new NotifyRateLimitedException(
          42,
          'Direct notification rate limit exceeded. Do NOT retry immediately.',
        ),
      );

      const res = await post().send({ text: 'x' }).expect(429);

      // 头（全仓过滤器零 setHeader 先例 ⇒ 只能由 controller 显式设置）
      expect(res.headers['retry-after']).toBe('42');
      // body：code 与 data 同值同源
      expect(res.body.code).toBe(ErrorCode.RATE_LIMITED);
      expect(res.body.data).toEqual({ retryAfterSeconds: 42 });
      expect(res.body.message).toContain('Do NOT retry immediately');
    });

    it('409 幂等冲突：code 9002 透传（代理层不得改写成 500）', async () => {
      directService.send.mockRejectedValue(
        new ConflictException({
          message: 'clientRequestId "k1" was already used with a different text/link',
          code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        }),
      );

      const res = await post().send({ text: 'x', clientRequestId: 'k1' }).expect(409);

      expect(res.body.code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    });

    it('400：text 缺失（DTO 层拦下，不透传到服务）', async () => {
      const res = await post().send({}).expect(400);

      // ⚠️ code 是 **400**（HTTP 状态映射），不是 9000：main.ts 用的是裸 ValidationPipe，
      // 未自定义 exceptionFactory ⇒ 过滤器按状态映射成 ErrorCode.BAD_REQUEST。
      // 9000 = VALIDATION_ERROR 是**业务**校验码（手写 throw 用），管道校验不走它。
      expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(res.body.message).toContain('text');
      expect(directService.send).not.toHaveBeenCalled();
    });

    it('400：link 是绝对 URL（**开放重定向闸门**）', async () => {
      await post().send({ text: 'x', link: 'https://evil.example/tasks/1' }).expect(400);

      expect(directService.send).not.toHaveBeenCalled();
    });

    it('400：多传未知字段（forbidNonWhitelisted）', async () => {
      await post().send({ text: 'x', recipient: 'ou_someone_else' }).expect(400);

      expect(directService.send).not.toHaveBeenCalled();
    });

    it('401：守卫放行但身份投影为空（畸形请求）', async () => {
      actorMode = 'none';

      const res = await post().send({ text: 'x' }).expect(401);

      expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(directService.send).not.toHaveBeenCalled();
    });

    it('人类也可以调（JWT 面）——是否通知自己由服务的自回声判定兜底', async () => {
      actorMode = 'human';

      await post().send({ text: 'x' }).expect(200);

      const [actor] = directService.send.mock.calls[0];
      expect(actor).toEqual({
        id: 'user-1',
        type: ActorType.HUMAN,
        name: 'Owner',
        role: UserRole.ADMIN,
      });
    });
  });

  describe('GET /notifications/deliveries（admin 只读）', () => {
    it('admin：200 + 分页信封原样透传，query 被转成数字', async () => {
      const res = await get()
        .query({ page: '2', pageSize: '5', category: 'direct', status: 'success' })
        .expect(200);

      expect(res.body.data).toEqual(PAGE_STUB);
      expect(deliveryRepo.findAll).toHaveBeenCalledWith({
        page: 2,
        pageSize: 5,
        category: 'direct',
        status: 'success',
      });
    });

    it('admin：缺省 query 可省略（分页缺省由仓储层给）', async () => {
      await get().expect(200);

      expect(deliveryRepo.findAll).toHaveBeenCalledWith({});
    });

    it('403：非 admin 人类（@Roles(ADMIN) + RolesGuard 成对生效）', async () => {
      humanRole = UserRole.EDITOR;

      const res = await get().expect(403);

      expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(deliveryRepo.findAll).not.toHaveBeenCalled();
    });

    it('403：agent 面（API Key）不能读全平台投递记录', async () => {
      actorMode = 'agent';

      const res = await get().expect(403);

      expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(deliveryRepo.findAll).not.toHaveBeenCalled();
    });

    it('400：category 值域外（含 `digest` 是合法的，非白名单值被拦）', async () => {
      await get().query({ category: 'not_a_category' }).expect(400);
      expect(deliveryRepo.findAll).not.toHaveBeenCalled();

      await get().query({ category: 'digest' }).expect(200);
      expect(deliveryRepo.findAll).toHaveBeenCalledWith({ category: 'digest' });
    });

    it('400：pageSize 超过上限 100（@Max(100)）', async () => {
      await get().query({ pageSize: '101' }).expect(400);
      await get().query({ pageSize: '100' }).expect(200);
    });
  });
});
