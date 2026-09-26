/**
 * search-sql 导出组契约单测（批次 0 第 5 项；计划 §2.2/§2.3 形态钉死）。
 *
 * 覆盖：五元组黄金形态 / 参数完整性（每处引用都 set 了参数）/ 无插值负面断言
 * （对象 = 一切编译产物字面量，不止 :q）/ 生成串形态（禁相关子查询、禁 per-row
 * to_tsquery、保留参数名断言——PG 类型名禁作参数名）/ K 覆盖 / 空查询短路 /
 * headline options 构造期校验（9082464c 家族防线）。
 *
 * 纪律：本套件**不访问网络与数据库**；需要真 PG 形态的断言一律在 test/pending/。
 */
import { DataSource } from 'typeorm';
import {
  COMPILED_Q_PARAM,
  HEADLINE_DEFAULT_MAX_WORDS,
  K_GATE_K_PARAM,
  buildSearchSql,
  type SearchSqlGroup,
} from './search-sql';
import { K_GATE_ARM_CAP, compileQuery } from './tsquery-compiler';

/** 四消费方代表列名（别名覆盖 doc-search / messages / tasks / experience 四形态） */
const COLUMNS = { vector: 's.search_vector', text: 's.content' } as const;
const MARKS = { startSel: '<<<', stopSel: '>>>' } as const;

/** 非空编译产物 → 导出组（TS 窄化辅助） */
function buildGroup(q: string, kOverride?: number): SearchSqlGroup {
  const group = buildSearchSql(COLUMNS, compileQuery(q), MARKS, kOverride);
  if (group === null) throw new Error(`expected non-empty compile for ${q}`);
  return group;
}

/**
 * 绑定参数提取（**断言侧**正则，刻意非 TypeORM 同款）：`(?<!:):name` 用 lookbehind
 * 排除 `::tsquery`/`::int` cast 的假参数，只留真绑定参数，用于断言「真参数全部被注册」。
 * 对照事实（m1 勘正）：TypeORM 0.3.30 驱动侧替换正则 = `/:(\.\.\.)?([A-Za-z0-9_.]+)/g`
 * **无 lookbehind**（PostgresDriver.js:648-654 源码级）——它确实会把 `:tsquery` 扫成
 * 候选参数，但未注册名原样 `return full` 保留故 cast 安全；真注册同名参数才会被静默
 * 替换（保留参数名断言正是为堵这条路）。
 */
function extractParams(sql: string): string[] {
  return [...sql.matchAll(/(?<!:):([A-Za-z_]\w*)/g)].map((m) => m[1]);
}

describe('导出组黄金形态（逐字钉死）', () => {
  it('单 bigram 查询的五元组形态', () => {
    const group = buildGroup('出境');
    expect(group.scoreExpr).toBe(`ts_rank_cd(s.search_vector, to_tsquery('simple', :compiledQ))`);
    expect(group.prefilterExpr).toBe(`(s.search_vector @@ to_tsquery('simple', :compiledQ))`);
    expect(group.headlineExpr).toBe(
      `ts_headline('simple', cjk_unigram_text(s.content), to_tsquery('simple', :compiledQ), 'StartSel="<<<", StopSel=">>>", MaxWords=150')`,
    );
    expect(group.kGateExpr).toBe(`((s.search_vector @@ to_tsquery('simple', :arm1))::int >= :kGateK)`);
    expect(group.kGateParams).toEqual({ arm1: `('出'<->'境')`, kGateK: 1 });
  });

  it('多 arm 查询的 kGateExpr = 逐 arm 绑定求和 >= :kGateK（K 起始值 2）', () => {
    const group = buildGroup('证书快过期了怎么处理'); // 10 CJK 字 → 9 arm，K=2
    expect(group.kGateParams[K_GATE_K_PARAM]).toBe(2);
    const armSum = Array.from(
      { length: 9 },
      (_, i) => `(s.search_vector @@ to_tsquery('simple', :arm${i + 1}))::int`,
    ).join(' + ');
    expect(group.kGateExpr).toBe(`(${armSum} >= :kGateK)`);
  });

  it('列名参数化适配四消费方别名', () => {
    const group = buildSearchSql(
      { vector: 'm.search_vector', text: 'm.content' },
      compileQuery('出境'),
      MARKS,
    );
    expect(group?.scoreExpr).toBe(`ts_rank_cd(m.search_vector, to_tsquery('simple', :compiledQ))`);
    expect(group?.headlineExpr).toContain('cjk_unigram_text(m.content)');
  });

  it('headline MaxWords 可覆盖（评估集重定入口）', () => {
    const group = buildSearchSql(COLUMNS, compileQuery('出境'), { ...MARKS, maxWords: 80 });
    expect(group?.headlineExpr).toContain('MaxWords=80');
    expect(HEADLINE_DEFAULT_MAX_WORDS).toBe(150); // 起点 150（计划 §2.2）
  });

  it('doc-search 空标记通道：StartSel="" 恒双引号形态（9082464c 防线）', () => {
    const group = buildSearchSql(COLUMNS, compileQuery('出境'), { startSel: '', stopSel: '' });
    expect(group?.headlineExpr).toContain(`'StartSel="", StopSel="", MaxWords=150'`);
  });
});

