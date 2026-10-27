/**
 * =============================================================================
 * memory recall 限流（F4 项3，2026-10-17）
 * =============================================================================
 * [存在理由]
 *   recall 是**引擎成本端点**（Hument 侧召回），F4 前零限流。本 spec 钉死双桶语义：
 *   `default`(IP) 拦洪 + `actor`(身份) 公平配额，两桶**独立计数**。
 *
 * [为什么用 dummy controller 而不是真端点]
 *   真端点（MemoryController.recall）的阈值在测试环境被 `isTestEnv` 放宽到 100_000
 *   （memory e2e 有 22 处 recall 调用，真阈值会误伤）——**放宽后真端点不可判 429**。
 *   故与 auth-throttle.spec.ts:76-98 同处境：429 语义在 dummy controller 上判（同构的
 *   @Throttle 声明 + 真 ThrottlerGuard），真端点只判"元数据已接线" + "生产默认值被钉住"。
 *
 * [mock 必须用真实 guard 形状（S-M1）]
 *   身份挂载形态与真实守卫一致：API Key 通道 = `request.agent = { id }`，
 *   人类 JWT 通道 = `request.user = { userId }`。**写成 `user = { id }` 会让本文件全绿
 *   却放过线上 bug**（tracker 的 `user.userId` 恒 undefined → JWT 通道静默退化成 IP 兜底）。
 *
 * [每个用例独立 route]
 *   generateKey = `${class}-${handler}-${bucketName}-${tracker}`
 *   （throttler.guard.js:129-132）——故**不同 handler = 不同计数空间**。本文件每个用例
 *   打自己的 route，避免 IP 桶的累计计数在用例之间串味（同一 route 下 supertest 全部
 *   来自 127.0.0.1，IP 桶必然共享）。
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约) #18(不变量检查)
 * =============================================================================
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, HttpCode, HttpStatus, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request = require('supertest');
import { actorTracker } from '../../common/utils/throttler-trackers';
import { MemoryController } from './memory.controller';

const TTL_MS = 60_000;
/** 与 app.module.ts 相同的全局默认（极宽松 = 实际关闭） */
const GLOBAL_LIMIT = 100_000;
/** 测试环境放宽后的真端点阈值（memory.controller.ts 的 isTestEnv 分支） */
const RELAXED_LIMIT = 100_000;
/** 宽口径 IP 桶（用例只关心身份桶时用它，防止 4 次以内的请求被 IP 桶截胡） */
const WIDE = 1_000;

/**
 * 与 recall 端点同构的 @Throttle 声明（桶名、getTracker、阈值语义口径完全一致）。
 * 阈值参数化为窄口径：真阈值 300/60s 在测试环境被放宽，窄口径才可判。
 *
 * 桶的**迭代序**由 forRoot 数组决定，不是本对象里键的书写顺序（本对象只是按同一顺序
 * 书写以便对照）；准确说法：**模块级 ttl 升序，ttl 相等时保持声明序**（guard 的
 * `throttlers.sort((a,b) => a.ttl - b.ttl)` 是稳定排序；route 级 ttl 覆盖不参与排序，
 * 它只在取 limit/ttl 时覆盖值）。两个桶 ttl 都是 60s ⇒ 迭代序 = 声明序 = default 先。
 */
const recallLikeThrottle = (ipLimit: number, actorLimit: number) =>
  Throttle({
    default: { limit: ipLimit, ttl: TTL_MS },
    actor: { limit: actorLimit, ttl: TTL_MS, getTracker: actorTracker },
  });

/**
 * 限流探针：每个 handler 一种阈值组合，各自独立计数空间（见文件头）。
 */
@Controller('recall-throttle-probe')
class RecallThrottleProbeController {
  /** 双桶都窄：判 actor 桶 429、头后缀形态、两桶同超限时 default 先抛 */
  @recallLikeThrottle(3, 2)
  @Post('both-tight')
  @HttpCode(HttpStatus.OK)
  bothTight() {
    return { ok: true };
  }

  /** IP 宽 + actor 窄：判身份隔离（不同 agent 互不挤占） */
  @recallLikeThrottle(WIDE, 2)
  @Post('actor-isolation')
  @HttpCode(HttpStatus.OK)
  actorIsolation() {
    return { ok: true };
  }

  /** IP 宽 + actor 窄：判人类 JWT 通道按 userId 分桶 */
  @recallLikeThrottle(WIDE, 2)
  @Post('user-channel')
  @HttpCode(HttpStatus.OK)
  userChannel() {
    return { ok: true };
  }

