/**
 * `hument-provisioning.client` 单测（三步链 + 202 推进 + never-throw 联合）。
 *
 * 设计意图：这是二期「建项目自动注册 Hub」的**唯一联网点**，七件事必须钉死：
 * ① **三步链的装配**（socket 单行 JSON / bootstrap 的 Origin+Sec-Fetch-Site / 注册的 11 字段 +
 *    幂等键 + Cookie）——少一个字段或漏一个头就是 400/403，而失败文案不告诉你缺什么；
 * ② **Origin 形态**（scheme+host、**无尾斜杠**）：operator 面严格校验，尾斜杠即 403；
 *    畸形 baseUrl 必须在**构造期**变成可处置的配置错误（评审 S-5）；
 * ③ **读回不带 Origin、禁 query**（合同明文）；
 * ④ **cookie 每次现取现换**（不缓存）：每次 provision 都必须先走一遍 socket+bootstrap，
 *    且 202 重投用的是**新换的那一枚**（评审 S-7②：抓"旧 cookie 误用"）；
 * ⑤ **202 的确定性分叉**：`state=disabled` 立即失败、读回 `active` 才成功、未收敛才算失败；
 * ⑥ **`mayHaveLanded` 语义**：只在观测到过 202 之后的**无定论**失败上置位（评审 S-4）；
 * ⑦ **never-throw 联合**：socket 错/超时、fetch 抛错/超时、非 2xx、体破损各自落到固定分类。
 *
 * 传输面分两层测：`exchangeOverUnixSocket` 用**真的** Unix socket（`net.createServer` +
 * 临时目录，评审 S-7①），HTTP 面沿 `hument.engine.spec.ts` 的 `global.fetch` 替换模式；
 * `sleep` 恒为 no-op（不真等轮询间隔）。
 */
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HUMENT_LAUNCHER_OPERATION,
  HUMENT_LAUNCHER_SCHEMA_VERSION,
  HUMENT_OPERATOR_COOKIE_NAME,
  HUMENT_OPERATOR_ROUTES,
  HUMENT_OPERATOR_SOCKET_TIMEOUT_MS,
  HUMENT_PROJECT_STATES,
  HUMENT_PROVISIONING_DISABLE_TIMEOUT_MS,
  HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS,
  HUMENT_PROVISIONING_POLL_ATTEMPTS,
  HUMENT_PROVISIONING_POLL_INTERVAL_MS,
  HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  HumentProvisioningClient,
  HumentProvisioningConfigError,
  buildDisableIdempotencyKey,
  buildProvisioningBindingId,
  buildProvisioningCredentialRef,
  buildProvisioningIdempotencyKey,
  exchangeOverUnixSocket,
  resolveOperatorOrigin,
  type HumentProvisioningSettings,
} from './hument-provisioning.client';

/** 引擎设置（尾斜杠刻意留着——测端点规整与 Origin 取值；**不含超时/凭据 ref**见接口注释） */
const SETTINGS: HumentProvisioningSettings = {
  baseUrl: 'http://hub.local:8099/',
  operatorSocketPath: '/tmp/hument-control.sock',
  operatorBindingId: 'binding-ops-chamber',
  tenantId: 'chamber',
};

const SLUG = 'prov-walk-01';

/** launcher 成功响应（socket 一行 JSON） */
function launcherOk(code = 'code-1'): string {
  return JSON.stringify({
    schema_version: HUMENT_LAUNCHER_SCHEMA_VERSION,
    workbench_url: 'http://hub.local:8099/workbench',
    code,
    expires_in_seconds: 120,
  });
}

/** 造一个 fetch 响应替身（只需 ok/status/headers/text 四项） */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; rawText?: string } = {},
): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async () => (init.rawText !== undefined ? init.rawText : JSON.stringify(body)),
  } as unknown as Response;
}

/** bootstrap 成功响应（带 operator session cookie） */
function bootstrapOk(cookie = 'sess-1'): Response {
  return jsonResponse(
    { schema_version: 'hument-operator-v1' },
    {
      status: 200,
      headers: { 'set-cookie': `${HUMENT_OPERATOR_COOKIE_NAME}=${cookie}; Path=/; HttpOnly` },
    },
  );
}

/** 注册成功的 echo 体（与请求一致——不一致的用例另行构造） */
function registerEcho(slug = SLUG): Record<string, unknown> {
  return {
    project_id: slug,
    workspace_id: slug,
    actor_id: 'chamber',
    binding_id: buildProvisioningBindingId(slug),
  };
}

/** 造被测客户端（transport / sleep 全部替身；fetch 由各用例塞进 global） */
function clientOf(
  transport: jest.Mock,
  sleep: jest.Mock = jest.fn(async () => undefined),
): HumentProvisioningClient {
  return new HumentProvisioningClient(SETTINGS, transport, sleep as unknown as (ms: number) => Promise<void>);
}

