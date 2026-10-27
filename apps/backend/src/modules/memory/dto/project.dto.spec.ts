import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateMemoryProjectDto, UpdateMemoryProjectDto } from './project.dto';

/**
 * memory 项目请求 DTO 的**边界校验**单测（铁律 #21 双层校验第一层）。
 *
 * 本套件守 `engineWorkspaceId` / `engineActorId` / `engineCredentialRef` 三列的同一字符集闸：
 * 它们都是**标识符**——只校验、永不改写。**创建与改绑两个 DTO 同一字符集**：改绑路径少了
 * 这条闸，`PATCH` 会放行 `" ws1 "`（服务层不改写 ⇒ 带空格落库 = 引擎调用打到不存在的目标）。
 * 其余字段（slug / name / bindings）的规则各有既定用例与被测面，这里只造出最小合法载荷。
 */
describe('CreateMemoryProjectDto.engineWorkspaceId', () => {
  /** 除 engineWorkspaceId 外全部合法的载荷（一个真实 UUID 的绑定） */
  function dtoWith(engineWorkspaceId: unknown) {
    return plainToInstance(CreateMemoryProjectDto, {
      slug: 'demo-project',
      name: 'Demo Project',
      bindings: [{ type: 'board', id: '0b7e5b1c-3a2f-4d5e-8f90-1a2b3c4d5e6f' }],
      engineWorkspaceId,
    });
  }

  /** 只取该字段的校验错误（其余字段的断言不在本套件范围） */
  async function workspaceIdErrors(value: unknown) {
    const errors = await validate(dtoWith(value));
    return errors.filter((error) => error.property === 'engineWorkspaceId');
  }

  it('正例：允许 A-Z a-z 0-9 . _ : -（含 128 长度边界）', async () => {
    for (const ok of ['ws_01', 'org.prod:tenant-7', 'A'.repeat(128)]) {
      expect(await workspaceIdErrors(ok)).toHaveLength(0);
    }
  });

  it('反例：空格 / 斜杠 / 换行 / 星号 / 超长 ⇒ 拒绝（不静默截断或改写）', async () => {
    for (const bad of ['ws 01', 'org/prod', 'ws\n01', 'ws*01', 'A'.repeat(129)]) {
      const errors = await workspaceIdErrors(bad);
      expect(errors.length).toBeGreaterThan(0);
      // 触发的约束 = matches（超长同时命中 maxLength，两者都算拒绝）
      expect(errors[0].constraints).toBeDefined();
    }
  });

  it('可选：undefined / null 通过（三键全缺 = 自动开通分支的前提）', async () => {
    expect(await workspaceIdErrors(undefined)).toHaveLength(0);
    expect(await workspaceIdErrors(null)).toHaveLength(0);
  });
});

/**
 * `PATCH /memory/projects/:id` 的同一字段（**改绑路径**）。
 *
 * 为什么必须与 Create 同闸：服务层对 workspaceId **不做 trim**（标识符只校验不改写），
 * 少了这层 `PATCH { engineWorkspaceId: " ws1 " }` 会带着空格落库。
 */
describe('UpdateMemoryProjectDto.engineWorkspaceId', () => {
  function dtoWith(engineWorkspaceId: unknown) {
    return plainToInstance(UpdateMemoryProjectDto, { engineWorkspaceId });
  }

  async function workspaceIdErrors(value: unknown) {
    const errors = await validate(dtoWith(value));
    return errors.filter((error) => error.property === 'engineWorkspaceId');
  }

  it('正例：允许 A-Z a-z 0-9 . _ : -（含 128 长度边界）', async () => {
    for (const ok of ['ws_01', 'org.prod:tenant-7', 'A'.repeat(128)]) {
      expect(await workspaceIdErrors(ok)).toHaveLength(0);
    }
  });

  it('反例：首尾空白 / 内部空格 / 换行 / 斜杠 / 超长 ⇒ 拒绝（不 trim、不截断）', async () => {
    for (const bad of [' ws1 ', 'ws 01', 'ws\n01', 'org/prod', 'A'.repeat(129)]) {
      const errors = await workspaceIdErrors(bad);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toBeDefined();
    }
  });

  it('null = 清空、undefined = 不改（两者都通过）', async () => {
    expect(await workspaceIdErrors(null)).toHaveLength(0);
    expect(await workspaceIdErrors(undefined)).toHaveLength(0);
  });
});

/**
 * F3：三列同一字符集闸（DTO 层）。
 *
 * 服务层 `assertEngineIdentifier` 是第二道；这里钉住第一道，避免畸形 actor/credentialRef
 * 在直呼 HTTP 时绕过 DTO、到服务层才 400（错误面不一致）。
 */
describe('引擎三列（workspace / actor / credentialRef）同一字符集闸', () => {
  const FIELDS = ['engineWorkspaceId', 'engineActorId', 'engineCredentialRef'] as const;

  const createDto = (field: (typeof FIELDS)[number], value: unknown) =>
    plainToInstance(CreateMemoryProjectDto, {
      slug: 'demo-project',
      name: 'Demo Project',
      bindings: [{ type: 'board', id: '0b7e5b1c-3a2f-4d5e-8f90-1a2b3c4d5e6f' }],
      [field]: value,
    });

  const updateDto = (field: (typeof FIELDS)[number], value: unknown) =>
    plainToInstance(UpdateMemoryProjectDto, { [field]: value });

  async function errorsFor(field: (typeof FIELDS)[number], value: unknown, update: boolean) {
    const dto = update ? updateDto(field, value) : createDto(field, value);
    const errors = await validate(dto);
    return errors.filter((error) => error.property === field);
  }

  it.each(FIELDS)('%s：合法字符集通过（create + update）', async (field) => {
    for (const ok of ['ws_01', 'org.prod:tenant-7', 'A'.repeat(128)]) {
      expect(await errorsFor(field, ok, false)).toHaveLength(0);
      expect(await errorsFor(field, ok, true)).toHaveLength(0);
    }
  });

  it.each(FIELDS)('%s：空格 / 斜杠 / 换行 / 超长 ⇒ 拒绝（create + update）', async (field) => {
    for (const bad of ['bad value', 'org/prod', 'bad\nvalue', 'A'.repeat(129)]) {
      for (const update of [false, true]) {
        const errors = await errorsFor(field, bad, update);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].constraints).toBeDefined();
      }
    }
  });

  it.each(FIELDS)('%s：可选语义（undefined / null 通过）', async (field) => {
    expect(await errorsFor(field, undefined, false)).toHaveLength(0);
    expect(await errorsFor(field, null, false)).toHaveLength(0);
    expect(await errorsFor(field, undefined, true)).toHaveLength(0);
    expect(await errorsFor(field, null, true)).toHaveLength(0);
  });
});
