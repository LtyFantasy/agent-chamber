/**
 * B1 poll visibility against real PostgreSQL SQL and all migrations.
 * Fixed fake whitelists isolate the poll contract; this suite does not certify all ACL paths.
 * Only an exclusively created event_poll_b1_* database receives ordinary fixture events.
 */
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorType, EventType, UserRole } from '@agent-chamber/shared';
import { DataSource, DataSourceOptions, Logger } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';
import { Event } from '../src/database/entities/event.entity';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { UnifiedActor } from '../src/common/types/actor.types';
import { EventService } from '../src/modules/event/event.service';
import { SseService } from '../src/modules/sse/sse.service';

/** One owned database name, guarded again before deletion; never a business database. */
const temporaryName = `event_poll_b1_${process.pid}_${Date.now().toString(36)}`;
/** Capture actual SQL and bound values without credentials or shared business content. */
const queries: { query: string; parameters: unknown[] }[] = [];
/** Observe repository SQL rather than approximating TypeORM SQL in a mock. */
const sqlLogger: Logger = {
  logQuery(query, parameters) {
    queries.push({ query, parameters: parameters ?? [] });
  },
  logQueryError() {},
  logQuerySlow() {},
  logSchemaBuild() {},
  logMigration() {},
  log() {},
};

/** Reuse the canonical schema, but always override the database with an owned fixture target. */
function options(database: string, admin = false): DataSourceOptions {
  return {
    ...AppDataSource.options,
    host: process.env.TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT ?? 8744),
    username: process.env.TEST_DB_USERNAME ?? 'chamber',
    password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
    database,
    entities: admin ? [] : AppDataSource.options.entities,
    migrations: admin ? [] : AppDataSource.options.migrations,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: !admin,
    logger: sqlLogger,
  } as DataSourceOptions;
}

