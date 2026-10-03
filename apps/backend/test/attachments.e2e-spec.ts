/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Attachments + §6 消息（attachmentIds 绑定）
 *   - 补充: plan wiccan-carnage-rocket.md §7（测试矩阵 e2e 行）
 *
 * [踩坑索引]
 *   - MINIO-ENV: 本套件读 MINIO_* env（默认 127.0.0.1:19000 chamber-minio；
 *     9000 被别项目占用勿动）。MinIO 不可达整套 warn+skip（PG 不可达同口径）。
 *   - QUOTA-SEED: 配额用例不打 200MiB 真实上传——SQL 插一行 size_bytes=配额-10
 *     的假行（uploader=独立 agent），再传 33B 即越界触发 403·12003；
 *     该假行无对应 MinIO 对象，清理只删行。
 *   - EXPIRED-FIXTURE(v1.90.0-dev): 过期态一律「直改 DB expires_at」（forceExpire）构造，
 *     **不依赖时钟流逝、也不依赖 sweep 被关**——模块不注册 AttachmentGcService + 生产侧
 *     cron 受 isTestEnv 控制（ATTACHMENT_EXPIRED_SWEEP_ENABLED），故"过期但行仍在"的
 *     中间态全程稳定（410 不会翻 404）。安全方向: 任何新增过期用例都走 forceExpire。
 *   - PROJ-SNAPSHOT(v1.90.0-dev): 消息附件投影是**发送时刻快照**——直改附件行不影响
 *     历史消息的 expiresAt/expired；验"投影过期"要改 messages.metadata 快照
 *     （getMessageById 后 jsonb_set），不是改附件行。
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 新增用例必须登记 created.* 清理队列（FK 逆序 + MinIO 对象）
 *   □ RUN 后缀隔离纪律不破坏（不碰任何既有数据）
 *   □ 断言响应头时与 attachment.controller / attachment-public.controller 的出口头同批（三出口同套）
 *   □ 涉及 TTL 的用例：写入面走真实 API（PATCH config），过期态走 forceExpire 直改 DB
 * =============================================================================
 */

/**
 * Attachments e2e —— 真 PG + 真 MinIO 全链路套件（plan §7）
 *
 * 覆盖：
 * ① 全链：上传→元数据→内容（字节一致+五头）→删除→再读 404；
 * ② 读取授权矩阵：topic participant 放行 / space member 放行 / 局外人 404 /
 *    admin 放行 / 上传者自读；
 * ③ sendMessage 绑定：成功落 metadata.attachments（SQL 直查）/ 他人附件 403 /
 *    绑定他 topic 403 / >9 个 400 / 不存在 404 / 响应恒存在结构化 attachments 投影
 *    （P1：5 字段 + contentUrl，无附件 = []，不透原始 metadata 键）；
 * ④ 配额 403·12003（QUOTA-SEED 数据驱动，见踩坑索引）；
 * ⑤ bucket 匿名拒读（无凭证直连 MinIO getObject 被拒——private 断言）；
 * ⑥ FK SET NULL：硬删 topic 后附件落无绑定态（局外人 404、上传者 200）；
 * ⑦ linkHealth：含附件 URL 的 doc 重算后 broken 不含附件条目（§4.2）；
 * ⑧ X-API-Key 真实认证路径（agent 上传走 guard API Key 分支）；
 * ⑨ 缩略图变体（P2 批 1）：真实 PNG 上传 → thumb 对象（webp ≤512）+ 行 5 列 +
 *    投影第 6 键 + GET /thumbnail 200 五头 + 授权 404 一致性 + 删除双删（双 404）；
 *    伪图（sharp 解不了码）→ fail-open：行 5 列 null + 第 6 键缺席 + 404·12008。
 * ⑩ 短时签名 URL（P2 批 2）：铸造 200 no-store + 无凭证读 200（字节一致/五头/
 *    Cache-Control: private）+ audit 无 token；thumbnail 变体全链 + 两端点 12008
 *    逐字；负例矩阵（无/数组/篡改/错误 aid/会话 token/其它密钥族/过期）→ 400·401
 *    对应码；**双向回归**：铸造 token 打两类守卫族端点 → 401（本套件刻意让
 *    attachmentUrl.secret == jwt.secret，使该 401 只能由 payload 形状断言解释）；
 *    软删后公开端点 404·12000。
 *
 * 环境约定（telemetry/briefing 范式）：PG 或 MinIO 不可达 → warn + 整套 skip；
 * RUN 后缀隔离，afterAll 按 FK 依赖逆序硬删 + MinIO 对象逐个清空。
 */
import request = require('supertest');
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import * as crypto from 'crypto';
import * as Minio from 'minio';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  ErrorCode,
  TopicStatus,
  UserRole,
  API_PREFIX,
  DocSpaceMemberRole,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AttachmentController } from '../src/modules/attachments/attachment.controller';
