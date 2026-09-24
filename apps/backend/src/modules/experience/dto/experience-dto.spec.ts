import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  EXPERIENCE_CONTENT_MAX_LENGTH,
  EXPERIENCE_ENV_KEYS,
  EXPERIENCE_INTENTS,
  EXPERIENCE_TITLE_MAX_LENGTH,
} from '@agent-chamber/shared';
import { CreateExperienceDto } from './create-experience.dto';
import { UpdateExperienceDto } from './update-experience.dto';
import { QueryExperienceDto } from './query-experience.dto';
import { ReportExperienceFeedbackDto } from './report-experience-feedback.dto';
import { ReviewExperienceQualityDto } from './review-experience-quality.dto';
import {
  EXPERIENCE_MAX_DOMAINS,
  EXPERIENCE_MAX_PAGE_SIZE,
  EXPERIENCE_MAX_SIGNALS,
  EXPERIENCE_QUERY_MAX_LENGTH,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
} from '../experience.constants';

/**
 * 经验库 DTO 校验矩阵（plan §7「DTO：词表/数组上限 20×50/逗号残留 400/长度上限」）。
 *
 * 为什么用 `plainToInstance` 而不是 `new CreateExperienceDto()`：查询 DTO 的值来自 query
 * 字符串（`?includeExpired=true`），必须经 class-transformer 的 `@Transform` 才能得到
 * 真实类型——直接 new 出来的实例字段类型是 TS 编译期假象，测不出转换是否正确。
 *
 * 校验选项与生产全局管道**逐字一致**（main.ts：whitelist + forbidNonWhitelisted +
 * transform）——这是"客户端自传 quality 会被拒"这类契约断言的唯一可信方式。
 */
const VALIDATE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

/** 校验一个 plain 对象（按生产管道同款选项 + 同款 Transform） */
async function validateAs<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const instance = plainToInstance(cls, plain);
  return validate(instance, VALIDATE_OPTIONS);
}

/** 最小合法录入载荷（各用例只覆盖自己关心的字段） */
function validCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'WSL2 端口映射重启后失效',
    summary: '症状是宿主机访问不到已发布端口；解法是重启 docker-desktop 发行版',
    content: '## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...',
    intent: 'repair',
    signals: ['econnrefused'],
    ...overrides,
  };
}

