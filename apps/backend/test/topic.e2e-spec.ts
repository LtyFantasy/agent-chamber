import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode } from '@agent-chamber/shared';

describe('TopicController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());

    const jwtService = app.get(JwtService);
    authToken = jwtService.sign({ sub: '00000000-0000-4000-8000-000000000005', email: 'test@example.com', role: 'observer' });

    // Support JwtStrategy validation for every request (Actor unified model)
    mockRepos.User.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /topics - success', async () => {
    // AccessQueryService 会多次调用 createQueryBuilder 计算白名单，再进入 Service 主查询。
    // 提供一个支持完整链式调用的 mock，白名单查询返回空数组，最终返回空分页。
    mockRepos.Topic.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });

    return request(app.getHttpServer())
      .get('/topics')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('items');
        expect(res.body.data).toHaveProperty('total', 0);
      });
  });

  it('POST /topics - success', async () => {
    mockRepos.Topic.create.mockReturnValue({ title: 'Test Topic' });
    mockRepos.Topic.save.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', title: 'Test Topic' });
    mockRepos.TopicParticipant.create.mockReturnValue({});
    mockRepos.TopicParticipant.save.mockResolvedValue({});

    return request(app.getHttpServer())
      .post('/topics')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Test Topic', description: 'A test topic' })
      .expect(201)
      .expect((res: any) => {
        // ResponseInterceptor reads statusCode before NestJS sets the default 201 for POST
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', '00000000-0000-4000-8000-000000000001');
      });
  });

  it('GET /topics/:id - success', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({

      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', '00000000-0000-4000-8000-000000000001');
      });
  });

  it('GET /topics/:id - not found (404)', async () => {
    mockRepos.Topic.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-0000-0000-000000000999')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_NOT_FOUND);
        expect(res.body.message).toContain('Topic not found');
      });
  });

  it('PATCH /topics/:id - success', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({

      id: '00000000-0000-4000-8000-000000000001',
      title: 'Old Title',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });
    mockRepos.Topic.save.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'New Title',
      status: 'active',
    });

    return request(app.getHttpServer())
      .patch('/topics/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'New Title' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('title', 'New Title');
      });
  });

  it('DELETE /topics/:id - success', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({

      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });
    mockRepos.Topic.softRemove.mockResolvedValue({});

    return request(app.getHttpServer())
      .delete('/topics/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toBe(true);
      });
  });

  it('GET /topics/:id/messages - success', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const mockMsg1 = {
      id: 'msg-1',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Hello',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    };
    const mockMsg2 = {
      id: 'msg-2',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'World',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:01:00Z'),
    };

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[mockMsg2, mockMsg1], 2]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('messages');
        expect(res.body.data.messages).toHaveLength(2);
        // DESC + reverse → 正序 [msg-1, msg-2]
        expect(res.body.data.messages[0]).toHaveProperty('id', 'msg-1');
        expect(res.body.data.messages[0]).toHaveProperty('senderName', 'Test User');
        expect(res.body.data.messages[1]).toHaveProperty('id', 'msg-2');
      });
  });

  it('GET /topics/:id/messages?start=:msgId&limit=1 - returns start message', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const startMsg = {
      id: '00000000-0000-4000-8000-000000000010',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Start message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:02Z'),
    };
    mockRepos.Message.findOne.mockResolvedValue(startMsg);

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[startMsg], 1]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?start=00000000-0000-0000-0000-000000000010&limit=1')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.messages).toHaveLength(1);
        expect(res.body.data.messages[0]).toHaveProperty('id', '00000000-0000-4000-8000-000000000010');
      });
  });

  it('GET /topics/:id/messages?start=:msgId&limit=2 - returns start and next message', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const startMsg = {
      id: '00000000-0000-4000-8000-000000000010',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Start message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:02Z'),
    };
    const nextMsg = {
      id: '00000000-0000-4000-8000-000000000011',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Next message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:03Z'),
    };
    mockRepos.Message.findOne.mockResolvedValue(startMsg);

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[startMsg, nextMsg], 2]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?start=00000000-0000-0000-0000-000000000010&limit=2')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.messages).toHaveLength(2);
        expect(res.body.data.messages[0]).toHaveProperty('id', '00000000-0000-4000-8000-000000000010');
        expect(res.body.data.messages[1]).toHaveProperty('id', '00000000-0000-4000-8000-000000000011');
      });
  });

  it('GET /topics/:id/messages?start=:msgId&after=:anotherId - returns 400', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?start=00000000-0000-0000-0000-000000000010&after=00000000-0000-4000-8000-000000000011')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
      });
  });

  it('GET /topics/:id/messages?start=:nonexistentId - returns 404', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });
    mockRepos.Message.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?start=00000000-0000-4000-8000-000000000099&limit=1')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_MESSAGE_NOT_FOUND);
      });
  });

  it('GET /topics/:id/messages?end=:msgId&limit=1 - returns end message', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const endMsg = {
      id: '00000000-0000-4000-8000-000000000020',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'End message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:02Z'),
    };
    mockRepos.Message.findOne.mockResolvedValue(endMsg);

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[endMsg], 1]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?end=00000000-0000-0000-0000-000000000020&limit=1')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.messages).toHaveLength(1);
        expect(res.body.data.messages[0]).toHaveProperty('id', '00000000-0000-4000-8000-000000000020');
      });
  });

  it('GET /topics/:id/messages?end=:msgId&limit=2 - returns end and previous message', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const endMsg = {
      id: '00000000-0000-4000-8000-000000000020',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'End message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:02Z'),
    };
    const prevMsg = {
      id: '00000000-0000-4000-8000-000000000019',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Previous message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:01Z'),
    };
    mockRepos.Message.findOne.mockResolvedValue(endMsg);

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[endMsg, prevMsg], 2]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?end=00000000-0000-0000-0000-000000000020&limit=2')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.messages).toHaveLength(2);
        expect(res.body.data.messages[0]).toHaveProperty('id', '00000000-0000-4000-8000-000000000019');
        expect(res.body.data.messages[1]).toHaveProperty('id', '00000000-0000-4000-8000-000000000020');
      });
  });

  it('GET /topics/:id/messages?start=:startId&end=:endId - returns closed interval', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    const startMsg = {
      id: '00000000-0000-4000-8000-000000000010',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Start message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:02Z'),
    };
    const endMsg = {
      id: '00000000-0000-4000-8000-000000000020',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'End message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:04Z'),
    };
    const middleMsg = {
      id: '00000000-0000-4000-8000-000000000015',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'Middle message',
      replyToId: null,
      createdAt: new Date('2024-01-01T00:00:03Z'),
    };
    mockRepos.Message.findOne.mockResolvedValueOnce(startMsg).mockResolvedValueOnce(endMsg);

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[startMsg, middleMsg, endMsg], 3]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?start=00000000-0000-0000-0000-000000000010&end=00000000-0000-0000-0000-000000000020&limit=10')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.messages).toHaveLength(3);
        expect(res.body.data.messages[0]).toHaveProperty('id', '00000000-0000-4000-8000-000000000010');
        expect(res.body.data.messages[2]).toHaveProperty('id', '00000000-0000-4000-8000-000000000020');
      });
  });

  it('GET /topics/:id/messages?end=:nonexistentId - returns 404', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });
    mockRepos.Message.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?end=00000000-0000-4000-8000-000000000099&limit=1')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_MESSAGE_NOT_FOUND);
      });
  });

  it('GET /topics/:id/messages?end=:msgId&before=:anotherId - returns 400', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages?end=00000000-0000-0000-0000-000000000020&before=00000000-0000-4000-8000-000000000019')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
      });
  });

  it('POST /topics/:id/messages - success', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({

      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });
    mockRepos.Message.create.mockReturnValue({
      topicId: '00000000-0000-4000-8000-000000000001',
      content: 'Hello',
    });
    mockRepos.Message.save.mockResolvedValue({
      id: 'msg-1',
      topicId: '00000000-0000-4000-8000-000000000001',
      content: 'Hello',
    });

    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/messages')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'Hello' })
      .expect(201)
      .expect((res: any) => {
        // ResponseInterceptor reads statusCode before NestJS sets the default 201 for POST
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', 'msg-1');
      });
  });

  it('POST /topics/:id/messages - failure when topic is closed (400)', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({

      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'closed',
    });

    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/messages')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'Hello' })
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_CLOSED);
        expect(res.body.message).toContain('Topic is closed');
      });
  });

  // ==================== Batch E3：已读游标（human JWT 路径） ====================

  it('GET /topics/:id/messages/unread - 增量消息形状 + hasMore', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
      messageCount: 10,
    });

    mockRepos.TopicParticipant.findOne.mockResolvedValue({
      topicId: '00000000-0000-4000-8000-000000000001',
      participantId: '00000000-0000-4000-8000-000000000005',
      lastReadMessageId: 'msg-5',
    });

    mockRepos.Message.findOne.mockResolvedValue({
      id: 'msg-5',
      createdAt: new Date('2024-01-01T10:00:00Z'),
    });

    const unreadMsg1 = {
      id: 'msg-6',
      topicId: '00000000-0000-4000-8000-000000000001',
      senderId: '00000000-0000-4000-8000-000000000005',
      senderType: 'human',
      content: 'unread-1',
      replyToId: null,
      type: 'chat',
      createdAt: new Date('2024-01-01T11:00:00Z'),
    };
    const unreadMsg2 = { ...unreadMsg1, id: 'msg-7', content: 'unread-2' };

    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(3),
      getMany: jest.fn().mockResolvedValue([unreadMsg1, unreadMsg2]),
    });

    mockRepos.Actor.find.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', type: 'human', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.User.findBy.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000005', displayName: 'Test User', avatarUrl: null },
    ]);
    mockRepos.Agent.findBy.mockResolvedValue([]);

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages/unread?limit=20')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        const data = res.body.data;
        expect(data.topicId).toBe('00000000-0000-4000-8000-000000000001');
        expect(data.unreadCount).toBe(3);
        expect(data.lastReadMessageId).toBe('msg-5');
        expect(data.messages).toHaveLength(2);
        expect(data.messages[0]).toHaveProperty('senderName', 'Test User');
        expect(data.hasMore).toBe(true); // 3 unread > 2 returned
      });
  });

  it('GET /topics/:id/messages/unread?limit=51 - 超过上限返回 400', async () => {
    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001/messages/unread?limit=51')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400);
  });

  it('POST /topics/:id/read - 防回退：目标更旧 → advanced=false 且游标不动', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    // findOne: target 校验（旧消息 10:00）
    mockRepos.Message.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000010',
      createdAt: new Date('2024-01-01T10:00:00Z'),
    });

    // DB 内行值比较：新目标更旧 → newer=false
    mockRepos.Message.query.mockResolvedValue([{ newer: false }]);

    mockRepos.TopicParticipant.findOne.mockResolvedValue({
      topicId: '00000000-0000-4000-8000-000000000001',
      participantId: '00000000-0000-4000-8000-000000000005',
      lastReadMessageId: 'msg-99',
    });

    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/read')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ messageId: '00000000-0000-4000-8000-000000000010' })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.advanced).toBe(false);
        expect(res.body.data.lastReadMessageId).toBe('msg-99'); // 游标不动
        expect(mockRepos.TopicParticipant.save).not.toHaveBeenCalled();
      });
  });

  it('POST /topics/:id/read - 推进：目标更新 → advanced=true 且写库', async () => {
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Test Topic',
      creatorId: '00000000-0000-4000-8000-000000000005',
      creatorType: 'human',
      settings: { visibility: 'open' },
      status: 'active',
    });

    // findOne: target 校验（新消息 14:00）
    mockRepos.Message.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000020',
      createdAt: new Date('2024-01-01T14:00:00Z'),
    });

    // DB 内行值比较：新目标更新 → newer=true
    mockRepos.Message.query.mockResolvedValue([{ newer: true }]);

    const existingParticipant = {
      topicId: '00000000-0000-4000-8000-000000000001',
      participantId: '00000000-0000-4000-8000-000000000005',
      lastReadMessageId: 'msg-99',
      role: 'owner',
    };
    mockRepos.TopicParticipant.findOne.mockResolvedValue(existingParticipant);
    mockRepos.TopicParticipant.save.mockImplementation((entity: any) => Promise.resolve(entity));

    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/read')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ messageId: '00000000-0000-4000-8000-000000000020' })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.advanced).toBe(true);
        expect(res.body.data.lastReadMessageId).toBe('00000000-0000-4000-8000-000000000020');
        expect(mockRepos.TopicParticipant.save).toHaveBeenCalled();
        // upsert bug 守卫：role 不被降级
        expect(existingParticipant.role).toBe('owner');
      });
  });

  // ==================== v1.37 owner 代理权限（agent 创建 → owner 人类全通） ====================

  const agentCreatorId = '00000000-0000-0000-0000-0000000000aa';
  const ownerHumanId = '00000000-0000-4000-8000-000000000005';

  it('GET /topics/:id - owner human can read agent-created private topic (owner proxy)', async () => {
    // 模拟 agent（API Key）创建的 private 话题
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Agent Private Topic',
      creatorId: agentCreatorId,
      creatorType: 'agent',
      settings: { visibility: 'private' },
      status: 'active',
    });

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('creatorId', agentCreatorId);
        // owner 代理命中：确认查了 agents 表
        expect(mockRepos.Agent.exists).toHaveBeenCalledWith({
          where: { id: agentCreatorId, ownerId: ownerHumanId },
        });
      });
  });

  it('GET /topics/:id - non-owner human gets 404 for agent-created private topic', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Agent Private Topic',
      creatorId: agentCreatorId,
      creatorType: 'agent',
      settings: { visibility: 'private' },
      status: 'active',
    });

    return request(app.getHttpServer())
      .get('/topics/00000000-0000-4000-8000-000000000001')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_NOT_FOUND);
      });
  });

  it('POST /topics/:id/messages - owner human can send to agent-created private topic (owner proxy)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Agent Private Topic',
      creatorId: agentCreatorId,
      creatorType: 'agent',
      settings: { visibility: 'private' },
      status: 'active',
    });
    // 非参与者（owner 人类不在 participant 表，靠 owner 代理放行）
    mockRepos.TopicParticipant.findOne.mockResolvedValue(null);
    mockRepos.Message.create.mockReturnValue({
      topicId: '00000000-0000-4000-8000-000000000001',
      content: 'Hello from owner',
    });
    mockRepos.Message.save.mockResolvedValue({
      id: 'msg-owner-1',
      topicId: '00000000-0000-4000-8000-000000000001',
      content: 'Hello from owner',
    });

    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/messages')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'Hello from owner' })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', 'msg-owner-1');
      });
  });

  it('POST /topics/:id/messages - non-owner human gets 404 sending to agent-created private topic (read gate first)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    mockRepos.Topic.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Agent Private Topic',
      creatorId: agentCreatorId,
      creatorType: 'agent',
      settings: { visibility: 'private' },
      status: 'active',
    });
    mockRepos.TopicParticipant.findOne.mockResolvedValue(null);

    // 非 owner：controller 的 read 门禁（ensureCan）先行拦截 → 404，不泄露存在性
    return request(app.getHttpServer())
      .post('/topics/00000000-0000-4000-8000-000000000001/messages')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'Hello' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOPIC_NOT_FOUND);
      });
  });
});
