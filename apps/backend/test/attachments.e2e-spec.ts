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
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 新增用例必须登记 created.* 清理队列（FK 逆序 + MinIO 对象）
 *   □ RUN 后缀隔离纪律不破坏（不碰任何既有数据）
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
 * ⑧ X-API-Key 真实认证路径（agent 上传走 guard API Key 分支）。
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
import { AttachmentService } from '../src/modules/attachments/attachment.service';
import { AttachmentStorageService } from '../src/modules/attachments/storage.service';
import { AttachmentAccessService } from '../src/modules/attachments/attachment-access.service';
import { MulterLimitErrorInterceptor } from '../src/modules/attachments/multer-error.interceptor';
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
import { makePngBuffer } from '../src/modules/attachments/test-image-fixtures';

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
    // ConfigService：JwtOrApiKeyGuard 读 jwt.secret；StorageService 读 minio.*
    const configMock = {
      get: (key: string): unknown => {
        if (key === 'jwt.secret') return 'test-secret';
        if (key === 'minio.endPoint') return MINIO_CONFIG.endPoint;
        if (key === 'minio.port') return MINIO_CONFIG.port;
        if (key === 'minio.useSSL') return MINIO_CONFIG.useSSL;
        if (key === 'minio.accessKey') return MINIO_CONFIG.accessKey;
        if (key === 'minio.secretKey') return MINIO_CONFIG.secretKey;
        if (key === 'minio.bucket') return MINIO_CONFIG.bucket;
        return undefined;
      },
    };

    // 最小 Nest 模块：Attachment/Topic 两 controller + 真实服务链 + 真实
    // JwtOrApiKeyGuard（Bearer JWT 签发 + API Key sha256 查表双路径）+ 生产同款
    // 全局管线（ValidationPipe / ResponseInterceptor / AllExceptionsFilter /
    // /api/v1 前缀）。不走 AppModule：避免 schedule/WS 等无关启动面。
    moduleRef = await Test.createTestingModule({
      controllers: [AttachmentController, TopicController],
      providers: [
        AttachmentService,
        AttachmentStorageService,
        AttachmentAccessService,
        MulterLimitErrorInterceptor,
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
    expect(content.headers['cache-control']).toBe('private, max-age=3600');
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
    // 响应恒存在结构化 attachments 投影（P1 契约：5 字段 + contentUrl 派生）
    expect(sent.body.data.attachments).toEqual([
      {
        id: attId,
        originalName: '绑定.png',
        mimeType: 'image/png',
        sizeBytes: 33,
        contentUrl: `${API_PREFIX}/attachments/${attId}/content`,
      },
    ]);
    // 响应不含原始 metadata 键（投影只漏结构化字段，隐私/体积）
    expect(sent.body.data.metadata).toBeUndefined();
    created.messageIds.push(sent.body.data.id);

    // SQL 直查 metadata.attachments 索引形状（sizeBytes number）
    const rows: Array<{ attachments: Array<Record<string, unknown>> | null }> = await ds.query(
      `SELECT metadata->'attachments' AS attachments FROM messages WHERE id = $1`,
      [sent.body.data.id],
    );
    expect(rows[0].attachments).toEqual([
      { id: attId, originalName: '绑定.png', mimeType: 'image/png', sizeBytes: 33 },
    ]);
  });

  it('GET messages / unread（P1 真 PG 链路）：带附件消息投影恒存在（5 字段+contentUrl），无附件消息 attachments: []', async () => {
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
    const projection = [
      {
        id: attId,
        originalName: '投影.png',
        mimeType: 'image/png',
        sizeBytes: 33,
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
});
