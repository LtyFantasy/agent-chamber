/**
 * 受控 HTTP 合同测试：真实 RoundtableController + RoundtableService + ValidationPipe、
 * 响应信封与异常过滤器，固定人类 actor、内存仓储及外部副作用桩。
 * 验证 DTO → 裁决业务 → HTTP 状态/业务码；不接真实认证、PG、runner 或厂商 CLI，
 * 不代表全鉴权或生产端到端验收。核心裁决与公告方法均不替换。
 */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  API_PREFIX,
  ActorType,
  ErrorCode,
  MessageType,
  SYSTEM_ACTOR_ID,
} from '@agent-chamber/shared';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { PermissionService } from '../src/common/services/permission.service';
import { Actor } from '../src/database/entities/actor.entity';
import { Message } from '../src/database/entities/message.entity';
import { RoundtablePermissionRequest } from '../src/database/entities/roundtable-permission-request.entity';
import { RoundtableRunner } from '../src/database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { AuditService } from '../src/modules/audit/audit.service';
import { RoundtableController } from '../src/modules/roundtable/roundtable.controller';
import { RoundtableService } from '../src/modules/roundtable/roundtable.service';
import { RunnerRegistryService } from '../src/modules/roundtable/runner-registry.service';
import { TopicService } from '../src/modules/topic/topic.service';

/** 本套件独立内存 ID，无真实平台资源或凭据。 */
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const HUMAN_ID = '22222222-2222-4222-8222-222222222222';
const TOPIC_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '44444444-4444-4444-8444-444444444444';

/** 构造待裁决行，options 保持宽松以验证选中时的业务校验。 */
function pendingRequest(options: Record<string, unknown>[]): RoundtablePermissionRequest {
  return Object.assign(new RoundtablePermissionRequest(), {
    id: REQUEST_ID,
    requestId: 'rpc-opaque-1',
    seatId: SEAT_ID,
    topicId: TOPIC_ID,
    tool: { title: 'controlled tool' },
    options,
    status: 'pending',
    verdictOptionId: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-10-25T00:00:00Z'),
  });
}

