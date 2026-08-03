import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser: false + 手动注册：body-parser 默认 limit 仅 100kb，
  // DocSpace ingest（scripts/sync-docs.mjs）整文推送 docs/ 大文档（api-definition.md 等
  // 单文件 >100kb）会触发 PayloadTooLargeError。放宽到 5mb 覆盖文档同步场景。
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

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

  // Global prefix
  app.setGlobalPrefix('/api/v1');

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
