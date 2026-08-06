/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (doc_routes 段), plan §4-B5 (意图路由结构化)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空) #17(测试契约) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocService } from './doc.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { CreateDocRouteDto, UpdateDocRouteDto } from './dto';
import { DocRoute as DocRouteDto, ErrorCode } from '@agent-chamber/shared';

/**
 * codeEntry 格式校验（铁律 #21 业务校验层）：
 * - 超长（>512）→ 非法（DTO @MaxLength 已拦，此处双保险防御）
 * - 绝对路径（`/` 开头 POSIX 或盘符开头如 `C:\`）→ 非法
 * - 含 `..` 路径段（按 `/` 与 `\` 分割均查）→ 非法（可逃逸仓库根）
 *
 * 已知边界（plan §4-B5 明文）：本批次只做格式校验；仓库文件清单级联校验
 * （codeEntry 是否真实存在于仓库）缓行批次 C（需新增 manifest 写通道）。
 */
const CODE_ENTRY_MAX_LENGTH = 512;

/**
 * doc_routes 意图路由 Service（v1.42 批次 B5）
 *
 * 职责：
 * - CRUD：GET /doc-spaces/:id/routes（排序返回）、POST（createdBy=actor.id）、PATCH/DELETE
 * - 写时校验（铁律 #21/#22）：① primary/secondary doc 存在（未软删）且属于该空间 →
 *   400 DOC_ROUTE_DOC_NOT_FOUND；② headingPath 非空时精确命中该 doc 的 doc_sections.heading_path →
 *   400 DOC_ROUTE_HEADING_UNRESOLVED；③ codeEntry ≤512、禁绝对路径、禁 `..` 段 →
 *   400 DOC_ROUTE_INVALID_CODE_ENTRY；④ 路由本身不存在 → 404 DOC_ROUTE_NOT_FOUND
 *
 * 权限在 Controller 层完成（space read/write，铁律 #21 双层校验的格式/权限边界）。
 */
@Injectable()
export class DocRouteService {
  constructor(
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    private readonly docService: DocService,
  ) {}

  // ─── CRUD ───────────────────────────────────────────────────

  /** 按 ID 查路由（不含权限检查）。不存在 → 404 DOC_ROUTE_NOT_FOUND。 */
  async findById(id: string): Promise<DocRoute> {
    const route = await this.routeRepo.findOne({ where: { id } });
    if (!route) {
      throw new NotFoundException({
        message: 'Doc route not found',
        code: ErrorCode.DOC_ROUTE_NOT_FOUND,
      });
    }
    return route;
  }

