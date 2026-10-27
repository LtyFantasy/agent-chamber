/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - AppModule `ConfigModule.load` 数组的**单源常量**：所有 `registerAs` 配置工厂的
 *     统一挂载清单（app.module 消费；app.module.spec.ts 断言）。
 *
 * [代码职责]
 *   - 只做清单聚合；Memory 工厂随编译期发行门装配，不读取额外环境开关。
 *   - 新增 namespace 的唯一动作 = 在这里 +1 行（app.module 不再各自维护清单）
 *
 * [权威文档]
 *   - 线上 docs/integrations/oss-dual-repo.md §11（发行关闭时不解析引擎配置）
 *   - app.module.ts 文件头 D6 踩坑（2026-10-07 memory PoC 冒烟实证：`registerAs('memory')`
 *     存在但 load 数组漏挂 ⇒ `config.get('memory')` undefined ⇒ 引擎静默落 none + 矛盾 warn；
 *     单测/e2e 全部内联 ConfigModule 无一拦下。修复 = 清单单源化 + 守卫 spec）
 *
 * [关键不变量]
 *   - **本数组是 load 清单的唯一事实来源**：app.module 必须 `load: APP_CONFIG_LOADS`，
 *     禁止回退为各自内联数组（回退 = D6 类 bug 大门重开）。
 *   - 顺序即 ConfigModule 初始化顺序；现有七项为存量顺序，新增一律**追加到末尾**。
 *
 * [关联代码]
 *   - ../app.module.ts — 唯一消费方
 *   - ../app.module.spec.ts — 守卫：断言各 namespace 工厂均在数组中
 *
 * [修改检查]
 *   □ 新增 config 工厂 ⇒ 本数组 +1 **且** app.module.spec.ts 的 EXPECTED 列表 +1
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import databaseConfig from './database.config';
import jwtConfig from './jwt.config';
import minioConfig from './minio.config';
import attachmentUrlConfig from './attachment-url.config';
import judgmentConfig from './judgment.config';
import memoryConfig from './memory.config';
import notificationsConfig from './notifications.config';

/** AppModule ConfigModule.load 的单源清单（新增追加到末尾，见文件头不变量） */
export const APP_CONFIG_LOADS = [
  databaseConfig,
  jwtConfig,
  minioConfig,
  attachmentUrlConfig,
  judgmentConfig,
  // OSS 关闭时不执行工厂，继承的 HUMENT_* 也不能触发引擎配置校验。
  ...(MEMORY_FEATURE_ENABLED ? [memoryConfig] : []),
  notificationsConfig,
];