describe('参数完整性（每处引用都 set 了参数）', () => {
  it('所有表达式引用的绑定参数 = :compiledQ ∪ kGateParams 键集', () => {
    const group = buildGroup('出境 api 成本总闸');
    const registered = new Set([...Object.keys(group.kGateParams), COMPILED_Q_PARAM]);
    for (const expr of [group.scoreExpr, group.prefilterExpr, group.headlineExpr, group.kGateExpr]) {
      expect(expr).not.toBeNull();
      for (const param of extractParams(expr as string)) {
        expect(registered.has(param)).toBe(true);
      }
    }
    // 反向：kGateParams 里每个 arm 参数都在 kGateExpr 中被引用（无死参数）
    for (const key of Object.keys(group.kGateParams)) {
      expect(group.kGateExpr).toContain(`:${key}`);
    }
  });

  it('保留参数名断言：arm1..armN（1 起连续）+ kGateK，PG 类型名禁作参数名', () => {
    const group = buildGroup('成本总闸');
    const armKeys = Object.keys(group.kGateParams).filter((k) => k !== K_GATE_K_PARAM);
    expect(armKeys).toEqual(['arm1', 'arm2', 'arm3']); // 1 起、连续、无跳号
    // PG 类型名禁作参数名（TypeORM 0.3.30 会把 ::tsquery 扫成假参数——未注册名
    // 原样保留故安全；真注册同名参数则 cast 被静默替换，必须永不可得）
    const PG_TYPE_NAMES = ['tsquery', 'tsvector', 'regconfig', 'text', 'int', 'integer'];
    for (const key of [...Object.keys(group.kGateParams), COMPILED_Q_PARAM]) {
      expect(PG_TYPE_NAMES).not.toContain(key.toLowerCase());
    }
    // kGateExpr 中出现的「假参数」:tsquery 不得被注册
    expect(group.kGateParams).not.toHaveProperty('tsquery');
  });

  it('64 cap 同施：arm 参数数 = arms 数 ≤ 64，arm 参数值 = arm 规范形态文本', () => {
    const chars = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i * 16)).join('');
    const compiled = compileQuery(chars);
    const group = buildSearchSql(COLUMNS, compiled, MARKS);
    expect(compiled.arms).toHaveLength(K_GATE_ARM_CAP);
    const armKeys = Object.keys(group?.kGateParams ?? {}).filter((k) => k !== K_GATE_K_PARAM);
    expect(armKeys).toHaveLength(K_GATE_ARM_CAP);
    for (let i = 0; i < K_GATE_ARM_CAP; i++) {
      expect(group?.kGateParams[`arm${i + 1}`]).toBe(compiled.arms[i]);
    }
  });
});

