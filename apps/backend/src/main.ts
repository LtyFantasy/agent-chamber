import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { API_PREFIX } from '@agent-chamber/shared';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser: false + 手动注册：body-parser 默认 limit 仅 100kb，
  // DocSpace ingest（scripts/sync-docs.mjs）整文推送 docs/ 大文档（api-definition.md 等
  // 单文件 >100kb）会触发 PayloadTooLargeError。放宽到 10mb：覆盖文档同步 +
  // v1.55 import-bundle 空间回导（export bundle 随空间增长，agent-core 147 篇已 3.4MB）；
  // 生产 nginx 侧 client_max_body_size 需同步放宽（scripts/nginx/agent-chamber.conf）。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // 限流 tracker 修复（P2 批 2 / security major）：生产经 nginx 反代，不加 trust proxy 时
  // Express 的 req.ip 恒为 127.0.0.1（socket 对端 = nginx），throttler 按 IP 计数退化为
  // **全局合桶**——任何单一客户端都能把全站配额打满（现有上传 30/min 在生产就是如此）。
  // hop=1 与 nginx `$proxy_add_x_forwarded_for` 的附加语义配合是防伪的：Express 从 XFF
  // 右端取第 1 跳（= nginx 亲见的真实客户端地址），客户端自己伪造的左侧段被跳过；
  // 直连 8743（本地开发/无代理）无 XFF 头时回退 socket IP，行为不变。
  // ⚠️ 仅在"恰好一层可信反代"的前提下成立；多跳代理链需改为具体 IP/CIDR 白名单。
  app.set('trust proxy', 1);

  // CORS：默认 origin:true（全放行，行为不变）；生产可设 CORS_ORIGINS 逗号分隔白名单收紧。
  // 当前 Bearer header 鉴权风险本就可控，此项为前置收紧（见 .env.example 模板）。
  app.enableCors({
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
      : true,
    credentials: true,
  });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix（单源 = shared API_PREFIX，review-0831 任务 e013af33 三端收口）
  app.setGlobalPrefix(API_PREFIX);

  // WebSocket 适配器（M1 圆桌计划决策 3：平台首个 WS 服务端）。
  // WsAdapter 挂载后 @WebSocketGateway 生效；WS 路径（/ws/runner 等）不受全局
  // /api/v1 前缀影响。全局 APP_GUARD/INTERCEPTOR/FILTER 对 WS context 同样生效，
  // 行为实测结论见阶段 2 WS spike（roundtable gateway 只走 client.send、入站返回 void）。
  app.useWebSocketAdapter(new WsAdapter(app));

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('AI Agent Chamber API')
    .setDescription('AI Agent Chamber Collaboration Platform API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'apiKey')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = parseInt(process.env.PORT || '8743', 10);
  // 关停钩子（usage stats 批 1，D9/V6）：kill -TERM 时触发 onApplicationShutdown，
  // 让统计 buffer 把最后一窗口计数 flush 落库（终局 flush 自带 10s 超时护栏）。
  // 必须在 listen 之前注册——收到信号后才注册会漏掉关停事件。
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`Application is running on: http://localhost:${port}`);
  Logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

void bootstrap();