describe('CreateExperienceDto', () => {
  it('接受最小合法载荷（只有 signals 必填，domains/env/sourceProject/expiresAt 可选）', async () => {
    expect(await validateAs(CreateExperienceDto, validCreate())).toHaveLength(0);
  });

  it('拒绝空 signals（signals 恒必填 —— 不做"是否给了 signals"的条件校验双写分叉）', async () => {
    const errors = await validateAs(CreateExperienceDto, validCreate({ signals: [] }));
    expect(errors.some((e) => e.property === 'signals')).toBe(true);
  });

  it('拒绝缺失 signals', async () => {
    const payload = validCreate();
    delete payload.signals;
    const errors = await validateAs(CreateExperienceDto, payload);
    expect(errors.some((e) => e.property === 'signals')).toBe(true);
  });

  it('intent 词表外取值 → 400（受控五值）', async () => {
    const errors = await validateAs(CreateExperienceDto, validCreate({ intent: 'bugfix' }));
    expect(errors.some((e) => e.property === 'intent')).toBe(true);
    for (const intent of EXPERIENCE_INTENTS) {
      expect(await validateAs(CreateExperienceDto, validCreate({ intent }))).toHaveLength(0);
    }
  });

  it('客户端自传 quality → 400（徽章洗白防线的第一道物理隔离）', async () => {
    const errors = await validateAs(CreateExperienceDto, validCreate({ quality: 'verified' }));
    expect(errors.some((e) => e.property === 'quality')).toBe(true);
  });

  it('客户端自传 createdById → 400（录入者恒取认证身份）', async () => {
    const errors = await validateAs(
      CreateExperienceDto,
      validCreate({ createdById: '11111111-1111-4111-8111-111111111111' }),
    );
    expect(errors.some((e) => e.property === 'createdById')).toBe(true);
  });

  it('title 超列宽 200 → 400；恰好 200 通过', async () => {
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ title: 'a'.repeat(EXPERIENCE_TITLE_MAX_LENGTH) }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ title: 'a'.repeat(EXPERIENCE_TITLE_MAX_LENGTH + 1) }),
        )
      ).some((e) => e.property === 'title'),
    ).toBe(true);
  });

  it('summary 超 500 → 400（列宽 varchar(500)，必须在 DTO 拦下而不是等 PG 报 22001）', async () => {
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ summary: 'a'.repeat(EXPERIENCE_SUMMARY_MAX_LENGTH + 1) }),
        )
      ).some((e) => e.property === 'summary'),
    ).toBe(true);
  });

  it('content 超 64KB 产品上限 → 400；恰好 65536 通过', async () => {
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ content: 'x'.repeat(EXPERIENCE_CONTENT_MAX_LENGTH) }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ content: 'x'.repeat(EXPERIENCE_CONTENT_MAX_LENGTH + 1) }),
        )
      ).some((e) => e.property === 'content'),
    ).toBe(true);
  });

  // ─── 数组：上限 20×50 + 逗号残留 ───────────────────────────────

  it(`signals 元素数上限 ${EXPERIENCE_MAX_SIGNALS}：超出 → 400`, async () => {
    const many = Array.from({ length: EXPERIENCE_MAX_SIGNALS + 1 }, (_, i) => `sig-${i}`);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ signals: many }))).some(
        (e) => e.property === 'signals',
      ),
    ).toBe(true);
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ signals: many.slice(0, EXPERIENCE_MAX_SIGNALS) }),
        )
      ).length,
    ).toBe(0);
  });

  it('signals 单元素 >50 字符 → 400（元素是提炼出的 token，不是整句报错）', async () => {
    const errors = await validateAs(
      CreateExperienceDto,
      validCreate({ signals: ['a'.repeat(51)] }),
    );
    const message = errors.find((e) => e.property === 'signals')?.constraints ?? {};
    expect(JSON.stringify(message)).toContain('exceeding the 50-character limit');
  });

  it('signals 元素含逗号 → 400 + 文案指导"一个元素一条症状/重复参数"', async () => {
    const errors = await validateAs(
      CreateExperienceDto,
      validCreate({ signals: ['econnrefused, connect failed'] }),
    );
    const constraintText = JSON.stringify(
      errors.find((e) => e.property === 'signals')?.constraints ?? {},
    );
    expect(constraintText).toContain('comma');
    expect(constraintText).toContain('signals=a&signals=b');
    expect(constraintText).toContain('一个元素一条signal');
  });

  it('signals 元素纯空白 → 400（归一化后为空不是合法信号）', async () => {
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ signals: ['   '] }))).some(
        (e) => e.property === 'signals',
      ),
    ).toBe(true);
  });

  it(`domains 元素数上限 ${EXPERIENCE_MAX_DOMAINS} + 逗号拒绝（与 signals 同形校验）`, async () => {
    const many = Array.from({ length: EXPERIENCE_MAX_DOMAINS + 1 }, (_, i) => `d-${i}`);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ domains: many }))).some(
        (e) => e.property === 'domains',
      ),
    ).toBe(true);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ domains: ['devops,backend'] }))).some(
        (e) => e.property === 'domains',
      ),
    ).toBe(true);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ domains: ['devops'] }))).length,
    ).toBe(0);
  });

  // ─── env 键白名单 ─────────────────────────────────────────────

  it('env 键白名单外 → 400 且**回显合法键**（键受控、值开放的唯一枚举通道）', async () => {
    const errors = await validateAs(
      CreateExperienceDto,
      validCreate({ env: { platform: 'wsl2' } }),
    );
    const text = JSON.stringify(errors.find((e) => e.property === 'env')?.constraints ?? {});
    expect(text).toContain('platform');
    for (const key of EXPERIENCE_ENV_KEYS) {
      expect(text).toContain(key);
    }
  });

  it('env 四键合法值通过；值超 100 字符 / 非字符串 / 空串 → 400', async () => {
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({
            env: { os: 'wsl2', tool: 'docker', version: '24.0.7', runtime: 'node-20' },
          }),
        )
      ).length,
    ).toBe(0);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ env: { os: 'a'.repeat(101) } }))).some(
        (e) => e.property === 'env',
      ),
    ).toBe(true);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ env: { os: 20 } }))).some(
        (e) => e.property === 'env',
      ),
    ).toBe(true);
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ env: { os: '  ' } }))).some(
        (e) => e.property === 'env',
      ),
    ).toBe(true);
  });

  it('env 空对象 {} 合法（允许只写"哪个工具+哪个版本"）', async () => {
    expect((await validateAs(CreateExperienceDto, validCreate({ env: {} }))).length).toBe(0);
  });

  it('expiresAt 非 ISO 8601 → 400（必须 > now 的业务校验在 service）', async () => {
    expect(
      (await validateAs(CreateExperienceDto, validCreate({ expiresAt: '2026-13-45' }))).some(
        (e) => e.property === 'expiresAt',
      ),
    ).toBe(true);
    expect(
      (
        await validateAs(
          CreateExperienceDto,
          validCreate({ expiresAt: '2026-12-31T00:00:00.000Z' }),
        )
      ).length,
    ).toBe(0);
  });

  it('clientRequestId 超 64 → 400', async () => {
    expect(
      (
        await validateAs(CreateExperienceDto, validCreate({ clientRequestId: 'k'.repeat(65) }))
      ).some((e) => e.property === 'clientRequestId'),
    ).toBe(true);
  });
});

