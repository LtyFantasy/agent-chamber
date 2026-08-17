/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: .kimi/plan-info-online-batch-c.md §2 (C1 设计), docs/api-definition.md §16 (doc_routes 段)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #22(findOne必须判空) #11(注释强制) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocService } from './doc.service';
import type { RepoManifest, RouteHealthIssue } from '@agent-chamber/shared';

/**
 * codeEntry ↔ manifest.files 匹配（C2，路径段边界语义）：
 * - 精确命中：codeEntry 本身就是清单中的文件（如 `apps/backend/src/app.module.ts`）；
 * - 目录前缀命中：任一清单文件以 codeEntry 为目录前缀（codeEntry 允许目录路径，如
 *   `apps/backend/src/modules/` 命中其下任意文件）。前缀按路径段边界拼接：无尾斜杠时补 `/`
 *   再比对，`apps/web/src` 不会误命中 `apps/web/srcx/...`（同前缀字符串但不同目录段）。
 *
 * @param codeEntry - 路由代码入口（仓库内相对路径）
 * @param files - repoManifest.files 全量清单
 * @returns 命中任一文件返回 true
 */
function codeEntryInManifest(codeEntry: string, files: string[]): boolean {
  const dirPrefix = codeEntry.endsWith('/') ? codeEntry : `${codeEntry}/`;
  return files.some((f) => f === codeEntry || f.startsWith(dirPrefix));
}

/**
 * doc_routes 异步健康重检器（v1.42 批次 C1 + C2 codeEntry 级联校验）
 *
 * 职责：recheckSpace(spaceId) 拉空间全量路由，逐条对 primary/secondary headingPath
 * 跑 sectionExistsByHeadingPath（复用 DocService:763 现成 exists 查询）→ 组装 issues →
 * health={issues, checkedAt} 批量落库。
 *
 * C2 扩展（plan §3）：recheck 起始读一次 space.settings.repoManifest（git ls-files 清单），
 * 对每条非空 codeEntry 做存在性级联校验——无 manifest → codeEntryStatus:'unchecked'（不算
 * broken）；精确/目录前缀命中 → 'ok'；不命中 → issues 加 {kind:'codeEntry', target:'codeEntry',
 * value} + codeEntryStatus:'broken'。codeEntry 为空省略该键。broken 计数口径不变
 * （issues.length>0），totalBrokenRoutes 装配逻辑不受影响。
 *
 * T5 扩展（codeEntryType 分支）：codeEntryType='pattern' 的 glob 泛化写法（如
 * `apps/web/app/**` + `/page.tsx`）豁免精确存在性校验——health 标记
 * codeEntryStatus:'exempt' + codeEntryNote 说明，不产 issue、绝不报 broken；
 * 'exact'（缺省）沿用 C2 全量校验。heading 校验（①②）对两型一视同仁。
 *
 * 触发点（三处，事件驱动无轮询，plan §2）：
 * ① DocService.upsert 内容变更分支事务提交后 setImmediate（unchanged 早退不触发）；
 * ② DocService.remove 删文 setImmediate 内追加；
 * ③ 手动端点 POST /doc-spaces/:id/routes/recheck（部署后/PM 主动全量）。
 *
 * 失败语义：setImmediate 场景失败仅 Logger 记日志不透出（对齐 recalcSpaceLinkHealth 先例）；
 * 手动端点场景失败直接抛给调用方（同步 await）。
 *
 * 已知边界（plan §10 明文记录风格）：
 * - doc 软删后 sections 因 FK 级联仅限硬删而保留 → 指向已软删 doc 的路由 headingPath 仍可
 *   解析，不被标 broken（与 plan C1 测试三分支「heading ok/broken/none」设计一致；doc 删除
 *   导致的悬空留待后续批次，写时校验 ensureSpaceDoc 已保证新路由不会指向已删 doc）。
 */
@Injectable()
export class RouteHealthService {
  /** NestJS 内置 Logger（fire-and-forget 异步任务错误只记日志不透出，对齐仓内惯例） */
  private readonly logger = new Logger(RouteHealthService.name);

  constructor(
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
    // C2 注入：读 space.settings.repoManifest（manifest 级联校验的数据源）
    @InjectRepository(DocSpace)
    private readonly spaceRepo: Repository<DocSpace>,
    // 循环依赖说明（批次 C1）：DocService 触发点注入本服务（upsert/remove 内 this.routeHealthService），
    // 本服务又注入 DocService 复用 sectionExistsByHeadingPath → 互相依赖。NestJS 标准解法 = 双向
    // forwardRef（plan 授权「用 forwardRef 或…」，见主 Agent 派单 修改路径 4）。
    @Inject(forwardRef(() => DocService))
    private readonly docService: DocService,
  ) {}

