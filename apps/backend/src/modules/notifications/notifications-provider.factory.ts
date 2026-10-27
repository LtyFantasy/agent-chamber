/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块出口的 **DI 装配点**：按 `NOTIFY_PROVIDERS` 配置装配 provider 列表 +
 *     启动诊断（warnings 透传 / 零 provider 警告）。Logger 归属层（config 工厂保持纯函数
 *     无 Logger，见其文件头）。
 *
 * [代码职责]
 *   - `createNotifyProviders(config)`：按 `NOTIFY_PROVIDERS` 顺序构造 provider 实例数组
 *     （一期只有 `feishu`）；未知 token **fail-open 忽略**（config 侧已产 warning）。
 *     **本层负责把 config 的键喂进构造函数**——provider 叶子不读 env（见 [关键不变量]）
 *   - `resolveNotificationsConfig(config)`：读 `notifications` 配置 + **缺省兜底**
 *   - `NOTIFY_PROVIDER_LIST` token 的 provider 定义（`inject: [ConfigService]` + useFactory）
 *   - **三条启动诊断**：① config 的 `warnings` 逐条 warn；② 零 provider 但总开关开着 ⇒ warn；
 *     ③ 总开关启用 ⇒ 一行 INFO（provider 列表 + categories + 出境声明，**三处同源的第三处**）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §3 架构（ProviderRegistry：
 *     "factory 按 NOTIFY_PROVIDERS 装配，未知 token 忽略"）/ §4 配置（出境声明三处同源）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **零 provider 不是启动错误**（fail-open）：`NOTIFY_ENABLED=true` 但 `NOTIFY_PROVIDERS`
 *     为空时，平台照常启动，编排器把每次投递记成 `failed` + `no_provider` 语义。理由：
 *     通知是**可选出口**，配错出口不该让整个平台起不来（与 judgment 的 provider 缺省 none 同纪律）。
 *     **但必须打一行 warn**——"开着通知却没有出口"是最容易配错的组合。
 *   - **`NOTIFY_PROVIDER_LIST` 必须有缺省兜底**：e2e 的 ConfigModule 可能未 load `notifications`
 *     工厂，`config.get('notifications')` 会是 undefined——回落 `NOTIFICATIONS_CONFIG_FALLBACK`
 *     （enabled=false + 空 provider），保证编排器在任何装配下都拿到完整形状。
 *   - **config 的 `warnings` 只做透传打印**：文案在 config 侧已净化（键名 / 常量 / 合法值域 /
 *     经净化的 token），本层**不得**在其上再拼接 env 原值。
 *   - **本层不做配置校验**：fail-fast 矩阵在 config 工厂；本层只分派 + 打日志——同一判据写两处
 *     = 迟早一处漏改。
 *   - **启动 INFO 是出境声明的第三处**（前两处 = `.env.example` 的 Notify 区块、config 的生产
 *     fail-fast 文案）：三处引用 `NOTIFY_EGRESS_DECLARATION` 同一段文字，不得各写一遍。
 *   - **provider 实例顺序 = `NOTIFY_PROVIDERS` 出现顺序**：投递表按该顺序逐行落库，顺序变化
 *     会让 admin 列表的行序变化（单测断言顺序，防"顺手排序"）。
 *   - **凭据/超时只在本层从 config 取出、以构造参数喂进叶子**：叶子（`feishu.notify-provider.ts`）
 *     **不读 `process.env`**——否则"配置从哪来"会有两个答案，e2e 的 `overrideProvider` 也换不掉。
 *
 * [关联代码]
 *   - ../../config/notifications.config.ts — 配置来源、provider 值域、出境声明单源
 *   - notify-provider.interface.ts — `NOTIFY_PROVIDER_LIST` token 与端口契约
 *   - feishu.notify-provider.ts — 一期唯一实现（S3 真身；构造参数 = `FeishuProviderOptions`）
 *   - notify-orchestrator.service.ts — 本 token 的唯一消费者
 *   - notifications.module.ts — 本 provider 定义的装配点
 *
 * [持久踩坑]
 *   NOTIFY-FEISHU-PLACEHOLDER-LIVE(占位件上线)——**已于 S3 消除**：S2 骨架期的占位实现
 *     （恒 failed、不发任何字节）若被带上生产，表现为"配置全对、一条也收不到、投递表全是
 *     failed"。安全方向（已落地）: 占位分支整体删除、不留 fallback（一个恒失败的 provider
 *     比"没有 provider"更危险——后者至少会打 `dropped [no_provider]`）。
 *     ⚠️ 残留风险换了形态：**装上了 ≠ 凭据可用**。凭据错的第一条投递会以
 *     `business: ... code=99991663` 落库（不是静默），排障入口 = 投递表 + admin 列表。
 *
 * [铁律关联] #11(注释强制) #26(文档联动)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 token 必须同时给出"生产/测试各拿什么"的装配说明
 *   □ 新增 provider 必须同步本文件分派 + config 值域 + 两份 spec 的矩阵用例
 *   □ provider 构造函数新增键：必须从 config 取（不得让叶子读 env），并补 spec 的装配断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_EGRESS_DECLARATION,
  type NotificationsConfig,
} from '../../config/notifications.config';
import { FeishuNotifyProvider } from './feishu.notify-provider';
import { NOTIFY_PROVIDER_LIST, type NotifyProvider } from './notify-provider.interface';

