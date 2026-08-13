/**
 * 逐类型 payload 校验测试（docs/roundtable-design.md §4：上行/下行消息表）
 */
import { validatePayload } from './messages';
import { buildEnvelope, validateEnvelope } from './envelope';

const helloOk = {
  version: '0.1.0',
  vendors: ['kimi'],
  seats: { 'seat-1': { lastSentSeq: 3, lastReceivedSeq: 7 } },
};

describe('validatePayload: hello', () => {
  it('正例：版本 + vendors + 各座位对账信息', () => {
    expect(validatePayload('hello', helloOk).ok).toBe(true);
  });

  it('正例：vendors 含 codex（M4a 接入，chamber 按 vendor 绑定座位）', () => {
    expect(validatePayload('hello', { ...helloOk, vendors: ['kimi', 'codex'] }).ok).toBe(true);
  });

  it.each([
    ['version 缺失', { vendors: ['kimi'], seats: {} }],
    ['version 非字符串', { ...helloOk, version: 1 }],
    ['vendors 非数组', { ...helloOk, vendors: 'kimi' }],
    ['vendors 含非字符串', { ...helloOk, vendors: ['kimi', 1] }],
    ['vendors 含空字符串', { ...helloOk, vendors: [''] }],
    ['seats 非对象', { ...helloOk, seats: [] }],
    ['seats 项缺 lastSentSeq', { ...helloOk, seats: { s: { lastReceivedSeq: 1 } } }],
    ['seats 项 lastReceivedSeq 负数', { ...helloOk, seats: { s: { lastSentSeq: 1, lastReceivedSeq: -2 } } }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('hello', payload).ok).toBe(false);
  });
});

describe('validatePayload: seat.event（契约① SeatEvent 透传）', () => {
  const eventCases = [
    { name: 'message_chunk', event: { type: 'message_chunk', seatId: 's', text: '增量' } },
    { name: 'message_complete 无 silent', event: { type: 'message_complete', seatId: 's', stopReason: 'end_turn' } },
    { name: 'message_complete.silent=true', event: { type: 'message_complete', seatId: 's', stopReason: 'end_turn', silent: true } },
    { name: 'message_complete.silent=false', event: { type: 'message_complete', seatId: 's', stopReason: 'end_turn', silent: false } },
    { name: 'message_complete 带 text', event: { type: 'message_complete', seatId: 's', stopReason: 'end_turn', text: '全文' } },
    { name: 'tool_event', event: { type: 'tool_event', seatId: 's', tool: { name: 'bash' } } },
    {
      name: 'permission_request',
      event: {
        type: 'permission_request',
        seatId: 's',
        requestId: 'r1',
        tool: { name: 'bash' },
        options: [{ id: 'approve_once' }],
      },
    },
    { name: 'usage', event: { type: 'usage', seatId: 's', used: 100, size: 1000 } },
    { name: 'status 全字段', event: { type: 'status', seatId: 's', status: 'busy', detail: 'running' } },
    { name: 'status 无 detail', event: { type: 'status', seatId: 's', status: 'online' } },
    { name: 'seat_info 全字段', event: { type: 'seat_info', seatId: 's', model: 'kimi-k2', thinking: 'high', mode: 'auto' } },
    { name: 'seat_info 仅 seatId', event: { type: 'seat_info', seatId: 's' } },
    { name: 'seat_info 部分字段', event: { type: 'seat_info', seatId: 's', mode: 'yolo' } },
  ];

  it.each(eventCases.map((c) => [c.name, c.event] as [string, unknown]))('正例：%s', (_name, event) => {
    expect(validatePayload('seat.event', event).ok).toBe(true);
  });

  const badCases = [
    ['未知 event type', { type: 'mystery', seatId: 's' }],
    ['seatId 缺失', { type: 'message_chunk', text: 'x' }],
    ['message_chunk 缺 text', { type: 'message_chunk', seatId: 's' }],
    ['message_complete 缺 stopReason', { type: 'message_complete', seatId: 's' }],
    ['message_complete.silent 非布尔', { type: 'message_complete', seatId: 's', stopReason: 'end_turn', silent: 'yes' }],
    ['message_complete.text 非字符串', { type: 'message_complete', seatId: 's', stopReason: 'end_turn', text: 42 }],
    ['tool_event 缺 tool', { type: 'tool_event', seatId: 's' }],
    ['permission_request 缺 requestId', { type: 'permission_request', seatId: 's', tool: {}, options: [] }],
    ['permission_request 缺 options', { type: 'permission_request', seatId: 's', requestId: 'r', tool: {} }],
    ['usage.used 负数', { type: 'usage', seatId: 's', used: -1, size: 100 }],
    ['usage.size 非数字', { type: 'usage', seatId: 's', used: 1, size: 'big' }],
    ['seat_info.model 非字符串', { type: 'seat_info', seatId: 's', model: 1 }],
    ['seat_info.thinking 非字符串', { type: 'seat_info', seatId: 's', thinking: true }],
    ['seat_info.mode 非字符串', { type: 'seat_info', seatId: 's', mode: {} }],
    ['status 非法值', { type: 'status', seatId: 's', status: 'sleeping' }],
    ['status.detail 非字符串', { type: 'status', seatId: 's', status: 'online', detail: 1 }],
  ];
  it.each(badCases as [string, unknown][])('反例：%s', (_name, event) => {
    expect(validatePayload('seat.event', event).ok).toBe(false);
  });

  it('非对象 payload → 反例', () => {
    expect(validatePayload('seat.event', 'x').ok).toBe(false);
  });
});