describe('无插值负面断言（对象 = 一切编译产物字面量，不止 :q）', () => {
  it('生成串不含查询内容字面量（arm 文本只在参数集里）', () => {
    const group = buildGroup('出境 xyz-123 成本总闸');
    for (const expr of [group.scoreExpr, group.prefilterExpr, group.headlineExpr, group.kGateExpr as string]) {
      expect(expr).not.toContain('出');
      expect(expr).not.toContain('境');
      expect(expr).not.toContain('xyz-123');
      expect(expr).not.toContain('成本');
      expect(expr).not.toContain(`('出'<->'境')`);
    }
    // arm 文本的合法落点 = kGateParams 值
    expect(Object.values(group.kGateParams)).toContain(`('出'<->'境')`);
  });

  it('生成串不得引用 :q（旧裸参通道封死）', () => {
    const group = buildGroup('出境');
    for (const expr of [group.scoreExpr, group.prefilterExpr, group.headlineExpr, group.kGateExpr as string]) {
      expect(extractParams(expr)).not.toContain('q');
    }
  });

  it('生成串形态：禁相关子查询；to_tsquery 仅允许 `(\'simple\', :param)` 包裹形态（initplan 一次，非 per-row）', () => {
    const group = buildGroup('证书快过期了怎么处理');
    for (const expr of [group.scoreExpr, group.prefilterExpr, group.headlineExpr, group.kGateExpr as string]) {
      const upper = expr.toUpperCase();
      expect(upper).not.toContain('SELECT'); // 相关子查询 = 4× 自伤写法（实测 16 arm 20.3s）
      // to_tsquery 的合法落点 = `to_tsquery('simple', :绑定参数)` 包裹（initplan 每查询求值
      // 一次）；剥掉全部合法包裹后不得再有 to_tsquery 残留（防 per-row/列引用形态回潮）
      const stripped = expr.replace(/to_tsquery\('simple', :[A-Za-z_]\w*\)/g, '');
      expect(stripped).not.toContain('to_tsquery');
      expect(expr).not.toContain('plainto_tsquery');
      expect(expr).not.toContain('to_tsvector');
    }
  });
});

describe('空查询与无 arm 短路', () => {
  it('空编译产物 → buildSearchSql 返回 null（消费方按面枚举先行短路）', () => {
    expect(buildSearchSql(COLUMNS, compileQuery('「」'), MARKS)).toBeNull();
    expect(buildSearchSql(COLUMNS, compileQuery('   '), MARKS)).toBeNull();
    expect(buildSearchSql(COLUMNS, compileQuery(''), MARKS)).toBeNull();
  });

  it('纯 ASCII 查询：无 arm → kGateExpr=null 且 kGateParams 为空（不挂门）', () => {
    const group = buildGroup('race.service.ts:92');
    expect(group.kGateExpr).toBeNull();
    expect(group.kGateParams).toEqual({});
    // score/prefilter/headline 三段照常产出
    expect(group.scoreExpr).toContain(':compiledQ');
  });

  it('单字 CJK 查询：无 bigram → 不挂门（批次 1 常数分路径接管）', () => {
    const group = buildGroup('闸');
    expect(group.kGateExpr).toBeNull();
    expect(group.kGateParams).toEqual({});
  });
});

describe('K 覆盖与构造期校验', () => {
  it('kOverride 覆盖流入 kGateParams.kGateK（标定矩阵入口，受 arm 数钳制）', () => {
    expect(buildGroup('出境', 2).kGateParams[K_GATE_K_PARAM]).toBe(1); // 仅 1 arm，钳到 1
    expect(buildGroup('成本总闸', 3).kGateParams[K_GATE_K_PARAM]).toBe(3);
    expect(buildGroup('证书快过期了怎么处理', 1).kGateParams[K_GATE_K_PARAM]).toBe(1);
  });

  it('headline 标记含引号 → 构造期 throw（9082464c 家族防线）', () => {
    expect(() => buildSearchSql(COLUMNS, compileQuery('出境'), { startSel: `<'`, stopSel: '>' })).toThrow(
      /startSel/,
    );
    expect(() => buildSearchSql(COLUMNS, compileQuery('出境'), { startSel: '<', stopSel: '>"' })).toThrow(
      /stopSel/,
    );
  });

  it('maxWords 非正整数 → 构造期 throw', () => {
    expect(() =>
      buildSearchSql(COLUMNS, compileQuery('出境'), { ...MARKS, maxWords: 0 }),
    ).toThrow(/maxWords/);
    expect(() =>
      buildSearchSql(COLUMNS, compileQuery('出境'), { ...MARKS, maxWords: 1.5 }),
    ).toThrow(/maxWords/);
  });
});

