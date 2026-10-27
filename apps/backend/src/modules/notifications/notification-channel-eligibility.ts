/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **deliveryEligible 谓词的单源**（Notifications 二期）：一张渠道绑定行"此刻能不能投递"
 *     的判据。四处复用，改判据只改这一个文件。
 *
 * [代码职责]
 *   - `deliveryEligibleWhere()`：返回可直接展开进 TypeORM `find` / `count` 的 `where` 片段
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/spec.md` §3.2.33（谓词定义）/ `docs/api-definition.md` §20.3（四处复用）；
 *     播种行也满足它（skill `notifications/feishu-setup.md` §4）
 *
 * [关键不变量]
 *   - **谓词 = `enabled=true ∧ unbound_at IS NULL ∧ last_test_status IN ('ok','seeded')`**。
 *     三个分量缺一不可：
 *     · `enabled=false` = 用户静音（或刚改地址被重置）⇒ 不许投；
 *     · `unbound_at IS NOT NULL` = 解绑 tombstone ⇒ 立刻停投（"解绑 = 通知立即停止"）；
 *     · `last_test_status` 非 `ok`/`seeded` ⇒ 地址未验证/验证失败 ⇒ 投了也是必然失败。
 *     排除 `seeded` 会让**升级日**（D4 播种出来的存量用户）静默全灭——那是最坏的失败模式，
 *     因为症状是"没人收到任何通知"而所有配置看起来都对。
 *   - **四处复用**（plan §D3/D4；禁止在任何调用点手写这个三元组）：
 *     ① 候选查询（批 2 编排器）；② 零绑定锚点计数（批 1）；③ 批 2 直发 `recipient_not_bound`
 *     判定；④ 任何"该用户此刻能投递吗"的判定。
 *     ⚠️ **test 端点的前置闸刻意**不用这个谓词（m7）：它只排除 tombstone（`unbound_at IS NULL`），
 *     因为**验证动作恰恰要允许"未验证"的地址发起**——用本谓词当闸会让用户永远无法完成第一次
 *     验证（自锁：没验证 ⇒ 不 eligible ⇒ 不许发测试 ⇒ 永远没验证）。两处判据语义不同，勿混用。
 *   - **它不是"用户可见的绑定列表"过滤器**：`GET /notification-settings/me` 只过滤 tombstone，
 *     **不过滤 `enabled` / 验证态**（用户必须看到自己被静音的绑定，以及"还差一步验证"的状态）。
 *
 * [关联代码]
 *   - ../database/entities/user-notification-channel.entity.ts — 表契约 + 两个值域常量
 *     （谓词的**可执行形状**刻意不在实体文件里：barrel↔glob 守卫按"导出的函数 = 实体类"对账）
 *   - notify-orchestrator.service.ts — 零绑定锚点计数 / direct 无绑定预警
 *   - notification-settings.service.ts — test 前置判定
 *
 * [铁律关联] #11(注释强制) #18(不变量检查)
 * =============================================================================
 */
import { In, IsNull, type FindOptionsWhere } from 'typeorm';
import {
  DELIVERY_ELIGIBLE_LAST_TEST_STATUSES,
  UserNotificationChannel,
} from '../../database/entities/user-notification-channel.entity';

/**
 * 返回 deliveryEligible 谓词的 `where` 片段（单源，见文件头不变量）。
 *
 * 为什么返回 `FindOptionsWhere` 而不是一句 SQL / 一个布尔函数：所有调用方都是 TypeORM
 * 仓储查询（`find` / `count` / `findOne`），返回**可直接展开**的形状 = 不存在第二份手写
 * where（本仓最忌的静默分歧）。需要附加条件时展开它再叠加：
 * `{ ...deliveryEligibleWhere(), userId: In([...]) }`。
 *
 * @returns 可直接展开进 `find`/`count` 的 where 片段
 */
export function deliveryEligibleWhere(): FindOptionsWhere<UserNotificationChannel> {
  return {
    enabled: true,
    unboundAt: IsNull(),
    lastTestStatus: In([...DELIVERY_ELIGIBLE_LAST_TEST_STATUSES]),
  };
}
