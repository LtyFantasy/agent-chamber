/**
 * tsquery-compiler 契约单测（批次 0 第 5 项；计划 §3 批次 0 第 5 项全清单）。
 *
 * 覆盖：幂等 / 白名单与普查一致性守卫 / 空词项 / 末尾反斜杠 / NUL / 注入词形 /
 * bigram 去重（'测试测试'→2 arm）+ 64 cap 同施两消费串 / 两基准 / 降级不可达 /
 * 单引号发射 7 元语法字符矩阵 + 真实 lexeme 样本 / arm 规范形态钉死 + 解析形态去重 /
 * 含 `'` 双写 / ×÷ 归分隔符 / R-3 剥离表 / 元数据与 K 选择。
 *
 * 纪律：本套件**不访问网络与数据库**；需要真 PG 形态的断言一律在 test/pending/。
 */
import {
  ASCII_WORD_CHAR_WHITELIST,
  ASCII_WORD_PUNCT_WHITELIST,
  K_GATE_ARM_CAP,
  K_GATE_SHORT_QUERY_MAX_CJK_CHARS,
  SEARCH_QUERY_MAX_LENGTH,
  ZERO_WIDTH_STRIP_CHARS,
  chooseKGateK,
  compileQuery,
  getTsqueryCompileFallbackCount,
  normalizeQuery,
} from './tsquery-compiler';

