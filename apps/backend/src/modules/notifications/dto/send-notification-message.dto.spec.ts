/**
 * SendNotificationMessageDto 单测（请求契约：text 长度 / clientRequestId / **link 同源白名单**）。
 *
 * 设计意图：link 白名单是**开放重定向的闸门**（plan §7.1）——绝对 URL 一旦放过，一条
 * `https://evil.example/...` 就能让 Owner 在手机上点进第三方站点。故这里正反两面都钉：
 * ① 五个合法前缀各自通过；② 绝对 URL / 协议相对 `//host` / 非白名单前缀 / 空串一律被拦。
 *
 * 用 `plainToInstance` + `validate`（不启 Nest）：DTO 的真实校验发生在全局 ValidationPipe
 * 里，而那条管道用的就是这两个函数——比"断言正则本身"更接近线上行为。
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  NOTIFY_DIRECT_LINK_MAX_LENGTH,
  NOTIFY_DIRECT_LINK_PATTERN,
  NOTIFY_DIRECT_LINK_PREFIXES,
  NOTIFY_DIRECT_TEXT_MAX_LENGTH,
  SendNotificationMessageDto,
} from './send-notification-message.dto';

/** 跑一遍 DTO 校验，返回违规字段名 */
async function invalidFields(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(SendNotificationMessageDto, payload));
  return errors.map((error) => error.property).sort();
}

describe('SendNotificationMessageDto', () => {
  // ───────────────────────── text ─────────────────────────

  it('text 必填且 1..2000（空串与超长都拦下）', async () => {
    expect(await invalidFields({})).toEqual(['text']);
    expect(await invalidFields({ text: '' })).toEqual(['text']);
    expect(await invalidFields({ text: 'x'.repeat(NOTIFY_DIRECT_TEXT_MAX_LENGTH + 1) })).toEqual(['text']);
    expect(await invalidFields({ text: 'x'.repeat(NOTIFY_DIRECT_TEXT_MAX_LENGTH) })).toEqual([]);
    expect(await invalidFields({ text: '需要你拍板' })).toEqual([]);
  });

  it('text 非字符串（对象/数字）被拦下——不许把格式错误透传到 PostgreSQL', async () => {
    expect(await invalidFields({ text: { a: 1 } })).toEqual(['text']);
    expect(await invalidFields({ text: 42 })).toEqual(['text']);
  });

  // ───────────────────────── clientRequestId ─────────────────────────

  it('clientRequestId 可选、1..64', async () => {
    expect(await invalidFields({ text: 'x' })).toEqual([]);
    expect(await invalidFields({ text: 'x', clientRequestId: 'k1' })).toEqual([]);
    expect(await invalidFields({ text: 'x', clientRequestId: 'x'.repeat(65) })).toEqual(['clientRequestId']);
    // 空串不是"未提供"（@IsOptional 只跳过 undefined/null）
    expect(await invalidFields({ text: 'x', clientRequestId: '' })).toEqual(['clientRequestId']);
  });

  // ───────────────────────── link 白名单 ─────────────────────────

  it('link 缺席 / null 都合法（`link` 是可选的）', async () => {
    expect(await invalidFields({ text: 'x' })).toEqual([]);
    expect(await invalidFields({ text: 'x', link: undefined })).toEqual([]);
  });

  it('link 五个白名单前缀全部接受（含带 query/片段的相对路径）', async () => {
    const accepted = [
      '/tasks/8f14e45f-ceea-467a-9e2f-1b2c3d4e5f60',
      '/topics/abc',
      '/docs/docs%2Fapi-definition.md',
      '/boards/dd52aa41-c380-4d5b-8aec-c530e1737d38',
      '/experiences/123?tab=history',
      '/tasks/a/../b', // 相对路径的形态由服务端拼基址决定，白名单只管前缀同源
    ];
    for (const link of accepted) {
      expect(await invalidFields({ text: 'x', link })).toEqual([]);
    }
  });

  it('link 拒绝绝对 URL 与协议相对 URL（**开放重定向闸门**）', async () => {
    const rejected = [
      'https://evil.example/tasks/1',
      'http://evil.example',
      '//evil.example/tasks/1',
      'ftp://evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>',
    ];
    for (const link of rejected) {
      expect(await invalidFields({ text: 'x', link })).toEqual(['link']);
    }
  });

  it('link 拒绝非白名单前缀与形态不完整的路径', async () => {
    const rejected = [
      '/settings/profile',
      '/tasks', // 无尾斜杠 = 不是某个任务的深链
      '/tasksx/1',
      'tasks/1', // 缺前导斜杠
      '/',
      '',
    ];
    for (const link of rejected) {
      expect(await invalidFields({ text: 'x', link })).toEqual(['link']);
    }
  });

  it('link 拒绝空白与控制字符（**换行注入**：一条 link 不该能伪造出额外的"行"）', async () => {
    const rejected = [
      '/tasks/1\n/docs/2', // 原始换行：IM 渲染里能造出第二行
      '/tasks/1\r\n/docs/2', // CRLF
      '/tasks/1\t2', // 制表
      '/tasks/1 ', // 尾随空格
      ' /tasks/1', // 前导空格
      '/tasks/\u00001', // 原始 NUL（`\s` 拦不住 ⇒ 靠 `\p{Cc}`）
      '/tasks/\u007f1', // 原始 DEL
      '/tasks/1\u00a02', // 不换行空格（是 `\s` 但不是控制字符）
    ];
    for (const link of rejected) {
      expect(await invalidFields({ text: 'x', link })).toEqual(['link']);
    }
  });

  it('link 拒绝**百分号编码的控制字符**（`%0a` 本身不是空白，解码后才变换行）', async () => {
    const rejected = [
      '/tasks/1%0a/docs/2', // 小写 %0a
      '/tasks/1%0A/docs/2', // 大写 %0A
      '/docs/a%0D%0ab', // CRLF 注入的经典形态
      '/topics/x%00y', // NUL
      '/boards/x%7F', // DEL
      '/experiences/x%1F', // 0x1F
    ];
    for (const link of rejected) {
      expect(await invalidFields({ text: 'x', link })).toEqual(['link']);
    }
  });

  it('link 超长（>512）被拦下', async () => {
    const long = `/docs/${'x'.repeat(NOTIFY_DIRECT_LINK_MAX_LENGTH)}`;
    expect(await invalidFields({ text: 'x', link: long })).toEqual(['link']);
  });

  it('正则由前缀常量派生：每个前缀都能被 `NOTIFY_DIRECT_LINK_PATTERN` 接受', () => {
    for (const prefix of NOTIFY_DIRECT_LINK_PREFIXES) {
      expect(NOTIFY_DIRECT_LINK_PATTERN.test(`${prefix}x`)).toBe(true);
    }
    // 反向：正则只认这五个前缀（新增前缀必须改常量，改了这里自动跟着变）
    expect(NOTIFY_DIRECT_LINK_PREFIXES).toHaveLength(5);
    expect(NOTIFY_DIRECT_LINK_PATTERN.test('/settings/x')).toBe(false);
  });
});
