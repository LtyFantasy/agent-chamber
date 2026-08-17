/**
 * Api.docs.listAllDocs 分页循环单测
 *
 * 背景：后端 GET /doc-spaces/:id/docs 分页硬上限 100（QueryDocDto @Max(100)），
 * 单次 pageSize:100 拉取在 >100 篇文档的空间会静默丢失尾部。listAllDocs 仿
 * agents.listAll（评审 M-e）范式按 hasNext/total 循环翻页收齐。此处 mock
 * axios.create 控制 axiosInstance.request，验证：多页拼接、单页、total 恰好收齐
 * （hasNext 漂移双保险）、空空间四种情况。
 */

/** 受控的 request mock（jest.mock 工厂仅允许引用 mock 前缀的外部变量） */
const mockRequest = jest.fn();

/**
 * mock axios：api.ts 模块顶层两次 axios.create 生成 axiosInstance / publicAxiosInstance，
 * 并经 instance.interceptors.*.use 注册拦截器——create 返回受控实例、拦截器注册用 stub 吞掉，
 * 请求行为完全由测试注入（apiRequest 解包 response.data.data）。
 */
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({
      // 惰性绑定：create 在 api.ts 模块导入期即被调用（早于下方 const 初始化），
      // 直接引用 mockRequest 会命中 TDZ——包一层函数，真正调用发生在测试运行期
      request: (...args: unknown[]) => mockRequest(...args),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    }),
  },
}));

import { Api } from './api';

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

/** 构造完整 PaginatedResponse 页并包进 axios 响应壳（apiRequest 取 response.data.data） */
const mkPage = (
  items: DocSummary[],
  total: number,
  hasNext: boolean,
  pageNo: number,
): { data: { data: PaginatedDocs } } => ({
  data: {
    data: {
      items,
      total,
      page: pageNo,
      pageSize: 100,
      totalPages: Math.max(1, Math.ceil(total / 100)),
      hasNext,
      hasPrev: pageNo > 1,
    },
  },
});

/** 生成 [start, start+count) 连续编号的文档列表 */
const docsRange = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => mkDoc(start + i));

describe('Api.docs.listAllDocs 分页循环', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('>100 篇空间：循环翻页拼接全量，page/pageSize 与过滤参数逐页透传', async () => {
    mockRequest
      .mockResolvedValueOnce(mkPage(docsRange(0, 100), 250, true, 1))
      .mockResolvedValueOnce(mkPage(docsRange(100, 100), 250, true, 2))
      .mockResolvedValueOnce(mkPage(docsRange(200, 50), 250, false, 3));

    const result = await Api.docs.listAllDocs('space-1', { type: 'guide', tag: 'diary' });

    expect(result).toHaveLength(250);
    // 首尾齐全：第 1 页头部 + 第 3 页尾部均在（尾部即截断 bug 的静默丢失段）
    expect(result[0].id).toBe('doc-0');
    expect(result[249].id).toBe('doc-249');
    // 恰好三页：过滤参数原样透传、page 递增、pageSize 固定 100
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(mockRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'GET',
        url: '/doc-spaces/space-1/docs',
        params: { type: 'guide', tag: 'diary', page: 1, pageSize: 100 },
      }),
    );
    expect(mockRequest).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        params: { type: 'guide', tag: 'diary', page: 3, pageSize: 100 },
      }),
    );
  });

  it('单页空间（≤100 篇）：一次请求即结束，不发起多余翻页', async () => {
    mockRequest.mockResolvedValueOnce(mkPage(docsRange(0, 5), 5, false, 1));

    const result = await Api.docs.listAllDocs('space-1');

    expect(result).toHaveLength(5);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // 未传过滤参数 → params 仅含分页字段（...undefined 展开不污染）
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { page: 1, pageSize: 100 },
      }),
    );
  });

  it('total 边界：恰好 100 篇且后端 hasNext=true 漂移，按已收齐 total 双保险终止（防死循环）', async () => {
    // 模拟后端异常语义：total=100 已全部返回但 hasNext 仍为 true——
    // 循环的第二个终止条件（all.length >= total）必须兜住，否则无限翻页
    mockRequest.mockResolvedValue(mkPage(docsRange(0, 100), 100, true, 1));

    const result = await Api.docs.listAllDocs('space-1');

    expect(result).toHaveLength(100);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('空空间：返回空数组且仅请求一次', async () => {
    mockRequest.mockResolvedValueOnce(mkPage([], 0, false, 1));

    const result = await Api.docs.listAllDocs('space-1');

    expect(result).toEqual([]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
