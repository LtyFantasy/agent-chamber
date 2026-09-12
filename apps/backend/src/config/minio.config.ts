/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / MinIO 接入)
 *   - 补充: DEPLOY.md (MinIO 自举/端口绑定/env 注入)
 *
 * [踩坑索引] P2-#1(JWT 密钥静默回退硬编码默认值——同模式：MinIO 凭据缺失
 *            回退占位值仅适合开发，生产必须显式配置)
 *
 * [铁律关联] #11(注释) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';

/**
 * MinIO 连接配置（attachments 模块对象存储）。
 *
 * 六变量（plan §3.8 钉死）：
 * - MINIO_ENDPOINT：主机名。本地开发 127.0.0.1；compose 内网为服务名 minio
 *   （容器内 127.0.0.1 指向自身，backend 服务段显式注入 MINIO_ENDPOINT=minio）
 * - MINIO_PORT：API 端口（默认 9000；console 9001 仅运维，不参与 SDK 连接）
 * - MINIO_USE_SSL：'true' 启用 TLS（默认 false；本地/内网 HTTP，公网部署须显式开）
 * - MINIO_ACCESS_KEY / MINIO_SECRET_KEY：root 或专用服务账号凭据。
 *   默认值为 .env.example 同款占位（minio_root_user / change-me-minio-secret），
 *   仅供本地开发零配置起步；生产经 start.sh 全量 export 注入真值
 * - MINIO_BUCKET：附件 bucket 名（默认 agent-chamber-attachments；启动时
 *   bucketExists→makeBucket 自举，默认 private，严禁设 public 策略）
 */
export default registerAs('minio', () => ({
  endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minio_root_user',
  secretKey: process.env.MINIO_SECRET_KEY || 'change-me-minio-secret',
  bucket: process.env.MINIO_BUCKET || 'agent-chamber-attachments',
}));
