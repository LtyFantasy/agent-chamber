/**
 * 注入消息体（r3 冻结 schema）与沉默哨兵测试（docs/roundtable-design.md §4）
 */
import {
  assembleInjectBody,
  parseInjectBody,
  parseSilentReply,
  RULE_HEADER_VERSION,
  SILENT_SENTINEL,
} from './inject-body';

/** 标准单条消息（非座位发言：seatLabel/replyTo 为 null） */
const messageInput = {
  id: 'msg-1',
  from: { name: 'tianyu', type: 'human' as const, seatLabel: null, coordinator: false },
  ts: '2026-08-07T12:00:00Z',
  replyTo: null,
  content: '原文内容',
};

/** 构造一个标准 body（每次新实例，避免共享引用） */
function makeBody() {
  return assembleInjectBody({
    topic: { id: 'topic-1', title: '圆桌测试' },
    seatLabel: 'kimi-1',
    messages: [messageInput],
  });
}

describe('assembleInjectBody', () => {
  it('默认值：v=1 / kind=roundtable.inject / ruleHeaderVersion=当前版本 / windowMs=0 / coordinator=false', () => {
    const body = makeBody();
    expect(body.v).toBe(1);
    expect(body.kind).toBe('roundtable.inject');
    expect(body.seat).toEqual({ label: 'kimi-1', coordinator: false });
    expect(body.ruleHeaderVersion).toBe(RULE_HEADER_VERSION);
    expect(body.batch.windowMs).toBe(0);
    expect(body.batch.messages).toEqual([messageInput]);
  });

  it('显式 coordinator / windowMs 生效', () => {
    const body = assembleInjectBody({
      topic: { id: 'topic-1', title: '圆桌测试' },
      seatLabel: 'main-brain',
      coordinator: true,
      windowMs: 30000,
      messages: [],
    });
    expect(body.seat.coordinator).toBe(true);
    expect(body.batch.windowMs).toBe(30000);
  });
});

describe('parseInjectBody', () => {
  it('assemble 产物往返：parse ok 且深度相等', () => {
    const body = makeBody();
    const parsed = parseInjectBody(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.body).toEqual(body);
    }
  });

  it('agent 座位发言（seatLabel + 主脑 coordinator=true）通过', () => {
    const body = assembleInjectBody({
      topic: { id: 'topic-1', title: '圆桌测试' },
      seatLabel: 'kimi-1',
      messages: [
        {
          ...messageInput,
          id: 'm2',
          from: { name: 'kimi-2', type: 'agent', seatLabel: 'kimi-2', coordinator: true },
          replyTo: 'msg-1',
        },
      ],
    });
    expect(parseInjectBody(body).ok).toBe(true);
  });

  it('空 batch.messages 通过（攒批窗口内无新消息的合法边界）', () => {
    const body = assembleInjectBody({ topic: { id: 't', title: 't' }, seatLabel: 'kimi-1', messages: [] });
    expect(parseInjectBody(body).ok).toBe(true);
  });

  it('错误累积：v=2 + 非法消息同时报多条', () => {
    const res = parseInjectBody({ ...makeBody(), v: 2, batch: { windowMs: 0, messages: [{ ...messageInput, content: undefined }] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  const badCases = [
    ['非对象输入', 'not-an-object'],
    ['v=2', { ...makeBody(), v: 2 }],
    ['kind 错误', { ...makeBody(), kind: 'roundtable.other' }],
    [
      '缺 topic',
      (() => {
        const { topic, ...rest } = makeBody();
        return rest;
      })(),
    ],
    ['topic.id 空', { ...makeBody(), topic: { id: '', title: 't' } }],
    ['seat 缺 label', { ...makeBody(), seat: { coordinator: false } }],
    ['seat.coordinator 非布尔', { ...makeBody(), seat: { label: 'kimi-1', coordinator: 'yes' } }],
    ['ruleHeaderVersion=0', { ...makeBody(), ruleHeaderVersion: 0 }],
    ['ruleHeaderVersion 小数', { ...makeBody(), ruleHeaderVersion: 1.5 }],
    ['batch.windowMs 负数', { ...makeBody(), batch: { windowMs: -1, messages: [] } }],
    ['messages 非数组', { ...makeBody(), batch: { windowMs: 0, messages: 'x' } }],
    ['消息缺 id', { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, id: '' }] } }],
    [
      'from.type 非法',
      { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, from: { ...messageInput.from, type: 'robot' } }] } },
    ],
    [
      'from.seatLabel 数字',
      { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, from: { ...messageInput.from, seatLabel: 42 } }] } },
    ],
    [
      'from.coordinator 缺失',
      {
        ...makeBody(),
        batch: {
          windowMs: 0,
          messages: [{ ...messageInput, from: { name: 'tianyu', type: 'human', seatLabel: null } }],
        },
      },
    ],
    ['ts 非法格式', { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, ts: 'not-a-date' }] } }],
    ['replyTo 数字', { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, replyTo: 42 }] } }],
    ['content 缺失', { ...makeBody(), batch: { windowMs: 0, messages: [{ ...messageInput, content: undefined }] } }],
  ];
  it.each(badCases as [string, unknown][])('反例：%s', (_name, input) => {
    expect(parseInjectBody(input).ok).toBe(false);
  });
});

describe('parseSilentReply', () => {
  it('标准哨兵 → true', () => {
    expect(parseSilentReply(SILENT_SENTINEL)).toBe(true);
  });

  it('前后空白 → true（宽松解析：trim 后整体 parse）', () => {
    expect(parseSilentReply('  \n {"silent": true} \t')).toBe(true);
    expect(parseSilentReply('\n{"silent":true}\n')).toBe(true);
  });

  it('{"silent": false} → false', () => {
    expect(parseSilentReply('{"silent": false}')).toBe(false);
  });

  it('silent=true 夹杂其他字段 → true（整体 parse 成功且 silent===true）', () => {
    expect(parseSilentReply('{"silent": true, "note": "无事可说"}')).toBe(true);
  });

  it('silent 为字符串 "true" → false（须严格 === true）', () => {
    expect(parseSilentReply('{"silent": "true"}')).toBe(false);
  });

  it('非 JSON 自然文本 → false', () => {
    expect(parseSilentReply('好的，我来处理这个问题。')).toBe(false);
  });

  it('markdown 文本里藏 JSON → false（整体 parse 失败，不做内容扫描）', () => {
    expect(parseSilentReply('规则约定：整个回复仅回 `{"silent": true}` 哨兵，详见文档。')).toBe(false);
  });

  it('可 parse 但无 silent 字段（null/数字/数组/空对象）→ false', () => {
    expect(parseSilentReply('null')).toBe(false);
    expect(parseSilentReply('42')).toBe(false);
    expect(parseSilentReply('[]')).toBe(false);
    expect(parseSilentReply('{}')).toBe(false);
  });

  it('空字符串 / 纯空白 → false', () => {
    expect(parseSilentReply('')).toBe(false);
    expect(parseSilentReply('   ')).toBe(false);
  });
});