  /**
   * 重检一个空间内全部 doc_routes 的 health 并批量落库。
   *
   * @param spaceId 目标 DocSpace ID（不存在/无路由时安全返回零计数，不抛错）
   * @returns { rechecked: 已重检路由数, broken: issues.length>0 的路由数 }——手动 recheck
   *   端点直接透传此结果；setImmediate 触发方忽略返回值
   * @副作用 逐条覆写 route.health（批量 save）；检查时间戳统一取本方法入口时刻
   */
  async recheckSpace(spaceId: string): Promise<{ rechecked: number; broken: number }> {
    const routes = await this.routeRepo.find({ where: { spaceId } });
    if (routes.length === 0) {
      return { rechecked: 0, broken: 0 };
    }

    // C2：manifest 只读一次（同批次共享同一快照，避免重检中途被 sync 覆盖导致口径漂移）
    const repoManifest = await this.readRepoManifest(spaceId);

    // 同批次检查共用同一时间戳：checkedAt 语义 = "本次重检时刻"，避免跨路由毫秒漂移
    const checkedAt = new Date().toISOString();
    let broken = 0;

    for (const route of routes) {
      const issues: RouteHealthIssue[] = [];

      // ① primary headingPath：非空才检（null = 文档级跳转，无条件可解析）
      if (route.primaryHeadingPath) {
        const hit = await this.docService.sectionExistsByHeadingPath(
          route.primaryDocId,
          route.primaryHeadingPath,
        );
        if (!hit) {
          issues.push({ kind: 'heading', target: 'primary', value: route.primaryHeadingPath });
        }
      }

      // ② secondary headingPath：同 primary 语义（secondaryDocId 为 null 时无锚点可检）
      if (route.secondaryDocId && route.secondaryHeadingPath) {
        const hit = await this.docService.sectionExistsByHeadingPath(
          route.secondaryDocId,
          route.secondaryHeadingPath,
        );
        if (!hit) {
          issues.push({ kind: 'heading', target: 'secondary', value: route.secondaryHeadingPath });
        }
      }

      // ③ codeEntry manifest 级联校验（批次 C2 + T5 pattern 豁免）：非空才检。
      // 无 manifest → unchecked（不产 issue 不算 broken——「从未上报清单」≠「代码入口失配」）；
      // 有 manifest → 精确/目录前缀命中 ok，否则 broken + kind:'codeEntry' issue。
      // T5：codeEntryType='pattern'（glob 泛化写法）→ 豁免精确存在性校验（人类指引价值 >
      // 精确校验价值），codeEntryStatus:'exempt' + codeEntryNote 说明原因，issues 保持为空
      // → 天然不计入 broken（issues.length>0 是唯一 broken 判据，overview 口径自动对齐）。
      // codeEntryStatus 键由类型注释约定（RouteHealth.codeEntryStatus，shared DTO）。
      const codeEntry = route.codeEntry;
      if (codeEntry) {
        if (route.codeEntryType === 'pattern') {
          route.health = {
            issues,
            codeEntryStatus: 'exempt',
            codeEntryNote: 'glob pattern codeEntry — precise existence check exempted',
            checkedAt,
          };
        } else if (!repoManifest) {
          route.health = {
            issues,
            codeEntryStatus: 'unchecked',
            checkedAt,
          };
        } else {
          const hit = codeEntryInManifest(codeEntry, repoManifest.files);
          if (hit) {
            route.health = { issues, codeEntryStatus: 'ok', checkedAt };
          } else {
            issues.push({ kind: 'codeEntry', target: 'codeEntry', value: codeEntry });
            route.health = { issues, codeEntryStatus: 'broken', checkedAt };
          }
        }
      } else {
        route.health = { issues, checkedAt };
      }

      if (issues.length > 0) broken++;
    }

    await this.routeRepo.save(routes);
    return { rechecked: routes.length, broken };
  }

  /**
   * 读空间 repoManifest（C2；脏数据防御对齐 docspace.service B4 惯例）：
   * space 不存在 / settings.repoManifest 缺失 / files 非数组 → null（视为未上报）。
   * 数组元素不再逐条校验——写入端 DTO 已保证格式（铁律 #21 单一写口）。
   */
  private async readRepoManifest(spaceId: string): Promise<RepoManifest | null> {
    const space = await this.spaceRepo.findOne({ where: { id: spaceId } });
    const candidate = (space?.settings ?? {}).repoManifest as unknown;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !Array.isArray((candidate as RepoManifest).files)
    ) {
      return null;
    }
    return candidate as RepoManifest;
  }
}