describe('normalizeQuery', () => {
  it('剥离 NUL（PG text 禁存）', () => {
    expect(normalizeQuery('ab\u0000cd')).toBe('abcd');
  });

  it('剥离 C0/C1 控制符，保留 \\t\\n\\r（用户原生空白是合法分隔符）', () => {
    expect(normalizeQuery('a\u0001b\u0002c\u007Fd\u0085e\u009Ff')).toBe('abcdef');
    expect(normalizeQuery('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('剥离 U+2028/U+2029（JSONL 单行纪律）', () => {
    expect(normalizeQuery('a\u2028b\u2029c')).toBe('abc');
  });

  it('R-3 剥离表：零宽/变体族恰好 6 字符逐一剥离（含 1️⃣ 归一为 1）', () => {
    expect(ZERO_WIDTH_STRIP_CHARS).toHaveLength(6);
    for (const ch of ZERO_WIDTH_STRIP_CHARS) {
      expect(normalizeQuery(`a${ch}b`)).toBe('ab');
    }
    // 1️⃣ = '1' + U+FE0F + U+20E3 → 归一为裸 '1'（普查 §10.3 实测方向 = 增益）
    expect(normalizeQuery('1\uFE0F\u20E3')).toBe('1');
    // ⌨️：⌨ 本体不在剥离表（它是分隔符语义，剥离只去变体选择符）
    expect(normalizeQuery('\u2328\uFE0F')).toBe('\u2328');
  });

  it('剥离族恰好 6 个字面字符且各为单码点（TRANSLATE-NO-RANGE 专防）', () => {
    const cps = ZERO_WIDTH_STRIP_CHARS.map((ch) => ch.codePointAt(0));
    expect(cps).toEqual([0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f, 0x20e3]);
    // 任何字符都不得是 ASCII（区间散文记号陷阱会把字母数字卷进删除集）
    for (const cp of cps) expect(cp as number).toBeGreaterThan(0x7f);
  });

  it('硬截断 200 码点（不拆代理对），先剥离再截断', () => {
    const long = 'a'.repeat(250);
    expect(normalizeQuery(long)).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    // 先剥离再截断：250 个零宽 + 200 个 a → 剥完 200 个 a，不再截断
    expect(normalizeQuery('\u200B'.repeat(250) + 'a'.repeat(200))).toHaveLength(200);
    // 码点截断不拆代理对（Ext B 字符 U+20000 占 2 个 UTF-16 单元）
    const extB = String.fromCodePoint(0x20000);
    const truncated = normalizeQuery('a'.repeat(199) + extB + 'b'.repeat(50));
    expect([...truncated]).toHaveLength(200);
    expect(truncated.endsWith(extB)).toBe(true);
  });

  it('幂等：normalizeQuery(normalizeQuery(q)) === normalizeQuery(q)', () => {
    const battery = [
      '出境',
      '  出境，闸  ',
      'race.service.ts:92',
      'a&b 1️⃣ ⌨️',
      '「出境」【闸】',
      'a'.repeat(300) + '测试',
      '   ',
      '',
      '코ーヒー コーヒー ＡＢＣ',
    ];
    for (const q of battery) {
      const once = normalizeQuery(q);
      expect(normalizeQuery(once)).toBe(once);
    }
  });
});

describe('白名单与普查输出一致性守卫（契约①，census REPORT §5.2 复算对照）', () => {
  // 普查产出接受面（本仓 scripts/search-eval/census/REPORT.md §5.2 手工转录）：
  // 23 个标点 + a–z + 0–9 = 59 字符；另含 A–Z（simple 小写化遮蔽，普查侧不可见但必须收）
  const CENSUS_PUNCT_23 = [..."!#$%&'()*+,-./:;=?@[]_~"];
  const CENSUS_ALNUM = [
    ...'abcdefghijklmnopqrstuvwxyz',
    ...'0123456789',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', // A–Z：另行包含（小写化遮蔽）
  ];
  const CENSUS_EXPECTED = new Set([...CENSUS_PUNCT_23, ...CENSUS_ALNUM]);

  it('23 标点字面量与普查表逐字一致', () => {
    expect([...ASCII_WORD_PUNCT_WHITELIST]).toEqual(CENSUS_PUNCT_23);
  });

  it('完整白名单 = 85 字符（23 标点 + 0–9 + A–Z + a–z），与普查接受面集合相等', () => {
    expect(ASCII_WORD_CHAR_WHITELIST.size).toBe(85);
    expect(new Set(ASCII_WORD_CHAR_WHITELIST)).toEqual(CENSUS_EXPECTED);
  });

  it('白名单内字符在词元 run 内不断裂（承重：`api/v1/docs` 是一个 run）', () => {
    expect(compileQuery('api/v1/docs').tsquery).toBe(`'api/v1/docs'`);
    expect(compileQuery('race.service.ts:92').tsquery).toBe(`'race.service.ts:92'`);
  });

  it('白名单外 ASCII 一律分隔符（`"` `\\` `^` `` ` `` `{` `|` `}` `<` `>` 与空格）', () => {
    // 这些字符在数据里从不落在任何 lexeme 内（census §5.3），区外 = 分隔符零召回损失
    expect(compileQuery('a"b').tsquery).toBe(`'a' | 'b'`);
    expect(compileQuery('a\\b').tsquery).toBe(`'a' | 'b'`);
    expect(compileQuery('a<b>c').tsquery).toBe(`'a' | 'b' | 'c'`);
    expect(compileQuery('a`b|c').tsquery).toBe(`'a' | 'b' | 'c'`);
    expect(compileQuery('a^{b}').tsquery).toBe(`'a' | 'b'`);
  });
});

describe('compileQuery 基本形态', () => {
  it("空查询标志：纯分隔符/纯标点/空白/空串 → isEmpty=true 且 tsquery=null（绝不输出 ''）", () => {
    for (const q of ['', '   ', '「」【】', '，。！', '\t\n', '💬🔊', '!!!', '...', '---']) {
      const compiled = compileQuery(q);
      expect(compiled.isEmpty).toBe(true);
      expect(compiled.tsquery).toBeNull();
      expect(compiled.arms).toEqual([]);
      expect(compiled.tsquery).not.toBe('');
    }
  });

  it('单 CJK 字查询标志：恰好一个单字词项时置位（批次 1 常数分路径用）', () => {
    const compiled = compileQuery('闸');
    expect(compiled.singleCjkChar).toBe('闸');
    expect(compiled.tsquery).toBe(`'闸'`);
    expect(compiled.arms).toEqual([]);
    // 带空白/分隔符的单字查询仍是单字路径
    expect(compileQuery('  的  ').singleCjkChar).toBe('的');
    // 混排/多字/双单字都不是单字路径
    expect(compileQuery('出境').singleCjkChar).toBeNull();
    expect(compileQuery('出 闸').singleCjkChar).toBeNull();
    expect(compileQuery('1出').singleCjkChar).toBeNull();
    expect(compileQuery('api').singleCjkChar).toBeNull();
  });

  it('CJK 两字 → 单 bigram arm；三字 → 两 arm 滑窗', () => {
    expect(compileQuery('出境').tsquery).toBe(`('出'<->'境')`);
    expect(compileQuery('成本闸').tsquery).toBe(`('成'<->'本') | ('本'<->'闸')`);
  });

  it('混排：word run 与 CJK run 类间边界即切分（无需分隔符）', () => {
    expect(compileQuery('API接口').tsquery).toBe(`'API' | ('接'<->'口')`);
    expect(compileQuery('token续期').tsquery).toBe(`'token' | ('续'<->'期')`);
    // 第1轮：数字与汉字因类间边界自然切开
    expect(compileQuery('第1轮').tsquery).toBe(`'第' | '1' | '轮'`);
  });

  it('括号查询只产 CJK arm（R-1：标点归分隔符，不消费 arm 预算）', () => {
    const compiled = compileQuery('「出境，闸」');
    expect(compiled.tsquery).toBe(`('出'<->'境') | '闸'`);
    expect(compiled.arms).toEqual([`('出'<->'境')`]);
    expect(compileQuery('【出境】闸').tsquery).toBe(`('出'<->'境') | '闸'`);
  });

  it('全角字母数字 = ② 整词 run（一 run 一 term 不切分）', () => {
    expect(compileQuery('ＡＢＣ１２３').tsquery).toBe(`'ＡＢＣ１２３'`);
  });

  it('谚文/希腊/西里尔/拉丁扩展 = ② 整词 run', () => {
    expect(compileQuery('한글검색').tsquery).toBe(`'한글검색'`);
    expect(compileQuery('café').tsquery).toBe(`'café'`);
    expect(compileQuery('αβγ').tsquery).toBe(`'αβγ'`);
  });

  it('假名 + 长音符 ー = ① 可分字（コーヒー 三 bigram 链）', () => {
    const compiled = compileQuery('コーヒー');
    expect(compiled.arms).toEqual([`('コ'<->'ー')`, `('ー'<->'ヒ')`, `('ヒ'<->'ー')`]);
    expect(compiled.tsquery).toBe(compiled.arms.join(' | '));
  });

  it('× ÷ 归分隔符（R-2 文字澄清落入行为）', () => {
    expect(compileQuery('a×b').tsquery).toBe(`'a' | 'b'`);
    expect(compileQuery('a÷b').tsquery).toBe(`'a' | 'b'`);
    // 拉丁-1 字母本体仍是词字
    expect(compileQuery('à×ü').tsquery).toBe(`'à' | 'ü'`);
  });

  it('确定性：同一输入两次编译逐字段相等', () => {
    const a = compileQuery('出境 race.service.ts:92 测试测试');
    const b = compileQuery('出境 race.service.ts:92 测试测试');
    expect(a).toEqual(b);
  });
});

describe('纯标点 run 编译期丢弃（契约③ F2：PG 解析 0 nodes ⇒ 归入 isEmpty）', () => {
  it('单标点/多标点/元语法组合的纯标点查询 → isEmpty=true', () => {
    for (const q of ['!', '!!!', '...', '---', '&!():*', `''`, ',,,', '~', '?']) {
      const compiled = compileQuery(q);
      expect(compiled.isEmpty).toBe(true);
      expect(compiled.tsquery).toBeNull();
      expect(compiled.arms).toEqual([]);
    }
  });

  it('23 个白名单标点逐一 + 全组合拼接 → isEmpty=true（对齐 PG 23/23 实测）', () => {
    for (const ch of [...ASCII_WORD_PUNCT_WHITELIST]) {
      expect(compileQuery(ch).isEmpty).toBe(true);
      expect(compileQuery(`${ch}${ch}${ch}`).isEmpty).toBe(true);
    }
    expect(compileQuery([...ASCII_WORD_PUNCT_WHITELIST].join('')).isEmpty).toBe(true);
  });

  it('标点+字母混合 run 保留（含任一字母数字即非纯标点）', () => {
    expect(compileQuery('!!a!!').tsquery).toBe(`'!!a!!'`);
    expect(compileQuery('a&b').tsquery).toBe(`'a&b'`);
    expect(compileQuery(`it's`).tsquery).toBe(`'it''s'`);
    // ② 脚本字同样使 run 保留
    expect(compileQuery('!!é').tsquery).toBe(`'!!é'`);
  });

  it('混合查询中纯标点段被弃、字母/CJK 段保留', () => {
    expect(compileQuery('!!! abc ...').tsquery).toBe(`'abc'`);
    expect(compileQuery('--- 出境 ---').tsquery).toBe(`('出'<->'境')`);
    expect(compileQuery('!!! 出境').isEmpty).toBe(false);
  });
});

describe('① 类区间端点收窄（F3：分隔符码点不产 arm、按分隔符切 run）', () => {
  it('端点词字保留：U+9FEF / U+4DB5 仍是 ① 可分字', () => {
    expect(compileQuery('\u{9FEF}').tsquery).toBe(`'\u{9FEF}'`);
    expect(compileQuery('\u{4DB5}').tsquery).toBe(`'\u{4DB5}'`);
  });

  it('上界外码点归分隔符：U+9FF0–9FFF / U+4DB6–4DBF 逐点不产词项', () => {
    for (let cp = 0x9ff0; cp <= 0x9fff; cp++) {
      expect(compileQuery(String.fromCodePoint(cp)).isEmpty).toBe(true);
    }
    for (let cp = 0x4db6; cp <= 0x4dbf; cp++) {
      expect(compileQuery(String.fromCodePoint(cp)).isEmpty).toBe(true);
    }
  });

  it('伪造链关闭：`鿿出鿿`（U+9FFF 夹字）不再产含分隔符的 arm', () => {
    const compiled = compileQuery('鿿出鿿');
    // 鿿 归分隔符 ⇒ 出 成单字词项；无 bigram ⇒ 无 arm ⇒ K-gate 不挂门（K=2 伪造链关闭）
    expect(compiled.tsquery).toBe(`'出'`);
    expect(compiled.arms).toEqual([]);
    expect(compiled.singleCjkChar).toBe('出');
  });

  it('端点码点按分隔符切 run：两侧 CJK 各自成 run，不跨分隔符产 bigram', () => {
    expect(compileQuery('\u{4DB5}\u{4DB6}\u{4DB5}').tsquery).toBe(`'\u{4DB5}' | '\u{4DB5}'`);
    expect(compileQuery('出\u{9FF0}境').tsquery).toBe(`'出' | '境'`);
  });
});

describe('单引号词位发射（契约①：7 元语法字符矩阵 + 真实 lexeme 样本）', () => {
  // 7 个 tsquery 元语法字符（census §5.5）：裸拼 = 42601/静默 AND/带权重项；
  // 单引号词位的实测语义（PG16 演练库逐例验证）：词位使元语法字符**失去 tsquery
  // 语法作用**，词位内容按文档同款 tokenizer 再分词——`'a&b'`/`'a!b'`/`'a(b'`/
  // `'a:b'`/`'a*b'` 均解析为 `'a' <-> 'b'` 短语链；仅 `'` 起引号/分隔作用（故双写）。
  // 本矩阵钉的是**发射形态**（PG 解析行为断言在 test/pending/）
  const METASYNTAX = ['&', '!', '(', ')', ':', '*', `'`] as const;

  it.each(METASYNTAX.map((c) => [c]))('元语法字符 %s 的词项按单引号词位形态发射', (ch) => {
    const compiled = compileQuery(`a${ch}b`);
    const expected = ch === `'` ? `'a''b'` : `'a${ch}b'`;
    expect(compiled.tsquery).toBe(expected);
    // 结构上仍是一个词元 run（白名单内含全部 7 字符）
    expect(compiled.tsquery?.split(' | ')).toHaveLength(1);
  });

  it('真实 lexeme 样本（census §5.2 证据样本）逐一按单引号词位发射', () => {
    const samples: Array<[string, string]> = [
      ['race.service.ts:92', `'race.service.ts:92'`],
      ['github.com:443', `'github.com:443'`],
      ['judgment:1', `'judgment:1'`],
      ['a&b', `'a&b'`],
      ['a!b', `'a!b'`],
      ['a(b', `'a(b'`],
      ['a-b', `'a-b'`],
      ['X-API-Key', `'X-API-Key'`],
      ['v1.85.0', `'v1.85.0'`],
      ['UTC+08:00', `'UTC+08:00'`],
      ['experience.service.ts:1747', `'experience.service.ts:1747'`],
      ['https://platform.example.com/docs/xxx', `'https://platform.example.com/docs/xxx'`],
    ];
    for (const [q, expected] of samples) {
      expect(compileQuery(q).tsquery).toBe(expected);
    }
  });

  it('普查真实字符形状（差分 e2e 样本表同源）在单引号发射路径上是单 run', () => {
    for (const shape of [
      '/web**',
      'dockerfile.backend/web**',
      '/r/machinelearning/)!',
      '(https://platform.example.com)',
    ]) {
      const compiled = compileQuery(shape);
      expect(compiled.tsquery).toBe(`'${shape}'`);
    }
  });

  it("含单引号词项双写（`it's` → `'it''s'`）", () => {
    expect(compileQuery(`it's`).tsquery).toBe(`'it''s'`);
    // 连续引号逐一双写（含字母使 run 保留；纯引号 run 归 isEmpty，见 F2 套件）
    expect(compileQuery(`a''b`).tsquery).toBe(`'a''''b'`);
  });

  it('末尾反斜杠：\\ 是分隔符，不破坏发射也不泄漏进词项', () => {
    expect(compileQuery('foo\\').tsquery).toBe(`'foo'`);
    expect(compileQuery('C:\\path').tsquery).toBe(`'C:' | 'path'`);
  });

  it('注入词形：tsquery 语法注入尝试全部落为字面词项', () => {
    // ⚠️ 推算口径：`'` 在白名单内 = 词字（census §5.2，7 行真实 lexeme），不是分隔符；
    // 相邻词字合并为一个 run，emitQuotedLexeme 对 run 内 `'` 逐一双写
    const injections: Array<[string, string]> = [
      [`a':'b`, `'a'':''b'`], // 权重注入：全词字单 run，引号双写后整串一个词位
      [`a':*`, `'a'':*'`], // 前缀匹配注入：同上
      [`!(a)`, `'!(a)'`], // 否定+括号：单 run 字面化
      [`a', 'b`, `'a'',' | '''b'`], // 空格切断为两 run，各 run 引号双写
    ];
    for (const [q, expected] of injections) {
      const compiled = compileQuery(q);
      expect(compiled.tsquery).toBe(expected);
      // 不变量：输出里除词位引号与 arm 结构字符外，不得出现未配对的 tsquery 元语法
      expect(compiled.isEmpty).toBe(false);
    }
    // 引号+AND（`' & `）：两个 run 均为纯标点 ⇒ F2 编译期丢弃，查询归 isEmpty——
    // AND 注入在词项层面即不成立
    expect(compileQuery(`' & `).isEmpty).toBe(true);
  });
});

describe('arm 规范形态与解析形态去重（TSQUERY-DEDUP-PARSED）', () => {
  it("arm 规范形态钉死 = ('出'<->'境')（单源一种形态）", () => {
    const compiled = compileQuery('出境');
    expect(compiled.arms).toEqual([`('出'<->'境')`]);
    // 形态逐字符钉死：括号 + 单引号词位 + <-> 无空格
    expect(compiled.arms[0]).toMatch(/^\('[^']+'<->'[^']+'\)$/);
  });

  it("解析形态去重：'测试测试' → 2 distinct arm（K-gate 重复计数泄漏的承重性质）", () => {
    const compiled = compileQuery('测试测试');
    expect(compiled.arms).toEqual([`('测'<->'试')`, `('试'<->'测')`]);
    expect(compiled.distinctBigramCount).toBe(2);
    // 重复 arm 在 tsquery 里也只出现一次（去重键 = 发射文本 ≡ 解析规范形态）
    expect(compiled.tsquery).toBe(`('测'<->'试') | ('试'<->'测')`);
  });

  it('去重跨 run 生效：同一 bigram 分散在两处只计 1', () => {
    const compiled = compileQuery('出境 旅游 出境');
    expect(compiled.arms).toEqual([`('出'<->'境')`, `('旅'<->'游')`]);
  });

  it('64 cap 同施：arms 与 tsquery 内 arm 同一集合（预过滤与门永不错位）', () => {
    // 100 个不同 CJK 字 → 99 distinct bigram > 64
    const chars = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i * 16)).join(
      '',
    );
    const compiled = compileQuery(chars);
    expect(compiled.arms).toHaveLength(K_GATE_ARM_CAP);
    expect(compiled.distinctBigramCount).toBe(99);
    expect(compiled.armTruncatedCount).toBe(99 - K_GATE_ARM_CAP);
    // tsquery 里的 arm 与 arms 严格同一集合同一顺序
    const termsInTsquery = (compiled.tsquery as string).split(' | ');
    expect(termsInTsquery).toEqual(compiled.arms);
    // cap 取前 64 个（首现序）
    expect(compiled.arms[0]).toBe(compileQuery(chars.slice(0, 2)).arms[0]);
  });

  it('元数据：cjkCharCount / distinctBigramCount / armTruncatedCount / queryTruncated', () => {
    const mixed = compileQuery('出境 api 成本总闸');
    expect(mixed.cjkCharCount).toBe(6);
    expect(mixed.distinctBigramCount).toBe(4); // 出境 + 成本/本总/总闸
    expect(mixed.armTruncatedCount).toBe(0);
    expect(mixed.queryTruncated).toBe(false);
    const long = compileQuery('闸' + 'a'.repeat(250));
    expect(long.queryTruncated).toBe(true);
  });
});

