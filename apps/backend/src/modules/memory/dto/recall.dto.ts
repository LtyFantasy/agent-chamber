/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆**召回**的请求 DTO（`POST /memory/projects/:id/recalls`）：查询词 + 视图 + 预算
 *     + 上下文字段
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：长度 / 正整数 / 上下限 / 词表 / 必填
 *   - 业务闸门（引擎可用性、项目读权限）在 `memory-recall.service.ts`
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3（`recall({query, view, maxItems,
 *     maxTokens, contextIdentity, contextEpoch, mode:'manual'})` 端口签名）/§6 端点面
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **`contextIdentity` / `contextEpoch` 必填且由调用方给**：Hument 合同把它们列为
 *     required，而**引擎不派生**（方案 §3 端口注释）——"引擎自己找上下文"等于把身份判定
 *     从 Chamber 侧偷走。缺省值会让每次召回都落到同一个伪上下文上（呈现事件去重失效）。
 *   - **`view` 缺省 `current`**（shared `MEMORY_RECALL_VIEW_CURRENT`）：缺省必须与
 *     "只看现行主张"一致——历史视图是显式选择，不能因为没传参数就把被取代的主张也召回回来。
 *   - **上限值取自 Hument 合同**（query 16384 / max_items 128 / max_tokens 262144 /
 *     max_bytes 1048576）：DTO 先挡，服务层透传；**服务层不再二次收紧**
 *     （收紧会让"我明明按合同传了预算"变成静默裁剪）。
 *   - **`contextEpoch` 的平台上限是"护栏"，不是引擎当前的运行时限制**：alpha.3 时代运行时
 *     会拒 `> 1e9`（schema 只有 `minimum: 0`，漂移已反馈 hument），**alpha.4 起引擎已放宽到
 *     JS 安全整数（FEEDBACK-10 已修复）**。平台**仍**卡 1e9——拦的不是"引擎会拒的值"，而是
 *     **一个几乎总是错的用法**：epoch 是"同一 identity 下的第几轮"（逻辑序号 / 相对纪元），
 *     `Date.now()` 毫秒（≈1.76e12）恒为误用，连 Unix 秒（≈1.76e9）也在护栏之上。
 *     保留更严的一侧 = 在**边界层**（铁律 #21）就指名"别传绝对时间"，而不是静默收下。
 *   - **`mode` 不在 DTO 里**：一期定死 `manual`（方案 §3），暴露它 = 让调用方能切成
 *     自动注入路径，而自动注入（hooks）一期明确不做。
 *
 * [关联代码]
 *   - ../memory-recall.service.ts — 本 DTO 的唯一消费方（闸门/透传/过滤/遥测）
 *   - ../memory.constants.ts — `MEMORY_CONTEXT_EPOCH_MAX`（**平台护栏**上限单源，注释带取证过程）
 *   - ../engines/memory-engine.interface.ts — `RecallMemoryInput`（透传形状）
 *   - packages/shared/src/enums/index.ts — `MEMORY_RECALL_VIEWS` 值域单源
 *
 * [修改检查]
 *   □ 已读 [权威文档] §3，新增预算参数必须同步引擎入参与 FakeEngine 的预算实现
 *   □ 新增/收紧任何上限前，先给出依据：**要么有合同/运行时实证**（引擎真会拒的值），
 *     **要么显式声明为"防误用的平台护栏"并写清理由**（如 `contextEpoch` 的 1e9：引擎 alpha.4
 *     起已放宽到 JS 安全整数，护栏仍**刻意保留**以拦"拿绝对时间当 epoch"这个恒错用法）。
 *     既无实证、又未声明为护栏的"平台口味"不得当闸门。
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MEMORY_RECALL_VIEWS, type MemoryRecallView } from '@agent-chamber/shared';
import { MEMORY_CONTEXT_EPOCH_MAX } from '../memory.constants';

/** Hument 合同的查询词上限（字符；平台不另设更严的闸门，见文件头不变量） */
const QUERY_MAX_LENGTH = 16384;

/** Hument 合同的预算上限（条数 / token / 字节；透传，不二次收紧） */
const MAX_ITEMS_CEILING = 128;
const MAX_TOKENS_CEILING = 262144;
const MAX_BYTES_CEILING = 1048576;

