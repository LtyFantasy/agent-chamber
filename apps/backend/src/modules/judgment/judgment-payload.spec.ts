/**
 * judgment-payload 单测（**判别日志载荷的体积与脱敏纪律**，内核级）。
 *
 * 设计意图：这一层是"日志不是内容第二副本"这条不变量的守门人。四条最容易静默失效的规则：
 * ① redaction 基线 = **两表并集且顺序有语义**（长形态在前）；漏掉长形态会留下半掩码
 *   （`ask_deadbeef` → `[redacted]eadbeef`，9 字符密钥留了 7 个）；
 * ② 截断必须**按字节**（CJK 3 字节/字符，按字符截会超预算 3 倍）；
 * ③ 超限信封**不许吞掉 redacted 标记**（吞了 = 导出侧把"已脱敏行"读成"未脱敏行"）；
 * ④ `countReturnedRows` 不依赖 driver 的 `affected` 落位（形状随驱动/语句变化）。
 *
 * 密钥假值全合成（仓库 NIT-1）：只借用公开前缀形态，后缀与任何真实 key 无关。
 */
import {
  JUDGMENT_REDACTION_BASELINE,
  JUDGMENT_REDACTION_PATTERNS,
  capJsonbPayload,
  countReturnedRows,
  judgmentActorKey,
  redactJudgmentPayload,
  safeErrorTag,
  truncateUtf8,
} from './judgment-payload';
import { EXPERIENCE_SECRET_PATTERNS } from '../experience/experience.constants';

const MAX_BYTES = 16 * 1024;

describe('judgment-payload · redaction 基线', () => {
  it('基线 = 两表并集且**长形态在前**（前缀兜底在后；顺序即语义）', () => {
    expect(JUDGMENT_REDACTION_BASELINE.length).toBe(
      JUDGMENT_REDACTION_PATTERNS.length + EXPERIENCE_SECRET_PATTERNS.length,
    );
    // 长形态（消费整个值）必须排在闸门正则（前缀命中）之前
    expect(JUDGMENT_REDACTION_BASELINE.slice(0, JUDGMENT_REDACTION_PATTERNS.length)).toEqual(
      JUDGMENT_REDACTION_PATTERNS,
    );
  });

  it('redact("ask_deadbeef") 不含 `eadbeef`（半掩码回归钉；9 字符密钥不许留 7 个）', () => {
    const { payload, redacted } = redactJudgmentPayload({ q: 'ask_deadbeef' });
    expect(redacted).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('eadbeef');
    expect(serialized).toContain('[redacted]');
  });

  it('其它凭证族同样吃整个值（apikey_ / sk- / password= / PEM / age / putty）', () => {
    const { payload } = redactJudgmentPayload({
      a: 'apikey_AAAABBBBCCCC',
      b: 'sk-1234567890abcd',
      c: 'password=hunter2',
      d: 'age-secret-key-1ABCDEF',
      e: 'PuTTY-User-Key-File-3: ssh-rsa AAAA',
    });
    const serialized = JSON.stringify(payload);
    for (const leaked of ['AAAABBBBCCCC', '1234567890abcd', 'hunter2', '1ABCDEF']) {
      expect(serialized).not.toContain(leaked);
    }
    // 只掩值，不吞结构（日志仍要可读、可作语料）
    expect(serialized).toContain('[redacted]');
  });

  it('深扫描：数组元素与嵌套对象里的密钥同样被掩（不是只扫顶层字符串）', () => {
    const { redacted, payload } = redactJudgmentPayload({
      state: { signals: ['ask_aaaabbbb', 'ok'], nested: { deep: 'password=s3cret' } },
    });
    expect(redacted).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('aaaabbbb');
    expect(serialized).not.toContain('s3cret');
    // 无命中的字符串原样保留（掩码不得改写无关内容）
    expect(serialized).toContain('ok');
  });

  it('无命中 ⇒ redacted=false 且载荷逐字节不变（不做无谓的复制/改写）', () => {
    const input = { state: { content: 'no secrets here' }, model: 'jev-latest' };
    const result = redactJudgmentPayload(input);
    expect(result.redacted).toBe(false);
    expect(result.payload).toEqual(input);
  });

  it('能力追加模式只做**追加**：内核基线恒跑（clear 调不出来）', () => {
    const { redacted } = redactJudgmentPayload(
      { a: 'ask_aaaabbbb', b: 'my-capability-token-xyz' },
      [/my-capability-token-[a-z]+/g],
    );
    expect(redacted).toBe(true);
    const payload = redactJudgmentPayload(
      { b: 'my-capability-token-xyz' },
      [/my-capability-token-[a-z]+/g],
    ).payload;
    expect(JSON.stringify(payload)).not.toContain('xyz');
  });

  it('带 g 的正则不因 lastIndex 状态漏掩（连续两次调用结果一致）', () => {
    const once = redactJudgmentPayload({ a: 'ask_aaaabbbb' }).payload;
    const twice = redactJudgmentPayload({ a: 'ask_aaaabbbb' }).payload;
    expect(JSON.stringify(twice)).not.toContain('aaaabbbb');
    expect(twice).toEqual(once);
  });
});