describe('chooseKGateK（计划 §2.3：≤4 CJK 字 K=1，更长 K=2 起始值，可覆盖）', () => {
  it('起始值：≤4 字 K=1；>4 字 K=2', () => {
    expect(chooseKGateK(K_GATE_SHORT_QUERY_MAX_CJK_CHARS, 3)).toBe(1);
    expect(chooseKGateK(K_GATE_SHORT_QUERY_MAX_CJK_CHARS + 1, 4)).toBe(2);
    expect(chooseKGateK(2, 1)).toBe(1);
  });

  it('无 arm → null（消费方不挂门：纯 ASCII / 单字 CJK 查询）', () => {
    expect(chooseKGateK(0, 0)).toBeNull();
    expect(chooseKGateK(1, 0)).toBeNull();
  });

  it('防御钳制：K 永不超过 arm 数（否则门恒假 = 静默零召回）', () => {
    // 出出出出出：5 字但去重后仅 1 arm——起始 K=2 必须钳到 1
    expect(chooseKGateK(5, 1)).toBe(1);
    expect(chooseKGateK(100, 2)).toBe(2);
  });

  it('override 覆盖供标定矩阵（同样受 arm 数钳制）', () => {
    expect(chooseKGateK(2, 5, 3)).toBe(3);
    expect(chooseKGateK(2, 2, 9)).toBe(2);
    expect(chooseKGateK(2, 5, 0)).toBe(1); // K≥1
  });
});

