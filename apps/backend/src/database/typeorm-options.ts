/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **生产运行时** TypeORM 连接选项的单一构造点（`app.module.ts` 的
 *     `TypeOrmModule.forRoot` 唯一实参来源）
 *
 * [代码职责]
 *   - 抽出连接选项为可单测的工厂 `buildTypeOrmOptions()`：让「连接级会话默认值
 *     (`extra`) 确实被装配进生产 DataSource」成为**可被测试断言的装配事实**，
 *     而不是只能靠人眼看 app.module.ts 的那一行
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: src/database/pg-session-defaults.ts — `extra` 的取值与「连接级下发」论证
 *
 * [关键不变量]
 *   - **本工厂 = 生产运行时 DataSource 的唯一选项源**：`app.module.ts` 只许
 *     `TypeOrmModule.forRoot(buildTypeOrmOptions())`，禁止在 module 里再写内联选项对象
 *     （两处选项必然漂移，而其中一处是生产）。
 *   - `migrations` glob 的相对基准是**本文件所在目录**（`__dirname`）：编译产物在
 *     `dist/apps/backend/src/database/`，故取值必须是 `/migrations/*{.ts,.js}`（不含
 *     `database/` 前缀）；改路径必须同步改 `typeorm-options.spec.ts` 的目录存在性断言。
 *   - `extra` 必须直接引用 `PG_CONNECTION_EXTRA`（同源引用，非再写一份字面量）：
 *     `%` 算子读的是会话参数，字面量副本一旦漂移即静默收窄召回范围。
 *
 * [关联代码]
 *   - src/app.module.ts — 唯一消费方（`TypeOrmModule.forRoot(buildTypeOrmOptions())`）
 *   - src/database/data-source.ts — CLI/真库测试的那份（另一装配点，同样引用同一常量）
 *   - src/database/typeorm-options.spec.ts — 装配断言（「删掉 extra 即红」）
 *
 * [持久踩坑]
 *   PGCONN-FACTORY-BYPASS(装配旁路): 抽了工厂但不改 `forRoot` 调用点（或日后有人又在
 *     module 里写内联选项）⇒ 单测断言的是工厂而非真正被装配的那份，守卫失效。
 *     安全方向: 看到本文件被引用前先确认 `app.module.ts` 里只有一个选项来源；
 *     `forRoot` 的实参必须是本工厂调用，不得出现内联对象字面量。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { PG_CONNECTION_EXTRA } from './pg-session-defaults';
import * as entities from './entities';

/**
 * 构造生产运行时的 TypeORM 连接选项。
 *
 * 为什么是「工厂 + 导出」而不是就地内联对象：`extra`（pg_trgm 相似度阈值）这类
 * **连接级**参数只影响 `%` 算子的召回面，一旦在装配处漏掉，症状是「检索静默少召回」
 * 而不是任何报错——纯靠 code review 守不住。抽成工厂后，单测可断言
 * `buildTypeOrmOptions().extra` 与 `PG_CONNECTION_EXTRA` 同源（见 typeorm-options.spec.ts），
 * 删掉那行即红。
 *
 * 取值与历史内联块**逐字一致**（含 process.env 回退口径与注释里的语义），仅把
 * `migrations` glob 的基准改为本文件所在目录（见 [关键不变量]）。
 */
export function buildTypeOrmOptions(): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'agent_chamber',
    password: process.env.DB_PASSWORD || '***',
    // DB_NAME 优先，DB_DATABASE 为 .env.example 历史键名 fallback（A5：向后兼容）
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'agent_chamber',
    // 连接级会话默认值（pg_trgm 相似度阈值；DocSpace 检索预过滤 `%` 的召回前提）。
    // ⚠️ 本工厂是**生产运行时的唯一 DataSource**（不复用 database/data-source.ts，那份只给
    // TypeORM CLI 与真库测试用）——故两处必须同时引用同一常量，只改一处 = 测试绿而生产
    // 静默丢召回。详见 database/pg-session-defaults.ts 文件头。
    extra: PG_CONNECTION_EXTRA,
    entities: Object.values(entities),
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    migrationsRun: true,
    logging: process.env.NODE_ENV === 'development',
  };
}