describe('kOverride 构造期校验（m7：非有限整数 = 开发者错误）', () => {
  it('1.5 / NaN / Infinity → 构造期 throw；合法整数照常', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildSearchSql(COLUMNS, compileQuery('出境'), MARKS, bad)).toThrow(/kOverride/);
    }
    expect(buildGroup('成本总闸', 3).kGateParams[K_GATE_K_PARAM]).toBe(3);
  });
});

describe('TypeORM 真替换断言（getQueryAndParameters · 免连库 · code review 建议）', () => {
  /**
   * 为什么可以免连库：`new DataSource(options)` 构造期即实例化 PostgresDriver，
   * `getQueryAndParameters()` 只触达 `driver.escapeQueryWithParameters`
   * （PostgresDriver.js:648-654 真实现）与 expressionMap——全程不发起连接。
   * 本套件钉的是**真实驱动替换行为**（不是正则模型复述）：命名参数 → `$n` 编号、
   * cast 保留、未注册名原样保留。
   */
  function replaceViaDriver(): { sql: string; params: unknown[] } {
    const ds = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 1, // 永不连接（无 initialize）；占位值
      username: 'spec',
      password: 'spec',
      database: 'spec',
    });
    const compiled = compileQuery('出境');
    const group = buildGroup('出境');
    const qb = ds
      .createQueryBuilder()
      .select(group.scoreExpr, 'score')
      .from('doc_sections', 's')
      .where(group.prefilterExpr)
      .andWhere(group.kGateExpr as string)
      // 未注册名探针：驱动对未注册参数必须原样保留（`:tsquery` 同款安全机制）
      .andWhere('s.position >= :unregisteredFloor')
      .setParameter(COMPILED_Q_PARAM, compiled.tsquery)
      .setParameters(group.kGateParams);
    const [sql, params] = qb.getQueryAndParameters();
    return { sql, params };
  }

  it(':compiledQ 多消费点共用 $1；:arm1 → $2（to_tsquery 包裹内）；:kGateK → $3；未注册名原样保留', () => {
    const { sql, params } = replaceViaDriver();
    // 逐字钉死（真实驱动输出，已实测）：两消费点共用 $1、to_tsquery 包裹原样保留、
    // `::int` cast 保留、未注册名 `:unregisteredFloor` 原样保留
    expect(sql).toBe(
      `SELECT ts_rank_cd(s.search_vector, to_tsquery('simple', $1)) AS "score" FROM "doc_sections" "s" ` +
        `WHERE (s.search_vector @@ to_tsquery('simple', $1)) AND ((s.search_vector @@ to_tsquery('simple', $2))::int >= $3) ` +
        'AND s.position >= :unregisteredFloor',
    );
    // 参数数组 = [compiledQ, arm1, kGateK]（共编号 ⇒ compiledQ 只出现一次）
    expect(params).toEqual([`('出'<->'境')`, `('出'<->'境')`, 1]);
    // 分解断言（防整串断言脆性掩盖机制漂移）
    expect(sql.match(/\$1/g)).toHaveLength(2); // score + prefilter 共用
    expect(sql).toContain(`to_tsquery('simple', $2)`); // 逐 arm 包裹保留
    expect(sql).toContain('::int'); // ::int 不被扫成参数
    expect(sql).not.toContain(':compiledQ');
    expect(sql).not.toContain(':arm1');
    expect(sql).not.toContain(':kGateK');
  });
});
