import 'reflect-metadata';
import { validate } from 'class-validator';
import { PatchDocSectionDto } from './patch-doc-section.dto';

/**
 * PatchDocSectionDto 校验测试（v1.55 任务 T3）
 *
 * 设计意图：content 必填且必须是字符串（空串合法 = 删除该节的语义入口，
 * 由 service 层承接）。格式边界在 DTO 层 400（铁律 #21），不进 service。
 */
describe('PatchDocSectionDto', () => {
  it('accepts valid content (heading line + body)', async () => {
    const dto = new PatchDocSectionDto();
    dto.content = '## 第一节\n\n新正文';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts empty string content (delete-section semantics, service-level handling)', async () => {
    const dto = new PatchDocSectionDto();
    dto.content = '';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing content (required field)', async () => {
    const dto = new PatchDocSectionDto();

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'content')).toBe(true);
  });

  it('rejects non-string content', async () => {
    const dto = new PatchDocSectionDto();
    (dto as { content: unknown }).content = 123;

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'content' && e.constraints?.isString)).toBe(true);
  });
});