/** 召回入参 */
export class RecallMemoryDto {
  /** 查询词（Hument required；**只落 sha256 摘要进遥测，不落原文**） */
  @ApiProperty({
    description: 'Recall query (Hument maxLength 16384)',
    maxLength: QUERY_MAX_LENGTH,
  })
  @IsString()
  @Length(1, QUERY_MAX_LENGTH)
  query: string;

  /** 视图（`current` 缺省 / `history` 含被取代的历史主张；**透传**给引擎） */
  @ApiPropertyOptional({ enum: MEMORY_RECALL_VIEWS, description: 'Recall view (default current)' })
  @IsOptional()
  @IsIn(MEMORY_RECALL_VIEWS)
  view?: MemoryRecallView;

  /** 预算：最大条数（Hument ≤128） */
  @ApiPropertyOptional({ description: 'Max items (≤128)', minimum: 1, maximum: MAX_ITEMS_CEILING })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ITEMS_CEILING)
  maxItems?: number;

  /** 预算：最大 token（Hument ≤262144） */
  @ApiPropertyOptional({
    description: 'Max tokens (≤262144)',
    minimum: 1,
    maximum: MAX_TOKENS_CEILING,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TOKENS_CEILING)
  maxTokens?: number;

  /** 预算：最大字节（Hument ≤1048576） */
  @ApiPropertyOptional({
    description: 'Max bytes (≤1048576)',
    minimum: 1,
    maximum: MAX_BYTES_CEILING,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BYTES_CEILING)
  maxBytes?: number;

  /**
   * 上下文身份（Hument required，**由调用方传入**）。
   *
   * 典型取值 = 本次会话/任务的身份串（如任务 id 或 agent id）；引擎用它做呈现事件的
   * 去重与归因。**不要传用户正文**（它会被引擎用于 digest）。
   */
  @ApiProperty({ description: 'Context identity (required by the engine; do not pass prose)' })
  @IsString()
  @Length(1, 256)
  contextIdentity: string;

  /**
   * 上下文世代（Hument required；同一 identity 下递增，标识"第几轮"）。
   *
   * ⚠️ **上限 1e9 是平台主动保留的护栏，不是引擎当前的运行时限制**：alpha.3 时代引擎会拒
   * `> 1e9`（`recall-request.schema.json` 只声明了 `minimum: 0`，漂移已反馈 hument 作者；
   * 边界二分实证 1e9 过 / 1e9+1 拒 `invalid_argument`），但 **alpha.4 起引擎已放宽到 JS 安全
   * 整数（FEEDBACK-10 已修复）**。平台**仍**卡 1e9，因为它拦的是**一个几乎总是错的用法**：
   * epoch 的语义是"同一 identity 下的第几轮"（逻辑序号 / 相对纪元），**别传 `Date.now()`**——
   * 毫秒时间戳 ≈1.76e12 语义荒谬；⚠️ **`Date.now()/1000`（Unix 秒 ≈1.76e9）同样在护栏之上**
   * ——"秒级"必须是**相对纪元**（自定基准起算），或干脆用每个上下文内的自增序号
   * （引擎只拿它做同一 identity 下的呈现去重，绝对值无意义）。
   */
  @ApiProperty({
    description:
      'Context epoch (required by the engine). RANGE 0..1e9 is a PLATFORM guardrail (the engine ' +
      'accepted up to the JS safe integer since alpha.4): epoch should be a logical sequence or a ' +
      'relative epoch, so do NOT pass Date.now() milliseconds (≈1.76e12), and note that even Unix ' +
      'SECONDS (≈1.76e9) exceed the ceiling — use a small relative epoch instead (an incrementing ' +
      'counter per context, or seconds relative to your own base).',
    minimum: 0,
    maximum: MEMORY_CONTEXT_EPOCH_MAX,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MEMORY_CONTEXT_EPOCH_MAX, {
    message:
      `contextEpoch must be an integer in 0..${MEMORY_CONTEXT_EPOCH_MAX}: this is the PLATFORM ` +
      'guardrail (the engine itself accepted values up to the JS safe integer since alpha.4) — an ' +
      'epoch should be a logical sequence or a relative epoch. Do NOT pass Date.now() ' +
      'milliseconds (≈1.76e12) — and note even Unix SECONDS (≈1.76e9) are over the ceiling: use ' +
      'a small relative epoch (an incrementing counter per context, or seconds relative to your ' +
      'own base). 别传毫秒时间戳（Unix 秒同样超标），请改用逻辑纪元',
  })
  contextEpoch: number;
}
