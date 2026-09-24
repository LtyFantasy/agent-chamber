/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）输入字段的 class-validator 自定义校验器
 *
 * [代码职责]
 *   - signals / domains 数组元素形状（**逗号残留拒绝** + 长度 + 非空）与 env 键白名单
 *     的校验装饰器（Create 与 Query 两套 DTO 共用同一实现，禁各自内联一份）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（匹配契约：归一化 + ANY-overlap +
 *     传参协议）/§3（API 契约 DTO 约束）/§7（DTO 测试点）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（序列化协议）
 *
 * [关键不变量]
 *   - **逗号必须被拒绝**（plan §2 跨通道序列化钉死）：REST 传数组用**重复 query 参数**
 *     （`?signals=a&signals=b`），逗号连接的形态一律 400——报错信号原文含逗号是常态，
 *     一旦允许逗号拆分，`signals=ECONNREFUSED, connect failed` 会被静默劈成两条假信号。
 *     文案必须指导正确写法（"一个元素一条症状"），而不是只说"invalid"
 *   - env 键白名单单源 = shared `EXPERIENCE_ENV_KEYS`（本文件不手抄键清单）；400 文案
 *     **回显合法键**——写入者枚举受控键的唯一通道（值开放，键受控）
 *   - 校验只看**原始值**的形状与长度；归一化（trim + lowercase）在 service 层做，
 *     两者不许互相代劳（DTO 归一化会让 e2e 分不清"归一化生效"与"校验放行"）
 *
 * [关联代码]
 *   - dto/create-experience.dto.ts / dto/query-experience.dto.ts — 两个消费方
 *   - experience.service.ts — 归一化执行点（本文件只校验形状）
 *   - packages/shared/src/dto/experience.dto.ts — EXPERIENCE_ENV_KEYS 键白名单单源
 *
 * [持久踩坑]
 *   EXPERIENCE-COMMA-SPLIT(逗号静默劈裂): 若照 `labels` 先例在 @Transform 里按逗号
 *     split（task 模块 labels 正是该形态），含逗号的症状串会被无声拆成多条假信号，
 *     检索侧从此既搜不到也查不出错。安全方向: 数组元素校验**显式拒绝逗号**，并把
 *     "正确写法"写进 400 文案。
 * =============================================================================
 */
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { EXPERIENCE_ENV_KEYS } from '@agent-chamber/shared';
import {
  EXPERIENCE_ELEMENT_MAX_LENGTH,
  EXPERIENCE_ENV_VALUE_MAX_LENGTH,
} from '../experience.constants';

/** 元素级校验的失败原因（用于拼可操作的中文/英文混排文案） */
interface ElementIssue {
  index: number;
  reason: 'empty' | 'comma' | 'too-long' | 'not-string';
  length?: number;
}

/**
 * signals / domains 数组的**元素级**校验器实现（供两个装饰器共用）。
 *
 * 只做元素形状校验：数组容器本身由 `@IsArray()` 承担，元素数量上限由
 * `@ArrayMaxSize()` 承担（各自文案独立，便于定位）。
 */
class ExperienceElementsConstraint implements ValidatorConstraintInterface {
  constructor(
    private readonly maxLength: number,
    private readonly label: string,
  ) {}

  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return true; // 容器形状交给 @IsArray
    return this.collectIssues(value).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const issues = this.collectIssues(args.value as unknown[]);
    const first = issues[0];
    if (!first) return `${args.property} contains an invalid ${this.label} element`;
    if (first.reason === 'comma') {
      return (
        `${args.property}[${first.index}] contains a comma — pass ONE ${this.label} per element ` +
        `using repeated query parameters (e.g. \`?${args.property}=a&${args.property}=b\`); ` +
        `comma-joined values are rejected because real error strings contain commas. ` +
        `一个元素一条${this.label}：请用重复参数传数组，勿用逗号连接`
      );
    }
    if (first.reason === 'empty') {
      return `${args.property}[${first.index}] is empty after trimming — each ${this.label} must be a non-empty token`;
    }
    if (first.reason === 'too-long') {
      return `${args.property}[${first.index}] is ${first.length} characters, exceeding the ${this.maxLength}-character limit — extract the distinguishing keyword (e.g. \`ECONNREFUSED\`), not the full error sentence`;
    }
    return `${args.property}[${first.index}] must be a string`;
  }

  /** 收集全部违规元素（只取第一条拼文案，但校验是全量的） */
  private collectIssues(value: unknown[]): ElementIssue[] {
    const issues: ElementIssue[] = [];
    value.forEach((element, index) => {
      if (typeof element !== 'string') {
        issues.push({ index, reason: 'not-string' });
        return;
      }
      if (element.includes(',')) {
        issues.push({ index, reason: 'comma' });
        return;
      }
      const trimmed = element.trim();
      if (trimmed.length === 0) {
        issues.push({ index, reason: 'empty' });
        return;
      }
      if (trimmed.length > this.maxLength) {
        issues.push({ index, reason: 'too-long', length: trimmed.length });
      }
    });
    return issues;
  }
}

