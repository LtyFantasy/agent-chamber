/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - doc_routes **健康重检**（异步全量巡检：headingPath 锚 + codeEntry manifest
 *     级联）与 **锚校验公共入口**（DocSpace 元数据治理 2 期 A2 收口）。
 *
 * [代码职责]
 *   - `recheckSpace`：拉空间全量路由 → 逐条校验锚与 codeEntry → 组装 issues →
 *     `health={issues, checkedAt}` 批量落库（三触发点：upsert/remove 的 setImmediate +
 *     手动端点）。
 *   - `analyzeDocRouteAnchors`（2 期新增，**A2 唯一锚校验公共入口**）：查指向某文档的
 *     路由引用 + 逐锚比对，供 doc.service（upsert 事务内 / delete）与 doc-move.service
 *     复用——**禁止在其他 service 复制锚校验逻辑**（第二事实源必然漂移）。
 *   - `readRepoManifest`：读 `space.settings.repoManifest`（C2 数据源）。
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: 线上 docs/api-definition.md §16（doc_routes 段 + hints 挂点表）
 *   - 补充: .kimi/plan-info-online-batch-c.md §2（C1 设计）
 *
 * [关键不变量]
 *   - **锚 = `headingPath` 精确等值**（null = 文档级跳转，无条件可解析）；
 *     `analyzeDocRouteAnchors` 的比对口径与 `sectionExistsByHeadingPath` 同源——
 *     只是数据源换成了调用方**将要写入的** headingPath 集合（A4：upsert 用 in-memory
 *     chunks，避免事务后再查 sections 造成快照不一致）。
 *   - `headingPaths === null` = **文档消失**（delete 语义）：指向它的全部路由判断
 *     （docId 锚断是语义判定，无逐锚成本）。
 *   - `issues.length > 0` 是**唯一 broken 判据**（codeEntryStatus:'exempt' 不产 issue
 *     故天然不计入）。
 *   - **不报 unchecked**：无 manifest → codeEntryStatus:'unchecked' 且不产 issue
 *     （「从未上报清单」≠「代码入口失配」）；`health=null/unchecked` **绝不解释为健康**。
 *
 * [关联代码]
 *   - modules/docspace/doc.service.ts — upsert 事务内（route_anchor_broken）与 remove
 *     （docId 锚断）调用 analyzeDocRouteAnchors
 *   - modules/docspace/doc-move.service.ts — move 的 route_anchor_recheck 复用
 *     `impact.docRoutes`（A3：零额外查询，不重复查路由）
 *   - modules/docspace/doc-route.controller.ts — 手动 recheck 端点（POST …/routes/recheck）
 *   - route-health.service.spec.ts — recheck 与 analyzeDocRouteAnchors 契约单测
 *
 * [持久踩坑]
 *   - ROUTE-HEALTH-1（unchecked ≠ healthy）：health 为 null / codeEntryStatus 为
 *     'unchecked' 时，消费方不得据此认为路由健康——提示面必须用 check_skipped 明确
 *     表达「没检查」。安全方向：需要判定时一律走 analyzeDocRouteAnchors 或 recheck。
 *
 * [铁律关联] #17(测试契约) #22(findOne必须判空) #11(注释强制) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 *   □ 新增锚校验逻辑一律加进 analyzeDocRouteAnchors，禁止在消费方复制
 * =============================================================================
 */
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocService } from './doc.service';
import type { RepoManifest, RouteHealthIssue } from '@agent-chamber/shared';
import { CODE_ENTRY_TYPE } from './doc-constants';

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
        if (route.codeEntryType === CODE_ENTRY_TYPE.PATTERN) {
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

  // ─── 锚校验公共入口（2 期 A2 收口）────────────────────────────────────

  /**
   * 取指向该文档的路由引用清单（primary 或 secondary 命中 docId）。
   *
   * 空间内先过滤（`space_id` 索引 + 空间内 docId 比对）——route 实体只有
   * `@Index(['spaceId'])`，量级百级可接受（plan §6 成本评估）。
   *
   * public（2 期 A2）：doc.service / doc-move.service 复用，**禁止在消费方另写一份**。
   */
  async routesReferencingDoc(spaceId: string, docId: string): Promise<DocRoute[]> {
    return this.routeRepo
      .createQueryBuilder('r')
      .where('r.space_id = :spaceId', { spaceId })
      .andWhere('(r.primary_doc_id = :docId OR r.secondary_doc_id = :docId)', { docId })
      .getMany();
  }

  /**
   * 锚比对**纯函数**（2 期 A2 + MAJOR-2 修复）：给定引用清单与新的 headingPath 集合，
   * 返回断锚明细——**零 IO**，故可在 upsert 事务内安全调用（不占第二条连接）。
   *
   * 数据源语义（A4）：`headingPaths` 是调用方**将要落库的** section headingPath 集合
   * ——upsert 传事务内 in-memory `chunks` 的集合（与刚插入的 sections 同一份数据，
   * 零额外查询且与幂等快照同事务）；`null` = 文档消失（delete 语义，全部引用路由判断）。
   *
   * 比对口径与 `sectionExistsByHeadingPath` 完全一致（headingPath 精确等值；null 锚 =
   * 文档级跳转，无条件可解析），只是数据源不同——**本方法是唯一的锚校验实现**，
   * 消费方不得复制。
   *
   * @param routes 引用清单（调用方经 `routesReferencingDoc` 在**事务外**取好）
   * @param docId 目标文档
   * @param headingPaths 新 headingPath 集合；null = 文档消失（delete）
   * @returns routeCount（引用总数，供调用方做 cap 判定）+ 断锚路由 ID + 逐锚明细
   */
  analyzeRouteAnchors(
    routes: DocRoute[],
    docId: string,
    headingPaths: Set<string> | null,
  ): {
    routeCount: number;
    brokenRouteIds: string[];
    anchors: Array<{ routeId: string; headingPath: string }>;
  } {
    const brokenRouteIds: string[] = [];
    const anchors: Array<{ routeId: string; headingPath: string }> = [];

    for (const route of routes) {
      const routeAnchors = this.anchorsForDoc(route, docId);

      // 文档消失分支（delete）：**全部引用路由**判断——含纯文档级跳转（无 headingPath
      // 锚）的路由，它的 docId 锚目标已不存在；anchors 只列有锚的那些（docId 锚断本身
      // 无锚点可比）。
      if (headingPaths === null) {
        brokenRouteIds.push(route.id);
        anchors.push(...routeAnchors);
        continue;
      }

      if (routeAnchors.length === 0) continue; // 纯文档级引用（无锚）——内容变更不断它
      const broken = routeAnchors.filter((anchor) => !headingPaths.has(anchor.headingPath));
      if (broken.length === 0) continue;
      brokenRouteIds.push(route.id);
      anchors.push(...broken);
    }

    return { routeCount: routes.length, brokenRouteIds, anchors };
  }

  /**
   * 锚校验便捷入口（2 期 A2）：**查引用 + 比对**一步完成。
   *
   * ⚠️ **调用位置约束（MAJOR-2）**：本方法内含一次 `doc_routes` 查询，走 `routeRepo`
   * 的**独立连接**——**绝不可在已持有事务连接的代码路径内调用**（upsert 事务内调用会
   * 申请第二条连接；pg 池 max=10 且无获取超时，≥10 并发写即整库挂起）。
   * 事务内一律改为：事务外 `routesReferencingDoc` 取清单 → 事务内 `analyzeRouteAnchors`
   * 纯比对。**delete / 手动巡检（无事务）可直用本方法**。
   *
   * @param spaceId 目标空间
   * @param docId 目标文档
   * @param headingPaths 新 headingPath 集合；null = 文档消失（delete）
   */
  async analyzeDocRouteAnchors(
    spaceId: string,
    docId: string,
    headingPaths: Set<string> | null,
  ): Promise<{
    routeCount: number;
    brokenRouteIds: string[];
    anchors: Array<{ routeId: string; headingPath: string }>;
  }> {
    const routes = await this.routesReferencingDoc(spaceId, docId);
    return this.analyzeRouteAnchors(routes, docId, headingPaths);
  }

  /**
   * 取某路由中**指向目标文档的**非空锚（primary/secondary 两侧都判）。
   *
   * 纯函数（无 IO）：仅做角色归属判定与 null 锚过滤——null = 文档级跳转，
   * 与锚无关（delete 场景的「docId 锚断」由调用方的 null 分支统一表达）。
   */
  private anchorsForDoc(
    route: DocRoute,
    docId: string,
  ): Array<{ routeId: string; headingPath: string }> {
    const out: Array<{ routeId: string; headingPath: string }> = [];
    if (route.primaryDocId === docId && route.primaryHeadingPath) {
      out.push({ routeId: route.id, headingPath: route.primaryHeadingPath });
    }
    if (route.secondaryDocId === docId && route.secondaryHeadingPath) {
      out.push({ routeId: route.id, headingPath: route.secondaryHeadingPath });
    }
    return out;
  }
}