describe('validatePayload: seat.assign（SeatConfig 下发）', () => {
  const configOk = {
    seatId: 'seat-1',
    label: 'kimi-1',
    vendor: 'kimi',
    cwd: '/tmp/seat1',
    permissionMode: 'default',
  };

  it('正例：完整 SeatConfig', () => {
    expect(validatePayload('seat.assign', configOk).ok).toBe(true);
  });

  it('正例：带可选 model', () => {
    expect(validatePayload('seat.assign', { ...configOk, model: 'kimi-k2' }).ok).toBe(true);
  });

  it('正例：vendor=codex（M4a 接入）', () => {
    expect(validatePayload('seat.assign', { ...configOk, vendor: 'codex' }).ok).toBe(true);
  });

  it.each([
    ['seatId 缺失', { label: 'kimi-1', vendor: 'kimi', cwd: '/tmp', permissionMode: 'default' }],
    ['label 空字符串', { ...configOk, label: '' }],
    ['vendor 缺失', { ...configOk, vendor: undefined }],
    ['cwd 缺失', { ...configOk, cwd: undefined }],
    ['permissionMode 非法值', { ...configOk, permissionMode: 'sloppy' }],
    ['model 非字符串', { ...configOk, model: 1 }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('seat.assign', payload).ok).toBe(false);
  });
});

describe('validatePayload: seat.inject（规则头 + r3 冻结消息体）', () => {
  const bodyOk = {
    v: 1,
    kind: 'roundtable.inject',
    topic: { id: 't1', title: '圆桌测试' },
    seat: { label: 'kimi-1', coordinator: false },
    ruleHeaderVersion: 1,
    batch: {
      windowMs: 0,
      messages: [
        {
          id: 'm1',
          from: { name: 'tianyu', type: 'human', seatLabel: null, coordinator: false },
          ts: '2026-08-07T12:00:00Z',
          replyTo: null,
          content: '原文',
        },
      ],
    },
  };
  const injectOk = { ruleHeader: '# 圆桌规则头\n\n…', body: bodyOk };

  it('正例：规则头 + 完整消息体', () => {
    expect(validatePayload('seat.inject', injectOk).ok).toBe(true);
  });

  it.each([
    ['ruleHeader 缺失', { body: bodyOk }],
    ['ruleHeader 空字符串', { ...injectOk, ruleHeader: '' }],
    ['body 缺失', { ruleHeader: '# r' }],
    ['body 非法（v=2）', { ...injectOk, body: { ...bodyOk, v: 2 } }],
    ['body 非法（kind 错）', { ...injectOk, body: { ...bodyOk, kind: 'other' } }],
    ['body 非法（消息缺 content）', { ...injectOk, body: { ...bodyOk, batch: { windowMs: 0, messages: [{ ...bodyOk.batch.messages[0], content: undefined }] } } }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('seat.inject', payload).ok).toBe(false);
  });
});