describe('HumentProvisioningClient', () => {
  const ORIGINAL_FETCH = global.fetch;
  let fetchMock: jest.Mock;

  /** 装配 fetch：按 URL+method 分派的替身（返回 Response 或抛错） */
  function installFetch(
    stub: (url: string, method: string, init: RequestInit) => Response | Error,
  ): void {
    fetchMock = jest.fn(async (url: string, init: RequestInit) => {
      const result = stub(url, String(init.method), init);
      if (result instanceof Error) throw result;
      return result;
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  }

  /** 取第 n 次 fetch 调用的 URL / method / headers / body */
  function callAt(index = 0): {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
  } {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return {
      url,
      method: String(init.method),
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    };
  }

  /** 取所有注册 POST 的幂等键 / Cookie（按调用顺序） */
  function registerCalls(): Array<{ key: string | null; cookie: string | null }> {
    return fetchMock.mock.calls
      .filter(([, init]) => String((init as RequestInit).method) === 'POST')
      .filter(([url]) => !String(url).endsWith(HUMENT_OPERATOR_ROUTES.bootstrap))
      .map(([, init]) => {
        const headers = new Headers((init as RequestInit).headers);
        return { key: headers.get('Idempotency-Key'), cookie: headers.get('Cookie') };
      });
  }

  /** 只回注册 201/200 的替身（bootstrap 恒成功） */
  function onlyRegister(
    status: number,
    body: unknown,
  ): (url: string, method: string) => Response {
    return (url: string, method: string) =>
      method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
        ? bootstrapOk()
        : jsonResponse(body, { status });
  }

  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  });

  it('路由与派生常量单源（幂等键 / binding_id / 阶段预算 / 总墙钟 / Hub 注册态）', () => {
    expect(HUMENT_OPERATOR_ROUTES).toEqual({
      bootstrap: '/v1/operator/bootstrap',
      projects: '/v1/operator/projects',
    });
    expect(HUMENT_LAUNCHER_SCHEMA_VERSION).toBe('hument-launcher-v1');
    expect(HUMENT_LAUNCHER_OPERATION).toBe('issue_operator_bootstrap');
    expect(buildProvisioningIdempotencyKey('ws-1')).toBe('chamber-provision-ws-1');
    expect(buildProvisioningBindingId('ws-1')).toBe('binding-http-ws-1');
    // Hub 合同的注册态字面量（改这里 = 跟着 Hub 合同改，别在比较处写裸字面量）
    expect(HUMENT_PROJECT_STATES).toEqual({ ACTIVE: 'active', DISABLED: 'disabled' });
    // 评审 S-1：operator 面有自己的阶段预算，**不复用引擎的 90000ms**
    expect(HUMENT_OPERATOR_SOCKET_TIMEOUT_MS).toBe(5000);
    expect(HUMENT_PROVISIONING_POLL_ATTEMPTS).toBe(3);
    expect(HUMENT_PROVISIONING_POLL_INTERVAL_MS).toBe(2000);
    expect(HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS).toBe(120000);
  });

  describe('构造期 Origin 闸门（评审 S-5）', () => {
    it('合法端点 ⇒ scheme+host（无尾斜杠、无路径）', () => {
      expect(resolveOperatorOrigin('http://hub.local:8099')).toBe('http://hub.local:8099');
      expect(resolveOperatorOrigin('http://hub.local:8099/')).toBe('http://hub.local:8099');
      expect(resolveOperatorOrigin('https://hub.example.com')).toBe('https://hub.example.com');
    });

    it('畸形端点逐一拒装配（且**不把 env 原值写进 reason**）', () => {
      const cases = ['http://', 'hub:8099', 'http://hub.local:8099/v1', 'not a url', ''];
      for (const baseUrl of cases) {
        expect(() => resolveOperatorOrigin(baseUrl)).toThrow(HumentProvisioningConfigError);
        try {
          resolveOperatorOrigin(baseUrl);
        } catch (err: unknown) {
          const reason = (err as HumentProvisioningConfigError).reason;
          // 只出现键名与形态描述——值可能是带 userinfo 的 URL
          expect(reason).toContain('HUMENT_BASE_URL');
          if (baseUrl) expect(reason).not.toContain(baseUrl);
        }
      }
    });

    it('客户端构造函数拒绝畸形 baseUrl（不是运行期裸 TypeError）', () => {
      expect(
        () => new HumentProvisioningClient({ ...SETTINGS, baseUrl: 'http://' }),
      ).toThrow(HumentProvisioningConfigError);
      expect(
        () => new HumentProvisioningClient({ ...SETTINGS, baseUrl: 'hub:8099' }),
      ).toThrow(HumentProvisioningConfigError);
    });
  });

  describe('三步链（socket → bootstrap → register）', () => {
    it('201 直出：socket 请求形状 + bootstrap 头 + 注册 11 字段/幂等键/Cookie + 派生三键', async () => {
      const transport = jest.fn(async () => launcherOk('code-42'));
      installFetch(onlyRegister(201, registerEcho()));
      const client = clientOf(transport);

      const result = await client.provision(SLUG);

      // ① socket：单行 JSON + 尾换行 + 固定 schema/operation/binding_id + 5s 硬顶
      expect(transport).toHaveBeenCalledTimes(1);
      const [socketPath, request, timeoutMs] = transport.mock.calls[0] as unknown as [
        string,
        string,
        number,
      ];
      expect(socketPath).toBe('/tmp/hument-control.sock');
      expect(timeoutMs).toBe(HUMENT_OPERATOR_SOCKET_TIMEOUT_MS);
      expect(request.endsWith('\n')).toBe(true);
      expect(JSON.parse(request)).toEqual({
        schema_version: HUMENT_LAUNCHER_SCHEMA_VERSION,
        operation: HUMENT_LAUNCHER_OPERATION,
        binding_id: 'binding-ops-chamber',
      });

      // ② bootstrap：POST + Origin（scheme+host，**无尾斜杠**）+ Sec-Fetch-Site + {code}
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const bootstrap = callAt(0);
      expect(bootstrap.url).toBe('http://hub.local:8099/v1/operator/bootstrap');
      expect(bootstrap.method).toBe('POST');
      expect(bootstrap.headers.get('Content-Type')).toBe('application/json');
      expect(bootstrap.headers.get('Origin')).toBe('http://hub.local:8099');
      expect(bootstrap.headers.get('Sec-Fetch-Site')).toBe('same-origin');
      expect(bootstrap.body).toEqual({ code: 'code-42' });

      // ③ 注册：11 字段逐字 + Cookie + 幂等键
      const register = callAt(1);
      expect(register.url).toBe('http://hub.local:8099/v1/operator/projects');
      expect(register.method).toBe('POST');
      expect(register.headers.get('Cookie')).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-1`);
      expect(register.headers.get('Idempotency-Key')).toBe(buildProvisioningIdempotencyKey(SLUG));
      expect(register.headers.get('Origin')).toBe('http://hub.local:8099');
      expect(register.headers.get('Sec-Fetch-Site')).toBe('same-origin');
      expect(register.body).toEqual({
        tenant_id: 'chamber',
        project_id: SLUG,
        workspace_id: SLUG,
        actor_id: 'chamber',
        // ⚠️ 按 slug **派生**（Hub 侧 credential_ref 是主键 ⇒ 与注册 1:1，见
        // buildProvisioningCredentialRef 注释）；不是配置值
        credential_ref: buildProvisioningCredentialRef(SLUG),
        binding_id: buildProvisioningBindingId(SLUG),
        adapter: 'neutral',
        grants: ['actor_private'],
        // 更正链的引擎侧门槛（缺 ⇒ correct 403 source_access_denied，见常量注释）
        capabilities: ['inspect_read', 'runtime_private_write'],
        formation_enabled: true,
        relation_advisory_enabled: false,
      });
      expect(buildProvisioningCredentialRef(SLUG)).toBe(`ref-${SLUG}`);
      // 11 字段**全必填**：多一个少一个都是合同破损
      expect(Object.keys(register.body as Record<string, unknown>)).toHaveLength(11);

      expect(result).toEqual({
        ok: true,
        value: {
          workspaceId: SLUG,
          actorId: 'chamber',
          credentialRef: `ref-${SLUG}`,
          replay: false,
        },
      });
    });

    it('credential_ref **逐项目唯一**：两个不同 slug 的注册各带自己的 ref（Hub 侧主键 1:1）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? bootstrapOk()
          : jsonResponse({}, { status: 201 }),
      );
      const client = clientOf(transport);

      const first = await client.provision('prov-one');
      const second = await client.provision('prov-two');

      expect(first.ok && first.value.credentialRef).toBe('ref-prov-one');
      expect(second.ok && second.value.credentialRef).toBe('ref-prov-two');
      const refs = fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith(HUMENT_OPERATOR_ROUTES.projects))
        .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { credential_ref: string }).credential_ref);
      expect(refs).toEqual(['ref-prov-one', 'ref-prov-two']);
      expect(new Set(refs).size).toBe(2);
    });

    it('200 = 重放（replay=true）；且**每次 provision 都重新取 code + 换 cookie**（不缓存）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(onlyRegister(200, { ...registerEcho(), replay: true }));
      const client = clientOf(transport);

      const first = await client.provision(SLUG);
      const second = await client.provision(SLUG);

      expect(first.ok && first.value.replay).toBe(true);
      expect(second.ok && second.value.replay).toBe(true);
      // 两次 provision = 两次 socket + 两次 bootstrap + 两次注册（cookie 绝不跨调用复用）
      expect(transport).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('set-cookie 多条时只挑 operator session（`getSetCookie` 路径）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? jsonResponse(
              {},
              {
                status: 200,
                headers: {
                  'set-cookie': `csrf=abc; Path=/, ${HUMENT_OPERATOR_COOKIE_NAME}=sess-9; Path=/`,
                },
              },
            )
          : jsonResponse(registerEcho(), { status: 201 }),
      );

      await clientOf(transport).provision(SLUG);

      expect(callAt(1).headers.get('Cookie')).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-9`);
    });

    it('cookie 名必须锚定：`x-hument_operator_session=evil` **不**被当成通行证', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? jsonResponse(
              {},
              {
                status: 200,
                headers: { 'set-cookie': `x-hument_operator_session=evil; Path=/` },
              },
            )
          : jsonResponse(registerEcho(), { status: 201 }),
      );

      const result = await clientOf(transport).provision(SLUG);

      // 只有后缀伪装 ⇒ 解析不到 cookie ⇒ invalid_response（绝不带 evil 去注册）
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('invalid_response');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('echo 与请求不一致 ⇒ invalid_response（绝不落库一个指不回 Hub 那行的映射，N-8）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(onlyRegister(201, { ...registerEcho(), workspace_id: 'someone-elses-ws' }));

      const result = await clientOf(transport).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('invalid_response');
        expect(result.failure.message).toContain('echo');
        // 有定论（Hub 明确回了别的 workspace）⇒ 不置 mayHaveLanded（重试不会变）
        expect(result.failure.mayHaveLanded).toBeUndefined();
      }
    });

    it('echo 字段缺席**不**判失败（只判"回了但不一致"）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(onlyRegister(201, { schema_version: 'hument-operator-v1' }));

      const result = await clientOf(transport).provision(SLUG);

      expect(result.ok).toBe(true);
    });

    it('`displayName` 给了 ⇒ 注册体带 **trim 后**的 `display_name`（第 12 个**可选**键）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(onlyRegister(201, registerEcho()));

      await clientOf(transport).provision(SLUG, '  走查样本  ');

      const register = callAt(1);
      expect((register.body as Record<string, unknown>).display_name).toBe('走查样本');
      // 原 11 必填字段 + display_name
      expect(Object.keys(register.body as Record<string, unknown>)).toHaveLength(12);
    });

    it('`displayName` 省略 / 空白串 ⇒ 体中**不出现** `display_name`（Hub 默认取 workspace_id）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(onlyRegister(201, registerEcho()));
      const client = clientOf(transport);

      await client.provision(SLUG);
      await client.provision(SLUG, '   ');

      // 每次 provision = bootstrap(偶) + register(奇)；两次注册体都必须是**11 键**（无该键）
      for (const index of [1, 3]) {
        const register = callAt(index);
        expect(register.body).not.toHaveProperty('display_name');
        expect(Object.keys(register.body as Record<string, unknown>)).toHaveLength(11);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 孤儿 workspace 善后：disableProject（alpha.4 FEEDBACK-11）
  // ══════════════════════════════════════════════════════════════════════
  describe('disableProject（孤儿 workspace 善后）', () => {
    /** bootstrap 恒成功；其余请求回给定状态码与体（生命周期 PATCH） */
    function onlyLifecycle(status: number, body: unknown): (url: string, method: string) => Response {
      return (url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? bootstrapOk()
          : jsonResponse(body, { status });
    }

    it('200 + state=disabled ⇒ ok；URL/头/幂等键/体逐条核（**禁用链只带 state**）', async () => {
      const transport = jest.fn(async () => launcherOk('code-9'));
      installFetch(onlyLifecycle(200, { state: 'disabled', replay: false }));
      const client = clientOf(transport);

      const result = await client.disableProject(SLUG);

      expect(result).toEqual({ ok: true, value: { state: 'disabled', replay: false } });
      // 每次善后都现取现换一枚 cookie（同 provision 纪律：绝不缓存）
      expect(transport).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const patch = callAt(1);
      expect(patch.method).toBe('PATCH');
      expect(patch.url).toBe(`http://hub.local:8099/v1/operator/projects/chamber/${SLUG}`);
      expect(patch.headers.get('Content-Type')).toBe('application/json');
      expect(patch.headers.get('Origin')).toBe('http://hub.local:8099');
      expect(patch.headers.get('Sec-Fetch-Site')).toBe('same-origin');
      expect(patch.headers.get('Cookie')).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-1`);
      expect(patch.headers.get('Idempotency-Key')).toBe(buildDisableIdempotencyKey(SLUG));
      expect(buildDisableIdempotencyKey(SLUG)).toBe(`chamber-disable-${SLUG}`);
      // body 只有 state（合同 additionalProperties:false）：**绝不**把注册体那 11 字段带过来
      expect(patch.body).toEqual({ state: HUMENT_PROJECT_STATES.DISABLED });
      expect(Object.keys(patch.body as Record<string, unknown>)).toEqual(['state']);
    });

    it('200 + replay:true（同 key 的**历史 receipt**）⇒ 同样判 ok', async () => {
      // ⚠️ 语义（文件头）：replay 只代表"该 key 的命令已落地为 disabled"，
      // **不代表项目当前实时状态**（旧 key 重放不改当前状态）——本客户端只判"这条命令的落地"。
      installFetch(onlyLifecycle(200, { state: 'disabled', replay: true }));

      const result = await clientOf(jest.fn(async () => launcherOk())).disableProject(SLUG);

      expect(result).toEqual({ ok: true, value: { state: 'disabled', replay: true } });
    });

    it('非 2xx（409 preparing / 202 未定论）⇒ http 失败带状态码与标量', async () => {
      installFetch(
        onlyLifecycle(409, { error: { code: 'conflict', retryable: false, request_id: 'req-d' } }),
      );
      const conflict = await clientOf(jest.fn(async () => launcherOk())).disableProject(SLUG);

      expect(conflict.ok).toBe(false);
      if (!conflict.ok) {
        expect(conflict.failure.kind).toBe('http');
        expect(conflict.failure.httpStatus).toBe(409);
        expect(conflict.failure.engineCode).toBe('conflict');
        expect(conflict.failure.retryable).toBe(false);
        expect(conflict.failure.requestId).toBe('req-d');
      }

      // 202（2xx 但非 200）= 命令未定论 ⇒ 同样按 http 分类（**不**判善后成功）
      installFetch(onlyLifecycle(202, { state: 'preparing' }));
      const pending = await clientOf(jest.fn(async () => launcherOk())).disableProject(SLUG);
      expect(pending.ok).toBe(false);
      if (!pending.ok) {
        expect(pending.failure.kind).toBe('http');
        expect(pending.failure.httpStatus).toBe(202);
      }
    });

    it('200 但 state 不是 disabled（或字段缺席）⇒ invalid_response（绝不谎报善后成功）', async () => {
      for (const body of [{ state: 'active', replay: false }, { replay: true }]) {
        installFetch(onlyLifecycle(200, body));
        const result = await clientOf(jest.fn(async () => launcherOk())).disableProject(SLUG);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.kind).toBe('invalid_response');
      }
    });

    it('socket 不可达 ⇒ unreachable 且 **never-throw**（零 HTTP 调用）', async () => {
      const transport = jest.fn(async () => Promise.reject(new Error('ENOENT')));
      installFetch(() => jsonResponse({}));

      const result = await clientOf(transport).disableProject(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('unreachable');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('善后有**独立墙钟与 PATCH 硬顶**（刻意不复用 provision 的 120s，且收紧到 30s）', () => {
      expect(HUMENT_PROVISIONING_DISABLE_TIMEOUT_MS).toBe(10000);
      expect(HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS).toBe(30000);
      // socket 5s + bootstrap 15s + PATCH 10s = 30s **正好顶满**（S-2：不留余量）
      expect(HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS).toBeLessThan(
        HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
      );
    });

    it('换 cookie 期间墙钟耗尽 ⇒ **PATCH 一步不发**（预算前置检查），归 timeout/deadline（NIT-1/4）', async () => {
      // 假时钟：socket 取 code 期间时间停在 0（各阶段预算检查都通过），换 cookie（bootstrap）
      // 之后把时钟推过总墙钟 ⇒ disableProject 的 PATCH 前置检查必须拦下
      let now = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        installFetch((url: string, method: string) => {
          if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) {
            now = HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS + 1000;
            return bootstrapOk();
          }
          return jsonResponse({ state: 'disabled', replay: false });
        });

        const result = await clientOf(jest.fn(async () => launcherOk())).disableProject(SLUG);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.kind).toBe('timeout');
          expect(result.failure.message).toContain('lifecycle-command');
          // 假时钟下 latency 可精确断言（= 越过墙钟的那一刻 - 起点），不再是恒真的 >=0
          expect(result.failure.latencyMs).toBe(HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS + 1000);
        }
        // 只发了 bootstrap；PATCH **一次都没发**（预算耗尽就不再发起该阶段请求）
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('202 半成品态（决策 6：有界读回 → 同 key 重投 → 再不成即失败）', () => {
    it('读回 state=active ⇒ 成功；GET **不带 Origin、禁 query**', async () => {
      const transport = jest.fn(async () => launcherOk());
      let registerCalls = 0;
      installFetch((url: string, method: string) => {
        if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) return bootstrapOk();
        if (method === 'POST') {
          registerCalls += 1;
          return jsonResponse({ state: 'preparing' }, { status: 202 });
        }
        return jsonResponse({ state: 'active' }, { status: 200 });
      });
      const sleep = jest.fn(async () => undefined);
      const client = clientOf(transport, sleep);

      const result = await client.provision(SLUG);

      expect(result.ok).toBe(true);
      expect(registerCalls).toBe(1);
      // 有界读回：一次（第二次前就 active 了）
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(HUMENT_PROVISIONING_POLL_INTERVAL_MS);

      const get = callAt(2);
      expect(get.method).toBe('GET');
      expect(get.url).toBe(`http://hub.local:8099/v1/operator/projects/chamber/${SLUG}`);
      expect(get.url).not.toContain('?');
      expect(get.headers.get('Origin')).toBeNull();
      expect(get.headers.get('Sec-Fetch-Site')).toBe('same-origin');
      expect(get.headers.get('Cookie')).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-1`);
    });

    it('读回 state=disabled ⇒ **立即失败**（不轮询、不重投）且带出 error_code', async () => {
      const transport = jest.fn(async () => launcherOk());
      let registerCalls = 0;
      installFetch((url: string, method: string) => {
        if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) return bootstrapOk();
        if (method === 'POST') {
          registerCalls += 1;
          return jsonResponse({ state: 'preparing' }, { status: 202 });
        }
        return jsonResponse({ state: 'disabled', error_code: 'project_disabled' }, { status: 200 });
      });
      const sleep = jest.fn(async () => undefined);

      const result = await clientOf(transport, sleep).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.message).toContain('DISABLED');
        expect(result.failure.engineCode).toBe('project_disabled');
        // 确定性结论 ⇒ 不 hedge（重试不会改变"被禁用"）
        expect(result.failure.mayHaveLanded).toBeUndefined();
      }
      // 只轮询了一次就下结论；没有重投；没有第二次 socket
      expect(registerCalls).toBe(1);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it('**202 体**直接回 state=disabled ⇒ 连读回都不做', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? bootstrapOk()
          : jsonResponse({ state: 'disabled', error_code: 'project_disabled' }, { status: 202 }),
      );
      const sleep = jest.fn(async () => undefined);

      const result = await clientOf(transport, sleep).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.engineCode).toBe('project_disabled');
      }
      expect(sleep).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2); // bootstrap + register，无 GET、无重投
    });

    it('读回始终 preparing ⇒ **同幂等键**重投一次；重投用**新换的 cookie**（S-7②）', async () => {
      const transport = jest.fn(async () => launcherOk());
      let bootstrapCalls = 0;
      let registerPosts = 0;
      installFetch((url: string, method: string) => {
        if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) {
          bootstrapCalls += 1;
          return bootstrapOk(`sess-${bootstrapCalls}`);
        }
        if (method === 'POST') {
          registerPosts += 1;
          return registerPosts === 1
            ? jsonResponse({ state: 'preparing' }, { status: 202 })
            : jsonResponse(registerEcho(), { status: 201 });
        }
        return jsonResponse({ state: 'preparing' }, { status: 200 });
      });
      const sleep = jest.fn(async () => undefined);
      const client = clientOf(transport, sleep);

      const result = await client.provision(SLUG);

      expect(result.ok).toBe(true);
      // 有界轮询跑满 3 次才重投（不无限等）
      expect(sleep).toHaveBeenCalledTimes(HUMENT_PROVISIONING_POLL_ATTEMPTS);
      expect(registerPosts).toBe(2);
      // 两次注册**同一个幂等键**，但 Cookie 是**两枚不同的**（重投前重新换了一枚）
      const registers = registerCalls();
      expect(registers.map((call) => call.key)).toEqual([
        buildProvisioningIdempotencyKey(SLUG),
        buildProvisioningIdempotencyKey(SLUG),
      ]);
      expect(registers[0].cookie).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-1`);
      expect(registers[1].cookie).toBe(`${HUMENT_OPERATOR_COOKIE_NAME}=sess-2`);
      // 第二次 socket 也真的跑了（重换 cookie 走完整两步链）
      expect(transport).toHaveBeenCalledTimes(2);
    });

    it('读回始终 preparing 且重投仍 202 ⇒ 失败（invalid_response + mayHaveLanded）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? bootstrapOk()
          : jsonResponse({ state: 'preparing' }, { status: 202 }),
      );
      const sleep = jest.fn(async () => undefined);

      const result = await clientOf(transport, sleep).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('invalid_response');
        expect(result.failure.message).toContain('unknown');
        expect(result.failure.mayHaveLanded).toBe(true);
        expect(result.failure.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('重投回 **非 202 的 4xx/5xx** ⇒ 按 http 分类并带出标量（S-3：不再谎称"停在 preparing"）', async () => {
      const transport = jest.fn(async () => launcherOk());
      let registerCalls = 0;
      installFetch((url: string, method: string) => {
        if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) return bootstrapOk();
        if (method === 'POST') {
          registerCalls += 1;
          return registerCalls === 1
            ? jsonResponse({ state: 'preparing' }, { status: 202 })
            : jsonResponse(
                { error: { code: 'conflict', retryable: false, request_id: 'req-9' } },
                { status: 409 },
              );
        }
        return jsonResponse({ state: 'preparing' }, { status: 200 });
      });
      const sleep = jest.fn(async () => undefined);

      const result = await clientOf(transport, sleep).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.httpStatus).toBe(409);
        expect(result.failure.engineCode).toBe('conflict');
        expect(result.failure.retryable).toBe(false);
        expect(result.failure.requestId).toBe('req-9');
        expect(result.failure.message).not.toContain('preparing');
        // 无定论（重投被拒，Hub 上可能已有半成品）⇒ hedge
        expect(result.failure.mayHaveLanded).toBe(true);
      }
    });

    it('读回 GET 失败 ⇒ **弃链不重投**，且失败带 mayHaveLanded', async () => {
      const transport = jest.fn(async () => launcherOk());
      let registerCalls = 0;
      installFetch((url: string, method: string) => {
        if (method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)) return bootstrapOk();
        if (method === 'POST') {
          registerCalls += 1;
          return jsonResponse({ state: 'preparing' }, { status: 202 });
        }
        return jsonResponse({ error: { code: 'overloaded' } }, { status: 503 });
      });
      const sleep = jest.fn(async () => undefined);

      const result = await clientOf(transport, sleep).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.httpStatus).toBe(503);
        expect(result.failure.engineCode).toBe('overloaded');
        expect(result.failure.mayHaveLanded).toBe(true);
      }
      expect(registerCalls).toBe(1); // 弃链：没有重投
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  describe('失败面（never-throw：一律落 {ok:false, failure}）', () => {
    it('socket 传输抛普通错误 ⇒ unreachable；抛 TimeoutError ⇒ timeout（都**不** hedge）', async () => {
      const unreachable = clientOf(jest.fn(async () => Promise.reject(new Error('ENOENT'))));
      installFetch(() => jsonResponse({}));
      const a = await unreachable.provision(SLUG);
      expect(a.ok).toBe(false);
      if (!a.ok) {
        expect(a.failure.kind).toBe('unreachable');
        expect(a.failure.mayHaveLanded).toBeUndefined();
      }

      const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const timeout = clientOf(jest.fn(async () => Promise.reject(timeoutErr)));
      const b = await timeout.provision(SLUG);
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.failure.kind).toBe('timeout');
        expect(b.failure.mayHaveLanded).toBeUndefined();
      }
      // socket 失败 ⇒ 零 HTTP 调用（fail-fast，不做无 code 的 bootstrap）
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('launcher 回 error 标量 ⇒ http + engineCode（原文不进日志/不进结果）', async () => {
      const transport = jest.fn(async () => JSON.stringify({ error: 'invalid_binding_id' }));
      installFetch(() => jsonResponse({}));

      const result = await clientOf(transport).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.engineCode).toBe('invalid_binding_id');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('launcher 回非 JSON / 缺 code ⇒ invalid_response', async () => {
      for (const raw of ['', 'not json', JSON.stringify({ schema_version: 'x' })]) {
        const transport = jest.fn(async () => raw);
        installFetch(() => jsonResponse({}));
        const result = await clientOf(transport).provision(SLUG);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.kind).toBe('invalid_response');
      }
    });

    it('bootstrap 401 ⇒ http 401 + 错误体标量（code/retryable/request_id 不丢）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(() =>
        jsonResponse(
          {
            error: {
              code: 'unauthenticated',
              message: 'nope',
              request_id: 'req-7',
              retryable: false,
            },
          },
          { status: 401 },
        ),
      );

      const result = await clientOf(transport).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.httpStatus).toBe(401);
        expect(result.failure.engineCode).toBe('unauthenticated');
        expect(result.failure.retryable).toBe(false);
        expect(result.failure.requestId).toBe('req-7');
      }
    });

    it('bootstrap 200 但无 session cookie ⇒ invalid_response（绝不带着无凭据继续注册）', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch(() => jsonResponse({}, { status: 200, headers: { 'set-cookie': 'csrf=x; Path=/' } }));

      const result = await clientOf(transport).provision(SLUG);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('invalid_response');
      // 只调了 bootstrap，没有注册调用
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('首次注册 409 / 503 ⇒ http + 状态码（服务层按 409 翻 conflict）；**不** hedge', async () => {
      for (const status of [409, 503]) {
        const transport = jest.fn(async () => launcherOk());
        installFetch(onlyRegister(status, { error: { code: 'conflict', retryable: false } }));
        const result = await clientOf(transport).provision(SLUG);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.kind).toBe('http');
          expect(result.failure.httpStatus).toBe(status);
          expect(result.failure.engineCode).toBe('conflict');
          // 从未见过 202 ⇒ 无定论标记不出现
          expect(result.failure.mayHaveLanded).toBeUndefined();
        }
      }
    });

    it('注册 2xx 但体破损 ⇒ invalid_response；fetch 抛错 ⇒ unreachable / timeout 分码', async () => {
      const transport = jest.fn(async () => launcherOk());
      installFetch((url: string, method: string) =>
        method === 'POST' && url.endsWith(HUMENT_OPERATOR_ROUTES.bootstrap)
          ? bootstrapOk()
          : jsonResponse(null, { status: 201, rawText: 'not json' }),
      );
      const broken = await clientOf(transport).provision(SLUG);
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.failure.kind).toBe('invalid_response');

      const netErr = Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
      const failing = clientOf(jest.fn(async () => launcherOk()));
      installFetch(() => netErr);
      const a = await failing.provision(SLUG);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.failure.kind).toBe('unreachable');

      const timeoutErr = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      const timingOut = clientOf(jest.fn(async () => launcherOk()));
      installFetch(() => timeoutErr);
      const b = await timingOut.provision(SLUG);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.failure.kind).toBe('timeout');
    });
  });
});

