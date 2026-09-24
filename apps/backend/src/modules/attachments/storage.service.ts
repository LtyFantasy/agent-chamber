/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - MinIO 对象存储接入（attachments 模块唯一对象出口）+ 孤儿清扫的列举入口
 *
 * [代码职责]
 *   - put/get/remove 对象层封装 + bucket 启动自举
 *   - `listObjects()`：全桶只读异步迭代（仅孤儿清扫消费；无前缀/分页参数暴露）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / MinIO 接入)
 *   - 补充: docs/api-definition.md §Attachments — 软删/配额语义（业务语义不在本层）
 *
 * [关键不变量]
 *   - bucket 恒取配置值（业务层不传 bucket）：多 bucket 分流的唯一换点在此，
 *     entity.bucket 列只是入库冗余
 *   - removeObject 幂等（MinIO 对不存在键返回成功）——GC/清扫重试路径依赖该性质
 *   - 绝不在此或任何地方设 public 策略（e2e 断言匿名 getObject 被拒）
 *   - listObjects 只读；调用方不得在迭代中依赖"桶不变"（列举是弱一致快照）
 *
 * [关联代码]
 *   - attachment-gc.service.ts — 唯一消费 listObjects 的调用方（孤儿对象清扫）
 *   - attachment.service.ts — 业务语义（配额/授权/软删顺序）所在
 *
 * [持久踩坑]
 *   MINIO-DEFAULT(品牌默认值): 默认 bucket 名含品牌词，新增/改名时必须同步
 *     oss-rebrand 映射表，否则公开仓泄漏内网配置。详情: docs/oss-dual-repo.md
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 bucket 自举 fail-open 语义（见 onModuleInit）仍是预期行为
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增方法只暴露对象层语义（授权/配额等业务语义不得下沉到这里）
 * =============================================================================
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import type { Readable } from 'stream';

/**
 * 对象列表条目（`listObjects()` 迭代产出）。
 *
 * 只映射对象层事实，不携带任何业务语义：孤儿清扫按 key 与保护集比对、
 * 按 lastModified 判 grace 窗口，两个字段即是全部所需。
 */
export interface StoredObjectInfo {
  /** 对象键（bucket 内唯一；= attachment.object_key / thumb_key） */
  key: string;
  /** 字节数（运维对账用；清扫不消费） */
  size: number;
  /**
   * 服务端记录的最后修改时间；**null = 列举返回缺时间戳**。
   * 消费侧纪律：null 绝不能被当成"旧对象"（那等于凭未知年龄删数据），
   * 必须保守跳过——见 attachment-gc.service.ts 的 skippedUnknownAge。
   */
  lastModified: Date | null;
}

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

  /**
   * 列举 bucket 内全部对象（异步迭代，逐条产出——调用侧无需把整桶载入内存）。
   *
   * 语义（P2 批 4 孤儿清扫的唯一消费方）：
   * - recursive=true：只产出对象，不含目录占位（`prefix` 形状的条目）；
   * - 无前缀过滤：清扫必须看到**整桶**，否则未覆盖前缀下的孤儿会永久残留；
   * - 弱一致快照：列举期间桶内容可变，调用方不得依赖"列举结果即当前全量"
   *   （孤儿清扫用 grace 窗口覆盖该竞态，见 attachment-gc.service.ts）；
   * - error 处理：底层 BucketStream 的错误经 async 迭代器抛给调用方
   *   （不吞不降级），包装后附 bucket 上下文便于定位；缺时间戳的条目保留
   *   null 交给调用侧判定（本层不做"是否该删"的业务判断）。
   */
  async *listObjects(): AsyncGenerator<StoredObjectInfo> {
    try {
      for await (const item of this.client.listObjectsV2(this.bucket, '', true)) {
        // BucketItem 是联合类型：目录条目只有 prefix 字段（recursive=true 下
        // 理论不出现），name 缺失即非对象，跳过
        if (typeof item.name !== 'string' || item.name.length === 0) continue;
        yield {
          key: item.name,
          size: item.size ?? 0,
          lastModified: item.lastModified instanceof Date ? item.lastModified : null,
        };
      }
    } catch (err) {
      throw new Error(`listObjects failed (bucket="${this.bucket}"): ${(err as Error).message}`);
    }
  }
}
