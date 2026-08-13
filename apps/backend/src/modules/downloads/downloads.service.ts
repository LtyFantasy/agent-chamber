/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Downloads 分发端点
 *   - 补充: docs/roundtable-design.md §8c 最后一公里连接向导（P2 平台托管一键安装）
 *
 * [踩坑索引] L8(jsonb) D5(路径遍历)
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #22(findOne 判空/资源缺失 4xx)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: 文件名参数直接拼接路径 = 目录遍历漏洞。本服务对 integrations/:file
 *       只接受白名单扁平文件名，含 / \ .. 一律 404，禁止任何路径参数拼接。
 *       见 memory/2026-06-05.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';

/**
 * DOWNLOADS_DIR 注入 token（铁律 #11 rationale）：
 * 不能用 `constructor(dir?: string)` 裸可选参数——Nest DI 会把 String 当 provider
 * 解析，运行时直接炸（jest 直 new 测不出，dev 启动才暴露）。改为 @Optional token 注入：
 * 未注册 provider 时 dir=undefined → 走 resolveDownloadsDir() env/探测逻辑；
 * 单测仍可 `new DownloadsService(临时目录)` 直 new（装饰器不影响直接实例化）。
 */
export const DOWNLOADS_DIR_TOKEN = 'DOWNLOADS_DIR_TOKEN';

/**
 * 可下载资产清单（防路径遍历的白名单）：
 * - install-runner.sh / roundtable-runner.tar.gz：安装脚本与其自包含 bundle
 * - integrations/ 下四份对接指南：与 oss-docs/docs/integrations/ 实际文件名一一对应
 *
 * 为什么白名单而非黑名单：资产是构建期固化的静态文件集合，白名单天然
 * 排除「未来误放敏感文件」的回归；新增资产必须显式加进这里（铁律 #11 常量 rationale）。
 */
export const DOWNLOAD_WHITELIST = [
  'install-runner.sh',
  'roundtable-runner.tar.gz',
  'kimi.md',
  'kimi.zh-CN.md',
  'codex.md',
  'codex.zh-CN.md',
] as const;

/** 固定文件名 → Content-Type 映射（StreamableFile 不依赖扩展名猜，显式给全） */
const CONTENT_TYPE_BY_FILE: Record<string, string> = {
  'install-runner.sh': 'text/x-shellscript; charset=utf-8',
  'roundtable-runner.tar.gz': 'application/gzip',
  'kimi.md': 'text/markdown; charset=utf-8',
  'kimi.zh-CN.md': 'text/markdown; charset=utf-8',
  'codex.md': 'text/markdown; charset=utf-8',
  'codex.zh-CN.md': 'text/markdown; charset=utf-8',
};

/** 单个下载资产在磁盘上的定位信息（供 controller 组装 StreamableFile） */
export interface DownloadAsset {
  /** 磁盘绝对路径 */
  absPath: string;
  /** 文件字节数（用于 Content-Length） */
  size: number;
  /** Content-Type */
  contentType: string;
  /** Content-Disposition attachment 的文件名 */
  fileName: string;
}

/**
 * 解析 DOWNLOADS_DIR 的缺省值 = repo 根 dist-assets/。
 *
 * 磁盘布局（与 scripts/build-runner-bundle.sh 的产物一一对应）：
 * - dist-assets/install-runner.sh / roundtable-runner.tar.gz（根层）
 * - dist-assets/integrations/*.md（四份指南在 integrations/ 子目录）
 *
 * backend 进程 cwd 因启动方式而异（铁律 #11 必须写清语义）：
 * - dev：`pnpm --filter @agent-chamber/backend dev` 的工作目录是 apps/backend/
 * - 生产宿主机：scripts/start.sh 先 cd 到 repo 根再启动，cwd = repo 根
 * - docker：Dockerfile.backend WORKDIR /app，cwd = repo 根
 *
 * 因此不能直接 `resolve(process.cwd(), 'dist-assets')`（dev 下会指向
 * apps/backend/dist-assets，永远不存在）。改为从 cwd 与 __dirname 两个起点
 * 逐级向上探测「存在 dist-assets 的目录」，两头都找不到再兜底 cwd/dist-assets
 * （此时文件 stat 必然 404，由 DownloadsService 返回 404 而非 500）。
 */
export function resolveDownloadsDir(): string {
  const explicit = process.env.DOWNLOADS_DIR;
  if (explicit) {
    // 允许相对路径（相对当前进程 cwd，与 node 读 env 语义一致）
    return resolve(process.cwd(), explicit);
  }
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let depth = 0; depth < 8; depth++) {
      const candidate = join(dir, 'dist-assets');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return resolve(process.cwd(), 'dist-assets');
}

/**
 * 下载资产定位服务：白名单校验 + 文件存在性检查（铁律 #22：资源缺失返回 404，
 * 禁止把 stat 异常裸抛成 500）。
 */
@Injectable()
export class DownloadsService {
  private readonly downloadsDir: string;

  /**
   * @param dir 可选：显式指定资产目录（经 DOWNLOADS_DIR_TOKEN 注入 / 单测直 new）；
   *            缺省走 resolveDownloadsDir()（env 覆盖 → cwd/__dirname 向上探测）
   */
  constructor(@Optional() @Inject(DOWNLOADS_DIR_TOKEN) dir?: string) {
    this.downloadsDir = dir ?? resolveDownloadsDir();
  }

  /**
   * 白名单校验：只接受扁平文件名，拒绝任何路径分隔符 / 反斜杠 / ..（防目录遍历）。
   * 不在白名单、或磁盘上不存在 → NotFoundException。
   *
   * @param fileName 白名单内的文件名（如 'install-runner.sh'、'kimi.md'）
   * @returns 资产的绝对路径/大小/Content-Type
   * @throws NotFoundException 文件名非法或文件缺失
   */
  resolve(fileName: string): DownloadAsset {
    if (
      !DOWNLOAD_WHITELIST.includes(fileName as (typeof DOWNLOAD_WHITELIST)[number]) ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..')
    ) {
      // 未命中白名单或带路径成分：统一 404，不暴露目录结构
      throw new NotFoundException(`Download asset not found: ${fileName}`);
    }

    // 指南四份在 integrations/ 子目录（build-runner-bundle.sh 产物布局），其余在根层
    const relPath = fileName.endsWith('.md') ? join('integrations', fileName) : fileName;
    const absPath = join(this.downloadsDir, relPath);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      // 文件不存在（或 DOWNLOADS_DIR 未构建）：404 而非 500
      throw new NotFoundException(`Download asset not found: ${fileName}`);
    }
    if (!stat.isFile()) {
      throw new NotFoundException(`Download asset not found: ${fileName}`);
    }

    return {
      absPath,
      size: stat.size,
      contentType: CONTENT_TYPE_BY_FILE[fileName],
      fileName,
    };
  }
}
