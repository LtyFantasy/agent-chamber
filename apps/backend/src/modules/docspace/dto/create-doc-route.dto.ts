/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段)
 *   - 补充: plan §4-B5 (意图路由结构化)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DOC_ROUTE_CODE_ENTRY_TYPES, DocRouteCodeEntryType } from '@agent-chamber/shared';

/** sortOrder 上限：同空间路由数量级有限，10000 足够策展排序（对齐 doc_categories 惯例） */
const ROUTE_SORT_ORDER_MAX = 10000;

/**
 * POST /doc-spaces/:id/routes 请求体（v1.42 批次 B5）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：长度/UUID/整数边界；
 * 业务校验（铁律 #22，Service 层）：doc 存在且属于空间、headingPath 精确命中、codeEntry 路径格式。
 */
export class CreateDocRouteDto {
  @ApiProperty({
    description: '用户意图描述（"我要…"），如 "我要了解系统架构"',
    example: '我要了解系统架构',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  intent: string;

  @ApiPropertyOptional({
    description: '路由分组（可空），如 "architecture"、"troubleshooting"',
    example: 'architecture',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiProperty({
    description: '主文档 ID（路由第一步跳转；Service 层校验存在且属于该空间）',
    example: '5f3d1b2a-0000-4000-8000-000000000001',
  })
  @IsUUID()
  primaryDocId: string;

  @ApiPropertyOptional({
    description: '主文档定位锚点（doc_sections.heading_path 精确匹配；可空 = 文档级跳转）',
    example: '## 4. 实施步骤',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  primaryHeadingPath?: string;

  @ApiPropertyOptional({
    description: '次文档 ID（可空；看完主文档后需要再看时跳转）',
    example: '5f3d1b2a-0000-4000-8000-000000000002',
  })
  @IsOptional()
  @IsUUID()
  secondaryDocId?: string;

  @ApiPropertyOptional({
    description: '次文档定位锚点（可空）',
    example: '## 5. 关键设计决策',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  secondaryHeadingPath?: string;

  @ApiPropertyOptional({
    description: '代码入口（仓库内相对路径；Service 层校验：≤512、禁绝对路径与 `..` 段）',
    example: 'apps/backend/src/modules/docspace/doc.service.ts',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  codeEntry?: string;

  @ApiPropertyOptional({
    description:
      'codeEntry 类型（缺省 exact）：exact = 精确文件/目录路径（recheck 参与存在性校验）；' +
      'pattern = glob 泛化写法（如 `apps/web/app/**` + `/page.tsx`），recheck 豁免精确校验、不报 broken',
    example: 'exact',
    default: 'exact',
    enum: [...DOC_ROUTE_CODE_ENTRY_TYPES],
  })
  @IsOptional()
  @IsIn([...DOC_ROUTE_CODE_ENTRY_TYPES])
  codeEntryType?: DocRouteCodeEntryType;

  @ApiPropertyOptional({
    description: '排序权重（同空间内 ASC 升序展示，缺省 0）',
    example: 0,
    default: 0,
    minimum: 0,
    maximum: ROUTE_SORT_ORDER_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(ROUTE_SORT_ORDER_MAX)
  sortOrder?: number;
}
