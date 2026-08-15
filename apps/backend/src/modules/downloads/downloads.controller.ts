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
 * [铁律关联] #4(文档优先) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiProduces, ApiResponse, ApiParam } from '@nestjs/swagger';
import { createReadStream } from 'fs';
import { StreamableFile } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { DownloadsService } from './downloads.service';

/**
 * 下载分发控制器：公开提供「圆桌 runner 一键安装」链路资产。
 *
 * 与 install-skill.sh 同性质（公开下载，无需登录），故全部端点挂 @Public()；
 * 又因返回裸文件而非 JSON，必须挂 @SkipTransform() 跳过 ResponseInterceptor 的
 * { code, message, data } 包装（否则 StreamableFile 会被 map 成普通对象序列化，流被破坏）。
 *
 * 路径安全：install-runner.sh / roundtable-runner.tar.gz 为固定路由（无参数），
 * integrations/:file 由 DownloadsService 白名单校验（铁律 #21 双层校验）。
 */
@ApiTags('Downloads')
@Controller('downloads')
export class DownloadsController {
  constructor(private readonly downloadsService: DownloadsService) {}

  /**
   * 获取 runner 一键安装脚本（curl | bash 直链，供路径 B 人类一行命令使用）。
   */
  @Get('install-runner.sh')
  @Public()
  @SkipTransform()
  @ApiOperation({
    summary: 'Download install-runner.sh',
    description:
      'Public download of the roundtable runner one-command installer (Linux/macOS). ' +
      'Usage: curl -fsSL <platform>/api/v1/downloads/install-runner.sh | bash -s -- --platform-url <url> --api-key <key>',
  })
  @ApiProduces('text/x-shellscript')
  @ApiResponse({ status: 200, description: 'Shell script (attachment)' })
  @ApiResponse({ status: 404, description: 'Asset not built (dist-assets missing)' })
  getInstallRunnerScript(): StreamableFile {
    return this.streamAsset('install-runner.sh');
  }

  /**
   * 获取 runner 自包含 bundle（standalone 模式安装包，vendor 了 prod node_modules）。
   */
  @Get('roundtable-runner.tar.gz')
  @Public()
  @SkipTransform()
  @ApiOperation({
    summary: 'Download roundtable-runner.tar.gz',
    description:
      'Public download of the self-contained roundtable runner bundle ' +
      '(built by scripts/build-runner-bundle.sh into dist-assets/).',
  })
  @ApiProduces('application/gzip')
  @ApiResponse({ status: 200, description: 'Gzip archive (attachment)' })
  @ApiResponse({ status: 404, description: 'Asset not built (dist-assets missing)' })
  getRunnerBundle(): StreamableFile {
    return this.streamAsset('roundtable-runner.tar.gz');
  }

  /**
   * 获取对接指南（kimi/codex/opencode/claude-code 各 EN + zh-CN）。
   *
   * @param file 指南文件名，仅白名单内可访问（见 DownloadsService.DOWNLOAD_WHITELIST）
   */
  @Get('integrations/:file')
  @Public()
  @SkipTransform()
  @ApiOperation({
    summary: 'Download integration guide markdown',
    description:
      'Public download of roundtable runner integration guides. ' +
      'Whitelisted files: kimi.md / codex.md / opencode.md / claude-code.md (plus each .zh-CN.md).',
  })
  @ApiProduces('text/markdown')
  @ApiParam({ name: 'file', description: 'Guide filename (whitelist enforced)', example: 'kimi.md' })
  @ApiResponse({ status: 200, description: 'Markdown guide (attachment)' })
  @ApiResponse({ status: 404, description: 'File not in whitelist or missing' })
  getIntegrationGuide(@Param('file') file: string): StreamableFile {
    return this.streamAsset(file);
  }

  /**
   * 共用组装：定位资产 → StreamableFile（流式响应，Content-Type/Disposition/Length 一次给全）。
   *
   * @param fileName 白名单文件名
   * @returns NestJS StreamableFile，由框架直接流式写响应（nginx 已对 /api/ 关 proxy_buffering）
   */
  private streamAsset(fileName: string): StreamableFile {
    const asset = this.downloadsService.resolve(fileName);
    return new StreamableFile(createReadStream(asset.absPath), {
      type: asset.contentType,
      disposition: `attachment; filename="${asset.fileName}"`,
      length: asset.size,
    });
  }
}
