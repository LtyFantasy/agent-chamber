import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'agent_chamber',
  password: process.env.DB_PASSWORD || '***',
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'agent_chamber',
  namingStrategy: new SnakeNamingStrategy(),
  entities: [__dirname + '/entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
