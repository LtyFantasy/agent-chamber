/**
 * 敏感凭证检测器单测（v1.94.0-dev，卡 349d337e）
 *
 * 覆盖（计划 §二.2 的矩阵拆表要求）：
 * - **TP 表**（每条模式一个正例，`it.each` 逐条定位失败项）；
 * - **TN 表（must-not-match）**：文档/教程里的高频形态与**复合词**（`task_github_pat_…`）；
 * - **known-FP 表（must-match，钉死现状）**：占位 DSN / AWS 官方示例 key / 长 slug——
 *   **这些命中是已接受的**（注释标明），钉住它们是为了防止「顺手修一下」把已注册的
 *   误报当成回归来改（真正的手法是模式级 kill switch 收敛）；
 * - 经验库闸门的 PEM 正例矩阵 **9/9**（形态与 `experience.constants.ts` 同源）；
 * - patternId / label 词表纪律（**无逗号**——`ids` 是逗号拼接的单字符串）+ 无 `g`/`y` 旗标；
 * - 空串 / 非串 / `patterns` 过滤参数；
 * - **耗时上界**（四种对抗负载全表扫描各 < 500ms）+ **256KB 截断行为**（含尾部盲区）。
 *
 * ⚠️ **fixture 里的 DSN 一律拼装、不写字面形态**（计划派发警告）：源文件里出现
 * `<scheme>://user:pass@host` 的字面串会让平台扫到自己的测试数据。
 */
import {
  findSensitivePattern,
  SENSITIVE_PATTERNS,
  SENSITIVE_SCAN_MAX_CHARS,
  scanSensitiveContent,
  type SensitivePattern,
} from './sensitive-patterns';

/** 占位 DSN 的 scheme（拼装用，见文件头警告） */
const DSN_SCHEME = 'postgres';

/** 占位 DSN（**拼装**：源码里不出现可直接扫描的 DSN 字面形态） */
const PLACEHOLDER_DSN = `${DSN_SCHEME}://user:password@db.example.invalid`;

/** 平台真 key 形态（`ask_` + 32 位 base64url，含 `-` / `_`） */
const REAL_AGENT_KEY = 'ask_AbCdEf0123456789_-AbCdEf0123456789';

/** 逐条模式 → 正例（**顺序无关**：按 id 取名，缺失的 id 会在下方「全表覆盖」断言里暴露） */
const TRUE_POSITIVES: Record<string, string> = {
  platform_agent_key: `配置里写了 ${REAL_AGENT_KEY} 这行`,
  sk_key: 'sk-abcdefghij0123456789ABCDEFGHIJ',
  typesafe_key: 'apikey_abcdefghij0123456789ABCDEFGHIJ',
  github_token: 'ghp_abcdefghij0123456789ABCDEFGHIJKLMNOPQRST',
  aws_access_key: 'AKIAIOSFODNN7EXAMPLE',
  age_secret_key: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
  private_key_block: '-----BEGIN RSA PRIVATE KEY-----',
  connection_string: `连接串：${PLACEHOLDER_DSN}`,
  slack_token: 'xoxb-1234567890-abcdefghij',
};

/** fine-grained PAT 形态（同 `github_token` 码，第二支） */
const FINE_GRAINED_PAT = `github_pat_${'a'.repeat(24)}`;

/** 必须**不**命中（文档/教程/复合词/公钥/太短的形态） */
const TRUE_NEGATIVES: readonly string[] = [
  // 既有文档路径形态：含 `ask-` / `sk-` 的**词内**子串（左边界 lookbehind 挡住）
  'pre-batch3-drop-task-topic-id-20260726-101830.sql',
  // 教程请求头（bearer_jwt 刻意不收编）
  'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig',
  // 口令赋值（password_assignment 刻意不收编）
  'password=changeme123',
  // 教程 URL 的 userinfo（http(s) 被显式排除——最大的误报源）
  'https://user:password@example.com',
  // **复合词**：左边界含 `_` ⇒ `task_github_pat_…` 刻意不命中
  'task_github_pat_abcdefghij0123456789ABCDEF',
  // 公钥不是秘密；英文散文里的 "begin ... private key" 也不是 PEM 头
  '-----BEGIN PUBLIC KEY-----',
  'begin by generating a private key pair, then rotate it',
  // 太短（低于量词下界）
  'sk-abc',
  'ask_short',
  'xoxb-1',
  // 纯散文
  '这是一段正常的文档正文，没有任何凭证形态。',
];

/**
 * **known-FP（must-match，钉死现状）**：这些命中是**已接受**的误报。
 *
 * rationale：检测器的目标是「宁可多报」——官方示例 key / 占位 DSN / 长 slug 与真凭证
 * 形态无法区分。收敛手段是**模式级 kill switch**（`HINT_CREDENTIAL_PATTERNS_DISABLED`），
 * **不是**改正则去做语义猜测。钉住它们 = 防止后人把「已知误报」当回归修掉。
 */
