import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
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
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

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
  await app.listen(port);
  Logger.log(`Application is running on: http://localhost:${port}`);
  Logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

void bootstrap();
