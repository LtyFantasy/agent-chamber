import path from 'path';
import { readFileSync } from 'fs';
import { loadProfile } from './profile-loader';
import { matchesAnyPattern } from '../mapper/tool-mapper';

/**
 * 此 spec 本就校验 monorepo 的后端 profile；只读独立发行声明来选择固定 oracle。
 * 不 import shared 运行时代码，也不从被测 profile 推导预期，保持 automcp 无业务依赖。
 * 缺失、重复或非字面量声明必须失败，不能默认为某一发行模式。
 */
function readMemoryDistribution(): boolean {
  const source = readFileSync(
    path.resolve(__dirname, '../../../../packages/shared/src/constants/distribution.ts'),
    'utf8',
  );
  const names = source.match(/\bexport\s+const\s+MEMORY_FEATURE_ENABLED\b/g) ?? [];
  const declarations = [
    ...source.matchAll(/^export const MEMORY_FEATURE_ENABLED: boolean = (true|false);$/gm),
  ];
  if (names.length !== 1 || declarations.length !== 1) {
    throw new Error(
      'Profile contract requires exactly one literal MEMORY_FEATURE_ENABLED declaration',
    );
  }
  return declarations[0][1] === 'true';
}

/** 独立于 agent/full JSON 的发行模式；机制见线上 docs/integrations/oss-dual-repo.md §11。 */
const memoryFeatureEnabled = readMemoryDistribution();

/**
 * MCP 工具面分层（v1.39.0-dev）防回归测试：
 * 断言内置 profile 文件保持预期形态，防止后续裁剪/误改导致工具面漂移。
 * 相关设计：docs/integrations/automcp.md「双实例双入口」、docs/integrations/platform-mcp.md 工具口径。
 */