import { AttachmentPublicController } from '../src/modules/attachments/attachment-public.controller';
import { AttachmentService } from '../src/modules/attachments/attachment.service';
import { AttachmentSignedUrlService } from '../src/modules/attachments/attachment-signed-url.service';
import { AttachmentStorageService } from '../src/modules/attachments/storage.service';
import { AttachmentAccessService } from '../src/modules/attachments/attachment-access.service';
import { MulterLimitErrorInterceptor } from '../src/modules/attachments/multer-error.interceptor';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { TopicController } from '../src/modules/topic/topic.controller';
import { TopicService } from '../src/modules/topic/topic.service';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { RouteHealthService } from '../src/modules/docspace/route-health.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { PermissionService } from '../src/common/services/permission.service';
import { TopicPolicy } from '../src/common/policies/topic.policy';
import { BoardPolicy } from '../src/common/policies/board.policy';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import { TaskPolicy } from '../src/common/policies/task.policy';
import { AgentPolicy } from '../src/common/policies/agent.policy';
import { EventService } from '../src/modules/event/event.service';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Task } from '../src/database/entities/task.entity';
import { Attachment } from '../src/database/entities/attachment.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import {
  makePngBuffer,
  makeAnimatedGifBuffer,
  makeRealPngBuffer,
} from '../src/modules/attachments/test-image-fixtures';
import sharp from 'sharp';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** MinIO 测试实例（本批环境事实：chamber-minio @ 19000；env 覆盖） */
const MINIO_CONFIG = {
  endPoint: process.env.MINIO_ENDPOINT ?? '127.0.0.1',
  port: Number(process.env.MINIO_PORT ?? 19000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minio_root_user',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'change-me-minio-secret',
  bucket: process.env.MINIO_BUCKET ?? 'agent-chamber-attachments',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 配额常量（与 attachment.constants.ts 默认值一致——QUOTA-SEED 用例的算术基准） */
const DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024;

describe('attachments e2e（真 PG + 真 MinIO）', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let minioAvailable = false;
  let minioClient: Minio.Client;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let jwtService: JwtService;

  /** 本次运行创建的实体与对象（afterAll 按 FK 依赖逆序清理） */
  const created: {
    attachmentIds: string[];
    messageIds: string[];
    participantKeys: Array<{ topicId: string; participantId: string }>;
    topicIds: string[];
    sectionIds: string[];
    docIds: string[];
    memberKeys: Array<{ spaceId: string; actorId: string }>;
    spaceIds: string[];
    keyIds: string[];
    agentIds: string[];
    agentActorIds: string[];
    userIds: string[];
    userActorIds: string[];
    objectKeys: string[];
  } = {
    attachmentIds: [],
    messageIds: [],
    participantKeys: [],
    topicIds: [],
    sectionIds: [],
    docIds: [],
    memberKeys: [],
    spaceIds: [],
    keyIds: [],
    agentIds: [],
    agentActorIds: [],
    userIds: [],
    userActorIds: [],
    objectKeys: [],
  };

  /** PG/MinIO 双可达守卫（每个用例首行调用） */
  function available(): boolean {
    return dbAvailable && minioAvailable;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      // 与生产 AppModule 同款命名策略：未显式 name 的列走 snake_case
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[attachments e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // MinIO 可达性（bucket 缺失时顺手自建——与 StorageService.OnModuleInit 同语义）
    minioClient = new Minio.Client(MINIO_CONFIG);
    try {
      const exists = await minioClient.bucketExists(MINIO_CONFIG.bucket);
      if (!exists) await minioClient.makeBucket(MINIO_CONFIG.bucket);
      minioAvailable = true;
    } catch (err) {
      console.warn(`[attachments e2e] MinIO unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    // 与生产同构直连：真实 repo + 真实服务链（AuditService 真实例——audit 行
    // 随 created 记录清理；EventService 桩——事件写非被测面）
    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const actorProfile = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const auditService = new AuditService(ds.getRepository(AuditLog), ownerProxy, actorProfile);

    jwtService = new JwtService({ secret: 'test-secret' });
    // ConfigService：JwtOrApiKeyGuard 读 jwt.secret；StorageService 读 minio.*；
    // AttachmentSignedUrlService 读 attachmentUrl.secret/ttlDefaultSeconds
    const configMock = {
      get: (key: string): unknown => {
        if (key === 'jwt.secret') return 'test-secret';
        // 附件签名密钥**刻意与会话密钥同值**（仅本套件）：这样"铸造 token 作 Bearer
        // 打会话端点必须 401"才是真证据——签名合法，唯一的墙是 payload 形状断言
        // （B1-A）。若两钥不同，测试只能证明"签名不匹配"，证明不了断言有效。
        // 生产环境该同值会被 config fail-fast 拒绝（attachment-url.config.ts）。
        if (key === 'attachmentUrl.secret') return 'test-secret';
        if (key === 'attachmentUrl.ttlDefaultSeconds') return 300;
        if (key === 'minio.endPoint') return MINIO_CONFIG.endPoint;
        if (key === 'minio.port') return MINIO_CONFIG.port;
        if (key === 'minio.useSSL') return MINIO_CONFIG.useSSL;
        if (key === 'minio.accessKey') return MINIO_CONFIG.accessKey;
        if (key === 'minio.secretKey') return MINIO_CONFIG.secretKey;
        if (key === 'minio.bucket') return MINIO_CONFIG.bucket;
        return undefined;
      },
    };

    // 最小 Nest 模块：Attachment/Topic 两 controller + AttachmentPublicController
    // （P2 批 2 公开端点）+ 真实服务链 + 真实 JwtOrApiKeyGuard（Bearer JWT 签发 +
    // API Key sha256 查表双路径）+ 真实 JwtStrategy（TopicController 的
    // @UseGuards(JwtAuthGuard) 端点走 passport 'jwt'，即全局守卫同族）+ 生产同款
    // 全局管线（ValidationPipe / ResponseInterceptor / AllExceptionsFilter /
    // /api/v1 前缀）。不走 AppModule：避免 schedule/WS 等无关启动面。
    moduleRef = await Test.createTestingModule({
      controllers: [AttachmentController, AttachmentPublicController, TopicController],
      providers: [
        AttachmentService,
        AttachmentSignedUrlService,
        AttachmentStorageService,
        AttachmentAccessService,
        MulterLimitErrorInterceptor,
        JwtStrategy,
        TopicService,
        // AttachmentService 的 doc 绑定写校验链依赖（findById 真实例）；
        // RouteHealthService/DiagramRendererService 是 DocService 的非触达注入点，空桩
        DocService,
        DocSpaceService,
        { provide: RouteHealthService, useValue: {} },
        { provide: DiagramRendererService, useValue: {} },
        PermissionService,
        TopicPolicy,
        BoardPolicy,
        DocSpacePolicy,
        TaskPolicy,
        AgentPolicy,
        ApiKeyAuthService,
        JwtOrApiKeyGuard,
        { provide: OwnerProxyService, useValue: ownerProxy },
        { provide: ActorProfileService, useValue: actorProfile },
        { provide: AuditService, useValue: auditService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configMock },
        { provide: EventService, useValue: { create: async () => ({}) } },
        // sendMessage/findAll 不触达 mine 过滤，桩即可
        { provide: AccessQueryService, useValue: { getAccessibleTopicIds: async () => null } },
        { provide: ResourceValidator, useValue: new ResourceValidator() },
        { provide: DataSource, useValue: ds },
        // 生产同款响应信封 + 异常形状（main.ts / app.module.ts 对齐）
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // 真实 repo（真 ORM SQL）
        { provide: getRepositoryToken(Attachment), useValue: ds.getRepository(Attachment) },
        { provide: getRepositoryToken(Topic), useValue: ds.getRepository(Topic) },
        {
          provide: getRepositoryToken(TopicParticipant),
          useValue: ds.getRepository(TopicParticipant),
        },
        { provide: getRepositoryToken(Message), useValue: ds.getRepository(Message) },
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        { provide: getRepositoryToken(Agent), useValue: ds.getRepository(Agent) },
        { provide: getRepositoryToken(Actor), useValue: ds.getRepository(Actor) },
        { provide: getRepositoryToken(Board), useValue: ds.getRepository(Board) },
        { provide: getRepositoryToken(BoardList), useValue: ds.getRepository(BoardList) },
        { provide: getRepositoryToken(BoardMember), useValue: ds.getRepository(BoardMember) },
        { provide: getRepositoryToken(Task), useValue: ds.getRepository(Task) },
        { provide: getRepositoryToken(Doc), useValue: ds.getRepository(Doc) },
        { provide: getRepositoryToken(DocSpace), useValue: ds.getRepository(DocSpace) },
        { provide: getRepositoryToken(DocSpaceMember), useValue: ds.getRepository(DocSpaceMember) },
        { provide: getRepositoryToken(DocSection), useValue: ds.getRepository(DocSection) },
        { provide: getRepositoryToken(DocCategory), useValue: ds.getRepository(DocCategory) },
        { provide: getRepositoryToken(DocVersion), useValue: ds.getRepository(DocVersion) },
        { provide: getRepositoryToken(TaskDocLink), useValue: ds.getRepository(TaskDocLink) },
        { provide: getRepositoryToken(DocRoute), useValue: ds.getRepository(DocRoute) },
        { provide: getRepositoryToken(ApiKey), useValue: ds.getRepository(ApiKey) },
        { provide: getRepositoryToken(AuditLog), useValue: ds.getRepository(AuditLog) },
        {
          provide: getRepositoryToken(IdempotencyRecord),
          useValue: ds.getRepository(IdempotencyRecord),
        },
      ],
    }).compile();

    // bodyParser 配置复刻 main.ts:15-17（multipart 在该配置下工作的证明归
    // attachment-upload-multipart.spec.ts，此处保持同构环境）
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(json({ limit: '10mb' }));
    app.use(urlencoded({ extended: true, limit: '10mb' }));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  }, 60000);

  afterAll(async () => {
    if (dbAvailable) {
      // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
      for (const id of created.attachmentIds) await ds.getRepository(Attachment).delete({ id });
      for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
      for (const key of created.participantKeys) {
        await ds.getRepository(TopicParticipant).delete(key);
      }
      for (const id of created.topicIds) await ds.getRepository(Topic).delete({ id });
      for (const id of created.sectionIds) await ds.getRepository(DocSection).delete({ id });
      for (const id of created.docIds) await ds.getRepository(Doc).delete({ id });
      for (const key of created.memberKeys) await ds.getRepository(DocSpaceMember).delete(key);
      for (const id of created.spaceIds) await ds.getRepository(DocSpace).delete({ id });
      for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
      for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
      for (const id of created.userIds) await ds.getRepository(User).delete({ id });
      for (const id of created.agentActorIds) await ds.getRepository(Actor).delete({ id });
      for (const id of created.userActorIds) await ds.getRepository(Actor).delete({ id });
      // sendMessage/DELETE 写入的审计行（真实 AuditService）
      await ds.query(`DELETE FROM audit_logs WHERE entity_type = 'attachment'`);
      if (created.messageIds.length > 0) {
        await ds.query(
          `DELETE FROM audit_logs WHERE entity_type = 'message' AND entity_id = ANY($1)`,
          [created.messageIds],
        );
      }
      // topic 删除族的审计行（v1.90.0-dev 连带清理用例：controller 的 DELETE +
      // service 的 cascade_delete_attachments）——按本运行创建的 topic id 精确清理
      if (created.topicIds.length > 0) {
        await ds.query(
          `DELETE FROM audit_logs WHERE entity_type = 'topic' AND entity_id = ANY($1)`,
          [created.topicIds],
        );
      }
      await ds.destroy();
    }
    if (minioAvailable) {
      // 本运行上传对象逐个清空（bucket 共享环境，绝不清桶）
      for (const key of created.objectKeys) {
        await minioClient.removeObject(MINIO_CONFIG.bucket, key).catch(() => undefined);
      }
    }
    if (app) await app.close();
  }, 30000);

  // ─── 造数工具 ────────────────────────────────────────────────

  /** 建 human（actor + user 行），返回含 JWT 的身份包 */
  async function createHuman(
    role: UserRole,
    label: string,
  ): Promise<{ id: string; token: string; email: string }> {
    const s = runSuffix();
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `ATT ${label} ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.userActorIds.push(actor.id);
    const email = `att-${label}-${s}@example.com`;
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: `att${label}${s}`.slice(0, 50),
        email,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    created.userIds.push(actor.id);
    const token = jwtService.sign({ sub: actor.id, email, role });
    return { id: actor.id, token, email };
  }

  /**
   * 取既有 admin 身份签 JWT（只读使用）。
   * users.role='admin' 有 partial unique idx_unique_admin（全库单 admin）——测试
   * 不可再造 admin 行；此处复用开发库既有 admin 仅做读取授权判定（GET），
   * 不在其名下写任何数据，RUN 隔离纪律不破坏。
   */
  async function adminToken(): Promise<string> {
    const row = await ds.getRepository(User).findOne({ where: { role: UserRole.ADMIN } });
    if (!row) throw new Error('dev db has no admin user for e2e admin-token');
    return jwtService.sign({ sub: row.id, email: row.email, role: UserRole.ADMIN });
  }

  /** 建 agent（actor + agents + api_key 行，keyHash=sha256(rawKey) 真实认证路径） */
  async function createAgentWithKey(ownerId: string): Promise<{ id: string; rawKey: string }> {
    const s = runSuffix();
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `ATT Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.agentActorIds.push(actor.id);
    await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId,
        name: `ATT Agent ${s}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(actor.id);
    const rawKey = `ask_${crypto.randomBytes(24).toString('base64url')}`;
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: actor.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: ownerId,
      }),
    );
    created.keyIds.push(key.id);
    return { id: actor.id, rawKey };
  }

  /** 建 topic（visibility 可指定；creator 自动补 moderator participant 行——PRIVATE 上传/发言的前提） */
  async function createTopic(
    creatorId: string,
    visibility: 'open' | 'private' = 'open',
  ): Promise<Topic> {
    const s = runSuffix();
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `ATT Topic ${s}`,
        creatorId,
        status: TopicStatus.ACTIVE,
        settings: { visibility },
      }),
    );
    created.topicIds.push(topic.id);
    const row = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: creatorId,
        role: 'moderator',
        status: 'active',
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );
    created.participantKeys.push({ topicId: topic.id, participantId: row.participantId });
    return topic;
  }

  /** 建普通 participant 行（ACTIVE） */
  async function addParticipant(topicId: string, participantId: string): Promise<void> {
    await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId,
        participantId,
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );
    created.participantKeys.push({ topicId, participantId });
  }

  /** 建 space（visibility 可指定）+ doc（+1 section），返回三者 id */
  async function createSpaceWithDoc(
    creatorId: string,
    visibility: 'open' | 'private',
    sectionContent: string,
  ): Promise<{ spaceId: string; docId: string; sectionId: string; path: string }> {
    const s = runSuffix();
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `ATT Space ${s}`,
        slug: `att-space-${s}`,
        creatorId,
        settings: { visibility },
      }),
    );
    created.spaceIds.push(space.id);
    const path = `att-e2e/doc-${s}.md`;
    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: space.id,
        path,
        title: `ATT Doc ${s}`,
        createdBy: creatorId,
      }),
    );
    created.docIds.push(doc.id);
    const section = await ds.getRepository(DocSection).save(
      ds.getRepository(DocSection).create({
        docId: doc.id,
        position: 0,
        content: sectionContent,
      }),
    );
    created.sectionIds.push(section.id);
    return { spaceId: space.id, docId: doc.id, sectionId: section.id, path };
  }

  /** 建 space member 行 */
  async function addSpaceMember(spaceId: string, actorId: string): Promise<void> {
    await ds
      .getRepository(DocSpaceMember)
      .save(
        ds
          .getRepository(DocSpaceMember)
          .create({ spaceId, actorId, role: DocSpaceMemberRole.MEMBER }),
      );
    created.memberKeys.push({ spaceId, actorId });
  }

  /** HTTP 上传（Bearer），返回响应 body.data；断言 201 由调用方做 */
  function uploadPng(token: string, query: string, filename = 'e2e.png'): request.Test {
    return request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments?${query}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', makePngBuffer(2, 2), { filename, contentType: 'image/png' });
  }

  /** 从 DB 回读附件行（含 objectKey——响应契约不含，断言用） */
  async function readAttachmentRow(id: string): Promise<Attachment | null> {
    return ds.getRepository(Attachment).findOne({ where: { id } });
  }

  /** 读 MinIO 对象字节（缩略图内容断言；对象不存在时 reject，由调用方转成布尔） */
  async function readObjectBytes(key: string): Promise<Buffer> {
    const stream = await minioClient.getObject(MINIO_CONFIG.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** 对象是否存在（statObject 语义——软删/GC 后应为 false） */
  async function objectExists(key: string): Promise<boolean> {
    return minioClient
      .statObject(MINIO_CONFIG.bucket, key)
      .then(() => true)
      .catch(() => false);
  }

  /** 真实 PNG（sharp 可解码）上传——缩略图成功生成路径专用 */
  function uploadRealPng(
    token: string,
    buffer: Buffer,
    query: string,
    filename = 'e2e-real.png',
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments?${query}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename, contentType: 'image/png' });
  }

  /** 收原始字节响应体（StreamableFile 端点的 supertest 解析器） */
  function collectBytes(
    res: request.Response,
    cb: (err: Error | null, body: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }

  /** 铸造签名 URL（Bearer），返回原始响应（状态码由调用方断言） */
  function mintSignedUrl(
    token: string,
    attachmentId: string,
    body: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments/${attachmentId}/signed-url`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  /** 读公开端点（JSON 响应解析——错误体断言用；成功时是二进制，需 collectBytes 版） */
  function getPublicContent(attachmentId: string, token: string): request.Test {
    return request(app.getHttpServer()).get(
      `${API_PREFIX}/public/attachments/${attachmentId}/content?token=${token}`,
    );
  }

  /** 读公开端点（原始字节解析——200 响应体逐位比对用） */
  function getPublicContentBytes(attachmentId: string, token: string): request.Test {
    return getPublicContent(attachmentId, token).buffer(true).parse(collectBytes);
  }

  /** HTTP 上传（Bearer，任意字节/文件名/声明 Content-Type），201 由调用方断言 */
  function uploadBytes(
    token: string,
    buffer: Buffer,
    query: string,
    filename: string,
    contentType: string,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments?${query}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename, contentType });
  }

  /** 读全鉴权 content（原始字节解析） */
  function getContentBytes(token: string, attachmentId: string): request.Test {
    return request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${attachmentId}/content`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(collectBytes);
  }

  /** 读全鉴权 content（JSON 解析——错误体断言用） */
  function getContentRaw(token: string, attachmentId: string): request.Test {
    return request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${attachmentId}/content`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** 读缩略图（JSON 解析——错误体断言用） */
  function getThumbnailRaw(token: string, attachmentId: string): request.Test {
    return request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${attachmentId}/thumbnail`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** 按 id 从 GET messages 投影里取一条消息（投影断言用） */
  async function getMessageById(
    topicId: string,
    token: string,
    messageId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/topics/${topicId}/messages?limit=50`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (res.body.data.messages as Array<Record<string, unknown>>).find(
      (m) => m.id === messageId,
    );
  }

  /** 直接改 DB 构造过期态（N3：不依赖时钟流逝，也不依赖 sweep 被关——见下方 describe 注释） */
  async function forceExpire(id: string, secondsAgo = 60): Promise<void> {
    await ds.query(
      `UPDATE attachments SET expires_at = now() - ($2 || ' seconds')::interval WHERE id = $1`,
      [id, String(secondsAgo)],
    );
  }

  // ─── ① 全链路 ────────────────────────────────────────────────

  it('全链：上传→元数据→内容（字节一致+五头）→删除→再读 404', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'chain');
    const topic = await createTopic(uploader.id, 'open');

    // 上传
    const up = await uploadPng(uploader.token, `topicId=${topic.id}`, '链路 图.png').expect(201);
    const data = up.body.data;
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.contentUrl).toBe(`${API_PREFIX}/attachments/${data.id}/content`);
    // 中文名 mojibake 端到端还原（busboy latin1 → sanitize 修复）
    expect(data.originalName).toBe('链路 图.png');
    expect(data.mimeType).toBe('image/png');
    expect(typeof data.sizeBytes).toBe('number');
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.topicId).toBe(topic.id);
    expect(data.docId).toBeNull();
    created.attachmentIds.push(data.id);
    const row = await readAttachmentRow(data.id);
    expect(row).not.toBeNull();
    created.objectKeys.push(row!.objectKey);

    // 元数据（无 bucket/objectKey 内部字段）
    const meta = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    expect(meta.body.data.bucket).toBeUndefined();
    expect(meta.body.data.objectKey).toBeUndefined();
    expect(meta.body.data.id).toBe(data.id);

    // 内容：字节一致 + 五头（Content-Type/nosniff/Disposition/Cache-Control/ETag）
    const content = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}/content`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(content.body as Buffer, makePngBuffer(2, 2))).toBe(0);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-disposition']).toContain("inline; filename*=UTF-8''");
    expect(content.headers['cache-control']).toBe('private, max-age=300');
    expect(content.headers['content-security-policy']).toBe('sandbox');
    expect(content.headers['etag']).toBe(`"${data.sha256}"`);

    // 删除 → 再读 404·12000；MinIO 对象已清（listObjects 验证）
    await request(app.getHttpServer())
      .delete(`${API_PREFIX}/attachments/${data.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    const gone = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(404);
    expect(gone.body.code ?? gone.body.error?.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
    const stat = await minioClient
      .statObject(MINIO_CONFIG.bucket, row!.objectKey)
      .then(() => true)
      .catch(() => false);
    expect(stat).toBe(false);
  });

  // ─── ② 读取授权矩阵 ──────────────────────────────────────────

  it('授权矩阵：participant 放行 / 局外人 404 / admin 放行（topic 绑定）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'matrix-up');
    const participant = await createHuman(UserRole.EDITOR, 'matrix-part');
    const outsider = await createHuman(UserRole.EDITOR, 'matrix-out');
    const adminTok = await adminToken();
    // PRIVATE topic：OPEN 下局外人可读测不出 404
    const topic = await createTopic(uploader.id, 'private');
    await addParticipant(topic.id, participant.id);

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    created.objectKeys.push((await readAttachmentRow(id))!.objectKey);

    for (const [label, token, expected] of [
      ['uploader', uploader.token, 200],
      ['participant', participant.token, 200],
      ['outsider', outsider.token, 404],
      ['admin', adminTok, 200],
    ] as const) {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/attachments/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect([label, res.status]).toEqual([label, expected]);
      if (expected === 404) {
        expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
      }
    }
  });

  it('授权矩阵：space member 放行 / 局外人 404（doc 绑定）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'docmat-up');
    const member = await createHuman(UserRole.EDITOR, 'docmat-member');
    const outsider = await createHuman(UserRole.EDITOR, 'docmat-out');
    const adminTok = await adminToken();
    const { spaceId, docId } = await createSpaceWithDoc(uploader.id, 'private', '# x');
    await addSpaceMember(spaceId, member.id);

    const up = await uploadPng(uploader.token, `docId=${docId}`).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    created.objectKeys.push((await readAttachmentRow(id))!.objectKey);
    expect(up.body.data.docId).toBe(docId);
    expect(up.body.data.topicId).toBeNull();

    for (const [label, token, expected] of [
      ['uploader(creator)', uploader.token, 200],
      ['space member', member.token, 200],
      ['outsider', outsider.token, 404],
      ['admin', adminTok, 200],
    ] as const) {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/attachments/${id}/content`)
        .set('Authorization', `Bearer ${token}`);
      expect([label, res.status]).toEqual([label, expected]);
    }
  });

  // ─── ③ sendMessage 绑定 ──────────────────────────────────────

  it('sendMessage：带 attachmentIds 发送成功，metadata.attachments 落库（SQL 直查），响应不透传', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bind');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`, '绑定.png').expect(201);
    const attId = up.body.data.id as string;
    created.attachmentIds.push(attId);
    created.objectKeys.push((await readAttachmentRow(attId))!.objectKey);

    const sent = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '看图说话', attachmentIds: [attId] })
      .expect(201);
    expect(sent.body.data.id).toBeDefined();
    const boundExpiresAt = (await readAttachmentRow(attId))!.expiresAt!.toISOString();
    // 响应恒存在结构化 attachments 投影（P1 契约 + v1.90.0-dev TTL 位）
    expect(sent.body.data.attachments).toEqual([
      {
        id: attId,
        originalName: '绑定.png',
        mimeType: 'image/png',
        clientMimeType: 'image/png',
        sizeBytes: 33,
        expiresAt: boundExpiresAt,
        expired: false,
        contentUrl: `${API_PREFIX}/attachments/${attId}/content`,
      },
    ]);
    // 响应不含原始 metadata 键（投影只漏结构化字段，隐私/体积）
    expect(sent.body.data.metadata).toBeUndefined();
    created.messageIds.push(sent.body.data.id);

    // SQL 直查 metadata.attachments 索引形状（sizeBytes number + required hasThumbnail）
    const rows: Array<{ attachments: Array<Record<string, unknown>> | null }> = await ds.query(
      `SELECT metadata->'attachments' AS attachments FROM messages WHERE id = $1`,
      [sent.body.data.id],
    );
    expect(rows[0].attachments).toEqual([
      {
        id: attId,
        originalName: '绑定.png',
        mimeType: 'image/png',
        clientMimeType: 'image/png', // 展示信息入索引快照（静态事实）
        sizeBytes: 33,
        expiresAt: boundExpiresAt, // 静态事实入快照；expired 不入（响应时纯函数）
        hasThumbnail: false, // 伪图 → fail-open 无缩略图（P2 批 1 索引 required 布尔）
      },
    ]);
  });

  it('GET messages / unread（P1 真 PG 链路）：带附件消息投影恒存在（全字段+contentUrl+TTL 位），无附件消息 attachments: []', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'projup');
    // reader 无锚点（addParticipant 建行 lastReadMessageId=null）→ GET unread 全量未读
    const reader = await createHuman(UserRole.EDITOR, 'projread');
    const topic = await createTopic(uploader.id, 'open');
    await addParticipant(topic.id, reader.id);

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`, '投影.png').expect(201);
    const attId = up.body.data.id as string;
    created.attachmentIds.push(attId);
    created.objectKeys.push((await readAttachmentRow(attId))!.objectKey);
    const expiresAt = (await readAttachmentRow(attId))!.expiresAt!.toISOString();
    const projection = [
      {
        id: attId,
        originalName: '投影.png',
        mimeType: 'image/png',
        clientMimeType: 'image/png',
        sizeBytes: 33,
        expiresAt, // 静态事实（上传时冻结，四表面同一口径）
        expired: false, // 响应时纯函数
        contentUrl: `${API_PREFIX}/attachments/${attId}/content`,
      },
    ];

    // 带附件消息（POST 响应同形状，与上方用例冗余但独立闭环于本链路）
    const m1 = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '看图', attachmentIds: [attId] })
      .expect(201);
    const m1Id = m1.body.data.id as string;
    created.messageIds.push(m1Id);
    expect(m1.body.data.attachments).toEqual(projection);

    // 无附件消息 → 恒存在 []
    const m2 = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '无附件' })
      .expect(201);
    const m2Id = m2.body.data.id as string;
    created.messageIds.push(m2Id);
    expect(m2.body.data.attachments).toEqual([]);

    // GET messages（mapToMessageDtos 投影路径）：值/形状同源，且不含原始 metadata 键
    const list = await request(app.getHttpServer())
      .get(`${API_PREFIX}/topics/${topic.id}/messages?limit=50`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    const listBy = new Map(
      (list.body.data.messages as Array<Record<string, unknown>>).map((m) => [m.id as string, m]),
    );
    expect(listBy.get(m1Id)!.attachments).toEqual(projection);
    expect(listBy.get(m2Id)!.attachments).toEqual([]);
    expect(listBy.get(m1Id)).not.toHaveProperty('metadata');

    // unread 路径（reader 无锚点 → 全量未读）：同一 mapper 同形状
    const unread = await request(app.getHttpServer())
      .get(`${API_PREFIX}/topics/${topic.id}/messages/unread?limit=50`)
      .set('Authorization', `Bearer ${reader.token}`)
      .expect(200);
    const unreadBy = new Map(
      (unread.body.data.messages as Array<Record<string, unknown>>).map((m) => [m.id as string, m]),
    );
    expect(unreadBy.get(m1Id)!.attachments).toEqual(projection);
    expect(unreadBy.get(m2Id)!.attachments).toEqual([]);

    // REST 降级路径（reader 无游标 → 降级分支）行为锁（v1.85）：unreadCount 走真 COUNT
    // 而非旧 topics.message_count 口径；2 条消息均出自 uploader（≠ 请求者 reader）→ 全计未读；
    // messages 从话题开头全量给出（2 ≤ limit 50）→ hasMore=false
    expect(unread.body.data.unreadCount).toBe(2);
    expect(unread.body.data.messages).toHaveLength(2);
    expect(unread.body.data.hasMore).toBe(false);
  });

  it('sendMessage：他人附件 → 403·12004', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bindup');
    const outsider = await createHuman(UserRole.EDITOR, 'bindout');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    const attId = up.body.data.id as string;
    created.attachmentIds.push(attId);
    created.objectKeys.push((await readAttachmentRow(attId))!.objectKey);

    // outsider 对 OPEN topic 本身可发言——拦截必须来自附件归属校验
    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ content: '盗图', attachmentIds: [attId] })
      .expect(403);
    expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_FORBIDDEN);
  });

  it('sendMessage：附件绑定他 topic → 403·12004', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bindx');
    const topic1 = await createTopic(uploader.id, 'open');
    const topic2 = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic1.id}`).expect(201);
    const attId = up.body.data.id as string;
    created.attachmentIds.push(attId);
    created.objectKeys.push((await readAttachmentRow(attId))!.objectKey);

    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic2.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '跨话题引用', attachmentIds: [attId] })
      .expect(403);
    expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_FORBIDDEN);
  });

  it('sendMessage：attachmentIds 超 9 个 → 400（DTO 层，ValidationPipe 真实管线）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bind9');
    const topic = await createTopic(uploader.id, 'open');
    const ids = Array.from({ length: 10 }, () => crypto.randomUUID());

    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '太多', attachmentIds: ids })
      .expect(400);
    // DTO 校验消息聚合（AllExceptionsFilter 对数组 message 聚合到顶层）
    expect(JSON.stringify(res.body)).toContain('attachmentIds');
  });

  it('sendMessage：附件不存在 → 404·12000', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bind404');
    const topic = await createTopic(uploader.id, 'open');

    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '幽灵附件', attachmentIds: [crypto.randomUUID()] })
      .expect(404);
    expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
  });

  // ─── ④ 配额 403·12003（QUOTA-SEED 数据驱动）─────────────────

  it('配额：SUM 存量 + 本次越界 → 403·12003（含 X-API-Key 真实认证路径）', async () => {
    if (!available()) return;
    const owner = await createHuman(UserRole.EDITOR, 'quota-owner');
    const agent = await createAgentWithKey(owner.id);
    const topic = await createTopic(owner.id, 'open');

    // 假行：size_bytes = 配额-10（无对应 MinIO 对象——清理只删行不删对象）
    const seedKey = `quota-seed-${runSuffix()}.png`;
    const seed = await ds.getRepository(Attachment).save(
      ds.getRepository(Attachment).create({
        uploaderId: agent.id,
        bucket: MINIO_CONFIG.bucket,
        objectKey: seedKey,
        originalName: 'seed.png',
        mimeType: 'image/png',
        sizeBytes: String(DEFAULT_QUOTA_BYTES - 10),
        sha256: '0'.repeat(64),
        status: 'ready',
        topicId: topic.id,
      }),
    );
    created.attachmentIds.push(seed.id);

    // 33B 真实上传：SUM(配额-10) + 33 > 配额 → 403·12003
    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments?topicId=${topic.id}`)
      .set('X-API-Key', agent.rawKey)
      .attach('file', makePngBuffer(2, 2), { filename: 'q.png', contentType: 'image/png' })
      .expect(403);
    expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_QUOTA_EXCEEDED);
  });

  // ─── ⑤ bucket 匿名拒读 ───────────────────────────────────────

  it('bucket 匿名拒读：无凭证直连 MinIO getObject 被拒（private 断言）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'anon');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    const key = (await readAttachmentRow(id))!.objectKey;
    created.objectKeys.push(key);

    // 无签名裸 GET（anonymous）——MinIO 对 private bucket 返 403 AccessDenied
    const resp = await fetch(
      `http${MINIO_CONFIG.useSSL ? 's' : ''}://${MINIO_CONFIG.endPoint}:${MINIO_CONFIG.port}/${MINIO_CONFIG.bucket}/${key}`,
    );
    expect(resp.status).toBe(403);
  });

  // ─── ⑥ FK SET NULL 无绑定态 ─────────────────────────────────

  it('FK SET NULL：硬删 topic 后附件落无绑定态——局外人 404、上传者 200', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'fk-up');
    const outsider = await createHuman(UserRole.EDITOR, 'fk-out');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    created.objectKeys.push((await readAttachmentRow(id))!.objectKey);

    // SQL 硬删 topic（FK ON DELETE SET NULL 触发；本 topic 无消息等 CASCADE 面）
    await ds.query(`DELETE FROM topics WHERE id = $1`, [topic.id]);
    const after = await readAttachmentRow(id);
    expect(after!.topicId).toBeNull();

    // 无绑定态：局外人 404·12000，上传者 200
    const out = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${id}`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);
    expect(out.body.code ?? out.body.error?.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
  });

  // ─── ⑦ linkHealth：附件 URL 不进 broken ─────────────────────

  it('linkHealth：含附件 URL 的 doc 重算后 broken 不含附件条目（plan §4.2）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'lh');
    const topic = await createTopic(uploader.id, 'open');

    // 真实附件（其 contentUrl 将写进 doc 内容）
    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    const attId = up.body.data.id as string;
    created.attachmentIds.push(attId);
    created.objectKeys.push((await readAttachmentRow(attId))!.objectKey);
    const contentUrl = up.body.data.contentUrl as string;

    // doc：同目录真断链（broken=1 的对照组）+ 附件 URL + 正常存在链接
    const { spaceId, docId, path } = await createSpaceWithDoc(
      uploader.id,
      'open',
      `[img](${contentUrl}) and [ghost](./ghost.md) and [self](./${'x'})`,
    );
    // 再补一个真实存在的同空间 doc 作为正常链接目标
    const target = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId,
        path: `att-e2e/target-${runSuffix()}.md`,
        title: 'ATT Target',
        createdBy: uploader.id,
      }),
    );
    created.docIds.push(target.id);
    await ds
      .getRepository(DocSection)
      .save(ds.getRepository(DocSection).create({ docId: target.id, position: 0, content: 't' }));
    // 修正源 doc section：链接到真实 target + ghost + 附件
    await ds.query(`UPDATE doc_sections SET content = $1 WHERE doc_id = $2 AND position = 0`, [
      `[img](${contentUrl}) and [ghost](./ghost.md) and [ok](./${target.path.split('/').pop()})`,
      docId,
    ]);

    // 直构 DocService（recalcSpaceLinkHealth 只触达 docRepo/sectionRepo，余桩）
    const docService = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      { create: async () => ({}) } as unknown as EventService,
      {} as never, // routeHealthService（未触达）
      ds.getRepository(IdempotencyRecord),
      {} as never, // diagramRenderer（markdown 路径未触达）
    );
    const result = await docService.recalcSpaceLinkHealth(spaceId);

    // broken 恰为 1（ghost.md）；附件 URL 不判 broken（§4.2 防御显式跳过）
    expect(result.checked).toBe(2);
    expect(result.broken).toBe(1);
    const rows: Array<{ linkHealth: { broken: Array<{ href?: string; target?: string }> } }> =
      await ds.query(`SELECT link_health AS "linkHealth" FROM docs WHERE id = $1`, [docId]);
    const brokenHrefs = JSON.stringify(rows[0].linkHealth.broken);
    expect(brokenHrefs).toContain('ghost.md');
    expect(brokenHrefs).not.toContain('/attachments/');
    expect(path).toContain('att-e2e/');
  });

  // ─── ⑧ 缩略图变体（P2 批 1）──────────────────────────────────

  it('缩略图全链：真实 PNG 上传 → thumb 对象/行列/投影第 6 键 → GET /thumbnail 200 五头 → 授权 404 一致性', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'thumb-up');
    const outsider = await createHuman(UserRole.EDITOR, 'thumb-out');
    // PRIVATE topic：局外人对读取路径应得 404·12000（而不是 12008）
    const topic = await createTopic(uploader.id, 'private');
    const png = await makeRealPngBuffer(1024, 768);

    const up = await uploadRealPng(
      uploader.token,
      png,
      `topicId=${topic.id}`,
      '链路 图.png',
    ).expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);
    expect(data.thumbnailContentUrl).toBe(`${API_PREFIX}/attachments/${data.id}/thumbnail`);

    // 行 5 列（同生共死）+ 对象字节自洽（webp、最长边 512、sha256/size 对齐）
    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);
    expect(row.thumbKey).toMatch(/^[0-9a-f-]{36}\.thumb\.webp$/);
    expect(row.thumbKey).not.toBe(row.objectKey);
    expect(row.thumbWidth).toBe(512);
    expect(row.thumbHeight).toBe(384);
    const thumbBytes = await readObjectBytes(row.thumbKey!);
    expect(thumbBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(thumbBytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(Number(row.thumbSizeBytes)).toBe(thumbBytes.length);
    expect(row.thumbSha256).toBe(crypto.createHash('sha256').update(thumbBytes).digest('hex'));
    const meta = await sharp(thumbBytes).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(512);

    // GET /thumbnail：200 + 五头（Content-Type/nosniff/Disposition/缓存/ETag）+ 字节与对象一致
    const thumbRes = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}/thumbnail`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(thumbRes.body as Buffer, thumbBytes)).toBe(0);
    expect(thumbRes.headers['content-type']).toBe('image/webp');
    expect(thumbRes.headers['x-content-type-options']).toBe('nosniff');
    expect(thumbRes.headers['content-disposition']).toContain("inline; filename*=UTF-8''");
    expect(thumbRes.headers['content-disposition']).toContain('_thumb.webp');
    expect(thumbRes.headers['cache-control']).toBe('private, max-age=300');
    expect(thumbRes.headers['content-security-policy']).toBe('sandbox');
    expect(thumbRes.headers['etag']).toBe(`"${row.thumbSha256}"`);

    // 授权 404 一致性：局外人对缩略图端点同样是 404·12000（不是 12008——不泄露存在性）
    const denied = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}/thumbnail`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);
    expect(denied.body.code ?? denied.body.error?.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);

    // 投影（第 4 表面）：消息响应带条件第 6 键；SQL 直查索引含 required hasThumbnail
    const sent = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: '看图', attachmentIds: [data.id] })
      .expect(201);
    created.messageIds.push(sent.body.data.id);
    expect(sent.body.data.attachments).toEqual([
      {
        id: data.id,
        originalName: '链路 图.png',
        mimeType: 'image/png',
        clientMimeType: 'image/png',
        sizeBytes: data.sizeBytes,
        expiresAt: row.expiresAt!.toISOString(),
        expired: false,
        contentUrl: `${API_PREFIX}/attachments/${data.id}/content`,
        thumbnailContentUrl: `${API_PREFIX}/attachments/${data.id}/thumbnail`,
      },
    ]);
    const idxRows: Array<{ attachments: Array<Record<string, unknown>> }> = await ds.query(
      `SELECT metadata->'attachments' AS attachments FROM messages WHERE id = $1`,
      [sent.body.data.id],
    );
    expect(idxRows[0].attachments).toEqual([
      {
        id: data.id,
        originalName: '链路 图.png',
        mimeType: 'image/png',
        clientMimeType: 'image/png',
        sizeBytes: data.sizeBytes,
        expiresAt: row.expiresAt!.toISOString(),
        hasThumbnail: true,
      },
    ]);

    // 删除：行软删 → 两个读取端点都 404·12000；原图 + 缩略图对象双双清空
    await request(app.getHttpServer())
      .delete(`${API_PREFIX}/attachments/${data.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    for (const endpoint of ['content', 'thumbnail']) {
      const gone = await request(app.getHttpServer())
        .get(`${API_PREFIX}/attachments/${data.id}/${endpoint}`)
        .set('Authorization', `Bearer ${uploader.token}`)
        .expect(404);
      expect([endpoint, gone.body.code ?? gone.body.error?.code]).toEqual([
        endpoint,
        ErrorCode.ATTACHMENT_NOT_FOUND,
      ]);
    }
    expect(await objectExists(row.objectKey)).toBe(false);
    expect(await objectExists(row.thumbKey!)).toBe(false);
  });

  it('缩略图 fail-open：伪图（解不了码）→ 上传 201 无第 6 键 + 行 5 列 null + GET /thumbnail 404·12008', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'thumb-fo');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadPng(uploader.token, `topicId=${topic.id}`, '伪图.png').expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);
    // 四表面同一口径：无缩略图 = 字面缺键（Object.hasOwn === false，绝不 null/''）
    expect(Object.hasOwn(data, 'thumbnailContentUrl')).toBe(false);

    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey);
    expect(row.thumbKey).toBeNull();
    expect(row.thumbWidth).toBeNull();
    expect(row.thumbHeight).toBeNull();
    expect(row.thumbSizeBytes).toBeNull();
    expect(row.thumbSha256).toBeNull();

    // 无缩略图 → 404·12008（与"不存在/无权"的 12000 刻意分码），消息指导改用 /content
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}/thumbnail`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(404);
    expect(res.body.code ?? res.body.error?.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);
    expect(res.body.message ?? res.body.error?.message).toBe(
      'No thumbnail available for this attachment; use /attachments/:id/content for the original',
    );
    // 原图仍可读（fail-open 不阻断主链路）
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}/content`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
  });

  it('缩略图端点为 gif 首帧：多帧 GIF 上传 → thumb 尺寸为单帧（非堆叠）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'thumb-gif');
    const topic = await createTopic(uploader.id, 'open');
    const animatedGif = makeAnimatedGifBuffer();

    const up = await request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments?topicId=${topic.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .attach('file', animatedGif, { filename: 'anim.gif', contentType: 'image/gif' })
      .expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);

    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);
    // 2x2 双帧 GIF：首帧缩略图 2x2（若解码全部帧会得 2x4 堆叠）
    expect([row.thumbWidth, row.thumbHeight]).toEqual([2, 2]);
  });

  // ─── ⑨ 短时签名 URL（P2 批 2）────────────────────────────────
  //
  // 双向回归（security B1）证据链：本套件刻意让 attachmentUrl.secret == jwt.secret
  // （见 configMock 注释），因此以下两条 401 只能由 payload 形状断言解释：
  // ① 铸造 token 作 Bearer 打 JwtOrApiKeyGuard 端点 → 401 UNAUTHORIZED；
  // ② 铸造 token 作 Bearer 打 JwtAuthGuard（passport 策略）端点 → 401 TOKEN_INVALID；
  // ③ 反向：用户会话 token 打公开端点 → 401·12006（scope 断言）。

  it('签名 URL 全链（original）：铸造 200 no-store → 无凭证读 200 字节一致五头 → audit 无 token', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'sign-full');
    const topic = await createTopic(uploader.id, 'open');
    const png = await makeRealPngBuffer(800, 600);

    const up = await uploadRealPng(
      uploader.token,
      png,
      `topicId=${topic.id}`,
      '签名 图.png',
    ).expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);
    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    // 铸造：200 + no-store（响应体含能力凭证，任何缓存留存都等于凭证扩散）
    const minted = await mintSignedUrl(uploader.token, data.id, {}).expect(200);
    expect(minted.headers['cache-control']).toBe('no-store');
    expect(minted.body.data.variant).toBe('original');
    expect(minted.body.data.signedUrl).toContain(
      `${API_PREFIX}/public/attachments/${data.id}/content?token=`,
    );
    // 默认 TTL 300s（expiresAt 与签发时刻同源）
    expect(
      Math.abs(new Date(minted.body.data.expiresAt).getTime() - (Date.now() + 300_000)),
    ).toBeLessThan(10_000);
    const token = (minted.body.data.signedUrl as string).split('token=')[1];

    // 无凭证（无 Authorization / 无 X-API-Key）GET → 200 + 字节与对象存储逐位一致 + 五头
    const res = await getPublicContentBytes(data.id, token).expect(200);
    expect(Buffer.compare(res.body as Buffer, await readObjectBytes(row.objectKey))).toBe(0);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // 三出口同一套安全头（§1.2 M2）：公开面 200 也必须带 CSP sandbox
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['content-disposition']).toContain("inline; filename*=UTF-8''");
    // 能力 URL 禁共享缓存：恒 private 且无 max-age（对照 /content 的 private, max-age=300）
    expect(res.headers['cache-control']).toBe('private');
    expect(res.headers['etag']).toBe(`"${row.sha256}"`);

    // audit：mint_attachment_url 行落库，newData 仅 {variant, ttlSeconds, expiresAt}
    const auditRows: Array<{ action: string; new_data: Record<string, unknown> }> = await ds.query(
      `SELECT action::text AS action, new_data FROM audit_logs
       WHERE entity_type = 'attachment' AND entity_id = $1`,
      [data.id],
    );
    const mintAudits = auditRows.filter((r) => r.action === 'mint_attachment_url');
    expect(mintAudits).toHaveLength(1);
    expect(mintAudits[0].new_data).toEqual({
      variant: 'original',
      ttlSeconds: 300,
      expiresAt: minted.body.data.expiresAt,
    });
    // 能力凭证绝不进审计面
    expect(JSON.stringify(mintAudits[0])).not.toContain(token);
  });

  it('签名 URL 全链（thumbnail）：铸造 variant=thumbnail → webp 字节一致；无缩略图附件铸造/消费均 404·12008 逐字', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'sign-thumb');
    const topic = await createTopic(uploader.id, 'open');
    const png = await makeRealPngBuffer(1024, 768);

    const up = await uploadRealPng(uploader.token, png, `topicId=${topic.id}`).expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);
    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    // 显式 ttlSeconds=120 + thumbnail 变体
    const minted = await mintSignedUrl(uploader.token, data.id, {
      variant: 'thumbnail',
      ttlSeconds: 120,
    }).expect(200);
    expect(minted.body.data.variant).toBe('thumbnail');
    const token = (minted.body.data.signedUrl as string).split('token=')[1];

    const res = await getPublicContentBytes(data.id, token).expect(200);
    expect(Buffer.compare(res.body as Buffer, await readObjectBytes(row.thumbKey!))).toBe(0);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-disposition']).toContain('_thumb.webp');
    expect(res.headers['etag']).toBe(`"${row.thumbSha256}"`);
    expect(res.headers['cache-control']).toBe('private');

    // 无缩略图附件（头部伪图 → 批 1 fail-open：thumb 5 列 null）
    const upFo = await uploadPng(uploader.token, `topicId=${topic.id}`, '伪图.png').expect(201);
    const foId = upFo.body.data.id as string;
    created.attachmentIds.push(foId);
    created.objectKeys.push((await readAttachmentRow(foId))!.objectKey);

    // 铸造侧 fail-fast：variant=thumbnail → 404·12008 逐字（说明原因 + 替代变体）
    const deniedMint = await mintSignedUrl(uploader.token, foId, { variant: 'thumbnail' }).expect(
      404,
    );
    expect(deniedMint.body.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);
    expect(deniedMint.body.message).toBe(
      'No thumbnail available for this attachment (uploaded before v1.75 or generation failed); ' +
        'mint with variant=original instead',
    );

    // original 变体照常可铸造、可读（fail-open 不影响原图能力）
    const okMint = await mintSignedUrl(uploader.token, foId, {}).expect(200);
    await getPublicContent(foId, (okMint.body.data.signedUrl as string).split('token=')[1]).expect(
      200,
    );

    // 消费侧 12008（铸造侧已拦，此处手工签一枚 thumb 变体 token 覆盖该分支）
    const handToken = jwtService.sign(
      { aid: foId, var: 'thumbnail', scope: 'attachment:content' },
      { secret: 'test-secret', issuer: 'attachment-url', algorithm: 'HS256', expiresIn: 300 },
    );
    const pubDenied = await getPublicContent(foId, handToken).expect(404);
    expect(pubDenied.body.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);
    expect(pubDenied.body.message).toBe(
      'No thumbnail available for this signed URL; mint with variant=original instead',
    );
  });

  it('签名 URL 负例矩阵 + 双向回归：无/篡改/数组/错误 aid/会话 token/过期 → 400/401 对应码；铸造 token 打两类守卫族端点 → 401', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'sign-neg');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadRealPng(
      uploader.token,
      await makeRealPngBuffer(64, 64),
      `topicId=${topic.id}`,
    ).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    const row = (await readAttachmentRow(id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    const up2 = await uploadPng(uploader.token, `topicId=${topic.id}`, 'other.png').expect(201);
    const otherId = up2.body.data.id as string;
    created.attachmentIds.push(otherId);
    created.objectKeys.push((await readAttachmentRow(otherId))!.objectKey);

    const minted = await mintSignedUrl(uploader.token, id, {}).expect(200);
    const token = (minted.body.data.signedUrl as string).split('token=')[1];

    // 无 token → 400（DTO 形状层；12006/12007 只表达"凭证本身不可用"——plan §②.6
    // 文案只列签名/scope/aid 三断言与过期，缺失/空串/数组属格式错误，铁律 #21 分工）
    const missing = await request(app.getHttpServer())
      .get(`${API_PREFIX}/public/attachments/${id}/content`)
      .expect(400);
    expect(missing.body.code).toBe(ErrorCode.BAD_REQUEST);
    // 数组形态（Express 多值 query）→ 400（拒数组，不把数组喂进验签器）
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/public/attachments/${id}/content?token=a&token=b`)
      .expect(400);

    // 篡改 token → 401·12006 逐字
    const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;
    const t1 = await getPublicContent(id, tampered).expect(401);
    expect(t1.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);
    expect(t1.body.message).toBe(
      'Signed URL token is invalid (bad signature, wrong scope, or attachment id mismatch). ' +
        'Mint a new URL via POST /attachments/:id/signed-url; this public URL needs no API key.',
    );

    // 错误 aid：拿 id 的 token 打另一附件 → 401·12006
    const t2 = await getPublicContent(otherId, token).expect(401);
    expect(t2.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);

    // 用户会话 token（scope 断言挡下）→ 401·12006
    const t3 = await getPublicContent(id, uploader.token).expect(401);
    expect(t3.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);

    // 其它密钥族 token（如刷新 token，签名不符）→ 401·12006
    const foreignToken = jwtService.sign(
      { sub: uploader.id, type: 'refresh' },
      { secret: 'another-credential-family-secret', expiresIn: '7d' },
    );
    const t4 = await getPublicContent(id, foreignToken).expect(401);
    expect(t4.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);

    // 过期（手签 expiresIn 为负）→ 401·12007 逐字（与 12006 分码）
    const expiredToken = jwtService.sign(
      { aid: id, var: 'original', scope: 'attachment:content' },
      { secret: 'test-secret', issuer: 'attachment-url', algorithm: 'HS256', expiresIn: -10 },
    );
    const t5 = await getPublicContent(id, expiredToken).expect(401);
    expect(t5.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_EXPIRED);
    expect(t5.body.message).toBe(
      'Signed URL has expired. Mint a new URL via POST /attachments/:id/signed-url.',
    );

    // 篡改 token + 不存在 id → 401 而非 404（无效凭证不得借 404 探测存在性）
    const t6 = await getPublicContent(crypto.randomUUID(), tampered).expect(401);
    expect(t6.body.code).toBe(ErrorCode.ATTACHMENT_SIGNATURE_INVALID);

    // 双向回归①：铸造 token 作 Bearer 打 JwtOrApiKeyGuard 端点 → 401（无 API Key 兜底）
    const g1 = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/mine`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(g1.body.code).toBe(ErrorCode.UNAUTHORIZED);

    // 双向回归②：铸造 token 作 Bearer 打 JwtAuthGuard（passport 'jwt'，全局守卫同族）端点
    // → 401·TOKEN_INVALID（随机 UUID：即便守卫被绕过也不会删到真数据）
    const g2 = await request(app.getHttpServer())
      .delete(`${API_PREFIX}/topics/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(g2.body.code).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('软删后公开端点 404·12000：能力 URL 无撤销列表，软删是唯一失效手段（同一 token 立即失效）', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'sign-del');
    const topic = await createTopic(uploader.id, 'open');

    const up = await uploadRealPng(
      uploader.token,
      await makeRealPngBuffer(48, 48),
      `topicId=${topic.id}`,
    ).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    const row = (await readAttachmentRow(id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    const minted = await mintSignedUrl(uploader.token, id, {}).expect(200);
    const token = (minted.body.data.signedUrl as string).split('token=')[1];
    await getPublicContent(id, token).expect(200);

    // 软删（token 未失效——签名/声明与行状态无关；失效来自行不可见）
    await request(app.getHttpServer())
      .delete(`${API_PREFIX}/attachments/${id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);

    const gone = await getPublicContent(id, token).expect(404);
    expect(gone.body.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);
    // 对象也随删除双删（原图 + 缩略图）
    expect(await objectExists(row.objectKey)).toBe(false);
    expect(await objectExists(row.thumbKey!)).toBe(false);
  });

  it('铸造端点负例：越界 TTL/非法 variant → 400；非 UUID → 400；未认证 → 401；无缩略图变体 → 404·12008', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'sign-mint-neg');
    const topic = await createTopic(uploader.id, 'open');
    const up = await uploadRealPng(
      uploader.token,
      await makeRealPngBuffer(32, 32),
      `topicId=${topic.id}`,
    ).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    const row = (await readAttachmentRow(id))!;
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    // DTO 边界（诚实拒，不静默钳制）
    await mintSignedUrl(uploader.token, id, { ttlSeconds: 59 }).expect(400);
    await mintSignedUrl(uploader.token, id, { ttlSeconds: 3601 }).expect(400);
    await mintSignedUrl(uploader.token, id, { variant: 'webp' }).expect(400);
    // 格式层：非 UUID 早于 service（ParseUUIDPipe）
    await mintSignedUrl(uploader.token, 'not-a-uuid', {}).expect(400);
    // 鉴权：无凭证 → 401
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/attachments/${id}/signed-url`)
      .send({})
      .expect(401);
    // 合法边界值两端均可铸造（60 / 3600）
    await mintSignedUrl(uploader.token, id, { ttlSeconds: 60 }).expect(200);
    await mintSignedUrl(uploader.token, id, { ttlSeconds: 3600 }).expect(200);
  });

  // ─── ⑪ v1.90.0-dev 附件 TTL 批（类型放开 + 过期语义 + 连带清理）──────────
  //
  // 过期态构造纪律（N3）：`sweepExpiredAttachments` 的小时级 cron 受 isTestEnv
  // 控制（测试环境 disabled，见 attachment.constants.ATTACHMENT_EXPIRED_SWEEP_ENABLED），
  // 且本套件的最小模块**不注册 AttachmentGcService**——"过期但行仍在"的中间态
  // 在整个测试期间稳定（410 不会翻成 404）。expires_at 一律直改 DB 构造。

  it('非图片全链（M1 回归）：声明 image/png 的 HTML 字节 → octet-stream + .bin + 强制下载 + nosniff/CSP', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'bin');
    const topic = await createTopic(uploader.id, 'open');
    const evil = Buffer.from('<!doctype html><html><script>alert(1)</script></html>', 'utf8');

    const up = await uploadBytes(
      uploader.token,
      evil,
      `topicId=${topic.id}`,
      'evil.png',
      'image/png',
    ).expect(201);
    const data = up.body.data;
    created.attachmentIds.push(data.id);
    // M1：声明值永不进 mime_type；只进 client_mime_type（纯展示）
    expect(data.mimeType).toBe('application/octet-stream');
    expect(data.clientMimeType).toBe('image/png');
    expect(data.thumbnailContentUrl).toBeUndefined(); // 非图片不生成缩略图
    expect(typeof data.expiresAt).toBe('string'); // topic 默认 7d → 上传时冻结

    const row = (await readAttachmentRow(data.id))!;
    created.objectKeys.push(row.objectKey);
    expect(row.objectKey).toMatch(/\.bin$/); // objectKey 恒 .bin（M3）
    expect(row.mimeType).toBe('application/octet-stream');
    expect(row.clientMimeType).toBe('image/png');
    expect(row.thumbKey).toBeNull();
    // TTL 冻结 ≈ now + 7d（缺省档 fail-closed；毫秒级容差）
    const ttlMs = row.expiresAt!.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    // 对象元数据 Content-Type 也必须 octet-stream（声明值不固化到对象元数据，M3）
    const stat = await minioClient.statObject(MINIO_CONFIG.bucket, row.objectKey);
    expect(stat.metaData['content-type']).toBe('application/octet-stream');

    // 字节出口：非图片恒 octet-stream + attachment + nosniff + CSP sandbox + 300s 缓存
    const content = await getContentBytes(uploader.token, data.id).expect(200);
    expect(Buffer.compare(content.body as Buffer, evil)).toBe(0);
    expect(content.headers['content-type']).toBe('application/octet-stream');
    expect(content.headers['content-disposition']).toContain("attachment; filename*=UTF-8''");
    expect(content.headers['content-disposition']).not.toContain('inline');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-security-policy']).toBe('sandbox');
    expect(content.headers['cache-control']).toBe('private, max-age=300');

    // 非图片无缩略图 → 404·12008（而非 12000：附件可达但无该变体）
    const thumb = await getThumbnailRaw(uploader.token, data.id).expect(404);
    expect(thumb.body.code).toBe(ErrorCode.ATTACHMENT_THUMBNAIL_UNAVAILABLE);

    // 元数据面（四表面之一）：200 + clientMimeType + expiresAt，不因非图片变化
    const meta = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${data.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    expect(meta.body.data.clientMimeType).toBe('image/png');
    expect(meta.body.data.expiresAt).toBe(row.expiresAt!.toISOString());
  });

  it('TTL 档位冻结：1d 生效 / never → NULL / 脏值 fail-closed 回退 7d / doc 绑定恒 NULL', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'ttl');

    /** 建带 attachmentTtl 的 topic */
    async function topicWithTtl(attachmentTtl: unknown): Promise<Topic> {
      const topic = await createTopic(uploader.id, 'open');
      await ds.query(`UPDATE topics SET settings = settings || $2::jsonb WHERE id = $1`, [
        topic.id,
        JSON.stringify({ attachmentTtl }),
      ]);
      return topic;
    }

    // 1d
    const t1 = await topicWithTtl('1d');
    const u1 = await uploadPng(uploader.token, `topicId=${t1.id}`).expect(201);
    created.attachmentIds.push(u1.body.data.id);
    const r1 = (await readAttachmentRow(u1.body.data.id))!;
    created.objectKeys.push(r1.objectKey);
    const d1 = r1.expiresAt!.getTime() - Date.now();
    expect(d1).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(d1).toBeLessThan(25 * 60 * 60 * 1000);

    // never → NULL（永久）
    const t2 = await topicWithTtl('never');
    const u2 = await uploadPng(uploader.token, `topicId=${t2.id}`).expect(201);
    created.attachmentIds.push(u2.body.data.id);
    const r2 = (await readAttachmentRow(u2.body.data.id))!;
    created.objectKeys.push(r2.objectKey);
    expect(r2.expiresAt).toBeNull();
    expect(u2.body.data.expiresAt).toBeNull();

    // 脏值 → fail-closed 回退 7d（绝不回退 never）
    const t3 = await topicWithTtl('forever');
    const u3 = await uploadPng(uploader.token, `topicId=${t3.id}`).expect(201);
    created.attachmentIds.push(u3.body.data.id);
    const r3 = (await readAttachmentRow(u3.body.data.id))!;
    created.objectKeys.push(r3.objectKey);
    const d3 = r3.expiresAt!.getTime() - Date.now();
    expect(d3).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(d3).toBeLessThan(8 * 24 * 60 * 60 * 1000);

    // doc 绑定 → 恒 NULL（豁免 TTL，即使话题侧有档位也不适用）
    const { docId } = await createSpaceWithDoc(uploader.id, 'open', '# s\n');
    const u4 = await uploadPng(uploader.token, `docId=${docId}`).expect(201);
    created.attachmentIds.push(u4.body.data.id);
    const r4 = (await readAttachmentRow(u4.body.data.id))!;
    created.objectKeys.push(r4.objectKey);
    expect(r4.topicId).toBeNull();
    expect(r4.expiresAt).toBeNull();
  });

  it('TTL 写入面（M2）：PATCH /topics/:id config.attachmentTtl 真实 API 生效 → 后续上传 expiresAt ≈ now+1d', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'ttlapi');
    const topic = await createTopic(uploader.id, 'open');

    // DTO 白名单放行（forbidNonWhitelisted 真实管线：未声明键会 400，本键已声明）
    await request(app.getHttpServer())
      .patch(`${API_PREFIX}/topics/${topic.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ config: { attachmentTtl: '1d' } })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.settings.attachmentTtl).toBe('1d');
      });

    // 落库复核（settings jsonb 合并点，不经直改 SQL）
    const persisted = await ds.query(
      `SELECT settings->>'attachmentTtl' AS ttl FROM topics WHERE id = $1`,
      [topic.id],
    );
    expect(persisted[0].ttl).toBe('1d');

    // 新上传按**当时的设置**冻结 TTL
    const up = await uploadPng(uploader.token, `topicId=${topic.id}`).expect(201);
    created.attachmentIds.push(up.body.data.id);
    const row = (await readAttachmentRow(up.body.data.id))!;
    created.objectKeys.push(row.objectKey);
    const ttlMs = row.expiresAt!.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(25 * 60 * 60 * 1000);

    // 非法档位 → 400（@IsIn 白名单；DTO 层拦，不进合并点）
    await request(app.getHttpServer())
      .patch(`${API_PREFIX}/topics/${topic.id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ config: { attachmentTtl: 'forever' } })
      .expect(400);
    // 被拒的写入不得改变已落库值
    const after = await ds.query(
      `SELECT settings->>'attachmentTtl' AS ttl FROM topics WHERE id = $1`,
      [topic.id],
    );
    expect(after[0].ttl).toBe('1d');
  });

  it('过期语义（R2/R3/R4）：元数据面 200 带 expiresAt；content/thumbnail 410·12009；mint 与引用 400·12009；投影 expired', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'exp');
    const topic = await createTopic(uploader.id, 'open');
    // 真实 PNG（sharp 可解码）→ 该附件**有缩略图**：过期态下 /thumbnail 也必须是
    // 410·12009（覆盖"过期 + 有缩略图"分支；伪图只有 fail-open 的 12008 路径）
    const up = await uploadRealPng(
      uploader.token,
      await makeRealPngBuffer(32, 32),
      `topicId=${topic.id}`,
    ).expect(201);
    const id = up.body.data.id as string;
    created.attachmentIds.push(id);
    const row = (await readAttachmentRow(id))!;
    expect(row.thumbKey).not.toBeNull(); // 真实 PNG 必然生成缩略图（本用例前提）
    created.objectKeys.push(row.objectKey, row.thumbKey!);

    // 过期**前**：铸造一枚签名 URL（验证过期后公开端点同样 410，token 本身仍有效）
    const minted = await mintSignedUrl(uploader.token, id, {}).expect(200);
    const signedToken = (minted.body.data.signedUrl as string).split('token=')[1];

    // 过期**前**发一条引用消息（验证投影 expired 的墓碑语义）
    const sendRes = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: 'see image', attachmentIds: [id] })
      .expect(201);
    created.messageIds.push(sendRes.body.data.id);

    // 直改 DB 构造过期态（N3：不依赖时钟流逝）
    await forceExpire(id);

    // ① 元数据面：扫前仍 200 + expiresAt（懒判不下沉 findAccessible，m3 —— 墓碑卡片要数据）
    const meta = await request(app.getHttpServer())
      .get(`${API_PREFIX}/attachments/${id}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);
    expect(meta.body.data.expiresAt).toBeTruthy();
    expect(new Date(meta.body.data.expiresAt).getTime()).toBeLessThan(Date.now());

    // ② 字节面：410·12009（Gone 语义，与"从未存在"的 404·12000 刻意区分）
    const content = await getContentRaw(uploader.token, id).expect(410);
    expect(content.body.code).toBe(ErrorCode.ATTACHMENT_EXPIRED);
    const thumb = await getThumbnailRaw(uploader.token, id).expect(410);
    expect(thumb.body.code).toBe(ErrorCode.ATTACHMENT_EXPIRED);

    // ③ 铸造面：400·12009（死了就是死了，不许铸新票）
    const mint = await mintSignedUrl(uploader.token, id, {}).expect(400);
    expect(mint.body.code).toBe(ErrorCode.ATTACHMENT_EXPIRED);

    // ④ 公开端点（凭证仍有效）：410·12009
    const pub = await getPublicContent(id, signedToken).expect(410);
    expect(pub.body.code).toBe(ErrorCode.ATTACHMENT_EXPIRED);

    // ⑤ 引用面：新消息引用已过期附件 → 400·12009
    const send = await request(app.getHttpServer())
      .post(`${API_PREFIX}/topics/${topic.id}/messages`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .send({ content: 'again', attachmentIds: [id] })
      .expect(400);
    expect(send.body.code).toBe(ErrorCode.ATTACHMENT_EXPIRED);

    // ⑥ 投影（历史消息不动，**不 join 附件表**）：索引快照 = 发送时刻的静态事实——
    //    直改 DB 的 expires_at 不改写历史消息快照，故此刻 expired 仍为 false
    const msg = (await getMessageById(topic.id, uploader.token, sendRes.body.data.id))!;
    const att = (msg.attachments as Array<Record<string, unknown>>)[0];
    expect(att.expiresAt).toBe(row.expiresAt!.toISOString());
    expect(att.expired).toBe(false);
    expect(att.contentUrl).toBe(`${API_PREFIX}/attachments/${id}/content`);
    expect(att.clientMimeType).toBe('image/png');

    // ⑦ 时间前进（等价"发送后 TTL 到期"）：把索引快照的 expiresAt 改到过去 →
    //    投影实时纯函数算出 expired=true（墓碑卡片：消息不动，投影带 expired）
    const pastIso = new Date(Date.now() - 1000).toISOString();
    await ds.query(
      `UPDATE messages
         SET metadata = jsonb_set(metadata, '{attachments,0,expiresAt}', to_jsonb($2::text))
       WHERE id = $1`,
      [sendRes.body.data.id, pastIso],
    );
    const msg2 = (await getMessageById(topic.id, uploader.token, sendRes.body.data.id))!;
    const att2 = (msg2.attachments as Array<Record<string, unknown>>)[0];
    expect(att2.expiresAt).toBe(pastIso);
    expect(att2.expired).toBe(true);
    expect(att2.contentUrl).toBe(`${API_PREFIX}/attachments/${id}/content`); // 墓碑仍可点（下载端 410）
  });

  it('topic 连带清理（m5）：软删话题 → 附件 404 + 配额即时释放 + 一条汇总 audit', async () => {
    if (!available()) return;
    const uploader = await createHuman(UserRole.EDITOR, 'casc');
    const topic = await createTopic(uploader.id, 'open');
    const topicId = topic.id;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const up = await uploadPng(uploader.token, `topicId=${topicId}`).expect(201);
      ids.push(up.body.data.id as string);
      created.attachmentIds.push(up.body.data.id as string);
      const row = (await readAttachmentRow(up.body.data.id as string))!;
      created.objectKeys.push(row.objectKey);
    }

    // 删前：配额口径（与 attachment.service 同款谓词）计入这两行
    const before = await ds.query(
      `SELECT COALESCE(SUM(size_bytes),0)::text AS total FROM attachments
       WHERE uploader_id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [uploader.id],
    );
    expect(Number(before[0].total)).toBeGreaterThan(0);

    // 软删话题（真实 controller 链路：权限判定 + topic 审计 + 连带清理审计）
    await request(app.getHttpServer())
      .delete(`${API_PREFIX}/topics/${topicId}`)
      .set('Authorization', `Bearer ${uploader.token}`)
      .expect(200);

    // 连带软删：附件行 deleted_at 非空（语义反转：此前成员仍可读 → 现在 404）
    for (const id of ids) {
      const row = await readAttachmentRow(id);
      expect(row).toBeNull(); // findOne 默认滤软删（= 读取面 404）
      const raw = await ds.query(`SELECT deleted_at FROM attachments WHERE id = $1`, [id]);
      expect(raw[0].deleted_at).not.toBeNull();
    }
    // 字节面 404（连带软删后 = 不存在，m5 有意变更）
    const gone = await getContentRaw(uploader.token, ids[0]).expect(404);
    expect(gone.body.code).toBe(ErrorCode.ATTACHMENT_NOT_FOUND);

    // 配额即时释放（软删口径）
    const after = await ds.query(
      `SELECT COALESCE(SUM(size_bytes),0)::text AS total FROM attachments
       WHERE uploader_id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [uploader.id],
    );
    expect(Number(after[0].total)).toBe(0);

    // 汇总 audit：action=cascade_delete_attachments + {topicId, count}
    const audits = await ds.query(
      `SELECT actor_id, new_data FROM audit_logs
       WHERE action = 'cascade_delete_attachments' AND entity_id = $1`,
      [topicId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe(uploader.id);
    expect(audits[0].new_data).toEqual({ topicId, count: 2 });
  });
});