  /**
   * 空间全量路由（GET /doc-spaces/:id/routes）。
   * 排序：sortOrder ASC → createdAt ASC（策展顺序稳定，同权重先建先出）。
   */
  async findAll(spaceId: string): Promise<DocRoute[]> {
    return this.routeRepo.find({
      where: { spaceId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /** 创建路由：写时校验通过后落库，createdBy=actor.id。 */
  async create(spaceId: string, dto: CreateDocRouteDto, actor: UnifiedActor): Promise<DocRoute> {
    await this.validateRouteRefs(spaceId, dto);

    const route = this.routeRepo.create({
      spaceId,
      intent: dto.intent,
      category: dto.category ?? null,
      primaryDocId: dto.primaryDocId,
      primaryHeadingPath: dto.primaryHeadingPath ?? null,
      secondaryDocId: dto.secondaryDocId ?? null,
      secondaryHeadingPath: dto.secondaryHeadingPath ?? null,
      codeEntry: dto.codeEntry ?? null,
      sortOrder: dto.sortOrder ?? 0,
      createdBy: actor.id,
    });
    return this.routeRepo.save(route);
  }

  /**
   * 更新路由（PATCH，Partial 语义）。
   *
   * 写时校验触发（plan §4-B5）：仅当 PATCH 触及 primary/secondary doc 或 headingPath 或
   * codeEntry 时重跑——dto 与现有值合并成完整视图后整体校验（"只改 headingPath"也能用现有
   * primaryDocId 验证归属，杜绝半校验漏洞）。只改 intent/category/sortOrder 不触发校验，
   * 避免"doc 后续编辑致 headingPath 悬空（批次 C 范围）"阻塞纯排序调整。
   */
  async update(id: string, dto: UpdateDocRouteDto): Promise<DocRoute> {
    const route = await this.findById(id);

    const refsChanged =
      dto.primaryDocId !== undefined ||
      dto.primaryHeadingPath !== undefined ||
      dto.secondaryDocId !== undefined ||
      dto.secondaryHeadingPath !== undefined ||
      dto.codeEntry !== undefined;

    if (refsChanged) {
      const merged = {
        primaryDocId: dto.primaryDocId ?? route.primaryDocId,
        primaryHeadingPath:
          dto.primaryHeadingPath !== undefined ? dto.primaryHeadingPath : route.primaryHeadingPath,
        secondaryDocId:
          dto.secondaryDocId !== undefined ? dto.secondaryDocId : route.secondaryDocId,
        secondaryHeadingPath:
          dto.secondaryHeadingPath !== undefined
            ? dto.secondaryHeadingPath
            : route.secondaryHeadingPath,
        codeEntry: dto.codeEntry !== undefined ? dto.codeEntry : route.codeEntry,
      };
      await this.validateRouteRefs(route.spaceId, merged);
    }

    if (dto.intent !== undefined) route.intent = dto.intent;
    if (dto.category !== undefined) route.category = dto.category ?? null;
    if (dto.primaryDocId !== undefined) route.primaryDocId = dto.primaryDocId;
    if (dto.primaryHeadingPath !== undefined)
      route.primaryHeadingPath = dto.primaryHeadingPath ?? null;
    if (dto.secondaryDocId !== undefined) route.secondaryDocId = dto.secondaryDocId ?? null;
    if (dto.secondaryHeadingPath !== undefined)
      route.secondaryHeadingPath = dto.secondaryHeadingPath ?? null;
    if (dto.codeEntry !== undefined) route.codeEntry = dto.codeEntry ?? null;
    if (dto.sortOrder !== undefined) route.sortOrder = dto.sortOrder;

    return this.routeRepo.save(route);
  }

  /** 删除路由（硬删——路由是纯策展元数据，无审计/事件契约）。不存在 → 404。 */
  async remove(id: string): Promise<{ deleted: boolean }> {
    await this.findById(id);
    await this.routeRepo.delete({ id });
    return { deleted: true };
  }

  // ─── 写时校验（铁律 #21/#22）────────────────────────────────

  /**
   * 写时校验（create 全量 / update 合并后全量）：
   *
   * ① primary/secondary doc 存在（未软删）且属于该空间 → 400 DOC_ROUTE_DOC_NOT_FOUND；
   * ② headingPath 非空时精确命中该 doc 的 doc_sections.heading_path（exists 查询，
   *    复用 doc.service.sectionExistsByHeadingPath）→ 400 DOC_ROUTE_HEADING_UNRESOLVED；
   * ③ codeEntry 非空时格式校验 → 400 DOC_ROUTE_INVALID_CODE_ENTRY。
   *
   * 已知边界（plan §4-B5 明文注释）：只保证写入当下可解析；doc 后续编辑/重排致
   * headingPath 悬空属批次 C 异步校验范围，本批次不处理。
   */
  private async validateRouteRefs(
    spaceId: string,
    refs: {
      primaryDocId: string;
      primaryHeadingPath?: string | null;
      secondaryDocId?: string | null;
      secondaryHeadingPath?: string | null;
      codeEntry?: string | null;
    },
  ): Promise<void> {
    // ① doc 存在性 + 空间归属（findOne 经 TypeORM 软删过滤，软删文档视同不存在）
    await this.ensureSpaceDoc(spaceId, refs.primaryDocId);
    if (refs.secondaryDocId) {
      await this.ensureSpaceDoc(spaceId, refs.secondaryDocId);
    }

    // ② headingPath 精确命中（仅非空时校验；null = 文档级跳转，放行）
    if (refs.primaryHeadingPath) {
      const hit = await this.docService.sectionExistsByHeadingPath(
        refs.primaryDocId,
        refs.primaryHeadingPath,
      );
      if (!hit) {
        throw new BadRequestException({
          message: `headingPath '${refs.primaryHeadingPath}' does not resolve in primary doc`,
          code: ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED,
        });
      }
    }
    if (refs.secondaryDocId && refs.secondaryHeadingPath) {
      const hit = await this.docService.sectionExistsByHeadingPath(
        refs.secondaryDocId,
        refs.secondaryHeadingPath,
      );
      if (!hit) {
        throw new BadRequestException({
          message: `headingPath '${refs.secondaryHeadingPath}' does not resolve in secondary doc`,
          code: ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED,
        });
      }
    }

    // ③ codeEntry 格式校验（≤512、禁绝对路径、禁 `..` 段）
    if (refs.codeEntry) {
      this.validateCodeEntry(refs.codeEntry);
    }
  }

  /** doc 存在（未软删）且属于 spaceId；否则 400 DOC_ROUTE_DOC_NOT_FOUND。 */
  private async ensureSpaceDoc(spaceId: string, docId: string): Promise<void> {
    const doc = await this.docRepo.findOne({ where: { id: docId } });
    if (!doc || doc.spaceId !== spaceId) {
      throw new BadRequestException({
        message: `Document '${docId}' does not exist or does not belong to this space`,
        code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND,
      });
    }
  }

  /**
   * codeEntry 格式校验：超长 / 绝对路径（`/` 或盘符开头）/ 含 `..` 段 → 400
   * DOC_ROUTE_INVALID_CODE_ENTRY。
   */
  private validateCodeEntry(codeEntry: string): void {
    if (codeEntry.length > CODE_ENTRY_MAX_LENGTH) {
      throw new BadRequestException({
        message: 'codeEntry exceeds 512 characters',
        code: ErrorCode.DOC_ROUTE_INVALID_CODE_ENTRY,
      });
    }
    const isAbsolute =
      codeEntry.startsWith('/') || // POSIX 绝对路径
      /^[A-Za-z]:[\\/]/.test(codeEntry); // Windows 盘符绝对路径（如 C:\）
    const hasParentTraversal =
      codeEntry.split('/').includes('..') || codeEntry.split('\\').includes('..');
    if (isAbsolute || hasParentTraversal) {
      throw new BadRequestException({
        message: 'codeEntry must be a repository-relative path (no absolute path or `..` segments)',
        code: ErrorCode.DOC_ROUTE_INVALID_CODE_ENTRY,
      });
    }
  }
}

/** 实体 → 响应 DTO 投影（字段直拷，含 null 语义；health 原样透传——NULL = 未检） */
export function toDocRouteDto(route: DocRoute): DocRouteDto {
  return {
    id: route.id,
    spaceId: route.spaceId,
    intent: route.intent,
    category: route.category,
    primaryDocId: route.primaryDocId,
    primaryHeadingPath: route.primaryHeadingPath,
    secondaryDocId: route.secondaryDocId,
    secondaryHeadingPath: route.secondaryHeadingPath,
    codeEntry: route.codeEntry,
    health: route.health,
    sortOrder: route.sortOrder,
    createdBy: route.createdBy,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}
