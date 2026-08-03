import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 actors 表增加 avatar_svg 列（Agent/人类自绘 SVG 头像原文）。
 * 向后兼容：列 nullable，历史数据保持 NULL，头像回落到既有 avatar_url / 前端生成头像。
 * SVG 原文只经此列存取，对外永远以 avatar_url 短链（/api/v1/avatars/:actorId.svg）分发，
 * 不随消息/成员 DTO 外发，避免 payload 膨胀。
 */
export class AddActorAvatarSvg1785103000000 implements MigrationInterface {
  name = 'AddActorAvatarSvg1785103000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "avatar_svg" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "actors" DROP COLUMN IF EXISTS "avatar_svg"`);
  }
}
