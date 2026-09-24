/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件缩略图变体生成（webp，P2 批 1）：上传链路的解码/缩放/编码段
 *
 * [代码职责]
 *   - 唯一的 sharp 调用点（后端首用；web 侧 next 自带的 sharp 是另一条依赖链，
 *     apps/web 无 next/image 使用面，与本文件无关）；
 *   - 解码器全局收窄（block 非白名单 loader）+ 有界并发（信号量 2）+ 参数钉死。
 *   - 失败语义：**本文件只抛错，不吞错**——fail-open（warn 日志 + thumb 列全 null、
 *     上传照常）是 attachment.service.upload 的职责，日志字段（attachmentId/
 *     uploaderId/mime/error 类）只有调用方拿得到。
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / 缩略图变体)
 *   - 补充: docs/api-definition.md §Attachments（GET :id/thumbnail 端点契约与 12008）
 *
 * [关键不变量]
 *   - **严禁 block GIF/Nsgif loader**：产品要 GIF 首帧（白名单四格式之四），
 *     收窄只针对非白名单 loader（TIFF/SVG/PDF/HEIF/JP2/OpenSlide/Vips/Magick…）；
 *   - 解码参数恒定（security M1 钉死）：limitInputPixels=40MP + animated:false +
 *     pages:1 + sequentialRead:true；failOn 保持 sharp 默认 'warning'，**不得改
 *     'error'**（untrusted input 下 'error' 容错面更弱）；
 *   - 输出恒 webp 且最长边 ≤ ATTACHMENT_THUMB_MAX_EDGE、永不放大；
 *   - 解码并发恒被信号量压到 ≤ ATTACHMENT_THUMB_DECODE_CONCURRENCY。
 *
 * [关联代码]
 *   - `apps/backend/src/modules/attachments/attachment.service.ts` — 生成调用点
 *     （fail-open 边界）+ thumb 5 列入库（同生共死）
 *   - `apps/backend/src/modules/attachments/attachment.constants.ts` — 阈值单一事实源
 *
 * [持久踩坑]
 *   - THUMB-BLOCK-FAMILY(vips block 语义): libvips 的 block 沿类型继承链生效——
 *     block('VipsForeignLoad') 会连 GIF/PNG/JPEG 一起封掉，必须紧跟 unblock 白名单
 *     buffer loader；且 sharp 的内存输入只走 `*Buffer` 变体，unblock 文件名变体无效。
 *     安全方向：白名单缺一个 loader 时表现为"该格式缩略图全失败"（fail-open 可见），
 *     而不是解码面泄漏。实证命令见 thumbnail-generator.spec.ts。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量]（尤其 GIF loader 与解码参数）未被破坏
 *   □ 缩略图输出契约（webp/最长边/首帧）变化时，同步 shared 投影键 JSDoc 与文档
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import sharp from 'sharp';
import {
  ATTACHMENT_THUMB_DECODE_CONCURRENCY,
  ATTACHMENT_THUMB_DECODE_OPTIONS,
  ATTACHMENT_THUMB_MAX_EDGE,
  ATTACHMENT_THUMB_QUALITY,
} from './attachment.constants';

/** 缩略图生成结果：webp 字节 + 输出尺寸（= 入库的 thumb_width/thumb_height） */
export interface ThumbnailOutput {
  /** webp 编码后的完整字节（入库 thumb_size_bytes/sha256 的事实来源） */
  data: Buffer;
  /** 输出宽（px，≤ ATTACHMENT_THUMB_MAX_EDGE） */
  width: number;
  /** 输出高（px，≤ ATTACHMENT_THUMB_MAX_EDGE） */
  height: number;
}

/**
 * 白名单 loader 的 buffer 变体（解封清单）。
 *
 * sharp 从内存 Buffer 解码只调用 `*load_buffer` 系列（common.cc DetermineImageType
 * + vips 的 buffer loader 选择，实证见 spec），故只解封 Buffer 变体即可；
 * GIF 同时列 GifBuffer 与 NsgifBuffer（libvips 版本差异下两者都可能是实际命中者）。
 */
const THUMB_ALLOWED_BUFFER_LOADERS = [
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadGifBuffer',
  'VipsForeignLoadNsgifBuffer',
] as const;

/**
 * 解码器收窄（security M1）：先封整个 loader 家族，再按白名单解封。
 *
 * 为什么用"全封 + 白名单解封"而不是"逐个封非白名单"：白名单是**闭合集合**，
 * 新增格式（未来 libvips 加 loader）自动被拒，无需维护黑名单——默认拒绝面更小。
 * 进程级全局状态（libvips 操作表），本模块 import 时执行一次；重复执行等价。
 */
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: [...THUMB_ALLOWED_BUFFER_LOADERS] });

/**
 * 计数信号量（FIFO 等待队列，无外部依赖——只为 2 个并发槽不值得引三方包）。
 * 语义：acquire 在槽位耗尽时挂起调用方，release 时唤醒队首（严格先来先服务，
 * 不给大图饿死小图留窗口——队列顺序即到达顺序）。
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

/** 模块级单例信号量（并发上限 = ATTACHMENT_THUMB_DECODE_CONCURRENCY） */
const decodeSemaphore = new Semaphore(ATTACHMENT_THUMB_DECODE_CONCURRENCY);

/**
 * 生成 webp 缩略图（GIF/animated WebP 取首帧；最长边 ≤ 512 且不放大）。
 *
 * @param input 原始图片字节（调用方已完成魔数嗅探 + 头部尺寸校验；本函数
 *   仍自带 limitInputPixels 双保险，防头部解析与真实解码路径不一致）
 * @returns webp 字节 + 输出尺寸
 * @throws sharp/libvips 任意解码/编码错误——由调用方 fail-open 兜底
 */
export async function generateWebpThumbnail(input: Buffer): Promise<ThumbnailOutput> {
  await decodeSemaphore.acquire();
  try {
    const { data, info } = await sharp(input, ATTACHMENT_THUMB_DECODE_OPTIONS)
      .resize({
        width: ATTACHMENT_THUMB_MAX_EDGE,
        height: ATTACHMENT_THUMB_MAX_EDGE,
        fit: 'inside', // 最长边约束，保持宽高比
        withoutEnlargement: true, // 小图不放大（原尺寸输出）
      })
      .webp({ quality: ATTACHMENT_THUMB_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } finally {
    decodeSemaphore.release();
  }
}

/** 供 spec 断言的白名单导出（防后续改动悄悄把 GIF loader 移出白名单） */
export const THUMB_LOADER_WHITELIST: readonly string[] = THUMB_ALLOWED_BUFFER_LOADERS;
