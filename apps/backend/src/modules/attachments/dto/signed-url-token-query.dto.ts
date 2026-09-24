import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /public/attachments/:id/content?token=` 查询参数 DTO（P2 批 2 / plan §②.4）。
 *
 * token 是 POST /attachments/:id/signed-url 铸造的 HS256 JWT，放在 query 而非
 * Authorization 头：该端点要能直接进 `<img src>` / markdown（**公开端点的全部意义**），
 * 浏览器图片标签带不了自定义头。代价是 token 会出现在 URL 里——故：
 * ① 短 TTL（默认 300s）+ 无共享缓存（Cache-Control: private）；
 * ② 平台日志侧对 `token` 键强制脱敏（common/utils/redact-url.ts）。
 *
 * 格式层只管"是不是非空字符串、是否超长"：
 * - 必填 + `@IsNotEmpty`：缺失/空串是**形状错误**（400，铁律 #21 分工），
 *   12006/12007 只表达"凭证本身不可用"（签名/scope/aid 三断言、过期）；
 * - `@MaxLength(2048)`：JWT 结构下正常长度 << 1KB，超长直接拒（不把超大串喂给验签器）；
 * - 数组形态（`?token=a&token=b`，Express 多值 query 交付为数组）在 `@IsString` 处即拒
 *   （400）；controller 侧另有显式 `typeof` 复检（防校验链被绕过时把非字符串喂进 verify）。
 */
export class SignedUrlTokenQueryDto {
  /** 铸造返回的签名 token（原样回填，勿做任何裁剪/改写） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  @ApiProperty({
    description: 'Signed URL token minted by POST /attachments/:id/signed-url',
  })
  token: string;
}