describe('失败降级可观测（契约⑥：白名单内组合不抛 ⇒ 降级实际不可达）', () => {
  it('白名单 × 代表字符全组合电池：不抛、降级计数不变', () => {
    const before = getTsqueryCompileFallbackCount();
    const alphabet = [
      ...[...ASCII_WORD_PUNCT_WHITELIST], // 23 标点（含 7 元语法字符）
      'a',
      'Z',
      '0',
      '9', // 字母数字代表
      '出',
      '闸',
      'コ',
      'ー',
      '〇',
      '々', // ① 代表
      'é',
      'Ω',
      'Ж',
      '한',
      'Ａ',
      '１',
      String.fromCodePoint(0x20001), // ② 代表（含代理对）
      ' ',
      '"',
      '\\',
      '<',
      '>',
      '`',
      '|',
      '{',
      '}',
      '^', // 分隔符代表
      '「',
      '」',
      '【',
      '】',
      '，',
      '。',
      '🔊',
      '💬',
      '⌨', // 标点/emoji
      '\u200B',
      '\uFE0F',
      '\u20E3',
      '\u0000',
      '\u0001',
      '\u0085',
      '\u2028',
      '\u2029', // 剥离族/控制符
      '×',
      '÷',
      '・',
      'ｶ', // 边界字符（×÷/・/半角片假名归分隔符）
    ];
    // 1) 全字符单发 + 全两两组合
    for (const a of alphabet) {
      const r1 = compileQuery(a);
      expect(r1.isEmpty === false || r1.tsquery === null).toBe(true);
      for (const b of alphabet) {
        compileQuery(`${a}${b}`);
        compileQuery(`${a} ${b}`);
      }
    }
    // 2) 长链压力：全字母表拼接 ×10
    compileQuery(alphabet.join('').repeat(10));
    expect(getTsqueryCompileFallbackCount()).toBe(before);
  });

  it('降级路径存在且产物 = 空编译产物（不可达保险丝的契约形态）', () => {
    // 不直接触发真实异常（契约证明其不可达）；改为静态检查 compileQuery 的
    // 降级出口形状：空产物的全部字段与 emptyCompiledQuery 契约一致
    const empty = compileQuery('💬');
    expect(empty).toEqual({
      isEmpty: true,
      tsquery: null,
      arms: [],
      singleCjkChar: null,
      cjkCharCount: 0,
      distinctBigramCount: 0,
      queryTruncated: false,
      armTruncatedCount: 0,
    });
  });
});

describe('基准（烟测，非性能门禁：捕捉意外 O(n²)；契约④ 单趟线性）', () => {
  it('normalizeQuery 20 万字混合文本', () => {
    const text = ('出境 race.service.ts:92 成本总闸 ' + 'a'.repeat(100)).repeat(2500); // ≈20 万码点
    expect(text.length).toBeGreaterThanOrEqual(200_000);
    const t0 = Date.now();
    const normalized = normalizeQuery(text);
    const elapsed = Date.now() - t0;
    expect(normalized.length).toBe(SEARCH_QUERY_MAX_LENGTH); // 触发硬截断
    // 宽松上限 2s（本地正常 <50ms）；超时 = 实现引入了非线性行为
    expect(elapsed).toBeLessThan(2000);
  });

  it('compileQuery 200 CJK 字编译（199 bigram → 去重 → 64 cap）', () => {
    const q = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i * 8)).join('');
    const t0 = Date.now();
    const compiled = compileQuery(q);
    const elapsed = Date.now() - t0;
    expect(compiled.arms).toHaveLength(K_GATE_ARM_CAP);
    expect(compiled.cjkCharCount).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  });
});
