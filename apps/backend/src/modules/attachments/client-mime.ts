/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 客户端声明 mime 的 sanitize（`client_mime_type` 列的**唯一写入口**）
 *
 * [代码职责]
 *   - `sanitizeClientMimeType`：剥控制字符 → 取分号前 media type → 形状校验 → 截断
 *   - 产出**纯展示信息**（附件卡片图标分类参考），不参与任何服务决策
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §16a「附件 TTL 与类型放开」— mime 不变量与 clientMimeType 语义
 *   - 补充: docs/database.md — attachments.client_mime_type 列语义
 *
 * [铁律关联] #11(注释) #18(不变量检查) #17(测试契约)
 *
 * [关键不变量]
 *   - **mime_type 只承载字节证据**：声明值**永不进 mime_type**，只经本函数进
 *     `client_mime_type`（varchar(100)）——本文件是这条不变量的落地闸门。
 *   - **「非法 → NULL」契约在超长分支上同样成立**：形状校验必须在**完整串**上做，
 *     截断只能在最后一步。反序（先截断再校验）会让越界位置上的非法字符被"切掉"，
 *     把一个整串非法的声明洗白成形状合法的截断值落地。
 *   - 截断 ≤ `CLIENT_MIME_MAX_LENGTH`(100) 与列宽同源；多字节/控制字符面由
 *     "剥控制字符 + 形状限定 ASCII token" 共同封死（无需按字节截断）。
 *
 * [关联代码]
 *   - attachment.service.ts — 唯一调用方（upload 时对 `file.mimetype` 调本函数）
 *   - ../database/entities/attachment.entity.ts — client_mime_type 列（非法/缺失 → NULL）
 *   - client-mime.spec.ts — sanitize 规则矩阵（含截断顺序的回归用例）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 调整步骤顺序前先读 client-mime.spec.ts 的「越界非法字符不得被洗白」用例
 * =============================================================================
 */

/** client_mime_type 列宽（与 entity/migration 的 varchar(100) 同源） */
export const CLIENT_MIME_MAX_LENGTH = 100;

/**
 * RFC 6838 受限字符集（token）：ALPHA / DIGIT / ! # $ & - ^ _ . + 与 '*' '`' '|' '~'。
 * 这里用 TypeScript 正则，禁止使用 `.` 通配（否则 `a/../b` 之类噪声过闸）。
 */
const MIME_SHAPE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * sanitize 客户端声明的 mime。
 *
 * 规则（顺序固定，每步失败即回落 NULL）：
 * 0. 非字符串 / 空串 → NULL；
 * 1. 剥离全部控制字符（\x00-\x1F 含 \r\n\0、\x7F DEL）——删而非替换；
 * 2. 只取第一个 `;` 之前的 media type 段（丢弃 charset 等参数），trim；
 * 3. **形状校验 `type/subtype`（在完整串上做）** → 不匹配 NULL；
 * 4. 最后才截断 ≤ {@link CLIENT_MIME_MAX_LENGTH}（列宽是字符计，但 mime 形状限定
 *    为 ASCII，两者等效，此处按字符截断即可）。
 *
 * ⚠️ 步骤 3 必须在 4 之前（m1 评审）：若先截断再校验，越界位置上的非法字符会被
 * 「切掉」——`image/png` + 200 个 `x` + 空格 这类串会因空格落在 100 字符之外而
 * 变成形状合法的截断值，等于把**非法值洗白落地**。先校验完整串则"非法 → NULL"
 * 在超长分支上同样成立（合法且超长的值截断后仍是合法形状：token 字符集对截断封闭）。
 *
 * @param raw 声明值（multer `file.mimetype`，任意类型——外部输入不可信）
 * @returns sanitize 后的展示值；非法/缺失 → null
 */
export function sanitizeClientMimeType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, '');
  const mediaType = stripped.split(';')[0].trim();
  if (mediaType.length === 0) return null;
  if (!MIME_SHAPE.test(mediaType)) return null;
  return mediaType.slice(0, CLIENT_MIME_MAX_LENGTH);
}