  /** 无任何身份 → IP 兜底（agent/user 都不挂） */
  @recallLikeThrottle(2, WIDE)
  @Post('no-identity')
  @HttpCode(HttpStatus.OK)
  noIdentity() {
    return { ok: true };
  }

  /** IP 窄 + actor 宽：判 IP 桶跨身份**合计**计数（双桶独立） */
  @recallLikeThrottle(3, WIDE)
  @Post('shared-ip')
  @HttpCode(HttpStatus.OK)
  sharedIp() {
    return { ok: true };
  }
}

/** 测试中间件读的身份头（模拟真实守卫的装配结果，形状与 express.d.ts 一致） */
interface ProbeIdentity {
  agent?: { id: string } | null;
  user?: { userId: string } | null;
}

/**
 * 从 app.module.ts 源码提取 **APP_GUARD 的有序位次**（复审 MAJOR-2 的护栏）。
 *
 * 为什么不读 AppModule 元数据：`app.module.spec.ts` 文件头有明文决策——**不 boot 应用、
 * 不 import AppModule**（import 全模块图 = 慢 + 依赖 Nest 元数据内部约定；首版元数据断言
 * 已因此废弃，改为对单源常量直接断言）。故这里用**结构提取**而不是文本包含：解析
 * `provide: APP_GUARD,` → `useClass: X` 的成对形态并按出现顺序排列，文本包含式锚点无法
 * 发现"两条互换"这类改动，结构提取可以。
 *
 * 覆盖度闸门：`declared` 是 `provide: APP_GUARD` 的**声明条数**，必须等于解析到的条数——
 * 将来新增 useFactory / useExisting 形态的全局守卫时计数会对不上而**红**（强制显式登记），
 * 而不是被静默漏掉。
 */
function extractAppGuardOrder(): { guards: string[]; declared: number } {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.module.ts'), 'utf-8');
  // 去掉整行注释（`*` / `//` / `/*` 开头），避免注释里的 `provide: APP_GUARD` 被计入
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');

  const declared = (code.match(/provide:\s*APP_GUARD\b/g) ?? []).length;
  const guards = [...code.matchAll(/provide:\s*APP_GUARD\s*,\s*useClass:\s*([A-Za-z_$][\w$]*)/g)].map(
    (m) => m[1],
  );
  return { guards, declared };
}

