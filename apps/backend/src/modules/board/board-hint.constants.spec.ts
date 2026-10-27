/**
 * board digest 截断续读常量 ↔ 平台 hint 注册表 **同源守卫** + 零 IO 构造器单测
 * （阶段三，决策 12 / 决策 9）
 *
 * 覆盖：码表与 `BOARD_DIGEST_DEFINITIONS` 双向同源；元数据（family 'read' /
 * ownerSurface 'board_digest' / 24h / 不参与 docspace 排序 / 文案指针）；构造器 data 四字段
 * 与「段 → 该段自己的 limit 参数」映射；resourceKey = boardId（去重键语义）。
 *
 * 注册表侧 board 元数据是**字面量内联**的（依赖方向纪律：`modules/hints` 不能 import
 * `modules/board`）⇒ 码值漂移会让查表静默失败且无报错，故必须有本守卫（方向 board → hints）。
 */
import { getHintDefinition, listHintDefinitions } from '../hints/hint-registry';
import {
  BOARD_DIGEST_SECTION_LIMIT_PARAM,
  BOARD_HINT,
  BOARD_HINT_CODES,
  BOARD_HINT_MESSAGES,
  BOARD_HINT_PROFILE,
  BOARD_HINT_SURFACE,
  buildBoardDigestTruncatedHint,
} from './board-hint.constants';

describe('BOARD_HINT ↔ hint-registry 同源守卫', () => {
  it('BOARD_HINT 的每个码值都在注册表登记', () => {
    for (const code of BOARD_HINT_CODES) {
      expect(getHintDefinition(code)).toBeDefined();
    }
  });

  it("注册表 ownerSurface='board_digest' = 本文件码表之并（无幽灵码、无遗漏）", () => {
    const declared = new Set<string>(BOARD_HINT_CODES);
    const registryCodes = listHintDefinitions({ ownerSurface: BOARD_HINT_SURFACE }).map((d) => d.code);

    expect(registryCodes.length).toBe(declared.size);
    for (const code of registryCodes) expect(declared.has(code)).toBe(true);
  });

  it('注册表元数据：族 read / 产出面 board_digest / 24h（教学定位）/ 不参与 docspace 排序', () => {
    const definition = getHintDefinition(BOARD_HINT.DIGEST_TRUNCATED);
    expect(definition).toMatchObject({
      family: 'read',
      priorityRank: null,
      // 24h：教学定位（分页姿势学一次就够），不是每次提醒
      ttlMs: 24 * 60 * 60 * 1000,
      ownerSurface: BOARD_HINT_SURFACE,
      messageSource: 'modules/board/board-hint.constants.ts BOARD_HINT_MESSAGES[code]',
    });
  });

  it('文案齐备且含「已够用可忽略」出口（教学而非报警）', () => {
    const message = BOARD_HINT_MESSAGES[BOARD_HINT.DIGEST_TRUNCATED];
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('忽略');
    expect(BOARD_HINT_PROFILE.familyOf?.(BOARD_HINT.DIGEST_TRUNCATED)).toBe('read');
    expect(
      BOARD_HINT_PROFILE.resolveMessage({
        code: BOARD_HINT.DIGEST_TRUNCATED,
        status: 'suggestion',
        resourceKey: 'board-1',
      }),
    ).toBe(message);
  });
});

describe('buildBoardDigestTruncatedHint（纯函数构造器）', () => {
  it.each(Object.entries(BOARD_DIGEST_SECTION_LIMIT_PARAM))(
    '段 %s → data 四字段 + suggestedParams 用该段自己的 limit 参数拉全',
    (section, limitParam) => {
      const candidate = buildBoardDigestTruncatedHint(
        'board-1',
        section as keyof typeof BOARD_DIGEST_SECTION_LIMIT_PARAM,
        3,
        25,
      );

      // resourceKey = boardId（去重键 ⇒ 同一看板 24h 内提醒一次）
      expect(candidate.resourceKey).toBe('board-1');
      expect(candidate.code).toBe(BOARD_HINT.DIGEST_TRUNCATED);
      expect(candidate.status).toBe('suggestion');
      expect(candidate.data).toEqual({
        section,
        returnedCount: 3,
        totalCount: 25,
        suggestedTool: 'get_board_digest',
        suggestedParams: { [limitParam]: 25 },
      });
    },
  );

  it('不承诺、不解析：data 是结构化出口，文案里不出现具体数字', () => {
    const candidate = buildBoardDigestTruncatedHint('board-1', 'nextUp', 10, 99);
    expect(JSON.stringify(candidate.data)).toContain('99');
    expect(BOARD_HINT_MESSAGES[BOARD_HINT.DIGEST_TRUNCATED]).not.toContain('99');
  });
});
