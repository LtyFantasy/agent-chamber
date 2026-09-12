/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / MinIO 接入)
 *   - 补充: docs/api-definition.md §Attachments
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #11(注释) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 已核对 bucket 自举 fail-open 语义（见 onModuleInit）仍是预期行为
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import type { Readable } from 'stream';

/**
 * MinIO 对象存储封装（attachments 模块唯一出口）。
 *
 * 职责只到对象层：put/get/remove + 启动 bucket 自举；业务语义
 * （配额/授权/软删顺序）全在 attachment.service.ts。
 *
 * 自举策略（plan §3.8）：OnModuleInit 时 bucketExists → 缺则 makeBucket
 * （默认 private，**严禁在此或任何地方设 public 策略**——e2e 断言匿名
 * getObject 被拒）。失败记 error 不 throw（audit fail-open 同款决策）：
 * MinIO 暂未就绪（本地开发未起容器）不应拖垮整个 backend 启动；
 * 上传/读取路径遇到不可用会自然 500，错误面不因此扩大。
 */
@Injectable()
export class AttachmentStorageService implements OnModuleInit {
  private readonly logger = new Logger(AttachmentStorageService.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('minio.bucket') ?? 'agent-chamber-attachments';
    this.client = new Minio.Client({
      endPoint: this.configService.get<string>('minio.endPoint') ?? '127.0.0.1',
      port: this.configService.get<number>('minio.port') ?? 9000,
      useSSL: this.configService.get<boolean>('minio.useSSL') ?? false,
      accessKey: this.configService.get<string>('minio.accessKey') ?? '',
      secretKey: this.configService.get<string>('minio.secretKey') ?? '',
    });
  }

  /** 当前配置 bucket（service 层入库 attachment.bucket 列用，防两处各读各的配置） */
  getBucket(): string {
    return this.bucket;
  }

  async onModuleInit(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`MinIO bucket "${this.bucket}" created (private by default)`);
      }
    } catch (err) {
      // fail-open：启动不崩（本地 MinIO 未起不拖垮 backend），上传路径自然报错
      this.logger.error(
        `MinIO bucket bootstrap failed (bucket="${this.bucket}"): ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * 写入对象。putObject 直收 Buffer（SDK 实证）；metaData 携带 Content-Type，
   * 使对象自带正确类型（调试/直查场景友好；平台响应头仍以 DB mime_type 为单一来源）。
   */
  async putObject(objectKey: string, buf: Buffer, mimeType: string): Promise<void> {
    await this.client.putObject(this.bucket, objectKey, buf, buf.length, {
      'Content-Type': mimeType,
    });
  }

  /** 读取对象流（minio SDK 返回 readable stream，直接喂 StreamableFile） */
  async getObject(objectKey: string): Promise<Readable> {
    return this.client.getObject(this.bucket, objectKey);
  }

  /** 删除对象（MinIO 对不存在键幂等成功——DELETE/GC 重试路径天然安全） */
  async removeObject(objectKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}