/**
 * 真 socket 传输的三态（评审 S-7①）。
 *
 * 用**真的** Unix socket（`net.createServer` + 临时目录）而不是替身：`exchangeOverUnixSocket`
 * 是唯一直接跟 launcher 说话的地方，半包拼装 / 对端硬关 / 永不回帧三条路径只有真连才测得到。
 */
describe('exchangeOverUnixSocket（真 Unix socket）', () => {
  let dir: string;
  let server: Server | null = null;
  let liveSockets: import('node:net').Socket[] = [];
  let socketPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hument-sock-'));
    socketPath = join(dir, 'hument-control.sock');
    liveSockets = [];
  });

  afterEach(async () => {
    // ⚠️ `allowHalfOpen` 下服务端 socket 会一直挂着（正是被测协议要的语义）⇒ 关服务器前
    // 必须先主动断掉活动连接，否则 `server.close()` 会等连接自然结束 = 挂死到 jest 超时
    for (const socket of liveSockets) socket.destroy();
    liveSockets = [];
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** 起一个假 launcher：handler 拿到完整请求（读到 EOF）后自行决定怎么回 */
  async function listen(handler: (socket: import('node:net').Socket, request: string) => void) {
    // ⚠️ `allowHalfOpen: true` 是**必须的**：客户端写完后半关（shutdown write），默认设置下
    // 服务端收到 FIN 会立刻回 FIN ⇒ 客户端看到空 `'end'`，整个"读完请求再回帧"的协议就不成立
    // （真 launcher 同样是这个语义）
    server = createServer({ allowHalfOpen: true }, (socket) => {
      liveSockets.push(socket);
      let request = '';
      socket.on('data', (chunk: Buffer) => {
        request += chunk.toString('utf8');
      });
      socket.on('end', () => handler(socket, request));
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  }

  it('成功：单行 JSON 往返（服务端读到 EOF 才回帧）', async () => {
    const response = launcherOk('code-real');
    await listen((socket, request) => {
      expect(request.endsWith('\n')).toBe(true);
      socket.end(response);
    });

    const raw = await exchangeOverUnixSocket(socketPath, '{"ping":1}\n', 2000);

    expect(JSON.parse(raw)).toEqual({
      schema_version: HUMENT_LAUNCHER_SCHEMA_VERSION,
      workbench_url: 'http://hub.local:8099/workbench',
      code: 'code-real',
      expires_in_seconds: 120,
    });
  });

  it('半包：分两片写、跨片切开一个多字节字符也能拼回原文', async () => {
    const response = JSON.stringify({ code: 'code-中文', note: '走查样本' });
    await listen((socket) => {
      // 逐字节切：多字节 UTF-8 字符必然被切在中间（setEncoding 负责拼装）
      const bytes = Buffer.from(response, 'utf8');
      const cut = Math.floor(bytes.length / 2);
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.end(bytes.subarray(cut)), 5);
    });

    const raw = await exchangeOverUnixSocket(socketPath, '{"ping":1}\n', 2000);

    expect(JSON.parse(raw)).toEqual({ code: 'code-中文', note: '走查样本' });
  });

  it('对端断开且不回帧 ⇒ 在硬顶内收口（空响应交上层判体破损），不等满超时', async () => {
    await listen((socket) => {
      // 请求已读完，服务端直接断开、不回帧。
      // ⚠️ Node 在"数据已读完"的 socket 上 `destroy()` 实际发的是 FIN（不是 RST），所以客户端
      // 这里走的是 `'end'` 收口（空响应 ⇒ 上层按体破损判 invalid_response）；`'close'` 兜底那条
      // 分支针对的是 RST-without-end（对端被 kill），在本机不容易稳定复现——本用例断言的是
      // **可观测契约**：收口不依赖硬顶，绝不白等满超时。
      socket.destroy();
    });
    const startedAt = Date.now();

    const raw = await exchangeOverUnixSocket(socketPath, '{"ping":1}\n', 5000);

    expect(raw).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('永不回帧 ⇒ 走超时判别（固定硬顶内收口）', async () => {
    await listen(() => {
      /* 收了请求，故意不回 */
    });

    await expect(exchangeOverUnixSocket(socketPath, '{"ping":1}\n', 60)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('路径不存在 ⇒ 连接层错误（ENOENT）', async () => {
    await expect(
      exchangeOverUnixSocket(join(dir, 'nope.sock'), '{"ping":1}\n', 500),
    ).rejects.toThrow();
  });
});
