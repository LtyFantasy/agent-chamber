import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  RepoManifestDto,
  REPO_MANIFEST_MAX_FILES,
  REPO_MANIFEST_FILE_MAX_LENGTH,
  REPO_MANIFEST_SHA_MAX_LENGTH,
} from './repo-manifest.dto';

/**
 * RepoManifestDto 校验测试（v1.42 批次 C2）
 *
 * 覆盖（plan §7-C2）：sha 必填/长度 64 上限；files ≤20000 条、每条 ≤512；
 * 自定义约束逐项拒绝绝对路径（POSIX / 盘符）与 `..` 段（含反斜杠形式）；空串拒绝。
 */
describe('RepoManifestDto', () => {
  const validSha = 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d';

  function makeDto(overrides: Partial<RepoManifestDto> = {}): RepoManifestDto {
    return plainToInstance(RepoManifestDto, {
      sha: validSha,
      files: ['apps/backend/src/app.module.ts', 'docs/architecture.md'],
      ...overrides,
    });
  }

  it('accepts a valid payload (sha + relative files)', async () => {
    const errors = await validate(makeDto());
    expect(errors).toHaveLength(0);
  });

  it('accepts directory-style files (no extension, trailing slash allowed)', async () => {
    const errors = await validate(
      makeDto({ files: ['apps/backend/src/modules/', 'scripts/sync-docs.mjs'] }),
    );
    expect(errors).toHaveLength(0);
  });

  // ─── sha ───────────────────────────────────────────────────

  it('rejects missing sha', async () => {
    const errors = await validate(makeDto({ sha: undefined }));
    expect(errors.some((e) => e.property === 'sha' && e.constraints?.isNotEmpty)).toBe(true);
  });

  it('rejects empty sha', async () => {
    const errors = await validate(makeDto({ sha: '' }));
    expect(errors.some((e) => e.property === 'sha' && e.constraints?.isNotEmpty)).toBe(true);
  });

  it(`rejects sha over ${REPO_MANIFEST_SHA_MAX_LENGTH} chars`, async () => {
    const errors = await validate(makeDto({ sha: 'a'.repeat(REPO_MANIFEST_SHA_MAX_LENGTH + 1) }));
    expect(errors.some((e) => e.property === 'sha' && e.constraints?.maxLength)).toBe(true);
  });

  // ─── files 数量/长度边界 ───────────────────────────────────

  it(`rejects files over ${REPO_MANIFEST_MAX_FILES} entries (无界数组防撑大 settings jsonb)`, async () => {
    const files = Array.from({ length: REPO_MANIFEST_MAX_FILES + 1 }, (_, i) => `f${i}.ts`);
    const errors = await validate(makeDto({ files }));
    expect(errors.some((e) => e.property === 'files' && e.constraints?.arrayMaxSize)).toBe(true);
  });

  it(`accepts exactly ${REPO_MANIFEST_MAX_FILES} entries (上限边界放行)`, async () => {
    const files = Array.from({ length: REPO_MANIFEST_MAX_FILES }, (_, i) => `f${i}.ts`);
    const errors = await validate(makeDto({ files }));
    expect(errors).toHaveLength(0);
  });

  it(`rejects a single file over ${REPO_MANIFEST_FILE_MAX_LENGTH} chars`, async () => {
    const errors = await validate(
      makeDto({ files: ['a'.repeat(REPO_MANIFEST_FILE_MAX_LENGTH + 1)] }),
    );
    expect(errors.some((e) => e.property === 'files' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects empty-string file', async () => {
    const errors = await validate(makeDto({ files: [''] }));
    expect(errors.some((e) => e.property === 'files' && e.constraints?.isNotEmpty)).toBe(true);
  });

  it('rejects non-string files', async () => {
    const errors = await validate(makeDto({ files: [42 as unknown as string] }));
    expect(errors.some((e) => e.property === 'files' && e.constraints?.isString)).toBe(true);
  });

  // ─── 自定义约束：路径格式（绝对路径 / `..` 段） ─────────────

  it('rejects POSIX absolute path file (/etc/passwd)', async () => {
    const errors = await validate(makeDto({ files: ['/etc/passwd'] }));
    const filesErr = errors.find((e) => e.property === 'files');
    expect(filesErr?.constraints?.repoManifestFile).toMatch(/repository-relative/);
  });

  it('rejects Windows drive-letter absolute path file (C:\\x)', async () => {
    const errors = await validate(makeDto({ files: ['C:\\x\\app.ts'] }));
    const filesErr = errors.find((e) => e.property === 'files');
    expect(filesErr?.constraints?.repoManifestFile).toMatch(/repository-relative/);
  });

  it('rejects `..` parent-traversal segment (a/../b)', async () => {
    const errors = await validate(makeDto({ files: ['apps/backend/../secret'] }));
    const filesErr = errors.find((e) => e.property === 'files');
    expect(filesErr?.constraints?.repoManifestFile).toMatch(/repository-relative/);
  });

  it('rejects backslash `..` segment (a\\..\\b — Windows 分隔符形式)', async () => {
    const errors = await validate(makeDto({ files: ['apps\\backend\\..\\secret'] }));
    const filesErr = errors.find((e) => e.property === 'files');
    expect(filesErr?.constraints?.repoManifestFile).toMatch(/repository-relative/);
  });

  it('rejects leading `..` (..\\escape)', async () => {
    const errors = await validate(makeDto({ files: ['../outside'] }));
    const filesErr = errors.find((e) => e.property === 'files');
    expect(filesErr?.constraints?.repoManifestFile).toMatch(/repository-relative/);
  });

  it('mixed valid+invalid files: 整单被拒（任一项非法 → files 校验失败）', async () => {
    const errors = await validate(
      makeDto({ files: ['apps/backend/src/app.module.ts', '/etc/passwd'] }),
    );
    expect(errors.some((e) => e.property === 'files')).toBe(true);
  });
});