describe('recall 双桶限流（F4 项3）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        // 桶声明**必须与 app.module.ts 同形**（default 在前、actor 在后）：
        // guard 的 onModuleInit 只迭代这里声明的桶；迭代序 = 模块级 ttl 升序、ttl 相等
        // 时保持声明序（两桶同为 60s ⇒ 等于声明序，default 先抛）。
        ThrottlerModule.forRoot([
          { ttl: TTL_MS, limit: GLOBAL_LIMIT },
          { name: 'actor', ttl: TTL_MS, limit: GLOBAL_LIMIT },
        ]),
      ],
      controllers: [RecallThrottleProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = module.createNestApplication();
    // 身份装配中间件：把请求头映射成真实守卫会挂上的 request.agent / request.user
    app.use((req: unknown, _res: unknown, next: () => void) => {
      const r = req as ProbeIdentity & { headers: Record<string, string | undefined> };
      const agentId = r.headers['x-test-agent'];
      if (typeof agentId === 'string' && agentId.length > 0) r.agent = { id: agentId };
      const userId = r.headers['x-test-user'];
      if (typeof userId === 'string' && userId.length > 0) r.user = { userId };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('同一 agent 超过 actor 桶配额 → 429，且头带 -actor 后缀（default 桶通过时不带标准 Retry-After）', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) => request(server).post('/recall-throttle-probe/both-tight').set('X-Test-Agent', id);

    // IP 桶 3 / actor 桶 2：前 2 次两桶都过
    await asAgent('agent-A').expect(200);
    await asAgent('agent-A').expect(200);

    // 第 3 次：IP 桶 3/3 仍通过（3 > 3 为假），actor 桶 3 > 2 抛 —— 只有 -actor 后缀的 Retry-After
    const blocked = await asAgent('agent-A').expect(429);
    expect(blocked.headers['retry-after-actor']).toBeDefined();
    expect(blocked.headers['retry-after']).toBeUndefined();
    // 框架形态（throttler.guard.js:106-114 handleRequest）：**超限即抛，抛在写计数头之前**，
    // 故 429 只带 `Retry-After[-name]`；计数头只在放行响应上出现（见下一个用例对 200 的断言）。
    // 但 actor 桶抛之前 default 桶已放行并写过计数头 ⇒ 本响应里**仍会带 default 的 X-RateLimit-***：
    // 那是 **IP 桶的数字，不代表 IP 桶超限**（复审 MAJOR-1 钉死：别把它读成"两桶都超了"）。
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-limit-actor']).toBeUndefined();
  });

  it('两桶同时超限 → default(IP) 先抛（桶按模块 ttl 升序迭代，相等 ttl 即声明序），该响应不含任何计数头', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) => request(server).post('/recall-throttle-probe/both-tight').set('X-Test-Agent', id);

    // 承接上一个用例的计数（同 handler = 同计数空间）：IP 已 3/3、actor 已 3/2
    const blocked = await asAgent('agent-A').expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // 循环在 default 桶就抛出，actor 桶根本没被 increment ⇒ 无 -actor 后缀头
    expect(blocked.headers['retry-after-actor']).toBeUndefined();
    // 且 default 也在写计数头之前抛 ⇒ 本响应连标准 X-RateLimit-* 都没有
    // （"计数头只在放行响应出现"的另一半证据）
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined();
    expect(blocked.headers['x-ratelimit-limit-actor']).toBeUndefined();
  });

  it('不同 agent 各自独立配额（actor 桶按身份分桶，互不挤占）', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) => request(server).post('/recall-throttle-probe/actor-isolation').set('X-Test-Agent', id);

    await asAgent('agent-X').expect(200);
    // 放行响应上两桶的计数头都在，且 actor 桶的头带 -actor 后缀（default 桶是标准头）
    const first = await asAgent('agent-X').expect(200);
    expect(first.headers['x-ratelimit-limit-actor']).toBe('2');
    expect(first.headers['x-ratelimit-remaining-actor']).toBe('0');
    expect(first.headers['x-ratelimit-limit']).toBe(String(WIDE));
    await asAgent('agent-X').expect(429);

    // 同一 IP、同一 route，但换了身份 → 自己的 2 次配额完好
    await asAgent('agent-Y').expect(200);
    await asAgent('agent-Y').expect(200);
    await asAgent('agent-Y').expect(429);
  });

  it('人类 JWT 通道按 request.user.userId 分桶（写成 user.id 会退化成 IP 兜底）', async () => {
    const server = app.getHttpServer();
    const asUser = (id: string) => request(server).post('/recall-throttle-probe/user-channel').set('X-Test-User', id);

    await asUser('user-1').expect(200);
    await asUser('user-1').expect(200);
    await asUser('user-1').expect(429);

    await asUser('user-2').expect(200);
    await asUser('user-2').expect(200);
    await asUser('user-2').expect(429);
  });

  it('无身份（agent/user 都缺）→ tracker 落 IP 兜底，仍受限流约束', async () => {
    const server = app.getHttpServer();
    const anonymous = () => request(server).post('/recall-throttle-probe/no-identity');

    await anonymous().expect(200);
    await anonymous().expect(200);
    const blocked = await anonymous().expect(429);
    // 无身份时只有 default 桶会超限 → 标准头
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('IP 桶跨身份合计计数（双桶独立：各 agent 远未用满自身配额也照样被拦）', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) => request(server).post('/recall-throttle-probe/shared-ip').set('X-Test-Agent', id);

    // IP 桶 3 / actor 桶 1000：两个 agent 各 2 次 → 各自配额无压力
    await asAgent('agent-P').expect(200);
    await asAgent('agent-P').expect(200);
    await asAgent('agent-Q').expect(200);

    // 第 4 次：IP 桶 4 > 3 → 429（身份桶只记到 2 与 1，完全没逼近）
    const blocked = await asAgent('agent-Q').expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('真 recall 端点：双桶元数据已接线（LIMIT/TTL/TRACKER × default/actor）', () => {
    const handler = MemoryController.prototype.recall;

    // 测试环境放宽到 100_000（memory e2e 22 处 recall 靠它不被误伤）——
    // 断言具体值可同时守住"放宽确实接线了"与"元数据确实来自 @Throttle"
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(RELAXED_LIMIT);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(TTL_MS);
    expect(Reflect.getMetadata('THROTTLER:LIMITactor', handler)).toBe(RELAXED_LIMIT);
    expect(Reflect.getMetadata('THROTTLER:TTLactor', handler)).toBe(TTL_MS);
    // actor 桶的身份 tracker 必须是 actorTracker（而不是退回 ip）
    expect(Reflect.getMetadata('THROTTLER:TRACKERactor', handler)).toBe(actorTracker);
    expect(Reflect.getMetadata('THROTTLER:TRACKERdefault', handler)).toBeUndefined();
  });

  it('生产默认阈值与 forRoot 桶声明被源码钉住（放宽/删声明都会静默失效，必须红）', () => {
    // 为什么扫源码：两处失效都是**静默**的——① 删掉 app.module 的 actor 条目 ⇒ guard 不迭代
    // 该桶 ⇒ @Throttle({actor}) 变死元数据、限流消失；② 改掉 env 名/默认值 ⇒ 生产配额漂移
    // 而测试（isTestEnv 放宽）永远看不见。这两条只能靠文本锚点守。
    // ⚠️ 文本锚点只保证"字样还在"，**数字本身由下一个用例实读**（三元写反仍会过文本锚点）。
    const controllerSrc = fs.readFileSync(path.join(__dirname, 'memory.controller.ts'), 'utf-8');
    expect(controllerSrc).toContain("process.env.MEMORY_RECALL_IP_THROTTLE_LIMIT || '300'");
    expect(controllerSrc).toContain("process.env.MEMORY_RECALL_THROTTLE_LIMIT || '30'");

    const appModuleSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app.module.ts'),
      'utf-8',
    );
    expect(appModuleSrc).toMatch(/\{\s*name:\s*'actor',\s*ttl:\s*60_000,\s*limit:\s*100_000\s*\}/);
  });

  it('生产默认阈值实读 = IP 300 / actor 30（isolateModules + NODE_ENV=production 穿透 isTestEnv 遮蔽）', () => {
    // 为什么必须实读（复审 MINOR-1）：测试环境把两个阈值都放宽成 100000，普通断言只能证明
    // "是个正数"——真实阈值 300/30 会在无人察觉时漂移（文本锚点也拦不住三元写反）。
    // 手法照 apps/backend/src/health/health.controller.spec.ts:282-318 的既定先例：临时切
    // 环境变量为生产形态 + isolateModules 重载控制器模块，让模块级常量走生产分支求值。
    const prevNodeEnv = process.env.NODE_ENV;
    const prevWorkerId = process.env.JEST_WORKER_ID;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;

      let ipLimit: unknown;
      let actorLimit: unknown;
      let actorTtl: unknown;
      jest.isolateModules(() => {
        const isolated =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./memory.controller') as typeof import('./memory.controller');
        ipLimit = Reflect.getMetadata('THROTTLER:LIMITdefault', isolated.MemoryController.prototype.recall);
        actorLimit = Reflect.getMetadata('THROTTLER:LIMITactor', isolated.MemoryController.prototype.recall);
        actorTtl = Reflect.getMetadata('THROTTLER:TTLactor', isolated.MemoryController.prototype.recall);
      });

      // 生产默认（env 逃生口未设置时）：IP 拦洪 300/min、身份 30/min（S-N3 / 峰值 2 次/分钟实测）
      expect(ipLimit).toBe(300);
      expect(actorLimit).toBe(30);
      expect(actorTtl).toBe(TTL_MS);
    } finally {
      // 环境变量原样还原（同文件其他用例与 jest 自身都可能读 JEST_WORKER_ID）
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = prevWorkerId;
    }
  });

  it('APP_GUARD 位次：身份装配守卫必须排在 ThrottlerGuard 之前（倒退 = actor 桶静默退化为 IP 桶）', () => {
    // 复审 MAJOR-2：actor 桶的 tracker 读 `request.agent` / `request.user`，而两者只在守卫里
    // 装配（生产序 = JwtAuthGuard → ApiKeyScopeGuard → ThrottlerGuard）。若 ThrottlerGuard 被
    // 前移，限流时身份尚未装配 ⇒ tracker 落 IP ⇒ **actor 桶 = 第二个 IP 桶**（30/min/IP，
    // automcp 双实例共享配额）：限流照跑、全部单测/e2e 全绿（它们不 boot AppModule），
    // 静默降级。故位次必须被机器钉住。
    const { guards, declared } = extractAppGuardOrder();

    // 覆盖度闸门：声明条数必须全部被解析到（新增 useFactory 形态的全局守卫 ⇒ 计数不符 ⇒ 红）
    expect(guards).toHaveLength(declared);

    const throttlerIndex = guards.indexOf('ThrottlerGuard');
    const identityIndex = guards.indexOf('JwtAuthGuard');
    expect(throttlerIndex).toBeGreaterThan(-1);
    expect(identityIndex).toBeGreaterThan(-1);
    expect(identityIndex).toBeLessThan(throttlerIndex);

    // 完整序（新增/重排全局守卫都必须显式更新本断言，而不是悄悄改变语义）
    expect(guards).toEqual(['JwtAuthGuard', 'ApiKeyScopeGuard', 'ThrottlerGuard']);
  });
});