describe('judgment-payload · 体积硬顶与标记', () => {
  it('未超限 ⇒ 原对象返回（不重造、不加信封）', () => {
    const small = { state: { content: 'x' } };
    expect(capJsonbPayload(small, MAX_BYTES)).toBe(small);
  });

  it('超限 ⇒ 截断 + truncated/originalBytes 标记，且**不超过硬顶**', () => {
    const payload = { state: { content: 'x'.repeat(20_000) } };
    const capped = capJsonbPayload(payload, MAX_BYTES);
    expect(capped.truncated).toBe(true);
    expect(capped.originalBytes).toBeGreaterThan(MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('CJK 载荷按**字节**截断（按字符截会留下 ~3 倍体积——实测坑）', () => {
    const payload = { state: { content: '经'.repeat(20_000) } }; // 60KB
    const capped = capJsonbPayload(payload, MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    // 截断后的片段是合法 UTF-8（不出现替换字符）
    expect(String(capped.json)).not.toContain('\uFFFD');
  });

  it('redacted 标记**不被截断吞掉**（两种标记名都搬进信封）', () => {
    const withState = capJsonbPayload(
      { stateRedacted: true, state: { content: 'x'.repeat(20_000) } },
      MAX_BYTES,
    );
    expect(withState.stateRedacted).toBe(true);
    const withLog = capJsonbPayload(
      { logRedacted: true, state: { content: 'x'.repeat(20_000) } },
      MAX_BYTES,
    );
    expect(withLog.logRedacted).toBe(true);
  });

  it('truncateUtf8：不切在多字节字符中间（回退到字符边界）', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
    // '经' = 3 字节：上限 4 ⇒ 只能放 1 个完整字符
    expect(truncateUtf8('经经', 4)).toBe('经');
    expect(Buffer.byteLength(truncateUtf8('经经经', 8), 'utf8')).toBe(6);
  });
});

describe('judgment-payload · 落库与告警原语', () => {
  it('countReturnedRows 兼容两种 driver 形状（`[[rows], affected]` 与 `rows`）', () => {
    expect(countReturnedRows([[{ id: 'a' }], 1])).toBe(1);
    expect(countReturnedRows([[{ id: 'a' }], 0])).toBe(1); // 不信 affected
    expect(countReturnedRows([{ id: 'a' }, { id: 'b' }])).toBe(2);
    expect(countReturnedRows(null)).toBe(0);
  });

  it('judgmentActorKey：有 actor 用 `type:id`，无 actor 走兜底桶（不静默不限流）', () => {
    expect(judgmentActorKey({ id: 'u1', type: 'agent' } as never)).toBe('agent:u1');
    expect(judgmentActorKey(null)).toBe('system:unknown');
    expect(judgmentActorKey({ type: 'human' } as never)).toBe('system:unknown');
  });

  it('safeErrorTag 只出类名 + 可选错误码（绝不带 message）', () => {
    expect(safeErrorTag(new Error('boom with secret=abc'))).toBe('Error');
    expect(safeErrorTag(Object.assign(new Error('x'), { name: 'QueryFailedError', code: '23502' }))).toBe(
      'QueryFailedError/23502',
    );
    expect(safeErrorTag(undefined)).toBe('Error');
  });
});