/**
 * 装饰器：数组元素必须是「单个 token」（无逗号、trim 后非空、≤50 字符）。
 *
 * @param label 元素语义标签（进 400 文案，如 'signal' / 'domain tag'）
 */
function IsExperienceElements(label: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isExperienceElements',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: new ExperienceElementsConstraint(EXPERIENCE_ELEMENT_MAX_LENGTH, label),
    });
  };
}

/** signals 元素校验（≤50 字符、无逗号、非空；文案含"一个元素一条症状"） */
export function IsExperienceSignals(validationOptions?: ValidationOptions) {
  return IsExperienceElements('signal', validationOptions);
}

/** domains 元素校验（与 signals 同形；文案标签换为 domain tag） */
export function IsExperienceDomains(validationOptions?: ValidationOptions) {
  return IsExperienceElements('domain tag', validationOptions);
}

/**
 * env 键白名单校验器实现（键受控、值开放）。
 *
 * 逐项 rationale：
 * - **键必须 ∈ EXPERIENCE_ENV_KEYS**：键不收敛，同一环境指纹会被写成 os/osName/platform
 *   三种，精确相等匹配随之失效（plan §2）——400 文案回显合法键，让写入者知道可选集；
 * - **值必须是非空字符串且 ≤100 字符**：值开放（工具/运行时取值域无法穷举）但要有界，
 *   否则 env jsonb 可被塞进任意长大文本；
 * - 空对象 `{}` 合法（经验允许只写「哪个工具 + 哪个版本」而不写其他键）。
 */
class ExperienceEnvConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true; // 可空性交给 @IsOptional
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return this.inspect(value as Record<string, unknown>).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const problems = this.inspect((args.value ?? {}) as Record<string, unknown>);
    const legal = EXPERIENCE_ENV_KEYS.join(', ');
    const unknownKeys = problems.filter((p) => p.kind === 'unknown-key').map((p) => p.key);
    const badValues = problems.filter((p) => p.kind === 'bad-value').map((p) => p.key);
    if (unknownKeys.length > 0) {
      return (
        `${args.property} contains unknown key(s): ${unknownKeys.join(', ')}. ` +
        `env keys are a controlled whitelist; legal keys are: ${legal}. ` +
        `Values stay open (any tool/runtime value is allowed).`
      );
    }
    if (badValues.length > 0) {
      return (
        `${args.property}.${badValues.join(', ')} must be a non-empty string of at most ` +
        `${EXPERIENCE_ENV_VALUE_MAX_LENGTH} characters`
      );
    }
    return `${args.property} must be an object mapping whitelisted keys (${legal}) to string values`;
  }

  /** 收集 key/value 级违规项 */
  private inspect(
    value: Record<string, unknown>,
  ): { kind: 'unknown-key' | 'bad-value'; key: string }[] {
    const problems: { kind: 'unknown-key' | 'bad-value'; key: string }[] = [];
    for (const [key, raw] of Object.entries(value)) {
      if (!(EXPERIENCE_ENV_KEYS as readonly string[]).includes(key)) {
        problems.push({ kind: 'unknown-key', key });
        continue;
      }
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        problems.push({ kind: 'bad-value', key });
        continue;
      }
      if (raw.trim().length > EXPERIENCE_ENV_VALUE_MAX_LENGTH) {
        problems.push({ kind: 'bad-value', key });
      }
    }
    return problems;
  }
}

/**
 * 装饰器：env 必须是「白名单键 + 字符串值」的对象（键白名单外 400 并回显合法键）。
 */
export function IsExperienceEnv(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isExperienceEnv',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: new ExperienceEnvConstraint(),
    });
  };
}

/**
 * 查询串布尔参数变换（`?includeExpired=true` → true）。
 *
 * rationale：query 参数天然是字符串，NestJS 的 `@Type(() => Boolean)` 会把 `'false'`
 * 变成 `true`（Boolean('false') === true）——这是该写法在全仓被避免的原因。显式白名单
 * 转换只认 `'true'`/`'1'` 才为真，其余一律假（含 `'false'`/空串）。
 */
export function ToBoolean(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });
}
