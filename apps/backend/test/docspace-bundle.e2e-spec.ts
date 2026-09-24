/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: 铁律 #23 教训（RT-SEAT-1）——导出/回导涉及 chunk/reconstruct 全文往返与
 *     ORM SQL 生成（sections/headingPath 重建、jsonb settings 读写），mock 单测测不出，
 *     必须有打真实 PG 的集成覆盖
 *
 * [踩坑索引] -
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace 导出→回导 roundtrip —— 真实 PG 集成套件（任务 T6；P2 批 5 追加媒体段）
 *
 * 与 docspace-patch.e2e-spec.ts 同款基建：打本地开发库 chamber-postgres，
 * 直接实例化 DocSpaceService/DocService/DocRouteService/DocBundleService
 * （真 TypeORM repo + 真 chunker/重建管线）。PG 不可达时整套降级跳过。
 *
 * 覆盖（验收标准 4）：
 * ① roundtrip 无损：导出 → 导入新空间后 docs（全文 content 逐字节相等 + 策展元数据）、
 *    categories、routes（含 codeEntryType/headingPath）内容一致
 * ② per-doc 失败不中止：目标空间存在 source 冲突文档（git:）→ 该篇 failed，其余成功
 * ③ 幂等再导入：重复导入不重复创建（doc/category/route 计数不变）
 * ④ formatVersion 校验：99 → 400 VALIDATION_ERROR；1/2 均接受
 * ⑤ overwriteSpaceMeta 默认关闭（空间元数据零写）+ 显式开启（覆盖 name/description/settings，
 *    保留 slug/creator）
 * ⑥ 媒体段（P2 批 5，真 MinIO）：导出打包附件字节（含缩略图）→ 导入新空间行回绑 +
 *    正文换成新 id + 授权读取字节一致；同 bundle 二导行数/对象数不变 + docs unchanged；
 *    v1 兼容（跳 media、正文保留旧 URL）；导出守卫（too_large / 联合预算 budget_exceeded，
 *    且**读对象前**即判定）；真 PG 的复用 tie-break（ORDER BY created_at,id）；
 *    手改包伪造 mime + 脚本字节 → failed 且零落行（存储型 XSS 防御，真 ORM 证据）
 *
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource, In } from 'typeorm';
import { ActorType, ErrorCode, Visibility } from '@agent-chamber/shared';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import { randomUUID, createHash } from 'crypto';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DocService } from '../src/modules/docspace/doc.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { DocRouteService } from '../src/modules/docspace/doc-route.service';
import { DocBundleService } from '../src/modules/docspace/doc-bundle.service';
import { DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES } from '../src/modules/docspace/doc-bundle.constants';
import { AttachmentService } from '../src/modules/attachments/attachment.service';
import { AttachmentStorageService } from '../src/modules/attachments/storage.service';
import { AttachmentAccessService } from '../src/modules/attachments/attachment-access.service';
import {
  makeRealPngBuffer,
  makeRealWebpBuffer,
} from '../src/modules/attachments/test-image-fixtures';
import { PermissionService } from '../src/common/services/permission.service';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';
import type { AccessQueryService } from '../src/common/services/access-query.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { ResourceValidator } from '../src/common/resource-validator';
import type { AuditService } from '../src/modules/audit/audit.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `bundle-e2e-${Date.now()}`;

/**
 * 固定测试 actor（docs.created_by 为 uuid 列，upsert 缺省 'system' 字面量会被 PG 拒绝）。
 * 本套件专用哨兵 id（不与 docspace-move/patch-metadata 共用 '...00aa'）：afterAll 按
 * actorId 清理 audit_logs 时并行安全，不误删其他套件行（08-29 套件污染修复）
 */
const testActor = { id: '00000000-0000-4000-8000-0000000000a4', type: ActorType.HUMAN };

/** 固定空间 creator（doc_spaces.creator_id 为 uuid 列） */
const spaceCreator = '00000000-0000-4000-8000-0000000000ee';