describe('UpdateExperienceDto', () => {
  it('expectedUpdatedAt 必填（省略 → 400；乐观锁不许"省略即绕过"）', async () => {
    const errors = await validateAs(UpdateExperienceDto, { title: '新标题' });
    expect(errors.some((e) => e.property === 'expectedUpdatedAt')).toBe(true);
  });

  it('只带乐观锁的最小合法载荷通过（全部可改字段缺席 = 不动）', async () => {
    expect(
      (await validateAs(UpdateExperienceDto, { expectedUpdatedAt: '2026-09-21T10:00:00.000Z' }))
        .length,
    ).toBe(0);
  });

  it('自传 quality → 400（质量只能走 admin 终审端点，不得从 PATCH 旁路洗白）', async () => {
    const errors = await validateAs(UpdateExperienceDto, {
      expectedUpdatedAt: '2026-09-21T10:00:00.000Z',
      quality: 'verified',
    });
    expect(errors.some((e) => e.property === 'quality')).toBe(true);
  });

  it('B1：七个非清空字段传显式 null → 400（曾因 @IsOptional 静默放行，直通 service 后炸 500）', async () => {
    // 逐个字段钉死：null 必须进入校验被 @IsString/@IsIn/@IsArray/@IsObject 拦下。
    // 后端加固是"同一空洞的 REST 消费者共享"，故 REST 侧也要有自己的守卫（不只依赖 MCP）。
    for (const field of ['title', 'summary', 'content', 'intent', 'signals', 'domains', 'env']) {
      const errors = await validateAs(UpdateExperienceDto, {
        expectedUpdatedAt: '2026-09-21T10:00:00.000Z',
        [field]: null,
      });
      expect(errors.some((e) => e.property === field)).toBe(true);
    }
  });

  it('expiresAt / sourceProject 允许显式 null（清空语义：null = 采用，缺席 = 保留）', async () => {
    const errors = await validateAs(UpdateExperienceDto, {
      expectedUpdatedAt: '2026-09-21T10:00:00.000Z',
      expiresAt: null,
      sourceProject: null,
    });
    expect(errors).toHaveLength(0);
  });

  it('signals 元素逗号 / 超长同样被拒（与录入同形校验）', async () => {
    const errors = await validateAs(UpdateExperienceDto, {
      expectedUpdatedAt: '2026-09-21T10:00:00.000Z',
      signals: ['a,b'],
    });
    expect(errors.some((e) => e.property === 'signals')).toBe(true);
  });
});

describe('QueryExperienceDto', () => {
  it('空查询串合法（缺省 recent + 分页缺省由 service 兜底）', async () => {
    expect((await validateAs(QueryExperienceDto, {})).length).toBe(0);
  });

  it('重复 query 参数（数组）→ 通过：`signals=a&signals=b` 解析为数组后校验通过', async () => {
    expect(
      (await validateAs(QueryExperienceDto, { signals: ['econnrefused', 'port-unreachable'] }))
        .length,
    ).toBe(0);
  });

  it('单值 query 参数自动包成单元素数组（`?signals=a` 不是数组也要能用）', async () => {
    const instance = plainToInstance(QueryExperienceDto, { signals: 'econnrefused' });
    expect(instance.signals).toEqual(['econnrefused']);
    expect(await validate(instance, VALIDATE_OPTIONS)).toHaveLength(0);
  });

  it('数组元素含逗号 → 400（逗号连接会被静默劈成假信号，必须显式拒绝）', async () => {
    expect(
      (await validateAs(QueryExperienceDto, { signals: ['a,b'] })).some(
        (e) => e.property === 'signals',
      ),
    ).toBe(true);
  });

  it('q 超 200 字符 → 400（只走 plainto_tsquery + 绑定参数）', async () => {
    expect(
      (
        await validateAs(QueryExperienceDto, { q: 'a'.repeat(EXPERIENCE_QUERY_MAX_LENGTH + 1) })
      ).some((e) => e.property === 'q'),
    ).toBe(true);
  });

  it('includeExpired/includeSuspect 接受 query 字符串形态 true/false（Boolean("false") === true 的经典坑）', async () => {
    const dto = plainToInstance(QueryExperienceDto, {
      includeExpired: 'true',
      includeSuspect: 'false',
    });
    expect(dto.includeExpired).toBe(true);
    expect(dto.includeSuspect).toBe(false);
    expect(await validate(dto, VALIDATE_OPTIONS)).toHaveLength(0);
  });

  it('intent / quality / sort 值域外 → 400', async () => {
    expect(
      (await validateAs(QueryExperienceDto, { intent: 'bugfix' })).some(
        (e) => e.property === 'intent',
      ),
    ).toBe(true);
    expect(
      (await validateAs(QueryExperienceDto, { quality: 'trusted' })).some(
        (e) => e.property === 'quality',
      ),
    ).toBe(true);
    expect(
      (await validateAs(QueryExperienceDto, { sort: 'newest' })).some((e) => e.property === 'sort'),
    ).toBe(true);
  });

  it(`pageSize 上限 ${EXPERIENCE_MAX_PAGE_SIZE}：超出 / 0 / 负数 → 400`, async () => {
    expect(
      (await validateAs(QueryExperienceDto, { pageSize: EXPERIENCE_MAX_PAGE_SIZE + 1 })).some(
        (e) => e.property === 'pageSize',
      ),
    ).toBe(true);
    expect(
      (await validateAs(QueryExperienceDto, { pageSize: 0 })).some(
        (e) => e.property === 'pageSize',
      ),
    ).toBe(true);
    expect(
      (await validateAs(QueryExperienceDto, { page: -1 })).some((e) => e.property === 'page'),
    ).toBe(true);
    expect((await validateAs(QueryExperienceDto, { pageSize: 100, page: 1 })).length).toBe(0);
  });

  it('createdById：合法 UUID 通过；非 UUID 形态 → 400（铁律 #21：格式错误不得透传到 PG 的 uuid 比较）', async () => {
    expect(
      (
        await validateAs(QueryExperienceDto, {
          createdById: '11111111-1111-4111-8111-111111111111',
        })
      ).length,
    ).toBe(0);
    // 名字（展示值）不是合法取值 —— 契约写死"只收 UUID"
    expect(
      (await validateAs(QueryExperienceDto, { createdById: 'coder' })).some(
        (e) => e.property === 'createdById',
      ),
    ).toBe(true);
    expect(
      (await validateAs(QueryExperienceDto, { createdById: 'not-a-uuid' })).some(
        (e) => e.property === 'createdById',
      ),
    ).toBe(true);
  });
});

