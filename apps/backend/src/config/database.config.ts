import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'agent_chamber',
  password: process.env.DB_PASSWORD || '***',
  // DB_NAME 优先，DB_DATABASE 为 .env.example 历史键名 fallback（A5：两键名并存期向后兼容）
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'agent_chamber',
  ssl: process.env.DB_SSL === 'true',
}));