/** MinIO 测试实例（chamber-minio @ 19000；9000 被别项目占用勿动） */
const MINIO_CONFIG = {
  endPoint: process.env.MINIO_ENDPOINT ?? '127.0.0.1',
  port: Number(process.env.MINIO_PORT ?? 19000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minio_root_user',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'change-me-minio-secret',
  bucket: process.env.MINIO_BUCKET ?? 'agent-chamber-attachments',
};

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 造 ≥targetBytes 的正文（短行列表）。
 *
 * ⚠️ 刻意不用"单个 3MB 长行"：`link-health.maskMarkdownCode` 在非围栏行的每个字符上
 * 都会重新扫描到行尾（atLineStart 不复位），长行会让 upsert 变成 O(n²) 实际挂死
 * （本次实测踩到，已作为既有实现问题单独记录）。用真实形态（短行）既避开该路径，
 * 又更贴近"重租户 3MB 级空间"的真实分布。
 */
function fillerContent(targetBytes: number): string {
  const line = '- 填充条目：用于把 docs 段推过 3MB，验证媒体额度被压缩。0123456789 abcdefghij';
  const perLine = Buffer.byteLength(line, 'utf8') + 8;
  const count = Math.ceil(targetBytes / perLine);
  const parts: string[] = ['# 大文档', ''];
  for (let i = 0; i < count; i += 1) parts.push(`- ${i} ${line}`);
  return parts.join('\n');
}

/**
 * 媒体用例专用 actor（`attachments.uploader_id` 有 FK → actors，必须真实行）。
 * 用独立 id 便于 afterAll 按 uploader 精确清理本套件造的附件行。
 */
const mediaActor = { id: '00000000-0000-4000-8000-0000000000b5', type: ActorType.HUMAN };

/** 固定回归标题：裸 §3.2 属于标题正文，不得被误当作 headingPath 层级分隔符 */
const specialHeading = '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）';

describe('DocBundleService 导出→回导 roundtrip — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let minioAvailable = false;
  let minioClient: Minio.Client;

  let docspaceService: DocSpaceService;
  let docService: DocService;
  let docRouteService: DocRouteService;
  let bundleService: DocBundleService;
  let attachmentService: AttachmentService;
  let storageService: AttachmentStorageService;

  /** 源空间 + 目标空间（afterAll 兜底清理） */
  let srcSpaceId: string;
  let tgtSpaceId: string;
  const srcDocIds: string[] = [];
  const tgtDocIds: string[] = [];
  const srcRouteIds: string[] = [];
  const tgtRouteIds: string[] = [];

  // ── 媒体用例（P2 批 5）状态 ──
  /** 媒体源/目标空间 + 守卫/预算空间（各自 RUN 后缀，afterAll 全清） */
  let mediaSrcSpaceId: string;
  let mediaTgtSpaceId: string;
  let guardSpaceId: string;
  const mediaSpaceIds: string[] = [];
  const mediaDocIds: string[] = [];
  /** 本套件落过 MinIO 的对象键（afterAll 逐个清） */
  const mediaObjectKeys: string[] = [];
  let mediaActorRowCreated = false;
  /** 媒体源：文档 path / 原图字节 / 缩略图字节 / 源附件行 */
  let mediaDocPath: string;
  let mediaPng: Buffer;
  let mediaThumb: Buffer;
  let mediaSrcAtt: Attachment;
  /** 守卫用例：>6MiB 行（无对象）/ 5.75MiB 行（无对象，撞联合预算） */
  let tooLargeAtt: Attachment;
  let budgetAtt: Attachment;

  /** 冲刷 setImmediate 队列（route health recheck fire-and-forget） */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** 铺一个测试空间（空 settings 显式透传，避免依赖 DB default） */
  async function makeSpace(name: string): Promise<string> {
    const repo = ds.getRepository(DocSpace);
    const saved = await repo.save(
      repo.create({
        name,
        slug: `${name}-${RUN}`.slice(0, 128),
        description: null,
        creatorId: spaceCreator,
        settings: {},
      }),
    );
    return saved.id;
  }

  /** 通过真实 upsert 管线铺文档（sections/headingPath 由 chunker 生成，与导入路径同管线） */
  async function seedDoc(spaceId: string, path: string, content: string): Promise<Doc> {
    const r = await docService.upsert(spaceId, { path, content }, testActor);
    await flushImmediates();
    return docService.findById(r.id);
  }

  /**
   * 铺一行 doc 绑定附件 + 对应 MinIO 对象（原图 + 可选缩略图）。
   * 与上传路径同字段口径：sha256/sizeBytes 由**实际字节**算出（导出侧的字节自洽复核依赖它）。
   */
  async function seedAttachment(params: {
    docId: string;
    bytes: Buffer;
    mimeType: string;
    ext: string;
    originalName: string;
    thumb?: Buffer;
  }): Promise<Attachment> {
    const objectKey = `${randomUUID()}.${params.ext}`;
    await storageService.putObject(objectKey, params.bytes, params.mimeType);
    mediaObjectKeys.push(objectKey);

    let thumbFields: Partial<Attachment> = {};
    if (params.thumb) {
      const thumbKey = `${randomUUID()}.thumb.webp`;
      await storageService.putObject(thumbKey, params.thumb, 'image/webp');
      mediaObjectKeys.push(thumbKey);
      thumbFields = {
        thumbKey,
        thumbWidth: 64,
        thumbHeight: 48,
        thumbSizeBytes: String(params.thumb.length),
        thumbSha256: sha256Hex(params.thumb),
      };
    }

    const repo = ds.getRepository(Attachment);
    return repo.save(
      repo.create({
        uploaderId: mediaActor.id,
        bucket: storageService.getBucket(),
        objectKey,
        originalName: params.originalName,
        mimeType: params.mimeType,
        sizeBytes: String(params.bytes.length),
        sha256: sha256Hex(params.bytes),
        status: 'ready',
        topicId: null,
        docId: params.docId,
        ...thumbFields,
      }),
    );
  }

  /**
   * 只落 DB 行、**不落对象**的附件（守卫用例用）：
   * 若导出实现"先读对象再判上限"，该行会因对象缺失被丢弃（不入 media），
   * 因此"报 skipped 而不是消失"本身就是"读对象前预判"的证据。
   */
  async function seedRowOnlyAttachment(params: {
    docId: string;
    originalName: string;
    sizeBytes: number;
  }): Promise<Attachment> {
    const repo = ds.getRepository(Attachment);
    return repo.save(
      repo.create({
        uploaderId: mediaActor.id,
        bucket: storageService.getBucket(),
        objectKey: `${randomUUID()}.png`, // 该键在 MinIO 里不存在（刻意）
        originalName: params.originalName,
        mimeType: 'image/png',
        sizeBytes: String(params.sizeBytes),
        sha256: 'c'.repeat(64),
        status: 'ready',
        topicId: null,
        docId: params.docId,
      }),
    );
  }

  /** 按 path 取目标空间文档（媒体断言用） */
  async function findDocByPath(spaceId: string, path: string): Promise<Doc | null> {
    return ds
      .getRepository(Doc)
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.path = :path', { path })
      .getOne();
  }

  /**
   * 彻底删一个空间及其全部从属行（docs 无 FK 到 space：`docs.space_id` 是裸列，
   * 先删 doc 再删 space，否则留下 space_id 悬空、path 仍在的孤儿 doc——
   * 历史上本套件的导入目标空间正是这样漏下的）。
   */
  async function deleteSpaceCompletely(spaceId: string): Promise<void> {
    const docs = await ds.getRepository(Doc).find({ where: { spaceId } });
    for (const doc of docs) {
      await ds.getRepository(DocSection).delete({ docId: doc.id });
      await ds.getRepository(DocVersion).delete({ docId: doc.id });
      await ds.getRepository(Doc).delete({ id: doc.id });
    }
    for (const route of await ds.getRepository(DocRoute).find({ where: { spaceId } })) {
      await ds.getRepository(DocRoute).delete({ id: route.id });
    }
    for (const category of await ds.getRepository(DocCategory).find({ where: { spaceId } })) {
      await ds.getRepository(DocCategory).delete({ id: category.id });
    }
    await ds.getRepository(DocSpaceMember).delete({ spaceId });
    await ds.getRepository(DocSpace).delete({ id: spaceId });
  }

  /** 该空间全部附件行（按 id 序，断言稳定） */
  async function findAttachmentsByDocIds(docIds: string[]): Promise<Attachment[]> {
    if (docIds.length === 0) return [];
    const rows = await ds.getRepository(Attachment).find({ where: { docId: In(docIds) } });
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      // PG 不可达 → 整套降级跳过（本套件是环境依赖型集成测试）
      console.warn(
        `[docspace-bundle e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // ── Service 装配：真 repo + 打桩的 Event/RouteHealth/AccessQuery/ResourceValidator ──
    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;
    const accessQueryStub = {} as unknown as AccessQueryService;
    const resourceValidatorStub = {} as unknown as ResourceValidator;
    // 统一批 A1：DocSpaceService 构造新增 actorProfileService（真实例，成员 enrich 走公共解析）
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    // 统一批 A2：DocSpaceService/DocRouteService 构造新增 auditService（本套件断言不触达
    // 审计行，log 打桩防 createCategory/update 等写路径抛错）
    const auditServiceStub = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;

    docspaceService = new DocSpaceService(
      ds.getRepository(DocSpace),
      ds.getRepository(DocSpaceMember),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(TaskDocLink),
      ds.getRepository(DocRoute),
      ds.getRepository(Agent),
      ds.getRepository(User),
      ds.getRepository(Actor),
      ds.getRepository(Board),
      ds.getRepository(Topic),
      accessQueryStub,
      resourceValidatorStub,
      eventStub,
      actorProfileService,
      auditServiceStub,
    );
    docService = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      eventStub,
      routeHealthStub,
      ds.getRepository(IdempotencyRecord),
      // Diagram IR v1：bundle 回导 diagram 的重校验重渲染由 docspace-diagram e2e 覆盖；本套件桩件仅防构造参数缺失
      { validateAndRender: jest.fn() } as unknown as DiagramRendererService,
    );
    docRouteService = new DocRouteService(
      ds.getRepository(DocRoute),
      ds.getRepository(Doc),
      docService,
      auditServiceStub,
    );

    // ── 媒体用例装配（P2 批 5）：真 MinIO + 真 AttachmentService 门面 ──
    // 为什么在 bundle 套件里跑真对象存储：媒体段的核心命题是"字节真的过去了"，
    // 假存储只能证明调用顺序。MinIO 不可达 → 媒体用例整段跳过（文档用例不受影响）。
    minioClient = new Minio.Client(MINIO_CONFIG);
    try {
      const exists = await minioClient.bucketExists(MINIO_CONFIG.bucket);
      if (!exists) await minioClient.makeBucket(MINIO_CONFIG.bucket);
      minioAvailable = true;
    } catch (err) {
      console.warn(
        `[docspace-bundle e2e] MinIO unavailable, media cases skipped: ${(err as Error).message}`,
      );
    }

    const configStub = {
      get: (key: string): unknown => {
        if (key === 'minio.endPoint') return MINIO_CONFIG.endPoint;
        if (key === 'minio.port') return MINIO_CONFIG.port;
        if (key === 'minio.useSSL') return MINIO_CONFIG.useSSL;
        if (key === 'minio.accessKey') return MINIO_CONFIG.accessKey;
        if (key === 'minio.secretKey') return MINIO_CONFIG.secretKey;
        if (key === 'minio.bucket') return MINIO_CONFIG.bucket;
        return undefined;
      },
    };
    storageService = new AttachmentStorageService(configStub as unknown as ConfigService);

    // 读取授权走**真实 Policy**（附件 GET 的授权判定不能在本套件另写一份）：
    // DocSpacePolicy（真 repo）+ 其余 Policy 桩（本套件只碰 space 读，用不到它们）
    const docSpacePolicy = new DocSpacePolicy(
      ds.getRepository(DocSpaceMember),
      new OwnerProxyService(ds.getRepository(Agent)),
    );
    const permService = new PermissionService(
      {} as never,
      {} as never,
      docSpacePolicy,
      {} as never,
      {} as never,
    );
    const accessService = new AttachmentAccessService(
      ds.getRepository(Topic),
      ds.getRepository(Doc),
      ds.getRepository(DocSpace),
      {} as never,
      permService,
    );
    attachmentService = new AttachmentService(
      ds.getRepository(Attachment),
      ds.getRepository(TopicParticipant),
      ds,
      storageService,
      accessService,
      {} as never, // topicService：本套件只碰 doc 绑定附件（topic 分支不触达）
      docService,
      docspaceService,
      permService,
      new OwnerProxyService(ds.getRepository(Agent)),
      auditServiceStub,
    );

    bundleService = new DocBundleService(
      docspaceService,
      docService,
      docRouteService,
      attachmentService,
      ds.getRepository(DocSpace),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
    );

    // ── 源空间种子：2 分类 + 3 文档 + 2 路由（含 headingPath 锚点与 pattern codeEntry）──
    srcSpaceId = await makeSpace(`BundleSrc ${RUN}`);
    await docspaceService.createCategory(srcSpaceId, {
      name: '架构',
      slug: 'arch',
      description: '架构类文档',
      sortOrder: 5,
    });
    await docspaceService.createCategory(srcSpaceId, {
      name: '运维',
      slug: 'ops',
      sortOrder: 1,
    });

    const docA = await seedDoc(
      srcSpaceId,
      `tmp/${RUN}-a.md`,
      `# 导出文档 A\n\n引言段落。\n\n## 架构总览\n\n架构正文。\n\n## ${specialHeading}\n\n特殊标题正文。\n\n### 嵌套子标题\n\n嵌套子标题正文。\n\n## 数据流\n\n数据流正文。`,
    );
    const docB = await seedDoc(srcSpaceId, `tmp/${RUN}-b.md`, `# 导出文档 B\n\n运维指南。`);
    const docC = await seedDoc(srcSpaceId, `tmp/${RUN}-c.md`, `# 导出文档 C\n\n未分类。`);
    srcDocIds.push(docA.id, docB.id, docC.id);

    // 给 docA 补策展元数据（category/tags/docType/summary），验证导出元数据保真
    await docService.upsert(
      srcSpaceId,
      {
        path: docA.path,
        content: `# 导出文档 A\n\n引言段落。\n\n## 架构总览\n\n架构正文。\n\n## ${specialHeading}\n\n特殊标题正文。\n\n### 嵌套子标题\n\n嵌套子标题正文。\n\n## 数据流\n\n数据流正文。`,
        title: '导出文档 A',
        summary: '策展摘要 A',
        docType: 'guide',
        category: '架构',
        tags: ['backend', 'roundtrip'],
      },
      testActor,
    );
    await flushImmediates();
    // docB 归入运维分类
    await docService.upsert(
      srcSpaceId,
      {
        path: docB.path,
        content: `# 导出文档 B\n\n运维指南。`,
        title: '导出文档 B',
        docType: 'operations',
        category: '运维',
        tags: ['ops'],
      },
      testActor,
    );
    await flushImmediates();

    // 路由 1：headingPath 锚点（取 chunker 真实产物，避免硬编码分隔符细节）+ pattern codeEntry
    const headingPath = (
      await ds
        .getRepository(DocSection)
        .createQueryBuilder('s')
        .where('s.doc_id = :docId', { docId: docA.id })
        .andWhere('s.heading_path LIKE :headingPath', { headingPath: `%${specialHeading}%` })
        .getOne()
    )?.headingPath;
    expect(headingPath).toBe(`导出文档 A § ${specialHeading}`);
    const route1 = await docRouteService.create(
      srcSpaceId,
      {
        intent: '我要了解导出文档 A 的架构',
        category: '架构',
        primaryDocId: docA.id,
        primaryHeadingPath: headingPath ?? undefined,
        secondaryDocId: docB.id,
        codeEntry: 'apps/backend/src/modules/docspace/**',
        codeEntryType: 'pattern',
        sortOrder: 10,
      },
      testActor,
    );
    // 路由 2：文档级跳转（无 headingPath，codeEntryType 缺省 exact）
    const route2 = await docRouteService.create(
      srcSpaceId,
      {
        intent: '我要看运维指南',
        category: '运维',
        primaryDocId: docB.id,
        codeEntry: 'apps/backend/src/modules/docspace/doc.service.ts',
        sortOrder: 20,
      },
      testActor,
    );
    srcRouteIds.push(route1.id, route2.id);

    // ── 媒体用例种子（P2 批 5）：需 MinIO；不可达则整段跳过 ──
    if (minioAvailable) {
      // 媒体 actor（attachments.uploader_id 有 FK → actors，必须真实行）
      const actorRepo = ds.getRepository(Actor);
      await actorRepo.save(
        actorRepo.create({
          id: mediaActor.id,
          type: ActorType.HUMAN,
          displayName: `BundleMedia ${RUN}`,
          status: 'active',
        }),
      );
      mediaActorRowCreated = true;

      // ① 媒体源空间：1 篇文档（正文内联附件 URL）+ 1 行带缩略图的附件 + 2 个对象
      mediaSrcSpaceId = await makeSpace(`BundleMediaSrc ${RUN}`);
      mediaSpaceIds.push(mediaSrcSpaceId);
      mediaDocPath = `tmp/${RUN}-img.md`;
      const imgDoc = await seedDoc(mediaSrcSpaceId, mediaDocPath, `# 图文档\n\n占位段落。`);
      mediaDocIds.push(imgDoc.id);

      mediaPng = await makeRealPngBuffer(120, 90);
      mediaThumb = await makeRealWebpBuffer(64, 48);
      mediaSrcAtt = await seedAttachment({
        docId: imgDoc.id,
        bytes: mediaPng,
        mimeType: 'image/png',
        ext: 'png',
        originalName: '图.png',
        thumb: mediaThumb,
      });
      // 正文引用该附件（重写配对键 = 该 id）——upsert 走重建管线，与导入路径同管线
      await docService.upsert(
        mediaSrcSpaceId,
        {
          path: mediaDocPath,
          content: `# 图文档\n\n![img](/api/v1/attachments/${mediaSrcAtt.id}/content)\n`,
        },
        testActor,
      );
      await flushImmediates();

      mediaTgtSpaceId = await makeSpace(`BundleMediaTgt ${RUN}`);
      mediaSpaceIds.push(mediaTgtSpaceId);

      // ② 守卫/联合预算空间：≥3MB 正文（真实大空间形态，压缩媒体额度）+ 两行"无对象"候选
      //    （>6MiB → too_large；5.75MiB → base64 8.03MB 超剩余额度 → budget_exceeded）
      guardSpaceId = await makeSpace(`BundleGuard ${RUN}`);
      mediaSpaceIds.push(guardSpaceId);
      const bigDoc = await seedDoc(guardSpaceId, `tmp/${RUN}-big.md`, fillerContent(3_200_000));
      mediaDocIds.push(bigDoc.id);
      tooLargeAtt = await seedRowOnlyAttachment({
        docId: bigDoc.id,
        originalName: 'a-huge.png',
        sizeBytes: DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES + 1,
      });
      budgetAtt = await seedRowOnlyAttachment({
        docId: bigDoc.id,
        originalName: 'b-mid.png',
        sizeBytes: Math.floor(5.75 * 1024 * 1024),
      });
    }
  }, 120000);

  afterAll(async () => {
    if (!dbAvailable) return;

    // 硬删兜底清理（sections 走 CASCADE，显式删更直白；路由/分类先行防 FK 逻辑残留）
    for (const id of [...tgtRouteIds, ...srcRouteIds]) {
      await ds.getRepository(DocRoute).delete({ id });
    }
    for (const id of [...tgtDocIds, ...srcDocIds]) {
      await ds.getRepository(DocSection).delete({ docId: id });
      await ds.getRepository(Doc).delete({ id });
    }
    if (tgtSpaceId) {
      const tgtCats = await ds.getRepository(DocCategory).find({ where: { spaceId: tgtSpaceId } });
      for (const c of tgtCats) {
        await ds.getRepository(DocCategory).delete({ id: c.id });
      }
      await ds.getRepository(DocSpace).delete({ id: tgtSpaceId });
    }
    if (srcSpaceId) {
      const srcCats = await ds.getRepository(DocCategory).find({ where: { spaceId: srcSpaceId } });
      for (const c of srcCats) {
        await ds.getRepository(DocCategory).delete({ id: c.id });
      }
      await ds.getRepository(DocSpace).delete({ id: srcSpaceId });
    }
    // upsert/importBundle 写 audit_logs（actorId = testActor.id）——必须同步清理，否则
    // 残留行会挤占 activity-logs 套件 admin 全量查询的 20 条窗口（createdAt DESC）导致
    // 其 row-B/row-D/row-E 被挤出分页（08-29 实测 82+ 行污染）。按 actorId 删（本套件
    // 专用哨兵 actor，并行安全），覆盖用例内临时 doc 的 audit 行
    await ds.getRepository(AuditLog).delete({ actorId: testActor.id });

    // ── 媒体用例清理（FK 逆序：附件行 → 对象 → doc → space → actor）──
    if (minioAvailable) {
      // 本套件 mediaActor 名下的全部附件行（含导入在目标空间新建的行）——按
      // uploader 精确圈定（不 LIKE、不按空间，防漏行：批 4 教训"残留验证用全量 count"）
      const mediaRows = await ds.getRepository(Attachment).find({
        where: { uploaderId: mediaActor.id },
        withDeleted: true,
      });
      for (const row of mediaRows) {
        await ds.getRepository(Attachment).delete({ id: row.id });
      }
      // 对象：DB 行里的 key + 记录过的 key（守卫用例的行刻意无对象，删除幂等安全）
      const keys = new Set<string>(mediaObjectKeys);
      for (const row of mediaRows) {
        if (row.objectKey) keys.add(row.objectKey);
        if (row.thumbKey) keys.add(row.thumbKey);
      }
      for (const key of keys) {
        await storageService.removeObject(key).catch(() => undefined);
      }
    }
    for (const id of mediaDocIds) {
      await ds.getRepository(DocSection).delete({ docId: id });
      await ds.getRepository(DocVersion).delete({ docId: id });
      await ds.getRepository(Doc).delete({ id });
    }
    for (const spaceId of mediaSpaceIds) {
      await deleteSpaceCompletely(spaceId);
    }
    // 兜底 A：按 RUN 前缀硬删残留 doc（导入到目标空间的新行不在 tracked id 列表里）
    const leftoverDocs = await ds
      .getRepository(Doc)
      .createQueryBuilder('d')
      .where('d.path LIKE :prefix', { prefix: `tmp/${RUN}-%` })
      .getMany();
    for (const doc of leftoverDocs) {
      await ds.getRepository(DocSection).delete({ docId: doc.id });
      await ds.getRepository(DocVersion).delete({ docId: doc.id });
      await ds.getRepository(Doc).delete({ id: doc.id });
    }
    // 兜底 B：RUN 命名的残留空间（用例中途失败/空间未登记的路径）
    const leftoverSpaces = await ds
      .getRepository(DocSpace)
      .createQueryBuilder('s')
      .where('s.name LIKE :suffix', { suffix: `%${RUN}` })
      .getMany();
    for (const space of leftoverSpaces) {
      await deleteSpaceCompletely(space.id);
    }
    // 媒体 actor 写的 audit 行（importBundle → batchUpsert 路径）
    await ds.getRepository(AuditLog).delete({ actorId: mediaActor.id });
    if (mediaActorRowCreated) {
      await ds.getRepository(Actor).delete({ id: mediaActor.id });
    }
    await ds.destroy();
  }, 120000);

  // ─── ① roundtrip 无损 ───────────────────────────────────────

  it('roundtrip 无损：导出→导入新空间，docs 全文+元数据 / categories / routes 内容一致', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    expect(bundle.formatVersion).toBe(2);
    expect(bundle.docs).toHaveLength(3);
    expect(bundle.categories).toHaveLength(2);
    expect(bundle.routes).toHaveLength(2);

    // v1.62.0：导出 docs[] item 增 docId + contentHash（原始写入 payload 的 SHA-256，
    // 权威 revision 标识——content 是重建产物，其 SHA-256 ≠ contentHash）；且该新形状
    // bundle 直接回导不炸（含 docId/contentHash 字段不被 forbidNonWhitelisted 拒绝）
    for (const item of bundle.docs as Array<{ docId: string; contentHash: string | null }>) {
      expect(item.docId).toBeTruthy();
      expect(item.contentHash).toBeTruthy();
    }

    // 目标空间（空壳）导入
    tgtSpaceId = await makeSpace(`BundleTgt ${RUN}`);
    const result = await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
    await flushImmediates();

    // docs：全部 created、零失败
    expect(result.docs.summary).toEqual({
      total: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    // categories：全部 created
    expect(result.categories.summary).toEqual({ total: 2, created: 2, updated: 0, failed: 0 });
    // routes：全部 created（headingPath 写时校验通过 = 目标 sections 与源一致）
    expect(result.routes.summary).toEqual({ total: 2, created: 2, updated: 0, failed: 0 });
    // space meta：默认不回写
    expect(result.spaceMeta).toEqual({ applied: false, status: 'skipped' });

    // ── 逐篇对比：全文（getContent full=true 逐字节）+ 策展元数据 ──
    for (const srcDoc of await ds.getRepository(Doc).find({ where: { spaceId: srcSpaceId } })) {
      const tgtDoc = await ds
        .getRepository(Doc)
        .createQueryBuilder('d')
        .where('d.space_id = :spaceId', { spaceId: tgtSpaceId })
        .andWhere('d.path = :path', { path: srcDoc.path })
        .getOne();
      expect(tgtDoc).toBeTruthy();
      tgtDocIds.push(tgtDoc!.id);

      const srcFull = await docService.getContent(srcDoc.id, true);
      const tgtFull = await docService.getContent(tgtDoc!.id, true);
      expect(tgtFull.content).toBe(srcFull.content);
      expect(tgtDoc!.title).toBe(srcDoc.title);
      expect(tgtDoc!.summary).toBe(srcDoc.summary);
      expect(tgtDoc!.docType).toBe(srcDoc.docType);
      expect([...(tgtDoc!.tags ?? [])].sort()).toEqual([...(srcDoc.tags ?? [])].sort());
    }

    // ── 分类对比 ──
    const srcCats = await ds
      .getRepository(DocCategory)
      .find({ where: { spaceId: srcSpaceId }, order: { name: 'ASC' } });
    const tgtCats = await ds
      .getRepository(DocCategory)
      .find({ where: { spaceId: tgtSpaceId }, order: { name: 'ASC' } });
    expect(tgtCats.map((c) => [c.name, c.slug, c.description, c.sortOrder])).toEqual(
      srcCats.map((c) => [c.name, c.slug, c.description, c.sortOrder]),
    );

    // ── 路由对比（docId → path 归一对齐）──
    const pathOf = async (docId: string | null): Promise<string | null> => {
      if (!docId) return null;
      const doc = await ds.getRepository(Doc).findOne({ where: { id: docId } });
      return doc?.path ?? null;
    };
    const srcRoutes = await ds.getRepository(DocRoute).find({ where: { spaceId: srcSpaceId } });
    const tgtRoutes = await ds.getRepository(DocRoute).find({ where: { spaceId: tgtSpaceId } });
    tgtRouteIds.push(...tgtRoutes.map((r) => r.id));
    expect(tgtRoutes).toHaveLength(srcRoutes.length);

    const normRoute = async (r: DocRoute) => ({
      intent: r.intent,
      category: r.category,
      primaryDocPath: await pathOf(r.primaryDocId),
      primaryHeadingPath: r.primaryHeadingPath,
      secondaryDocPath: await pathOf(r.secondaryDocId),
      secondaryHeadingPath: r.secondaryHeadingPath,
      codeEntry: r.codeEntry,
      codeEntryType: r.codeEntryType,
      sortOrder: r.sortOrder,
    });
    const srcNorm = (await Promise.all(srcRoutes.map(normRoute))).sort((a, b) =>
      a.intent.localeCompare(b.intent),
    );
    const tgtNorm = (await Promise.all(tgtRoutes.map(normRoute))).sort((a, b) =>
      a.intent.localeCompare(b.intent),
    );
    expect(tgtNorm).toEqual(srcNorm);
  }, 60000);

  // ─── ② per-doc 失败不中止 ───────────────────────────────────

  it('per-doc 失败不中止：source 冲突文档该篇 failed，其余文档照常 created', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    // 目标空间预先放一篇 source='git:' 的同路径文档（真实冲突：native 导入必 409 DOC_SOURCE_MISMATCH）
    const conflictPath = `tmp/${RUN}-a.md`;
    const conflictSpace = await makeSpace(`BundleConflict ${RUN}`);
    const conflictDoc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: conflictSpace,
        categoryId: null,
        path: conflictPath,
        title: 'git 同步版',
        summary: null,
        docType: null,
        tags: [],
        source: 'git:test-sync',
        contentHash: 'conflict-hash',
        sourceSha: null,
        sectionCount: 1,
        tokenEstimate: 1,
        createdBy: spaceCreator,
      }),
    );
    try {
      const result = await bundleService.importBundle(conflictSpace, bundle as never, testActor);
      await flushImmediates();

      // 该篇 failed（DOC_SOURCE_MISMATCH），其余 2 篇 created——批次未中止
      expect(result.docs.summary.failed).toBe(1);
      expect(result.docs.summary.created).toBe(2);
      const failedItem = result.docs.results.find((r) => r.path === conflictPath);
      expect(failedItem?.status).toBe('failed');
      expect(failedItem?.error?.code).toBe(ErrorCode.DOC_SOURCE_MISMATCH);
      // 冲突文档未被改动（source 隔离校验拒绝写入）
      const stillThere = await ds.getRepository(Doc).findOne({ where: { id: conflictDoc.id } });
      expect(stillThere?.source).toBe('git:test-sync');
    } finally {
      // 清理冲突空间
      await ds.getRepository(DocSection).delete({ docId: conflictDoc.id });
      await ds.getRepository(Doc).delete({ id: conflictDoc.id });
      const cats = await ds.getRepository(DocCategory).find({ where: { spaceId: conflictSpace } });
      for (const c of cats) await ds.getRepository(DocCategory).delete({ id: c.id });
      const routes = await ds.getRepository(DocRoute).find({ where: { spaceId: conflictSpace } });
      for (const r of routes) await ds.getRepository(DocRoute).delete({ id: r.id });
      await ds.getRepository(DocSpace).delete({ id: conflictSpace });
    }
  }, 60000);

  // ─── ③ 幂等再导入 ───────────────────────────────────────────

  it('幂等再导入：重复导入同一 bundle 不重复创建（计数不变、docs unchanged/updated）', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    if (!tgtSpaceId) {
      tgtSpaceId = await makeSpace(`BundleTgt ${RUN}`);
      await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
      await flushImmediates();
    }

    const countDocs = () => ds.getRepository(Doc).count({ where: { spaceId: tgtSpaceId } });
    const countCats = () => ds.getRepository(DocCategory).count({ where: { spaceId: tgtSpaceId } });
    const countRoutes = () => ds.getRepository(DocRoute).count({ where: { spaceId: tgtSpaceId } });
    const before = {
      docs: await countDocs(),
      cats: await countCats(),
      routes: await countRoutes(),
    };

    const again = await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
    await flushImmediates();

    // 无 created：docs 内容相同 → unchanged；categories/routes 业务键命中 → updated
    expect(again.docs.summary.created).toBe(0);
    expect(again.docs.summary.unchanged).toBe(3);
    expect(again.categories.summary).toEqual({ total: 2, created: 0, updated: 2, failed: 0 });
    expect(again.routes.summary).toEqual({ total: 2, created: 0, updated: 2, failed: 0 });

    const after = {
      docs: await countDocs(),
      cats: await countCats(),
      routes: await countRoutes(),
    };
    expect(after).toEqual(before);
  }, 60000);

  // ─── ④ formatVersion 校验 ───────────────────────────────────

  it('formatVersion 不匹配 → 400 VALIDATION_ERROR，零写入', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    const bad = { ...bundle, formatVersion: 99 };
    const probeSpace = await makeSpace(`BundleProbe ${RUN}`);
    try {
      await expect(
        bundleService.importBundle(probeSpace, bad as never, testActor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.VALIDATION_ERROR },
      });
      expect(await ds.getRepository(Doc).count({ where: { spaceId: probeSpace } })).toBe(0);
      expect(await ds.getRepository(DocCategory).count({ where: { spaceId: probeSpace } })).toBe(0);
    } finally {
      await ds.getRepository(DocSpace).delete({ id: probeSpace });
    }
  }, 60000);

  // ─── ⑤ overwriteSpaceMeta ───────────────────────────────────

  it('overwriteSpaceMeta：默认关闭零写；显式开启覆盖 name/description/settings，保留 slug/creator', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    const metaSpace = await makeSpace(`BundleMeta ${RUN}`);
    const metaRepo = ds.getRepository(DocSpace);
    try {
      // 默认关闭：空间元数据不被 bundle 触碰
      const before = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(before?.name).toBe(`BundleMeta ${RUN}`);
      expect(before?.description).toBeNull();

      const r1 = await bundleService.importBundle(metaSpace, bundle as never, testActor);
      expect(r1.spaceMeta.applied).toBe(false);
      const afterDefault = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(afterDefault?.name).toBe(`BundleMeta ${RUN}`); // 未覆盖
      expect(afterDefault?.description).toBeNull();

      // 显式开启：name/description/settings 整对象覆盖
      await docspaceService.update(metaSpace, { description: '目标图例' });
      const r2 = await bundleService.importBundle(metaSpace, bundle as never, testActor, true);
      expect(r2.spaceMeta).toEqual({ applied: true, status: 'updated' });

      const after = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(after?.name).toBe(bundle.space.name);
      expect(after?.description).toBe(bundle.space.description);
      expect(after?.settings.visibility).toBe(Visibility.OPEN);
      // 身份字段不随 bundle 迁移
      expect(after?.slug).toContain('BundleMeta');
      expect(after?.creatorId).toBe(spaceCreator);
    } finally {
      await ds.getRepository(DocSpace).delete({ id: metaSpace });
    }
  }, 60000);

  // ─── ⑥ 媒体段 roundtrip（P2 批 5，真 PG + 真 MinIO）──────────

  it('媒体 roundtrip：导出打包附件字节（含缩略图）→ 导入新空间：行回绑 + 正文用新 id + 授权读取字节一致', async () => {
    if (!dbAvailable || !minioAvailable) return;

    const bundle = await bundleService.exportBundle(mediaSrcSpaceId);
    expect(bundle.formatVersion).toBe(2);
    expect(bundle.media).toHaveLength(1);
    expect(bundle.mediaOmitted).toEqual([]);

    const item = bundle.media[0];
    if ('skipped' in item) throw new Error('expected a packed media item');
    expect(item).toMatchObject({
      sourceAttachmentId: mediaSrcAtt.id,
      docPath: mediaDocPath,
      originalName: '图.png',
      mimeType: 'image/png',
      sizeBytes: mediaPng.length,
      sha256: sha256Hex(mediaPng),
    });
    // 字节真的在包里（base64 解出与源文件逐字节相等）+ 缩略图载荷
    expect(Buffer.from(item.contentBase64, 'base64').equals(mediaPng)).toBe(true);
    expect(item.thumbnail).toMatchObject({
      width: 64,
      height: 48,
      sizeBytes: mediaThumb.length,
      sha256: sha256Hex(mediaThumb),
    });
    expect(Buffer.from(item.thumbnail!.contentBase64, 'base64').equals(mediaThumb)).toBe(true);

    // ── 导入目标空间（importer = mediaActor）──
    const result = await bundleService.importBundle(mediaTgtSpaceId, bundle as never, mediaActor);
    await flushImmediates();
    expect(result.media).toEqual({ created: 1, reused: 0, skipped: 0, failed: [] });
    expect(result.docs.summary).toEqual({
      total: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });

    // 行在且回绑到新 doc；uploader = importer；thumb 5 列随行落库
    const newDoc = await findDocByPath(mediaTgtSpaceId, mediaDocPath);
    expect(newDoc).toBeTruthy();
    const tgtRows = await findAttachmentsByDocIds([newDoc!.id]);
    expect(tgtRows).toHaveLength(1);
    const newRow = tgtRows[0];
    expect(newRow.id).not.toBe(mediaSrcAtt.id);
    expect(newRow.uploaderId).toBe(mediaActor.id);
    expect(newRow.status).toBe('ready');
    expect(newRow.docId).toBe(newDoc!.id);
    expect(newRow.thumbKey).toBeTruthy();
    expect(newRow.thumbSha256).toBe(sha256Hex(mediaThumb));

    // 正文换成 NEW id，源 id 不再出现（无映射不重写不适用：这里必有映射）
    const tgtContent = (await docService.getContent(newDoc!.id, true)).content;
    expect(tgtContent).toContain(`/api/v1/attachments/${newRow.id}/content`);
    expect(tgtContent).not.toContain(mediaSrcAtt.id);

    // GET 等价物：授权读取链路（findAccessible → DocSpacePolicy read）+ 真实字节
    const readable = await attachmentService.getContent(newRow.id, mediaActor);
    const chunks: Buffer[] = [];
    for await (const chunk of readable.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const served = Buffer.concat(chunks);
    expect(served.equals(mediaPng)).toBe(true);
    expect(readable.attachment.mimeType).toBe('image/png');
    // 缩略图变体同样可取（5 列声明与实际对象一致）
    const thumbRead = await attachmentService.getThumbnail(newRow.id, mediaActor);
    const thumbChunks: Buffer[] = [];
    for await (const chunk of thumbRead.stream) {
      thumbChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(thumbChunks).equals(mediaThumb)).toBe(true);
  }, 60000);

  it('同 bundle 二导：附件行数/对象数不变 + docs unchanged（复用键命中，不重复落对象）', async () => {
    if (!dbAvailable || !minioAvailable) return;

    const bundle = await bundleService.exportBundle(mediaSrcSpaceId);
    const newDocBefore = await findDocByPath(mediaTgtSpaceId, mediaDocPath);
    expect(newDocBefore).toBeTruthy();
    const rowsBefore = await findAttachmentsByDocIds([newDocBefore!.id]);
    expect(rowsBefore).toHaveLength(1);
    const keysBefore = [rowsBefore[0].objectKey, rowsBefore[0].thumbKey].filter(
      (k): k is string => typeof k === 'string',
    );
    const contentBefore = (await docService.getContent(newDocBefore!.id, true)).content;

    const again = await bundleService.importBundle(mediaTgtSpaceId, bundle as never, mediaActor);
    await flushImmediates();

    // 幂等：复用命中（不新建行、不新建对象），docs unchanged（正文重写结果逐字节相同）
    expect(again.media).toEqual({ created: 0, reused: 1, skipped: 0, failed: [] });
    expect(again.docs.summary.unchanged).toBe(1);
    expect(again.docs.summary.created).toBe(0);

    const newDocAfter = await findDocByPath(mediaTgtSpaceId, mediaDocPath);
    const rowsAfter = await findAttachmentsByDocIds([newDocAfter!.id]);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(rowsBefore[0].id); // 同一行
    expect(
      [rowsAfter[0].objectKey, rowsAfter[0].thumbKey].filter((k) => typeof k === 'string'),
    ).toEqual(keysBefore);
    expect((await docService.getContent(newDocAfter!.id, true)).content).toBe(contentBefore);
    // 对象数不变：原图 + 缩略图两个对象都还在（且没有为复用项新写对象）
    for (const key of keysBefore) {
      const stat = await minioClient.statObject(MINIO_CONFIG.bucket, key);
      expect(stat.size).toBeGreaterThan(0);
    }
  }, 60000);

  it('复用 tie-break（真 PG ORDER BY created_at,id）：同 sha 两候选取更早的一行', async () => {
    if (!dbAvailable || !minioAvailable) return;

    // 独立空间：先做一次导入拿到 R1（绑定目标 doc），再插一条 docId NULL 的更早 R0
    const tieSpace = await makeSpace(`BundleTie ${RUN}`);
    mediaSpaceIds.push(tieSpace);
    const bundle = await bundleService.exportBundle(mediaSrcSpaceId);
    const first = await bundleService.importBundle(tieSpace, bundle as never, mediaActor);
    await flushImmediates();
    expect(first.media.created).toBe(1);

    const tieDoc = await findDocByPath(tieSpace, mediaDocPath);
    expect(tieDoc).toBeTruthy();
    const [r1] = await findAttachmentsByDocIds([tieDoc!.id]);
    expect(r1).toBeTruthy();

    // R0：同 uploader/sha、未绑定（docId NULL）、createdAt 更早 —— 确定性序应选中它
    const repo = ds.getRepository(Attachment);
    const r0 = await repo.save(
      repo.create({
        uploaderId: mediaActor.id,
        bucket: storageService.getBucket(),
        objectKey: `${randomUUID()}.png`, // 复用项不读对象 → 无需真实对象
        originalName: 'earlier.png',
        mimeType: 'image/png',
        sizeBytes: String(mediaPng.length),
        sha256: sha256Hex(mediaPng),
        status: 'ready',
        topicId: null,
        docId: null,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );

    const second = await bundleService.importBundle(tieSpace, bundle as never, mediaActor);
    await flushImmediates();

    expect(second.media).toEqual({ created: 0, reused: 1, skipped: 0, failed: [] });
    const afterDoc = await findDocByPath(tieSpace, mediaDocPath);
    const content = (await docService.getContent(afterDoc!.id, true)).content;
    // 选中更早的 R0：正文指向 R0，且 R0 被回绑到目标 doc
    expect(content).toContain(`/api/v1/attachments/${r0.id}/content`);
    const rebound = await ds.getRepository(Attachment).findOne({ where: { id: r0.id } });
    expect(rebound?.docId).toBe(afterDoc!.id);
    expect(rebound?.id).not.toBe(r1.id);
  }, 60000);

  it('v1 兼容：formatVersion=1 包导入 → 跳 media（全零值形状）、正文保留旧 URL、零附件行', async () => {
    if (!dbAvailable || !minioAvailable) return;

    const v2 = await bundleService.exportBundle(mediaSrcSpaceId);
    const v1 = { ...v2, formatVersion: 1, media: undefined, mediaOmitted: undefined };
    const v1Space = await makeSpace(`BundleMediaV1 ${RUN}`);
    mediaSpaceIds.push(v1Space);

    const before = await ds.getRepository(Attachment).count({
      where: { uploaderId: mediaActor.id },
    });

    const result = await bundleService.importBundle(v1Space, v1 as never, mediaActor);
    await flushImmediates();

    expect(result.formatVersion).toBe(1);
    expect(result.media).toEqual({ created: 0, reused: 0, skipped: 0, failed: [] });
    const v1Doc = await findDocByPath(v1Space, mediaDocPath);
    expect(v1Doc).toBeTruthy();
    // 无映射不重写：旧 URL 原样保留（断链可见，不换成错链）
    expect((await docService.getContent(v1Doc!.id, true)).content).toContain(
      `/api/v1/attachments/${mediaSrcAtt.id}/content`,
    );
    expect(await ds.getRepository(Attachment).count({ where: { uploaderId: mediaActor.id } })).toBe(
      before,
    );
  }, 60000);

  it('导出守卫：单项超 6MiB → too_large；docs≥3MB 联合预算下超剩余额度 → budget_exceeded（均不读对象）', async () => {
    if (!dbAvailable || !minioAvailable) return;

    const readSpy = jest.spyOn(attachmentService, 'readObjectBytes');
    try {
      const bundle = await bundleService.exportBundle(guardSpaceId);

      expect(bundle.media).toEqual([
        {
          skipped: 'too_large',
          sourceAttachmentId: tooLargeAtt.id,
          docPath: `tmp/${RUN}-big.md`,
          originalName: 'a-huge.png',
          sizeBytes: DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES + 1,
        },
        {
          skipped: 'budget_exceeded',
          sourceAttachmentId: budgetAtt.id,
          docPath: `tmp/${RUN}-big.md`,
          originalName: 'b-mid.png',
          sizeBytes: Math.floor(5.75 * 1024 * 1024),
        },
      ]);
      // 预判发生在读对象之前（两行刻意没有对象：若先读就会因缺对象而"消失"而不是 skipped）
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  }, 60000);

  it('手改包防御：伪造 mime + 脚本字节 → 该项 failed 且零落行（真 ORM 的 XSS 回归证据）', async () => {
    if (!dbAvailable || !minioAvailable) return;

    const bundle = await bundleService.exportBundle(mediaSrcSpaceId);
    const scriptBytes = Buffer.from('<script>alert(1)</script>');
    const forged = {
      ...bundle,
      media: [
        {
          sourceAttachmentId: mediaSrcAtt.id,
          docPath: mediaDocPath,
          originalName: 'evil.png',
          mimeType: 'image/png',
          sizeBytes: scriptBytes.length,
          sha256: sha256Hex(scriptBytes),
          contentBase64: scriptBytes.toString('base64'),
        },
      ],
    };
    const xssSpace = await makeSpace(`BundleXss ${RUN}`);
    mediaSpaceIds.push(xssSpace);
    const before = await ds.getRepository(Attachment).count({
      where: { uploaderId: mediaActor.id },
    });

    const result = await bundleService.importBundle(xssSpace, forged as never, mediaActor);
    await flushImmediates();

    expect(result.media.created).toBe(0);
    expect(result.media.failed).toEqual([
      {
        docPath: mediaDocPath,
        originalName: 'evil.png',
        reason: expect.stringContaining('not an allowed image'),
      },
    ]);
    // 零落行（真 ORM count）+ 正文无映射不重写（旧 URL 保留）
    expect(await ds.getRepository(Attachment).count({ where: { uploaderId: mediaActor.id } })).toBe(
      before,
    );
    const xssDoc = await findDocByPath(xssSpace, mediaDocPath);
    expect((await docService.getContent(xssDoc!.id, true)).content).toContain(
      `/api/v1/attachments/${mediaSrcAtt.id}/content`,
    );
  }, 60000);
});
