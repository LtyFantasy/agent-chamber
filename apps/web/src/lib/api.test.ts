/**
 * Api.docs 懒加载目录树端点单测（v1.70.0-dev）
 *
 * 覆盖：getTree 双游标分页参数透传、getFacets 端点、getDocByPath ?path= 精确契约
 * （命中取首项 / 未命中 null）。此处 mock axios.create 控制 axiosInstance.request，
 * 验证请求形状（method/url/params）。
 */

/** 受控的 request mock（jest.mock 工厂仅允许引用 mock 前缀的外部变量） */
const mockRequest = jest.fn();
/**
 * 拦截器 use 留存（review-0831 任务 04e8d744：mock 前缀变量，用例从 mock.calls 拿 handler 手动调用）。
 * 必须 var 声明 + factory 内初始化：jest.mock 被 hoist 到 import 之前执行，而 api.ts 模块顶层
 * （import 期）即调用 axios.create + interceptors.use——若在文件正文 const 初始化，create 求值
 * interceptors 对象字面量时命中 TDZ（Cannot access before initialization）。
 */
// eslint-disable-next-line no-var -- TDZ 规避：jest.mock factory 早于模块体执行，let/const 必炸（见上方注释）
var mockRequestUse: jest.Mock;
// eslint-disable-next-line no-var -- 同上
var mockResponseUse: jest.Mock;

/**
 * mock axios：api.ts 模块顶层两次 axios.create 生成 axiosInstance / publicAxiosInstance，
 * 并经 instance.interceptors.*.use 注册拦截器——create 返回受控实例、拦截器注册用 stub 吞掉，
 * 请求行为完全由测试注入（apiRequest 解包 response.data.data）。
 */
jest.mock('axios', () => {
  // factory 在 hoist 后立即执行（早于 api.ts 模块体求值），此处初始化拦截器 mock
  mockRequestUse = jest.fn();
  mockResponseUse = jest.fn();
  return {
    __esModule: true,
    default: {
      create: () => ({
        // 惰性绑定：create 在 api.ts 模块导入期即被调用（早于下方 const 初始化），
        // 直接引用 mockRequest 会命中 TDZ——包一层函数，真正调用发生在测试运行期
        request: (...args: unknown[]) => mockRequest(...args),
        interceptors: {
          request: { use: mockRequestUse },
          response: { use: mockResponseUse },
        },
      }),
    },
  };
});

import { Api, setAuthHooks } from './api';

/** 从 listDocs 返回类型推导，fixture 与真实 DocSummary 保持同步，不硬编码形状 */
type PaginatedDocs = Awaited<ReturnType<typeof Api.docs.listDocs>>;
type DocSummary = PaginatedDocs['items'][number];

/** 构造最小 DocSummary（shared 契约仅 id/spaceId/path/title 必填） */
const mkDoc = (i: number): DocSummary => ({
  id: `doc-${i}`,
  spaceId: 'space-1',
  path: `docs/d${String(i).padStart(3, '0')}.md`,
  title: `Doc ${i}`,
});

describe('Api.docs.getTree / getFacets / getDocByPath（懒加载目录树 v1.70.0-dev）', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('getTree 透传 prefix/双游标分页参数到 tree 端点', async () => {
    mockRequest.mockResolvedValueOnce({
      data: {
        data: {
          prefix: 'docs/',
          folders: { items: [], total: 0, hasMore: false },
          docs: { items: [], total: 0, hasMore: false },
        },
      },
    });

    await Api.docs.getTree('space-1', { prefix: 'docs/', docsOffset: 50, foldersOffset: 200 });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/doc-spaces/space-1/docs/tree',
        params: { prefix: 'docs/', docsOffset: 50, foldersOffset: 200 },
      }),
    );
  });

  it('getFacets 请求 facets 端点', async () => {
    mockRequest.mockResolvedValueOnce({
      data: { data: { types: [], tags: [], categories: [] } },
    });

    await Api.docs.getFacets('space-1');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/doc-spaces/space-1/docs/facets' }),
    );
  });

  it('getDocByPath 走 ?path= 精确契约：命中取首项，未命中返回 null', async () => {
    mockRequest.mockResolvedValueOnce({
      data: {
        data: {
          items: [mkDoc(1)],
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    });
    const hit = await Api.docs.getDocByPath('space-1', 'docs/d001.md');
    expect(hit?.id).toBe('doc-1');
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/doc-spaces/space-1/docs',
        params: { path: 'docs/d001.md' },
      }),
    );

    mockRequest.mockResolvedValueOnce({
      data: {
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    });
    const miss = await Api.docs.getDocByPath('space-1', 'nope.md');
    expect(miss).toBeNull();
  });
});

describe('Api 拦截器（authHooks 注入，review-0831 任务 04e8d744 拆环）', () => {
  afterEach(() => {
    // setAuthHooks 是模块级变量，注入后跨用例残留——重置回默认空钩子（铁律 #17）
    setAuthHooks({ getToken: () => null, onUnauthorized: () => {} });
  });

  it('请求拦截器经 authHooks.getToken 注入 Authorization', () => {
    const requestHandler = mockRequestUse.mock.calls[0][0] as (config: {
      headers?: Record<string, string>;
    }) => typeof config;
    setAuthHooks({ getToken: () => 'test-token', onUnauthorized: () => {} });

    const config = requestHandler({ headers: {} });

    expect(config.headers?.Authorization).toBe('Bearer test-token');
  });

  it('401 响应拦截器触发 onUnauthorized', async () => {
    const onUnauthorized = jest.fn();
    setAuthHooks({ getToken: () => null, onUnauthorized });
    const responseErrorHandler = mockResponseUse.mock.calls[0][1] as (
      error: unknown,
    ) => Promise<never>;
    const error = {
      response: { status: 401, data: { message: 'unauthorized', code: 'AUTH_EXPIRED' } },
    };

    await expect(responseErrorHandler(error)).rejects.toBe(error);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // 注：handler 内 window.location.href='/login' 的跳转断言不可测——jsdom 的 location
    // 不可 redefine（defineProperty 抛 TypeError），赋值仅触发虚拟控制台 jsdomError 不抛错、
    // URL 不实际变化；跳转行为由 e2e/手测覆盖，此用例只钉死 onUnauthorized 契约。
  });
});
