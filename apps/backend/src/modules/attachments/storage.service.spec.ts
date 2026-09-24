/**
 * AttachmentStorageService 单测（mock minio SDK）
 *
 * 覆盖：构造参数映射（minio.config 六变量 → Client options）、
 * onModuleInit bucket 自举三分支（存在跳过 / 缺失创建 / 失败 fail-open 不 rethrow）、
 * put/get/remove 的参数透传（bucket 恒为配置值——业务层不传 bucket，防两处漂移）、
 * listObjects 异步迭代（recursive 全桶列举 / 目录条目与缺时间戳条目处理 /
 * 流错误包装后抛出——P2 批 4 孤儿清扫的列举入口）。
 */
import * as Minio from 'minio';
import { Readable } from 'stream';
import { AttachmentStorageService } from './storage.service';
import { ConfigService } from '@nestjs/config';

// factory 内初始化 client（踩坑索引：jest.mock hoist + 外层 const 即时求值 = TDZ；
// 此处实现为每次 new Client() 返回独立 mock 对象，经 mock.results 取回）
jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bucketExists: jest.fn(),
    makeBucket: jest.fn(),
    putObject: jest.fn(),
    getObject: jest.fn(),
    removeObject: jest.fn(),
    listObjectsV2: jest.fn(),
  })),
}));

interface MockMinioClient {
  bucketExists: jest.Mock;
  makeBucket: jest.Mock;
  putObject: jest.Mock;
  getObject: jest.Mock;
  removeObject: jest.Mock;
  listObjectsV2: jest.Mock;
}

const CONFIG: Record<string, unknown> = {
  'minio.endPoint': 'minio.internal',
  'minio.port': 9001,
  'minio.useSSL': true,
  'minio.accessKey': 'ak',
  'minio.secretKey': 'sk',
  'minio.bucket': 'test-bucket',
};

describe('AttachmentStorageService', () => {
  const MockedClient = Minio.Client as unknown as jest.Mock;
  let service: AttachmentStorageService;
  let client: MockMinioClient;

  beforeEach(() => {
    MockedClient.mockClear();
    const configService = { get: (key: string) => CONFIG[key] } as unknown as ConfigService;
    service = new AttachmentStorageService(configService);
    client = MockedClient.mock.results[0].value as MockMinioClient;
  });

  it('构造函数把 minio.config 六变量映射为 Client options', () => {
    expect(MockedClient).toHaveBeenCalledWith({
      endPoint: 'minio.internal',
      port: 9001,
      useSSL: true,
      accessKey: 'ak',
      secretKey: 'sk',
    });
    expect(service.getBucket()).toBe('test-bucket');
  });

  it('onModuleInit：bucket 已存在 → 不创建', async () => {
    client.bucketExists.mockResolvedValue(true);
    await service.onModuleInit();
    expect(client.bucketExists).toHaveBeenCalledWith('test-bucket');
    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it('onModuleInit：bucket 缺失 → makeBucket 自举', async () => {
    client.bucketExists.mockResolvedValue(false);
    await service.onModuleInit();
    expect(client.makeBucket).toHaveBeenCalledWith('test-bucket');
  });

  it('onModuleInit：MinIO 不可达 → fail-open（记 error 不 rethrow，启动不崩）', async () => {
    client.bucketExists.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('putObject：bucket 取配置值，直收 Buffer + 长度 + Content-Type 元数据', async () => {
    const buf = Buffer.from('png-bytes');
    await service.putObject('k1.png', buf, 'image/png');
    expect(client.putObject).toHaveBeenCalledWith('test-bucket', 'k1.png', buf, buf.length, {
      'Content-Type': 'image/png',
    });
  });

  it('getObject：透传 bucket 与 key 并返回流', async () => {
    const stream = { pipe: jest.fn() };
    client.getObject.mockResolvedValue(stream);
    await expect(service.getObject('k2.png')).resolves.toBe(stream);
    expect(client.getObject).toHaveBeenCalledWith('test-bucket', 'k2.png');
  });

  it('removeObject：透传 bucket 与 key', async () => {
    await service.removeObject('k3.png');
    expect(client.removeObject).toHaveBeenCalledWith('test-bucket', 'k3.png');
  });

  // ─── listObjects（P2 批 4 孤儿清扫的列举入口）────────────────────
  // 用真实 Readable（objectMode）造桶流：既能断言产出映射，也能验证
  // "流 emit error → 异步迭代器抛错"这条真实 SDK 行为路径

  /** 造一个 objectMode 桶流：先 push 全部条目，再 end（或 destroy 带错误） */
  function bucketStream(items: unknown[], error?: Error): Readable {
    const stream = new Readable({ objectMode: true, read() {} });
    process.nextTick(() => {
      for (const item of items) stream.push(item);
      if (error) stream.destroy(error);
      else stream.push(null);
    });
    return stream;
  }

  it('listObjects：recursive 全桶列举（bucket 恒取值，无前缀过滤）', async () => {
    const ts = new Date('2026-09-01T00:00:00Z');
    client.listObjectsV2.mockReturnValue(
      bucketStream([{ name: 'a.png', size: 10, lastModified: ts }]),
    );

    const out = [];
    for await (const item of service.listObjects()) out.push(item);

    expect(client.listObjectsV2).toHaveBeenCalledWith('test-bucket', '', true);
    expect(out).toEqual([{ key: 'a.png', size: 10, lastModified: ts }]);
  });

  it('listObjects：目录条目（无 name）跳过；缺时间戳/缺 size 条目保留 null/0（交调用侧保守判定）', async () => {
    client.listObjectsV2.mockReturnValue(
      bucketStream([
        { prefix: 'dir/', size: 0 },
        { name: 'b.png' }, // 缺 lastModified 与 size
        { name: 'c.png', size: 7, lastModified: new Date('2026-09-02T00:00:00Z') },
      ]),
    );

    const out = [];
    for await (const item of service.listObjects()) out.push(item);

    expect(out.map((i) => i.key)).toEqual(['b.png', 'c.png']);
    expect(out[0]).toEqual({ key: 'b.png', size: 0, lastModified: null });
    expect(out[1]).toEqual({
      key: 'c.png',
      size: 7,
      lastModified: new Date('2026-09-02T00:00:00Z'),
    });
  });

  it('listObjects：桶流 emit error → 异步迭代器抛错，包装带 bucket 上下文', async () => {
    client.listObjectsV2.mockReturnValue(bucketStream([], new Error('connect ECONNREFUSED')));

    const drain = async (): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _item of service.listObjects()) {
        /* 无产出 */
      }
    };

    await expect(drain()).rejects.toThrow(
      'listObjects failed (bucket="test-bucket"): connect ECONNREFUSED',
    );
  });
});
