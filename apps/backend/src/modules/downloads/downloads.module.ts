/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Downloads 分发端点
 *   - 补充: docs/roundtable-design.md §8c 最后一公里连接向导（P2 平台托管一键安装）
 *
 * [踩坑索引]
 *
 * [铁律关联] #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';

/**
 * 下载分发模块：公开静态资产（安装脚本 / runner bundle / 对接指南）。
 * 无 TypeORM 依赖、无鉴权（全部 @Public()），与 SkillModule 同构。
 */
@Module({
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