describe('validatePayload: seat.permission_verdict', () => {
  it('正例：requestId + optionId', () => {
    expect(
      validatePayload('seat.permission_verdict', { requestId: 'r1', optionId: 'approve_once' }).ok,
    ).toBe(true);
  });

  it.each([
    ['requestId 缺失', { optionId: 'approve_once' }],
    ['optionId 缺失', { requestId: 'r1' }],
    ['requestId 空字符串', { requestId: '', optionId: 'approve_once' }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('seat.permission_verdict', payload).ok).toBe(false);
  });
});

describe('validatePayload: hello_ack（阶段 5 新增下行回执，携带上行游标）', () => {
  const ackOk = { seats: { 'seat-1': { lastEventSeq: 7, failedEventSeqs: [5] } } };

  it('正例：各座位 lastEventSeq + failedEventSeqs', () => {
    expect(validatePayload('hello_ack', ackOk).ok).toBe(true);
  });

  it('正例：空 seats / 空 failedEventSeqs', () => {
    expect(validatePayload('hello_ack', { seats: {} }).ok).toBe(true);
    expect(validatePayload('hello_ack', { seats: { s: { lastEventSeq: 0, failedEventSeqs: [] } } }).ok).toBe(true);
  });

  it.each([
    ['seats 缺失', {}],
    ['seats 非对象', { seats: [] }],
    ['缺 lastEventSeq', { seats: { s: { failedEventSeqs: [] } } }],
    ['lastEventSeq 负数', { seats: { s: { lastEventSeq: -1, failedEventSeqs: [] } } }],
    ['failedEventSeqs 非数组', { seats: { s: { lastEventSeq: 1, failedEventSeqs: 5 } } }],
    ['failedEventSeqs 含负数', { seats: { s: { lastEventSeq: 1, failedEventSeqs: [-1] } } }],
    ['failedEventSeqs 含非整数', { seats: { s: { lastEventSeq: 1, failedEventSeqs: [1.5] } } }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('hello_ack', payload).ok).toBe(false);
  });
});

describe('validatePayload: ping（心跳；阶段 5 起可选 seats 游标字段）', () => {
  it('正例：空对象（旧协议纯心跳，向后兼容）', () => {
    expect(validatePayload('ping', {}).ok).toBe(true);
  });

  it('正例：可选 seats 游标字段', () => {
    expect(validatePayload('ping', { seats: { 'seat-1': { lastEventSeq: 3, failedEventSeqs: [] } } }).ok).toBe(true);
  });

  it.each([
    ['seats 非对象', { seats: 'x' }],
    ['seats 项缺 lastEventSeq', { seats: { s: { failedEventSeqs: [] } } }],
    ['seats 项 failedEventSeqs 含负数', { seats: { s: { lastEventSeq: 0, failedEventSeqs: [-2] } } }],
  ] as [string, unknown][])('反例：%s', (_name, payload) => {
    expect(validatePayload('ping', payload).ok).toBe(false);
  });
});

describe('validatePayload: 空 payload 类型（pong/ping/seat.cancel/seat.revoke/error）', () => {
  it.each(['pong', 'ping', 'seat.cancel', 'seat.revoke', 'error'] as const)('正例：%s 空对象', (type) => {
    expect(validatePayload(type, {}).ok).toBe(true);
  });

  it.each(['pong', 'ping', 'seat.cancel', 'seat.revoke', 'error'] as const)('反例：%s 非对象', (type) => {
    expect(validatePayload(type, 'x').ok).toBe(false);
  });
});

describe('validatePayload: 未知类型防御', () => {
  it('未知 type → 反例', () => {
    expect(validatePayload('mystery' as never, {}).ok).toBe(false);
  });
});

describe('信封 + payload 组合校验（§7 注入面）', () => {
  const configOk = {
    seatId: 'seat-1',
    label: 'kimi-1',
    vendor: 'kimi',
    cwd: '/tmp/seat1',
    permissionMode: 'default',
  };

  it('合法信封 + 合法 payload → 双重通过', () => {
    const env = buildEnvelope('seat.assign', configOk, { seatId: 'seat-1', seq: 1 });
    expect(validateEnvelope(env).ok).toBe(true);
    expect(validatePayload(env.type, env.payload).ok).toBe(true);
  });

  it('信封合法但 payload 非法 → payload 校验拦截', () => {
    const env = buildEnvelope('seat.assign', { ...configOk, permissionMode: 'sloppy' }, { seatId: 'seat-1', seq: 1 });
    expect(validateEnvelope(env).ok).toBe(true);
    expect(validatePayload(env.type, env.payload).ok).toBe(false);
  });
});
