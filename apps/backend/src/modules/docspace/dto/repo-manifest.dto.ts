/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, repo-manifest 段)
 *   - 补充: .kimi/plan-info-online-batch-c.md §3 (C2 设计)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #17(测试契约) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * manifest 容量常量（rationale）：
 * - files 上限 20000：本仓 ~1000 文件，20× 余量防无界数组撑大 settings jsonb
 *   （对齐 update-doc-space.dto.ts B1 先例：数组必须封顶）；
 * - 每条 ≤512：对齐 codeEntry 单值上限（doc_routes.code_entry 列长），
 *   仓库路径不可能更长，超限必为脏数据。
 */
export const REPO_MANIFEST_MAX_FILES = 20000;
export const REPO_MANIFEST_FILE_MAX_LENGTH = 512;
/** sha 上限 64：git SHA-1/SHA-256 十六进制均 ≤64 字符 */
export const REPO_MANIFEST_SHA_MAX_LENGTH = 64;

/**
 * 仓库相对路径格式校验（类级可复用约束，@Validate(..., { each: true }) 作用于 files 每项）。
 *
 * 语义对齐 doc-route.service.ts validateCodeEntry 的 codeEntry 格式规则：
 * - 禁绝对路径（POSIX `/` 开头或 Windows 盘符如 `C:\`）——仓库内路径必须相对；
 * - 禁 `..` 路径段（按 `/` 与 `\` 分割均查）——可逃逸仓库根；
 * - 禁空串。
 * 放 DTO 层而非 Service（铁律 #21）：路径格式 = 格式正确性，属校验层；
 * Service 只做存在性与写入。
 */
@ValidatorConstraint({ name: 'repoManifestFile', async: false })
export class RepoManifestFileConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const isAbsolute =
      value.startsWith('/') || // POSIX 绝对路径
      /^[A-Za-z]:[\\/]/.test(value); // Windows 盘符绝对路径（如 C:\）
    const hasParentTraversal = value.split('/').includes('..') || value.split('\\').includes('..');
    return !isAbsolute && !hasParentTraversal;
  }

  defaultMessage(): string {
    return 'each file must be a repository-relative path (no absolute path or `..` segments)';
  }
}

/**
 * PUT /doc-spaces/:id/repo-manifest 请求体（v1.42 批次 C2）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：sha ≤64；files ≤20000 条、每条 ≤512、
 * 仓库相对路径（自定义约束逐项校验）。
 * reportedAt 不由客户端传入——Service 写入时以服务端 now 生成（不信客户端时钟）。
 */
export class RepoManifestDto {
  @ApiProperty({
    description: 'git HEAD commit sha（清单对应的仓库版本）',
    example: '5506f8c3f9d1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c',
    maxLength: REPO_MANIFEST_SHA_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(REPO_MANIFEST_SHA_MAX_LENGTH)
  sha: string;

  @ApiProperty({
    description: 'git ls-files 全量相对路径清单（≤20000 条；每条 ≤512、禁绝对路径与 `..` 段）',
    example: ['apps/backend/src/app.module.ts', 'docs/architecture.md'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(REPO_MANIFEST_MAX_FILES)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(REPO_MANIFEST_FILE_MAX_LENGTH, { each: true })
  @Validate(RepoManifestFileConstraint, { each: true })
  files: string[];
}
