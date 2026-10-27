import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateNotificationSettingsDto } from './update-notification-settings.dto';

/**
 * PATCH /topics/:id/notification-settings 请求体校验（v1.96.0-dev 未读语义批 D5）。
 *
 * 锁的是**边界层**契约（双层校验的第一层，铁律 #21）：格式错误必须止于 pipe，
 * 不许漏到 SQL（`notification_settings @> ...` 对脏值零抛错，会静默写成脏数据）。
 *
 * ⚠️ 未知键（mute）的拒绝由全局 ValidationPipe 的 `forbidNonWhitelisted` 完成，
 * 单测里用 `validate(dto, { whitelist: true, forbidNonWhitelisted: true })` 复刻该口径
 * （main.ts 的全局 pipe 配置 = 生产口径；e2e 再锁一次真实路由）。
 */
describe('UpdateNotificationSettingsDto', () => {
  it('should accept a boolean mentionsOnly', async () => {
    const dto = plainToInstance(UpdateNotificationSettingsDto, { mentionsOnly: true });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('should reject a missing mentionsOnly (required, not tri-state)', async () => {
    const dto = plainToInstance(UpdateNotificationSettingsDto, {});

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'mentionsOnly' && e.constraints?.isBoolean)).toBe(true);
  });

  it('should reject a string "true" (no truthy coercion at the boundary)', async () => {
    const dto = plainToInstance(UpdateNotificationSettingsDto, { mentionsOnly: 'true' });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'mentionsOnly' && e.constraints?.isBoolean)).toBe(true);
  });

  it('should reject null mentionsOnly', async () => {
    const dto = plainToInstance(UpdateNotificationSettingsDto, { mentionsOnly: null });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'mentionsOnly')).toBe(true);
  });

  it('should reject the unwired "mute" key (forbidNonWhitelisted — mute is not wired yet)', async () => {
    const dto = plainToInstance(UpdateNotificationSettingsDto, {
      mentionsOnly: true,
      mute: true,
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    // 未知键 → whitelist 违规（生产由全局 pipe 翻成 400）
    expect(errors.some((e) => e.property === 'mute')).toBe(true);
  });
});