describe('mcp-profiles (agent.json / full.json 防回归)', () => {
  /**
   * agent.json（worker profile）include 的固定快照：基础 15 条，内测开启时追加 Memory 19 条。
   *
   * 与 apps/backend/config/mcp-profiles/agent.json 逐字一致（有序断言，JSON 数组顺序即文件顺序）。
   * 任何新增/删除/改写正则都会使快照断言失败。
   *
   * 2026-10-20 降级批（usage 35 天 <50 次，Owner 拍板）：worker 面从 48 条 include
   * 裁到 32 条，alpha.19 追加 usage 两读面后为 34 条——移除 16 个低频原子工具（event poll / topic create·join·leave·find_one /
   * board find_all·find_lists / task assign·move·dependency 读侧·milestones /
   * agent get_me·get_my_unread），它们仍可在 `/mcp-full` 或 REST 调用。
   * 同批语义工具由 `excludeCustomTools` 排除 17 个，两处合计 33 个降级项。
   *
   * 保留项中：
   * - `topic_controller_update_notification_settings` 是 worker 面唯一的 per-topic
   *   收件偏好入口（日报型 agent 自助静默，不能靠人类代设）；
   * - `notifications_controller_send_message` 只暴露直发，admin 投递记录列表刻意不进；
   * - 内部开启时末 19 条 = Memory 全系；本期 OSS 关闭时这 19 条必须全部缺席。
   */
  const NON_MEMORY_INCLUDE_SNAPSHOT: string[] = [
    '^topic_controller_find_all$',
    '^topic_controller_get_messages$',
    '^topic_controller_send_message$',
    '^topic_controller_update_notification_settings$',
    '^board_controller_find_one$',
    '^board_controller_find_list_tasks$',
    '^task_controller_find_all$',
    '^task_controller_find_one$',
    '^task_controller_update$',
    '^task_controller_get_comments$',
    '^task_controller_add_comment$',
    '^task_controller_batch_create$',
    '^task_controller_add_dependency$',
    '^search_controller_search$',
    '^notifications_controller_send_message$',
  ];

  /** 完整 Memory 固定 oracle，关闭模式仍逐一检查，不因本期不暴露而删除其测试。 */
  const MEMORY_INCLUDE_SNAPSHOT: string[] = [
    '^memory_controller_create_project$',
    '^memory_controller_list_projects$',
    '^memory_controller_get_project$',
    '^memory_controller_update_project$',
    '^memory_controller_nominate$',
    '^memory_controller_list_nominations$',
    '^memory_controller_get_nomination$',
    '^memory_controller_retry_nomination$',
    '^memory_controller_recover_project$',
    '^memory_controller_recall$',
    '^memory_controller_correct$',
    '^memory_controller_get_memory$',
    '^memory_controller_get_graph_view$',
    '^memory_controller_get_memory_view$',
    '^memory_controller_get_memory_view_history$',
    '^memory_controller_get_memory_view_representation$',
    '^memory_controller_get_memory_relations$',
    '^memory_controller_get_usage_summary$',
    '^memory_controller_get_usage_trace$',
  ];

  /** 只按独立发行门选择固定清单，不从实际 profile 的成员或数量反推预期。 */
  const AGENT_INCLUDE_SNAPSHOT: string[] = [
    ...NON_MEMORY_INCLUDE_SNAPSHOT,
    ...(memoryFeatureEnabled ? MEMORY_INCLUDE_SNAPSHOT : []),
  ];

  /**
   * agent.json `excludeCustomTools` 快照（17 个语义工具，精确名）。
   *
   * 与 include 的分工：include/exclude 正则只过滤 OpenAPI 原子工具；语义工具
   * （platform-mcp customTools）由本字段按精确名排除（automcp `filterCustomTools`）。
   * 精确名是必需的——`delete_doc` 与 `delete_doc_route` 同前缀，正则排除会误伤。
   *
   * 豁免红线（Owner 拍板，90 天内不许出现在本表）：memory 全系 / notifications×2 /
   * 经验库全系（record/search/read/update/report/review）。
   */
  const AGENT_EXCLUDE_CUSTOM_TOOLS_SNAPSHOT: string[] = [
    'create_topic_with_board',
    'import_docs',
    'import_doc_bundle',
    'upsert_diagram',
    'validate_diagram',
    'patch_diagram',
    'read_diagram',
    'get_my_activity',
    'list_orphan_docs',
    'export_doc_space',
    'list_doc_versions',
    'read_doc_version',
    'merge_doc_category',
    'update_doc_space_vocabulary',
    'delete_doc_route',
    'resolve_agent',
    'delete_doc',
  ];

  /**
   * 16 个被降级的原子工具（worker 面必须不再命中；full 面仍可达）。
   */
  const DOWNGRADED_ATOMIC_TOOLS: string[] = [
    'event_controller_poll',
    'topic_controller_leave',
    'topic_controller_create',
    'topic_controller_find_one',
    'topic_controller_join',
    'task_controller_assign',
    'task_controller_move',
    'task_controller_find_milestones',
    'task_controller_find_milestone',
    'task_controller_find_dependencies',
    'task_controller_find_dependents',
    'task_controller_remove_dependency',
    'board_controller_find_all',
    'board_controller_find_lists',
    'agent_controller_get_me',
    'agent_controller_get_my_unread',
  ];

  /**
   * worker 面**应当**命中的工具名全量（与 AGENT_INCLUDE_SNAPSHOT 一一对应）。
   *
   * 用途 = 计划 §6 要求的「每条 include 至少命中 1 个工具名」断言：快照只证明"正则没被改坏"，
   * 这里再证"每条正则**真的**命中一个工具名"——两条断言合起来才排除"正则写对了但工具改名了"
   * 这类静默丢工具（matchesAnyPattern 对不命中是静默 false）。
   */
  const AGENT_EXPECTED_TOOL_NAMES: string[] = AGENT_INCLUDE_SNAPSHOT.map((pattern) =>
    pattern.replace(/^\^/, '').replace(/\$$/, ''),
  );

  /**
   * full.json（full profile）显式 exclude 快照清单。
   *
   * 与 apps/backend/config/mcp-profiles/full.json 逐字一致。
   * 语义：full 面 include 为 `.*`，显式 exclude 承载全部排除——
   * ① admin_user_controller_*（Admin Users tag 不在默认排除名单，靠命名巧合才被漏排，显式写死防脆弱）
   * ② audit/monitoring/sse 控制器（原默认 tag 排除的等价物——full.json 一旦提供非空 exclude，
   *    applyFilter 会跳过默认 tag 排除，必须显式补上才保持"其余全量"语义不变）
   * ③ 操作级排除 `^experience_controller_backfill_judgments$`：判定补跑是**人类 admin 专属**
   *    动线（agent 调用必 403/1009），对 agent 面没有消费价值；写**全字面量**而非宽前缀
   *    （`^experience_controller_` 会把整个经验库从 full 面摘掉）。它也是**操作级** pattern
   *    的第一例——`gen-skill-tool-counts.mjs` 的 exclude 计数已同步支持这一级匹配。
   */
  const FULL_EXCLUDE_SNAPSHOT: string[] = [
    '^admin_user_controller_',
    '^audit_controller_',
    '^monitoring_controller_',
    '^sse_controller_',
    '^experience_controller_backfill_judgments$',
    ...(memoryFeatureEnabled ? [] : ['^memory_controller_.*']),
  ];

  /**
   * 定位仓库根目录下内置 profile 文件（jest cwd 为包目录，须从 __dirname 向上解析）
   *
   * ⚠️ 路径脆弱性（v1.39.0 评审遗留 C5）：该相对路径假定仓库布局为
   * `packages/automcp/` 与 `apps/backend/` 同级的 monorepo。oss 导出/快照仓若改变布局
   * （如剔除 apps/backend 或调整目录层级），此路径会失效导致测试红——
   * oss 导出白名单需包含 `apps/backend/config/mcp-profiles/` 目录，或在此类布局下跳过本 spec。
   *
   * @param name - profile 名称（agent / full）
   * @returns profile 文件绝对路径
   */
  function profilePath(name: string): string {
    return path.resolve(__dirname, '../../../../apps/backend/config/mcp-profiles', `${name}.json`);
  }

  /**
   * 加载 profile 的 include 清单
   *
   * @param name - profile 名称（agent / full）
   * @returns include 正则数组
   */
  async function loadInclude(name: string): Promise<string[]> {
    const profile = await loadProfile(profilePath(name));
    expect(profile.include).toBeDefined();
    return profile.include as string[];
  }

  /**
   * 加载 profile 的 exclude 清单（缺省视为空数组）
   *
   * @param name - profile 名称（agent / full）
   * @returns exclude 正则数组
   */
  async function loadExclude(name: string): Promise<string[]> {
    const profile = await loadProfile(profilePath(name));
    return profile.exclude ?? [];
  }

  describe('agent.json（worker profile）', () => {
    it('should keep the fixed include count for this distribution', async () => {
      const include = await loadInclude('agent');

      expect(include).toHaveLength(memoryFeatureEnabled ? 34 : 15);
    });

    it('should match the fixed include snapshot for this distribution (逐字防回归)', async () => {
      const include = await loadInclude('agent');

      // 有序快照：任何一条正则被改坏（删除/改写/新增）都会在此失败
      expect(include).toEqual(AGENT_INCLUDE_SNAPSHOT);
    });

    it('should match at least one tool name per include rule (每条 include 至少命中 1 个工具名)', async () => {
      const include = await loadInclude('agent');

      // 计划 §6 的命中断言：正则"没被改坏"（上一条）与"真的命中一个工具名"是两件事——
      // 后者才能抓出"工具被改名而 profile 未同步"（matchesAnyPattern 对不命中是静默 false）
      const matched = AGENT_EXPECTED_TOOL_NAMES.filter((tool) => matchesAnyPattern(tool, include));
      expect(matched).toEqual(AGENT_EXPECTED_TOOL_NAMES);
    });

    it('should apply the distribution boundary to each of the 19 Memory tools', async () => {
      const include = await loadInclude('agent');

      const memoryTools = [
        'memory_controller_create_project',
        'memory_controller_list_projects',
        'memory_controller_get_project',
        'memory_controller_update_project',
        'memory_controller_nominate',
        'memory_controller_list_nominations',
        'memory_controller_get_nomination',
        'memory_controller_retry_nomination',
        'memory_controller_recover_project',
        'memory_controller_recall',
        'memory_controller_correct',
        'memory_controller_get_memory',
        // 投影读面（五读面；只读安全，故进 worker 面）
        'memory_controller_get_graph_view',
        'memory_controller_get_memory_view',
        'memory_controller_get_memory_view_history',
        'memory_controller_get_memory_view_representation',
        // alpha.6 关系建议（作者自报、仅建议；只读）
        'memory_controller_get_memory_relations',
        // alpha.19 usage 两读面（只读；GET）
        'memory_controller_get_usage_summary',
        'memory_controller_get_usage_trace',
      ];
      for (const tool of memoryTools) {
        expect(matchesAnyPattern(tool, include)).toBe(memoryFeatureEnabled);
      }
    });

    it('should keep every rule a valid regex', async () => {
      const include = await loadInclude('agent');

      // 生产匹配逻辑对非法正则静默视为不匹配（matchesAnyPattern），
      // 一条写坏的正则等价于工具静默丢失——显式断言每条都能编译
      for (const pattern of include) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
    });

    it('should keep key tools: topic_controller_send_message', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('topic_controller_send_message', include)).toBe(true);
    });

    it('should keep key tools: topic_controller_update_notification_settings', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('topic_controller_update_notification_settings', include)).toBe(
        true,
      );
    });

    it('should keep key tools: task_controller_find_one', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('task_controller_find_one', include)).toBe(true);
    });

    it('should not expose the 16 downgraded atomic tools（降级仍可从 full/REST 调用）', async () => {
      const include = await loadInclude('agent');

      for (const tool of DOWNGRADED_ATOMIC_TOOLS) {
        expect(matchesAnyPattern(tool, include)).toBe(false);
      }
    });

    it('should keep excludeCustomTools snapshot (17 个语义工具精确名)', async () => {
      const profile = await loadProfile(profilePath('agent'));

      expect(profile.excludeCustomTools).toEqual(AGENT_EXCLUDE_CUSTOM_TOOLS_SNAPSHOT);
    });

    it('should preserve core atomic tools while applying the Memory distribution boundary', async () => {
      const include = await loadInclude('agent');

      // 开启模式保留 Memory，关闭模式逐一拒绝；notifications 直发与 topic 偏好始终保留。
      // 不要在这里用 excludeCustomTools 断言——该字段只作用于
      // custom tools，拿原子名去查它恒为 false，等于没有护栏。
      for (const name of [
        'memory_controller_recall',
        'memory_controller_correct',
        'memory_controller_get_memory_view',
        'memory_controller_get_memory_relations',
      ]) {
        expect(matchesAnyPattern(name, include)).toBe(memoryFeatureEnabled);
      }
      for (const name of [
        'notifications_controller_send_message',
        'topic_controller_update_notification_settings',
      ]) {
        expect(matchesAnyPattern(name, include)).toBe(true);
      }
    });

    it('should never exclude exempt semantic tools (经验库全系)', async () => {
      const profile = await loadProfile(profilePath('agent'));
      const excluded = new Set(profile.excludeCustomTools ?? []);

      // 语义工具的豁免护栏在这里：excludeCustomTools 能命中的只有 customTools，
      // 经验库上线 28 天推广期保护，90 天内不许进排除表（逐个点名防顺手带走）。
      for (const name of [
        'record_experience',
        'search_experiences',
        'read_experience',
        'update_experience',
        'report_experience_feedback',
        'review_experience_quality',
      ]) {
        expect(excluded.has(name)).toBe(false);
      }
    });

    it('should trim task_controller_create (semantic create_task covers it)', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('task_controller_create', include)).toBe(false);
    });

    it('should trim doc_controller_upsert (semantic upsert_doc covers it)', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('doc_controller_upsert', include)).toBe(false);
    });

    it('should trim task_controller_find_blockers (semantic follow_up_task covers it)', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('task_controller_find_blockers', include)).toBe(false);
    });

    it('should not rely on exclude for trimming', async () => {
      const exclude = await loadExclude('agent');

      // 裁剪全部由 include 精确正则完成，exclude 保持空数组
      expect(exclude).toHaveLength(0);
    });
  });

  describe('full.json（full profile）', () => {
    it('should keep the broad include pattern ".*"', async () => {
      const include = await loadInclude('full');

      expect(include).toEqual(['.*']);
    });

    it('should not exclude custom tools on full face (降级工具在 full 面全部可达)', async () => {
      const profile = await loadProfile(profilePath('full'));

      expect(profile.excludeCustomTools).toBeUndefined();
    });

    it('should match the complete fixed exclude snapshot for this distribution', async () => {
      const exclude = await loadExclude('full');

      // 非空 exclude 会关闭默认 tag 排除（applyFilter 契约），
      // 因此 audit/monitoring/sse 必须显式列出，与 admin_user 一起快照锁定
      expect(exclude).toEqual(FULL_EXCLUDE_SNAPSHOT);
    });

    it('should apply the distribution boundary to every Memory tool on the full face', async () => {
      const exclude = await loadExclude('full');

      for (const pattern of MEMORY_INCLUDE_SNAPSHOT) {
        const tool = pattern.replace(/^\^/, '').replace(/\$$/, '');
        expect(matchesAnyPattern(tool, exclude)).toBe(!memoryFeatureEnabled);
      }
    });

    it('should explicitly exclude admin user management tools', async () => {
      const exclude = await loadExclude('full');

      // 防命名巧合回归：Admin Users tag 不在默认排除名单，全量面必须显式排除
      for (const tool of [
        'admin_user_controller_find_all',
        'admin_user_controller_create_by_admin',
        'admin_user_controller_update_by_admin',
        'admin_user_controller_delete_by_admin',
      ]) {
        expect(matchesAnyPattern(tool, exclude)).toBe(true);
      }
    });

    it('should keep audit/monitoring/sse exclusion equivalent to default tag filter', async () => {
      const exclude = await loadExclude('full');

      // 默认 tag 排除的 4 个 ops（audit_controller_find_all / monitoring_controller_* 2 /
      // sse_controller_stream）在显式 exclude 下必须仍被排除，否则 full 面会回流内部模块
      for (const tool of [
        'audit_controller_find_all',
        'monitoring_controller_get_api_logs',
        'monitoring_controller_export_api_logs',
        'sse_controller_stream',
      ]) {
        expect(matchesAnyPattern(tool, exclude)).toBe(true);
      }

      // 其余常规工具不受影响（抽查：full 面核心管理入口仍在）
      expect(matchesAnyPattern('doc_controller_find_all', exclude)).toBe(false);
      expect(matchesAnyPattern('topic_controller_find_all', exclude)).toBe(false);
    });
  });
});
