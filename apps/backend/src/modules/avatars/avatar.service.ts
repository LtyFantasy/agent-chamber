/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Avatars（Wave 3 补充契约）
 *   - 补充: .kimi 会话 plan nova-prime-multiple-man-forager.md（Avatar 身份体系批次）
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '@agent-chamber/shared';
import { Actor } from '../../database/entities/actor.entity';

/**
 * SVG 头像原文体积上限（字节）。
 *
 * 32KB 的取舍：足够表达矢量插画级头像，同时把 DB 行膨胀与
 * GET 分发带宽限制在可忽略量级；超限直接 400，不截断不重写。
 */
const MAX_SVG_BYTES = 32 * 1024;

/**
 * 头像服务。
 *
 * 负责 SVG 自绘头像的写入（拒绝式 sanitize）与读取分发。
 * 安全模型：<img> 上下文下 SVG 内脚本本不执行，sanitize 是纵深防御，
 * 采用「拒绝式」——检测到危险特征即整体 400，不做重写改写，
 * 避免重写器自身引入解析差异漏洞。
 */
@Injectable()
export class AvatarService {
  constructor(
    @InjectRepository(Actor)
    private readonly actorRepo: Repository<Actor>,
  ) {}

  /**
   * 校验并保存当前 Actor 的 SVG 头像。
   *
   * 通过后联动把 avatarUrl 置为 /api/v1/avatars/:actorId.svg 短链，
   * 使所有只读 avatarUrl 的消费方（消息流/参与者/排行榜）零改动生效。
   *
   * @param actorId 当前登录 Actor（人类或 Agent）ID
   * @param svg SVG 文档原文
   * @returns 更新后的 avatarUrl
   */
  async uploadSvg(actorId: string, svg: string): Promise<{ avatarUrl: string }> {
    this.sanitizeSvg(svg);

    const actor = await this.actorRepo.findOne({ where: { id: actorId } });
    if (!actor) {
      throw new NotFoundException({
        message: 'Actor not found',
        code: ErrorCode.NOT_FOUND,
      });
    }

    const avatarUrl = `/api/v1/avatars/${actorId}.svg`;
    actor.avatarSvg = svg;
    actor.avatarUrl = avatarUrl;
    await this.actorRepo.save(actor);
    return { avatarUrl };
  }

  /**
   * 读取指定 Actor 的 SVG 头像原文。
   *
   * findOne 默认排除软删除 Actor（DeleteDateColumn 行为）。
   * Actor 不存在或未设置 SVG 头像统一返回 404（不区分两者，避免存在性探测）。
   */
  async getSvg(actorId: string): Promise<string> {
    const actor = await this.actorRepo.findOne({ where: { id: actorId } });
    if (!actor || !actor.avatarSvg) {
      throw new NotFoundException({
        message: 'Avatar not found',
        code: ErrorCode.NOT_FOUND,
      });
    }
    return actor.avatarSvg;
  }

  /**
   * 拒绝式 SVG 安全检查，不通过即抛 400。
   *
   * 规则（与设计决策对齐）：
   * 1. 体积 ≤ 32KB（按 UTF-8 字节计）；
   * 2. 允许前导空白与 <?xml 声明，其后必须以 <svg 根元素开头（防止伪装文档）；
   * 3. 不含 <script / foreignObject（嵌入 HTML 通道）；
   * 4. 不含 on\w+= 事件处理器属性（onload/onclick/...）；
   * 5. href / xlink:href 的值必须为空或 # 开头的内部引用（禁止外部资源加载，
   *    包括 http(s)、data:、javascript: 等一切外部形态）。
   */
  private sanitizeSvg(svg: string): void {
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
      throw new BadRequestException({
        message: `SVG exceeds size limit of ${MAX_SVG_BYTES} bytes`,
        code: ErrorCode.BAD_REQUEST,
      });
    }

    // 剥离前导空白与可选的 <?xml ...?> 声明后，根元素必须是 <svg
    const withoutXmlDecl = svg.replace(/^\s*<\?xml[\s\S]*?\?>/, '').trimStart();
    if (!/^<svg[\s>]/i.test(withoutXmlDecl)) {
      throw new BadRequestException({
        message: 'SVG must start with an <svg> root element',
        code: ErrorCode.BAD_REQUEST,
      });
    }

    const lower = svg.toLowerCase();
    if (lower.includes('<script') || lower.includes('foreignobject')) {
      throw new BadRequestException({
        message: 'SVG must not contain <script> or foreignObject',
        code: ErrorCode.BAD_REQUEST,
      });
    }

    if (/\son\w+\s*=/i.test(svg)) {
      throw new BadRequestException({
        message: 'SVG must not contain event handler attributes (on*=)',
        code: ErrorCode.BAD_REQUEST,
      });
    }

    // 提取所有 href / xlink:href 的值（双引号/单引号/无引号三种形态），仅允许 # 内部引用
    const hrefRe = /(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefRe.exec(svg)) !== null) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (value !== '' && !value.startsWith('#')) {
        throw new BadRequestException({
          message: 'SVG href values must be internal fragment references (#...)',
          code: ErrorCode.BAD_REQUEST,
        });
      }
    }
  }
}
