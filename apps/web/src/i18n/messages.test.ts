/**
 * messages.test.ts — **语言包全量键集守卫**（zh-CN / en）。
 *
 * 为什么要全量（而不是只守本批新增的 namespace）：`en.json` 是 `useTranslations` 的
 * 编译期真相源（`global.d.ts`），zh-CN 少一个键时**不会报错**——运行期静默回落英文，
 * 用户看到的是夹生界面（一半中文一半英文）。这种缺陷只能在"两份文件互相对齐"的层面拦住。
 *
 * 先例：`src/lib/doc-human-export.test.ts`（单 namespace 的键集断言）。那份只覆盖
 * 导出菜单/README 两个小节，本 spec 用 `src/i18n/locale-parity.ts` 的共用工具做**全量递归**
 * 版本——同一逻辑不写第二遍。
 *
 * 覆盖：
 * ① 键集互含（不多不少）；
 * ② 两侧无空文案（键在、文案空 = 界面出现空白行）；
 * ③ 插值占位符一致（`{seconds}` 只在一边存在 = 另一边插值不生效，纯静默故障）；
 * ④ 通知偏好的 10 个类别在两侧都齐备（把 i18n 与 `NOTIFICATION_CATEGORY_KEYS` 单源钉在一起，
 *    漏一个类别的文案 = 偏好区渲染出原始键名）。
 */

import en from '@/i18n/messages/en.json';
import zhCN from '@/i18n/messages/zh-CN.json';
import { checkLocaleParity, flattenMessageEntries, findBlankEntries } from './locale-parity';
import {
  NOTIFICATION_CATEGORY_GROUPS,
  NOTIFICATION_CATEGORY_KEYS,
} from '@/lib/notification-settings';

const report = checkLocaleParity(
  en as unknown as Record<string, unknown>,
  zhCN as unknown as Record<string, unknown>,
);

describe('语言包守卫（en ↔ zh-CN 全量递归）', () => {
  it('键集互含：两份文件不多不少', () => {
    expect(report.keyDiff).toEqual({ onlyInA: [], onlyInB: [] });
  });

  it('两侧无空文案', () => {
    expect({ blankInEn: report.blankInA, blankInZh: report.blankInB }).toEqual({
      blankInEn: [],
      blankInZh: [],
    });
  });

  it('插值占位符逐路径一致', () => {
    expect(report.placeholderDiff).toEqual([]);
  });

  it('总体体检通过（三项合成结论）', () => {
    expect(report.ok).toBe(true);
  });
});

describe('通知偏好文案齐备性（与类别单源钉死）', () => {
  /** 本批新增的 namespace 子树（从真相源里取，避免手抄） */
  const enNotifications = (
    en as unknown as { settings: { notifications: Record<string, unknown> } }
  ).settings.notifications;
  const zhNotifications = (
    zhCN as unknown as { settings: { notifications: Record<string, unknown> } }
  ).settings.notifications;

  const enCategories = (enNotifications.prefs as { categories: Record<string, unknown> })
    .categories;
  const zhCategories = (zhNotifications.prefs as { categories: Record<string, unknown> })
    .categories;

  it('10 个类别在两侧都有 name + description 且非空', () => {
    for (const categories of [enCategories, zhCategories]) {
      expect(Object.keys(categories).sort()).toEqual([...NOTIFICATION_CATEGORY_KEYS].sort());
      for (const key of NOTIFICATION_CATEGORY_KEYS) {
        const entry = categories[key] as { name?: string; description?: string };
        expect(entry.name).toBeTruthy();
        expect(entry.description).toBeTruthy();
      }
    }
  });

  it('4 个分组在两侧都有 title + description', () => {
    for (const notifications of [enNotifications, zhNotifications]) {
      const groups = (notifications.prefs as { groups: Record<string, unknown> }).groups;
      expect(Object.keys(groups).sort()).toEqual(
        NOTIFICATION_CATEGORY_GROUPS.map((g) => g.id).sort(),
      );
      for (const group of NOTIFICATION_CATEGORY_GROUPS) {
        const entry = groups[group.id] as { title?: string; description?: string };
        expect(entry.title).toBeTruthy();
        expect(entry.description).toBeTruthy();
      }
    }
  });

  it('本批 namespace 无空文案（含 tab 标签）', () => {
    expect(findBlankEntries(enNotifications)).toEqual([]);
    expect(findBlankEntries(zhNotifications)).toEqual([]);
  });

  it('摊平工具本身可用（守卫不是空转：能看见真实键）', () => {
    const paths = flattenMessageEntries(enNotifications).map((e) => e.path);
    expect(paths).toContain('prefs.categories.task_done.name');
    expect(paths).toContain('channel.errors.rateLimited.description');
    expect(paths).toContain('prefs.groups.tasks.title');
  });
});
