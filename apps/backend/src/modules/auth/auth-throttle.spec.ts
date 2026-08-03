/**
 * A6 登录限流测试
 *
 * 覆盖：
 * 1. ThrottlerGuard + @Throttle 接线验证——超阈值返回 429（用独立 dummy controller，
 *    不依赖 auth.controller 的测试环境放宽阈值）；
 * 2. 全局默认极宽松——未标注 @Throttle 的端点高频访问不受影响
 *    （保护 events/poll、SSE、MCP 编排等高频路径，v2 收窄决策）；
 * 3. AuthController 的 login/register 确实携带限流元数据。
 */

import 'reflect-metadata';
import { Controller, Post, HttpCode, HttpStatus, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerGuard, Throttle } from '@nestjs/throttler';
import request = require('supertest');
import { AuthController } from './auth.controller';

/** 与 app.module.ts 相同的全局默认（极宽松 = 实际关闭） */
const GLOBAL_LIMIT = 100_000;
const TTL_MS = 60_000;

@Controller('throttle-probe')
class ThrottleProbeController {
  @Throttle({ default: { limit: 2, ttl: TTL_MS } })
  @Post('limited')
  @HttpCode(HttpStatus.OK)
  limited() {
    return { ok: true };
  }

  @Post('open')
  @HttpCode(HttpStatus.OK)
  open() {
    return { ok: true };
  }
}

describe('A6 auth rate limiting', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: TTL_MS, limit: GLOBAL_LIMIT }])],
      controllers: [ThrottleProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('超阈值触发 429', async () => {
    const server = app.getHttpServer();

    // 限流 2 次/分钟：前 2 次放行，第 3 次 429
    await request(server).post('/throttle-probe/limited').expect(200);
    await request(server).post('/throttle-probe/limited').expect(200);
    await request(server).post('/throttle-probe/limited').expect(429);
  });

  it('全局默认极宽松：未标注 @Throttle 的端点高频访问不受限', async () => {
    const server = app.getHttpServer();

    // 连续 10 次（远超任何业务限流阈值）全部放行
    for (let i = 0; i < 10; i++) {
      await request(server).post('/throttle-probe/open').expect(200);
    }
  });

  it('AuthController login/register 携带限流元数据（@Throttle 已接线）', () => {
    // @Throttle({ default: {...} }) 写入 'THROTTLER:LIMITdefault' / 'THROTTLER:TTLdefault' 元数据
    const loginLimit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      AuthController.prototype.login,
    );
    const registerLimit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      AuthController.prototype.register,
    );
    const loginTtl = Reflect.getMetadata('THROTTLER:TTLdefault', AuthController.prototype.login);

    // 测试环境阈值放宽为 100000（防 E2E 误伤），生产默认 5 次/分钟；
    // 此处只断言元数据存在且为有限值，具体阈值由 auth.controller.ts 常量控制
    expect(typeof loginLimit).toBe('number');
    expect(loginLimit).toBeGreaterThan(0);
    expect(registerLimit).toBe(loginLimit);
    expect(loginTtl).toBe(TTL_MS);

    // refresh/logout 不应被收紧（沿用全局宽松默认）
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', AuthController.prototype.refresh)).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', AuthController.prototype.logout)).toBeUndefined();
  });
});
