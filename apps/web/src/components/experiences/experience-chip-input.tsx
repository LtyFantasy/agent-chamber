'use client';

/**
 * 经验库 chip 输入（signals / domains 共用）
 *
 * 契约要点（与后端 DTO 逐字对齐，`@/lib/experience` 的 `validateExperienceChip` 是唯一
 * 校验入口）：一个 chip 一个关键词 token，**不能含逗号**（逗号 = 把整句报错塞一个
 * 元素，后端 400 并提示 one element per symptom）、元素 ≤50 字符、数组 ≤20 个。
 * 录入/编辑 Dialog 与（未来）列表页过滤条共用本组件，避免两处校验漂移。
 *
 * 交互：回车提交当前输入（并清空）；空输入时按 Backspace 删掉最后一个 chip；
 * 校验失败在下方就地显示原因（不阻断继续输入）。
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { validateExperienceChip, type ExperienceChipError } from '@/lib/experience';

interface ExperienceChipInputProps {
  /** 输入框上方的字段标签（i18n 结果由调用方传入） */
  label: string;
  /** 输入框下方的说明文案（可选；解释匹配语义等） */
  hint?: string;
  /** 输入框 placeholder */
  placeholder?: string;
  /** 当前 chip 列表 */
  values: string[];
  /** 列表变更回调（已归一化去重后的新数组） */
  onChange: (next: string[]) => void;
  /** 元素数上限（signals/domains 各有常量，由调用方传入） */
  max: number;
  /** 输入框 data-testid（测试定位用） */
  testId: string;
}

/** 校验失败原因 → 就地提示文案（显式字面量：next-intl v4 的 key 有编译期校验，禁动态拼） */
function chipErrorMessage(
  t: ReturnType<typeof useTranslations<'experiences'>>,
  reason: ExperienceChipError,
  max: number,
): string {
  switch (reason) {
    case 'comma':
      return t('form.chipComma');
    case 'too_long':
      return t('form.chipTooLong');
    case 'too_many':
      return t('form.chipTooMany', { max });
    default:
      return t('form.chipEmpty');
  }
}

function ExperienceChipInput({
  label,
  hint,
  placeholder,
  values,
  onChange,
  max,
  testId,
}: ExperienceChipInputProps) {
  const t = useTranslations('experiences');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** 回车提交：校验 → 归一化（lowercase，与后端写侧归一化对齐）→ 去重追加 */
  const commit = () => {
    const invalid = validateExperienceChip(draft, values, max);
    if (invalid) {
      setError(chipErrorMessage(t, invalid, max));
      return;
    }
    const normalized = draft.trim().toLowerCase();
    if (!values.includes(normalized)) onChange([...values, normalized]);
    setDraft('');
    setError(null);
  };

  /** 移除指定 chip */
  const remove = (value: string) => {
    onChange(values.filter((v) => v !== value));
    setError(null);
  };

  return (
    <div className="space-y-1.5">
      {/* label ↔ input 显式关联（评审 minor 5）：id 由 testId 派生，保证多实例（signals/domains）不撞 */}
      <label htmlFor={testId} className="text-sm font-medium">
        {label}
      </label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-chips`}>
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-xs text-foreground/80"
            >
              {value}
              <button
                type="button"
                aria-label={`${t('form.removeChip')}: ${value}`}
                onClick={() => remove(value)}
                className="opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={testId}
        data-testid={testId}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // 阻止表单内回车触发提交（chip 输入的回车是"添加"，不是"提交表单"）
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && draft.length === 0 && values.length > 0) {
            remove(values[values.length - 1]);
          }
        }}
      />
      {error ? (
        <p className={cn('text-xs text-destructive')} data-testid={`${testId}-error`}>
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export { ExperienceChipInput };
