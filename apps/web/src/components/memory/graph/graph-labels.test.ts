/**
 * graph-labels.test.ts — 枚举 → 文案映射的首例测试（2026-10-11 走查修复批补建）。
 *
 * 为什么要有：本模块的不变量「default 分支必须返回原值（域外值原样透传，不冒充已知值）」
 * 此前只是文件头注释，没有任何测试钉住它——注释式不变量等于没有不变量。
 * scope 映射随抽屉人话化新增（`actor_private` → 「仅本项目」等），一并覆盖三值 + 域外。
 */

import { memoryScopeLabel } from './graph-labels';

/** 假 t：把 key 原样返回（断言映射到哪个 key，而不是断言译文本身——译文归 i18n 文件） */
const fakeT = ((key: string) => key) as unknown as Parameters<typeof memoryScopeLabel>[0];

describe('memoryScopeLabel（记忆作用域 → 人话文案）', () => {
  it('值域三值各自映射到专属 key（一值一 key，不共享）', () => {
    expect(memoryScopeLabel(fakeT, 'actor_private')).toBe('graph.scope.actorPrivate');
    expect(memoryScopeLabel(fakeT, 'workspace_shared')).toBe('graph.scope.workspaceShared');
    expect(memoryScopeLabel(fakeT, 'owner_shared')).toBe('graph.scope.ownerShared');
  });

  it('域外值原样透传（不冒充已知值、不返回空串）', () => {
    expect(memoryScopeLabel(fakeT, 'org_wide_v2')).toBe('org_wide_v2');
  });
});