describe('Event poll DocSpace visibility (isolated PostgreSQL)', () => {
  let admin: DataSource | undefined;
  let db: DataSource | undefined;
  let created = false;
  let service: EventService;
  /** Synthetic IDs only; no authentication or real identity lookups occur. */
  const actor: UnifiedActor = { id: randomUUID(), type: ActorType.AGENT };
  const otherActorId = randomUUID();
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  const topicId = randomUUID();
  const boardId = randomUUID();
  /** Fixed fake whitelist providers; AccessQuery's permission algorithm is unchanged. */
  const access = {
    getAccessibleTopicIds: jest.fn(),
    getAccessibleBoardIds: jest.fn(),
    getAccessibleDocSpaceIds: jest.fn(),
  };

  jest.setTimeout(300_000);

  /** Nested finally closes every connection and drops only the database created by this run. */
  async function cleanup(): Promise<void> {
    try {
      if (db?.isInitialized) await db.destroy();
    } finally {
      try {
        if (created && admin?.isInitialized) {
          if (!/^event_poll_b1_\d+_[a-z0-9]+$/.test(temporaryName)) {
            throw new Error('Unsafe temporary database name');
          }
          await admin.query(`DROP DATABASE "${temporaryName}" WITH (FORCE)`);
          created = false;
          const remaining = await admin.query(
            'SELECT datname FROM pg_database WHERE datname = $1',
            [temporaryName],
          );
          expect(remaining).toHaveLength(0);
          console.info(`[B1 temporary database] dropped ${temporaryName}; remaining=0`);
        }
      } finally {
        if (admin?.isInitialized) await admin.destroy();
      }
    }
  }

  beforeAll(async () => {
    try {
      admin = new DataSource(options(process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres', true));
      await admin.initialize(); // An unavailable PostgreSQL is a failure, never a skip.
      await admin.query(`CREATE DATABASE "${temporaryName}"`);
      created = true;
      db = new DataSource(options(temporaryName));
      await db.initialize();
      const migrations = await db.runMigrations();
      expect(migrations.length).toBe(db.migrations.length);
      expect(migrations.length).toBeGreaterThan(0);
      service = new EventService(
        db.getRepository(Event),
        { emit: jest.fn() } as unknown as SseService,
        access as unknown as AccessQueryService,
        new EventEmitter2(),
      );
      console.info(
        `[B1 temporary database] created ${temporaryName}; migrations=${migrations.length}`,
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  afterAll(cleanup);

  beforeEach(async () => {
    // This table belongs exclusively to this run; every case starts with an explicit event order.
    await db!.getRepository(Event).clear();
    jest.clearAllMocks();
    access.getAccessibleTopicIds.mockResolvedValue([]);
    access.getAccessibleBoardIds.mockResolvedValue([]);
    access.getAccessibleDocSpaceIds.mockResolvedValue([spaceId]);
    queries.length = 0;
  });

  /** Insert an ordinary synthetic event through the real repository and DB cursor default. */
  async function event(overrides: Partial<Event> = {}): Promise<Event> {
    const repo = db!.getRepository(Event);
    return repo.save(
      repo.create({
        eventType: EventType.DOC_UPDATED,
        resourceType: 'doc',
        resourceId: randomUUID(),
        actorId: otherActorId,
        payload: { spaceId },
        ...overrides,
      }),
    );
  }

  it('returns another actor’s independent document create/update/delete events', async () => {
    const expected: Event[] = [];
    for (const eventType of [EventType.DOC_CREATED, EventType.DOC_UPDATED, EventType.DOC_DELETED]) {
      expected.push(await event({ eventType }));
    }

    const result = await service.poll({}, actor);

    expect(result.events.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(
      result.events.every((row) => !row.topicId && !row.boardId && row.actorId !== actor.id),
    ).toBe(true);
    expect(result.nextCursor).toBe(expected[2].cursor);
    expect(access.getAccessibleDocSpaceIds).toHaveBeenCalledWith(actor);
  });

  it('excludes other spaces, missing spaceId and malformed values without a UUID cast failure', async () => {
    for (const payload of [
      { spaceId: otherSpaceId },
      {},
      { spaceId: 'not-a-uuid' },
      { spaceId: null },
      { spaceId: 7 },
    ]) {
      await event({ payload });
    }
    const visible = await event();

    const result = await service.poll({}, actor);

    expect(result.events.map((row) => row.id)).toEqual([visible.id]);
  });

  it('empty DocSpace whitelist keeps only personal events and emits no empty IN list', async () => {
    access.getAccessibleDocSpaceIds.mockResolvedValue([]);
    await event();
    const personal = await event({ actorId: actor.id, payload: {} });

    const result = await service.poll({}, actor);

    expect(result.events.map((row) => row.id)).toEqual([personal.id]);
    const selection = queries.find((row) => /FROM "events" "event"/.test(row.query));
    expect(selection?.query).not.toContain("->>'spaceId'");
    expect(selection?.query).not.toMatch(/IN\s*\(\s*\)/);
  });

  it.each([false, true])(
    'preserves topic/board/personal OR and visibility grouping (withCursor=%s)',
    async (withCursor) => {
      access.getAccessibleTopicIds.mockResolvedValue([topicId]);
      access.getAccessibleBoardIds.mockResolvedValue([boardId]);
      // Every visible branch has an older counterexample: OR must never bypass the outer cursor AND.
      const old: Event[] = [];
      old.push(await event());
      old.push(await event({ topicId, payload: {} }));
      old.push(await event({ boardId, payload: {} }));
      old.push(await event({ actorId: actor.id, payload: {} }));
      const anchor = await event({ payload: { spaceId: otherSpaceId } });
      const fresh: Event[] = [];
      fresh.push(await event());
      fresh.push(await event({ topicId, payload: {} }));
      fresh.push(await event({ boardId, payload: {} }));
      fresh.push(await event({ actorId: actor.id, payload: { spaceId: otherSpaceId } }));
      await event({ payload: { spaceId: otherSpaceId } });

      const result = await service.poll(withCursor ? { cursor: anchor.cursor } : {}, actor);

      expect(result.events.map((row) => row.id)).toEqual(
        [...(withCursor ? [] : old), ...fresh].map((row) => row.id),
      );
      expect(result.nextCursor).toBe(fresh[3].cursor);
    },
  );

  it('filters before limit=1 and resumes without duplicates or omissions', async () => {
    await event({ payload: { spaceId: otherSpaceId } });
    const expected: Event[] = [];
    for (const eventType of [EventType.DOC_CREATED, EventType.DOC_UPDATED, EventType.DOC_DELETED]) {
      expected.push(await event({ eventType }));
      await event({ payload: { spaceId: otherSpaceId } });
    }
    let cursor: string | undefined;
    for (const visible of expected) {
      const page = await service.poll({ cursor, limit: 1 }, actor);
      expect(page.events.map((row) => row.id)).toEqual([visible.id]);
      expect(page.nextCursor).toBe(visible.cursor);
      cursor = page.nextCursor;
    }
    expect(await service.poll({ cursor, limit: 1 }, actor)).toEqual({
      events: [],
      nextCursor: cursor,
    });
  });

  it('admin bypasses all whitelist queries and sees unrelated events', async () => {
    const hidden = await event({ payload: { spaceId: otherSpaceId } });
    const adminActor = { ...actor, type: ActorType.HUMAN, role: UserRole.ADMIN };

    const result = await service.poll({}, adminActor);

    expect(result.events.map((row) => row.id)).toEqual([hidden.id]);
    expect(access.getAccessibleTopicIds).not.toHaveBeenCalled();
    expect(access.getAccessibleBoardIds).not.toHaveBeenCalled();
    expect(access.getAccessibleDocSpaceIds).not.toHaveBeenCalled();
  });

  it('first empty result anchors to global MAX; explicit cursor and now keep existing semantics', async () => {
    const hidden = await event({ payload: { spaceId: otherSpaceId } });

    expect(await service.poll({}, actor)).toEqual({ events: [], nextCursor: hidden.cursor });
    expect(await service.poll({ cursor: '0' }, actor)).toEqual({ events: [], nextCursor: '0' });
    expect(await service.poll({ cursor: 'now' }, actor)).toEqual({
      events: [],
      nextCursor: hidden.cursor,
    });
  });

  it('records actual text JSONB SQL, cursor AND grouping and a small-fixture EXPLAIN', async () => {
    access.getAccessibleTopicIds.mockResolvedValue([topicId]);
    access.getAccessibleBoardIds.mockResolvedValue([boardId]);
    const anchor = await event({ payload: { spaceId: otherSpaceId } });
    await event();
    queries.length = 0;

    await service.poll({ cursor: anchor.cursor, limit: 1 }, actor);

    const selection = queries.find((row) => /FROM "events" "event"/.test(row.query))!;
    expect(selection).toBeDefined();
    const where = selection.query.slice(selection.query.indexOf(' WHERE '));
    expect(where).toMatch(/"event"\."cursor" > \$\d+ AND \(/);
    // TypeORM keeps this JSONB expression raw; it does not quote the alias/property pair.
    expect(where).toMatch(/event\.payload->>'spaceId' IN \(\$\d+\)/);
    expect(where).toMatch(/OR "event"\."actor_id" = \$\d+\)/);
    expect(where).toMatch(/ORDER BY "event"\."cursor" ASC LIMIT 1$/);
    expect(where).not.toContain('::uuid');
    expect(selection.parameters).toEqual([anchor.cursor, topicId, boardId, spaceId, actor.id]);
    const plan = await db!.query(`EXPLAIN (FORMAT JSON) ${selection.query}`, selection.parameters);
    expect(plan[0]['QUERY PLAN'][0].Plan).toBeDefined();
    console.info(`[B1 SQL] ${JSON.stringify(selection)}`);
    console.info(`[B1 EXPLAIN small fixture only] ${JSON.stringify(plan)}`);
  });
});