describe('ReportExperienceFeedbackDto', () => {
  it('outcome 值域（helped / not_helpful）', async () => {
    expect(
      (await validateAs(ReportExperienceFeedbackDto, { outcome: 'helped', clientRequestId: 'k1' }))
        .length,
    ).toBe(0);
    expect(
      (
        await validateAs(ReportExperienceFeedbackDto, {
          outcome: 'not_helpful',
          clientRequestId: 'k1',
        })
      ).length,
    ).toBe(0);
    expect(
      (
        await validateAs(ReportExperienceFeedbackDto, { outcome: 'useful', clientRequestId: 'k1' })
      ).some((e) => e.property === 'outcome'),
    ).toBe(true);
  });

  it('clientRequestId 必填（表列 NOT NULL；缺失 → 400 而不是落库时才炸）', async () => {
    const errors = await validateAs(ReportExperienceFeedbackDto, { outcome: 'helped' });
    expect(errors.some((e) => e.property === 'clientRequestId')).toBe(true);
  });

  it('clientRequestId 空串 → 400（空键无法承担幂等语义）', async () => {
    expect(
      (
        await validateAs(ReportExperienceFeedbackDto, { outcome: 'helped', clientRequestId: '' })
      ).some((e) => e.property === 'clientRequestId'),
    ).toBe(true);
  });
});

describe('ReviewExperienceQualityDto', () => {
  it('只接受 verified / suspect（unverified 不在值域：撤回结论走内容改写回落）', async () => {
    expect(
      (await validateAs(ReviewExperienceQualityDto, { quality: 'verified', reason: '复现通过' }))
        .length,
    ).toBe(0);
    expect(
      (await validateAs(ReviewExperienceQualityDto, { quality: 'suspect', reason: '无法复现' }))
        .length,
    ).toBe(0);
    expect(
      (await validateAs(ReviewExperienceQualityDto, { quality: 'unverified', reason: 'x' })).some(
        (e) => e.property === 'quality',
      ),
    ).toBe(true);
  });

  it('reason 必填且非空（没有理由的终审事后无法复盘）', async () => {
    expect(
      (await validateAs(ReviewExperienceQualityDto, { quality: 'verified' })).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
    expect(
      (await validateAs(ReviewExperienceQualityDto, { quality: 'verified', reason: '' })).some(
        (e) => e.property === 'reason',
      ),
    ).toBe(true);
  });

  it('reason 超 500 → 400（审计载荷要有界）', async () => {
    expect(
      (
        await validateAs(ReviewExperienceQualityDto, {
          quality: 'verified',
          reason: 'a'.repeat(501),
        })
      ).some((e) => e.property === 'reason'),
    ).toBe(true);
  });
});
