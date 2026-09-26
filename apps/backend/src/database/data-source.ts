import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { PG_CONNECTION_EXTRA } from './pg-session-defaults';

/**
 * TypeORM CLI / 真库 e2e 的事实源。
 *
 * ⚠️ 本文件**不是**运行时 DataSource——生产运行时是 app.module.ts 的
 * `TypeOrmModule.forRoot`（两者互不继承）。连接级参数一律落 pg-session-defaults.ts
 * 并在两处同时引用（只改一处 = 测试与生产行为分叉，见该文件 [持久踩坑]）。
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'agent_chamber',
  password: process.env.DB_PASSWORD || '***',
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'agent_chamber',
  // 连接级会话默认值（pg_trgm 相似度阈值；DocSpace 检索预过滤 `%` 的召回前提）。
  // 必须在建连时下发：事后 SET/set_limit 会随连接归还污染连接池，SET LOCAL 无事务
  // 时不生效（静默收窄召回）。详见 pg-session-defaults.ts 文件头。
  extra: PG_CONNECTION_EXTRA,
  namingStrategy: new SnakeNamingStrategy(),
  entities: [__dirname + '/entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