/** 诊断日志的 Logger（**Logger 归属层 = 本文件**；config 工厂保持纯函数） */
const logger = new Logger('NotificationsProvider');

/**
 * 解析 `notifications` 配置（缺省兜底；见文件头不变量）。
 *
 * @param config Nest ConfigService（app 由 app.module 的 load 数组注入；e2e 可能没有）
 * @returns 完整配置形状
 */
export function resolveNotificationsConfig(config: ConfigService): NotificationsConfig {
  return config.get<NotificationsConfig>('notifications') ?? NOTIFICATIONS_CONFIG_FALLBACK;
}

/**
 * 按配置装配 provider 列表（未知 token 已由 config 剔除；此处按序构造实例）。
 *
 * @param settings 完整配置
 * @returns 有序 provider 数组（**可为空**——空 = 无出口，编排器据此记 `failed` 语义）
 */
export function createNotifyProviders(settings: NotificationsConfig): NotifyProvider[] {
  const providers: NotifyProvider[] = [];
  for (const token of settings.providers) {
    switch (token) {
      case 'feishu':
        // 凭据 / 超时**只在这里**从 config 取出并喂进叶子：叶子不读 env（见文件头不变量），
        // 于是"配置从哪来"只有一个答案，e2e 的 overrideProvider 也能整体换掉这一层。
        providers.push(
          new FeishuNotifyProvider({
            appId: settings.feishuAppId,
            appSecret: settings.feishuAppSecret,
            httpTimeoutMs: settings.httpTimeoutMs,
          }),
        );
        break;
      // 新增 provider 在这里 +1 个 case，并同步 config 值域（NOTIFY_PROVIDER_TOKENS）
      default:
        // 理论不可达（config 已过滤未知 token）；防御性忽略，绝不抛。
        logger.warn(`NOTIFY_PROVIDERS token "${token}" has no factory branch — ignored.`);
        break;
    }
  }
  return providers;
}

/**
 * provider 列表工厂（装配 + 启动诊断；见文件头）。
 *
 * 诊断顺序固定（warnings → 零出口 warn → 启用 INFO），便于单测与日志对读。
 *
 * @param config ConfigService
 * @returns 有序 provider 数组
 */
export function createNotifyProviderList(config: ConfigService): NotifyProvider[] {
  const settings = resolveNotificationsConfig(config);

  // ① 配置组合异常**响亮化**：config 工厂产 warnings（它保持纯函数无 Logger），本层逐条 warn。
  //    文案在 config 侧已净化（键名 / 常量 / 合法值域），**不得**在其上再拼 env 原值。
  for (const warning of settings.warnings) logger.warn(warning);

  const providers = createNotifyProviders(settings);

  // ② 零出口 warn：开着通知却没有 provider ⇒ 每次投递都被**丢弃**（打一行 INFO
  //    `dropped [no_provider]`，且**不落投递行**——没有出口就没有投递尝试）。
  if (settings.enabled && providers.length === 0) {
    logger.warn(
      'NOTIFY_ENABLED=true but NOTIFY_PROVIDERS is empty — the platform starts fine, but every ' +
        'notification will be dropped (logged as "dropped [no_provider]"; NO delivery row is ' +
        'written, so do not look for failures in notification_deliveries). Set ' +
        'NOTIFY_PROVIDERS=feishu (+FEISHU_*) or NOTIFY_ENABLED=false. See .env.example.',
    );
  }

  // ③ 启用 INFO：**出境声明的第三处**（与 .env.example 的 Notify 区块、config 的生产 fail-fast
  //    文案同源）。行首 `notifications ENABLED` 是 `.env.example` 的"生效自检"grep 契约。
  if (settings.enabled) {
    logger.log(
      `notifications ENABLED — providers=[${providers.map((p) => p.key).join(', ')}] ` +
        `categories=[${settings.categories.join(', ')}]; ` +
        `fields that egress: ${NOTIFY_EGRESS_DECLARATION}`,
    );
  }

  // ⚠️ S2 的"占位件"warn 已随 S3 真身落地**整体删除**（不留分支）：飞书叶子现在真的会发字节，
  //    再打"未实现"提示就是一句假话，会把排障引向错误方向（见文件头 [持久踩坑]）。

  return providers;
}

/** `NOTIFY_PROVIDER_LIST` 的 Nest provider 定义（NotificationsModule 展开并导出） */
export const notifyProviderListProvider: Provider = {
  provide: NOTIFY_PROVIDER_LIST,
  inject: [ConfigService],
  useFactory: createNotifyProviderList,
};