describe('Roundtable permission verdict (controlled HTTP)', () => {
  let app: INestApplication;
  /** 保存同一对象引用，使“未调用 save 但提前改对象”的缺陷也能被快照发现。 */
  let row: RoundtablePermissionRequest;
  const permRepo = { findOne: jest.fn(), save: jest.fn() };
  const seatRepo = { findOne: jest.fn(), save: jest.fn() };
  const topicService = {
    findById: jest.fn(),
    sendMessage: jest.fn(),
    isActiveParticipant: jest.fn(),
    join: jest.fn(),
  };
  const permissions = { ensureCan: jest.fn() };
  const ownerProxy = { isOwnerProxy: jest.fn() };
  const registry = { sendToRunner: jest.fn() };
  const audit = { log: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoundtableController],
      providers: [
        RoundtableService,
        { provide: getRepositoryToken(RoundtablePermissionRequest), useValue: permRepo },
        { provide: getRepositoryToken(RoundtableSeat), useValue: seatRepo },
        // 不导入 AppModule/数据库/WS：未参与裁决的依赖无需启动其生命周期。
        ...[RoundtableRunner, TopicParticipant, Topic, Message, Actor].map((entity) => ({
          provide: getRepositoryToken(entity),
          useValue: {},
        })),
        { provide: TopicService, useValue: topicService },
        { provide: PermissionService, useValue: permissions },
        { provide: OwnerProxyService, useValue: ownerProxy },
        { provide: RunnerRegistryService, useValue: registry },
        { provide: ActorProfileService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        /** 仅注入受控 actor；业务仍走真实 human/creator 治理校验。 */
        canActivate(context: ExecutionContext): boolean {
          context.switchToHttp().getRequest().user = { userId: HUMAN_ID, name: 'Controlled Human' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    row = pendingRequest([{ optionId: 'opaque:selected', kind: 'allow_once', name: 'Selected' }]);
    permRepo.findOne.mockImplementation(async () => row);
    permRepo.save.mockImplementation(async (value: RoundtablePermissionRequest) => value);
    seatRepo.findOne.mockResolvedValue({
      id: SEAT_ID,
      label: 'controlled-seat',
      runnerId: 'fake-runner',
    });
    topicService.findById.mockResolvedValue({ id: TOPIC_ID, creatorId: HUMAN_ID });
    topicService.isActiveParticipant.mockResolvedValue(true);
    topicService.sendMessage.mockResolvedValue({});
    permissions.ensureCan.mockResolvedValue(undefined);
    ownerProxy.isOwnerProxy.mockResolvedValue(false);
    registry.sendToRunner.mockReturnValue(true);
    audit.log.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** 所有失败路径共享零副作用断言，不替代请求快照断言。 */
  function expectNoSideEffects(): void {
    expect(permRepo.save).not.toHaveBeenCalled();
    expect(seatRepo.findOne).not.toHaveBeenCalled();
    expect(seatRepo.save).not.toHaveBeenCalled();
    expect(registry.sendToRunner).not.toHaveBeenCalled();
    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(topicService.join).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  }

  it.each([
    ['allow_once', 'opaque:permit-one/17', 'approved', '已批准'],
    ['allow_always', 'opaque:permit-session/18', 'approved', '已批准'],
    ['reject_once', 'opaque:deny-one/19', 'rejected', '已拒绝'],
    ['reject_always', 'opaque:deny-session/20', 'rejected', '已拒绝'],
  ])(
    '%s + opaque optionId → 201，持久状态/下行/公告/审计一致',
    async (kind, optionId, status, text) => {
      row = pendingRequest([{ optionId, kind, name: 'Opaque selection' }]);
      const response = await request(app.getHttpServer())
        .post(`${API_PREFIX}/roundtable/permission-requests/${REQUEST_ID}/verdict`)
        .send({ optionId })
        .expect(201);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response.body).toMatchObject({
        code: ErrorCode.SUCCESS,
        data: {
          status,
          verdictOptionId: optionId,
          resolvedBy: HUMAN_ID,
          resolvedAt: expect.any(String),
        },
      });
      expect(row).toMatchObject({ status, verdictOptionId: optionId, resolvedBy: HUMAN_ID });
      expect(row.resolvedAt).toBeInstanceOf(Date);
      expect(permRepo.save).toHaveBeenCalledTimes(1);
      expect(permRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status,
          verdictOptionId: optionId,
          resolvedBy: HUMAN_ID,
          resolvedAt: expect.any(Date),
        }),
      );
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect(registry.sendToRunner).toHaveBeenCalledWith(
        'fake-runner',
        expect.objectContaining({
          type: 'seat.permission_verdict',
          payload: { requestId: row.requestId, optionId },
        }),
      );
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        TOPIC_ID,
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: `Controlled Human ${text}了座位 controlled-seat 的审批请求`,
          type: MessageType.SYSTEM,
        }),
      );
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: HUMAN_ID,
          newData: { requestId: REQUEST_ID, seatId: SEAT_ID, topicId: TOPIC_ID, status },
        }),
      );
    },
  );

  it.each([
    { optionId: 'opaque:future', kind: 'future_kind' },
    { optionId: 'opaque:missing' },
    { optionId: 'opaque:number', kind: 42 },
    { optionId: 'reject', kind: 'reject' },
    { optionId: 'approve_once', kind: 'unknown' },
  ])(
    'unsupported selected kind $optionId → 422/VALIDATION_ERROR，原 pending 不变',
    async (option) => {
      row = pendingRequest([{ ...option, name: 'Unsupported selection' }]);
      const before = structuredClone(row);
      const response = await request(app.getHttpServer())
        .post(`${API_PREFIX}/roundtable/permission-requests/${REQUEST_ID}/verdict`)
        .send({ optionId: option.optionId })
        .expect(422);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(response.body).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringMatching(/kind.*missing or unsupported/),
      });
      expect(row).toEqual(before);
      expectNoSideEffects();
    },
  );

  it.each([{}, { optionId: '' }, { optionId: 7 }, { optionId: 'x'.repeat(101) }])(
    '非法 DTO %j → 400，业务仓储尚未读取',
    async (body) => {
      const before = structuredClone(row);
      const response = await request(app.getHttpServer())
        .post(`${API_PREFIX}/roundtable/permission-requests/${REQUEST_ID}/verdict`)
        .send(body)
        .expect(400);
      expect(response.body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(permRepo.findOne).not.toHaveBeenCalled();
      expect(row).toEqual(before);
      expectNoSideEffects();
    },
  );
});
