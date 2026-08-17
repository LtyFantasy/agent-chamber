/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, PATCH /docs/:id/content)
 *   - 补充: doc.service.ts patchByMatch（match 模式写 = 全文精确串替换 + 复用 upsert 重建管线）
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：patch_doc stale position 在 re-chunk 漂移后
 *     静默写错块（fail-open）→ 本端点是 fail-closed 改造的第二种写模式（match 模式），
 *     0 命中 404 / 多命中 409 / 唯一命中才替换
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * PATCH /docs/:id/content 请求体（match 模式写，fail-closed 改造）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：oldString 必须是非空字符串
 * （空串无定位语义——split 计数对空串是全长度命中，禁止透传 service）；
 * newString 允许空串（= 删除该片段）。
 *
 * 操作面契约：oldString 匹配的文本面 = GET /docs/:id/content?full=true 的保真全文
 * （skipDuplicateTitle=false、'\n\n' join）——调用方必须用该通道（或 read_doc）拿到的
 * 全文构造 oldString；web 默认渲染版（full=false）去掉首标题行，拿它会零命中 404。
 *
 * 命中语义（Service 层业务判定）：0 命中 → 404 DOC_NOT_FOUND；多命中 → 409
 * RESOURCE_CONFLICT + data.matchCount（扩大上下文重试）；唯一命中 → 替换重建。
 */
export class PatchDocContentDto {
  @ApiProperty({
    description:
      "Exact substring to replace, matched against the document's full=true content " +
      '(GET /docs/:id/content?full=true — NOT the default rendering, which drops the ' +
      'first title heading). 0 matches → 404; multiple matches → 409 + matchCount ' +
      '(expand with more context); exactly 1 match → replaced.',
  })
  @IsString()
  @IsNotEmpty()
  oldString: string;

  @ApiProperty({
    description: 'Replacement text (may be an empty string = delete the matched fragment)',
  })
  @IsString()
  newString: string;
}