const KNOWN_FALSE_POSITIVES: readonly string[] = [
  // AWS 官方文档示例 key
  'AKIAIOSFODNN7EXAMPLE',
  // 占位 DSN（文案自带「若是文档示例/占位符……忽略」出口）
  PLACEHOLDER_DSN,
  // 长 slug（行首 / `=` 后的 `sk-` 形态；见 sensitive-patterns.ts 第 2 条备注）
  'sk-a-very-long-slug-name-for-a-doc-2026',
];

/** 经验库闸门的 PEM 正例矩阵（与 `experience.constants.ts` 的注释矩阵逐条对齐） */
const PEM_POSITIVES: readonly string[] = [
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN EC PRIVATE KEY',
  'BEGIN DSA PRIVATE KEY',
  'BEGIN ECDSA PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
  'BEGIN ENCRYPTED PRIVATE KEY',
  'BEGIN SSH2 ENCRYPTED PRIVATE KEY',
  'BEGIN PGP PRIVATE KEY BLOCK',
  'BEGIN ML-DSA-87 PRIVATE KEY',
  '-----BEGIN RSA PRIVATE KEY-----',
];

describe('scanSensitiveContent（敏感凭证检测器）', () => {
  describe('命中（TP）', () => {
    it.each(Object.entries(TRUE_POSITIVES))('%s：正例命中', (id, text) => {
      const { ids } = scanSensitiveContent(text);
      expect(ids.split(',')).toContain(id);
    });

    it('github_token 第二支（fine-grained PAT）也命中', () => {
      expect(scanSensitiveContent(FINE_GRAINED_PAT).ids.split(',')).toContain('github_token');
    });

    it('平台真 key 形态（含 `-_` 的 32 位 base64url）命中', () => {
      expect(scanSensitiveContent(REAL_AGENT_KEY).ids.split(',')).toContain('platform_agent_key');
    });

    it('每条登记模式**都有**正例覆盖（新增模式却没进 TP 表 ⇒ 这里红）', () => {
      const covered = new Set([...Object.keys(TRUE_POSITIVES), 'github_token']);
      for (const entry of SENSITIVE_PATTERNS) {
        expect(covered.has(entry.id)).toBe(true);
      }
    });

    it('AWS 的 ASIA 家族（临时凭证）同样命中', () => {
      expect(scanSensitiveContent('ASIAZZZZZZZZZZZZZZZZ').ids.split(',')).toContain(
        'aws_access_key',
      );
    });

    it('PEM 正例矩阵全部命中（与经验库闸门同源形态）', () => {
      for (const header of PEM_POSITIVES) {
        expect(scanSensitiveContent(header).ids.split(',')).toContain('private_key_block');
      }
    });

    it('多模式命中：ids 是逗号拼接的多个 patternId（往返可 split）', () => {
      const text = `${REAL_AGENT_KEY} 和 sk-abcdefghij0123456789ABCDEFGHIJ`;
      const { ids } = scanSensitiveContent(text);
      const parts = ids.split(',');
      expect(parts.sort()).toEqual(['platform_agent_key', 'sk_key']);
    });
  });

  describe('不命中（TN）', () => {
    it.each(TRUE_NEGATIVES.map((text, index) => [index, text] as const))(
      'TN #%i：不命中任何模式',
      (_index, text) => {
        expect(scanSensitiveContent(text).ids).toBe('');
      },
    );
  });

  describe('known-FP（must-match，钉死现状——见常量注释）', () => {
    it.each(KNOWN_FALSE_POSITIVES.map((text, index) => [index, text] as const))(
      'known-FP #%i：命中（已接受，收敛走模式级 kill switch，不改正则）',
      (_index, text) => {
        expect(scanSensitiveContent(text).ids.length).toBeGreaterThan(0);
      },
    );
  });

  describe('词表与旗标纪律', () => {
    it('patternId / label 恒不含逗号（`ids` 是逗号拼接的单字符串，含逗号会破坏往返）', () => {
      for (const entry of SENSITIVE_PATTERNS) {
        expect(entry.id).not.toContain(',');
        expect(entry.label).not.toContain(',');
        expect(entry.label.length).toBeGreaterThan(0);
      }
    });

    it('模式禁带 `g` / `y` 旗标（lastIndex 状态会让跨调用复用半数漏报）', () => {
      for (const entry of SENSITIVE_PATTERNS) {
        expect(entry.pattern.global).toBe(false);
        expect(entry.pattern.sticky).toBe(false);
      }
    });

    it('patternId 全局唯一（重复 id 会让 ids 串里出现同名项，观测聚合失真）', () => {
      const ids = SENSITIVE_PATTERNS.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('findSensitivePattern：命中返回条目、未登记返回 undefined', () => {
      expect(findSensitivePattern('sk_key')?.label).toBe('sk- 前缀 key');
      expect(findSensitivePattern('nope')).toBeUndefined();
    });
  });

  describe('输入边界与过滤参数', () => {
    it('空串 / 非串（null / undefined / 数字）⇒ 无命中且不抛', () => {
      expect(scanSensitiveContent('')).toEqual({ ids: '', truncated: false });
      for (const value of [null, undefined, 42, {}] as unknown[]) {
        expect(scanSensitiveContent(value as string)).toEqual({ ids: '', truncated: false });
      }
    });

    it('patterns 过滤参数：只跑传入的模式（模式级 kill switch 的机制面）', () => {
      const onlySk = SENSITIVE_PATTERNS.filter((entry) => entry.id === 'sk_key');
      const text = `${REAL_AGENT_KEY} 与 sk-abcdefghij0123456789ABCDEFGHIJ`;
      expect(scanSensitiveContent(text).ids.split(',')).toContain('platform_agent_key');
      expect(scanSensitiveContent(text, onlySk).ids).toBe('sk_key');
      // 空模式表 ⇒ 什么都不扫（且不抛）
      expect(scanSensitiveContent(text, []).ids).toBe('');
    });

    it('**跨调用复用同一批 RegExp 对象**（模块级常量）仍逐次全量命中（无状态残留）', () => {
      const text = `sk-abcdefghij0123456789ABCDEFGHIJ ${REAL_AGENT_KEY}`;
      for (let i = 0; i < 3; i++) {
        expect(scanSensitiveContent(text).ids.split(',').sort()).toEqual([
          'platform_agent_key',
          'sk_key',
        ]);
      }
    });
  });

  describe('耗时上界（量词有界性守卫）', () => {
    /** 单负载全表扫描的实测耗时（ms，`process.hrtime.bigint()` 亚毫秒分辨率） */
    function timeScan(text: string): number {
      const started = process.hrtime.bigint();
      scanSensitiveContent(text);
      return Number(process.hrtime.bigint() - started) / 1e6;
    }

    it('四种对抗负载全表扫描各 < 500ms（旧的无界量词写法在 64KB 上就要 1900ms+ ⇒ 必红）', () => {
      const kb64 = 'a1b2c3d4e5f6'.repeat(5462).slice(0, 64 * 1024); // 64KB 单行小写 hex
      const dotted = 'a.b.c.d.e.f.'.repeat(6554).slice(0, 64 * 1024); // 64KB 点分链
      const slug = 'slug-segment-name-'.repeat(3641).slice(0, 64 * 1024); // 64KB slug
      // >1MB 中文（按单元长度算出repeat 次数，避免手改单元文案后负载悄悄缩水）
      const proseUnit = '这是一段用于压测的中文散文内容不含任何凭证形态';
      const prose = proseUnit.repeat(Math.ceil((1024 * 1024) / proseUnit.length) + 1);

      // **自检**：负载必须真的够大（否则「< 500ms」被短串平凡满足，守卫形同虚设）
      expect(kb64.length).toBe(64 * 1024);
      expect(dotted.length).toBe(64 * 1024);
      expect(slug.length).toBe(64 * 1024);
      expect(prose.length).toBeGreaterThan(1024 * 1024);

      expect(timeScan(kb64)).toBeLessThan(500);
      expect(timeScan(dotted)).toBeLessThan(500);
      expect(timeScan(slug)).toBeLessThan(500);
      expect(timeScan(prose)).toBeLessThan(500);
    });
  });

  describe('256K 字符截断行为', () => {
    it('上限常量 = 256K 字符（256 * 1024）', () => {
      expect(SENSITIVE_SCAN_MAX_CHARS).toBe(256 * 1024);
    });

    it('正文在限内 ⇒ truncated=false', () => {
      expect(scanSensitiveContent('短正文').truncated).toBe(false);
      expect(scanSensitiveContent('x'.repeat(SENSITIVE_SCAN_MAX_CHARS)).truncated).toBe(false);
    });

    it('正文超限 ⇒ truncated=true，且**限内的命中照常报出**', () => {
      const text = `${REAL_AGENT_KEY}${'x'.repeat(SENSITIVE_SCAN_MAX_CHARS)}`;
      const result = scanSensitiveContent(text);
      expect(result.truncated).toBe(true);
      expect(result.ids.split(',')).toContain('platform_agent_key');
    });

    it('**尾部盲区**（已登记的不覆盖清单）：限外才出现的凭证不报（truncated 让这件事可观测）', () => {
      const text = `${'x'.repeat(SENSITIVE_SCAN_MAX_CHARS)}${REAL_AGENT_KEY}`;
      const result = scanSensitiveContent(text);
      expect(result.truncated).toBe(true);
      expect(result.ids).toBe('');
    });
  });

  it('全表导出的是 SensitivePattern 形状（id / label / pattern 三键齐备）', () => {
    for (const entry of SENSITIVE_PATTERNS) {
      const typed: SensitivePattern = entry;
      expect(typeof typed.id).toBe('string');
      expect(typed.pattern).toBeInstanceOf(RegExp);
    }
  });
});
