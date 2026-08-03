import path from 'path';
import { loadProfile } from './profile-loader';
import { matchesAnyPattern } from '../mapper/tool-mapper';

/**
 * MCP 工具面分层（v1.39.0-dev）防回归测试：
 * 断言内置 profile 文件保持预期形态，防止后续裁剪/误改导致工具面漂移。
 * 相关设计：docs/automcp.md「双实例双入口」、docs/platform-mcp.md 工具口径。
 */
describe('mcp-profiles (agent.json / full.json 防回归)', () => {
  /**
   * agent.json（worker profile）include 全量 28 条正则的快照清单。
   *
   * 与 apps/backend/config/mcp-profiles/agent.json 逐字一致（有序断言，JSON 数组顺序即文件顺序）。
   * 任何新增/删除/改写正则都会使快照断言失败——比旧的"长度 28 + 抽查 5 个"更防回归。
   */
  const AGENT_INCLUDE_SNAPSHOT: string[] = [
    '^agent_controller_get_me$',
    '^topic_controller_find_all$',
    '^topic_controller_create$',
    '^topic_controller_find_one$',
    '^topic_controller_get_messages$',
    '^topic_controller_send_message$',
    '^topic_controller_join$',
    '^topic_controller_leave$',
    '^board_controller_find_all$',
    '^board_controller_find_one$',
    '^board_controller_find_lists$',
    '^board_controller_find_list_tasks$',
    '^task_controller_find_all$',
    '^task_controller_find_one$',
    '^task_controller_update$',
    '^task_controller_assign$',
    '^task_controller_move$',
    '^task_controller_get_comments$',
    '^task_controller_add_comment$',
    '^task_controller_batch_create$',
    '^task_controller_add_dependency$',
    '^task_controller_remove_dependency$',
    '^task_controller_find_dependencies$',
    '^task_controller_find_dependents$',
    '^task_controller_find_milestones$',
    '^task_controller_find_milestone$',
    '^event_controller_poll$',
    '^search_controller_search$',
  ];

  /**
   * full.json（full profile）显式 exclude 快照清单。
   *
   * 与 apps/backend/config/mcp-profiles/full.json 逐字一致。
   * 语义：full 面 include 为 `.*`，显式 exclude 承载全部排除——
   * ① admin_user_controller_*（Admin Users tag 不在默认排除名单，靠命名巧合才被漏排，显式写死防脆弱）
   * ② audit/monitoring/sse 控制器（原默认 tag 排除的等价物——full.json 一旦提供非空 exclude，
   *    applyFilter 会跳过默认 tag 排除，必须显式补上才保持"其余全量"语义不变）
   */
  const FULL_EXCLUDE_SNAPSHOT: string[] = [
    '^admin_user_controller_',
    '^audit_controller_',
    '^monitoring_controller_',
    '^sse_controller_',
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
    return path.resolve(
      __dirname,
      '../../../../apps/backend/config/mcp-profiles',
      `${name}.json`
    );
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
    it('should keep exactly 28 include rules', async () => {
      const include = await loadInclude('agent');

      expect(include).toHaveLength(28);
    });

    it('should match full 28-rule include snapshot (逐字防回归)', async () => {
      const include = await loadInclude('agent');

      // 有序快照：任何一条正则被改坏（删除/改写/新增）都会在此失败
      expect(include).toEqual(AGENT_INCLUDE_SNAPSHOT);
    });

    it('should keep every rule a valid regex', async () => {
      const include = await loadInclude('agent');

      // 生产匹配逻辑对非法正则静默视为不匹配（matchesAnyPattern），
      // 一条写坏的正则等价于工具静默丢失——显式断言每条都能编译
      for (const pattern of include) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
    });

    it('should keep key tools: topic_controller_create', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('topic_controller_create', include)).toBe(true);
    });

    it('should keep key tools: task_controller_find_milestones', async () => {
      const include = await loadInclude('agent');

      expect(matchesAnyPattern('task_controller_find_milestones', include)).toBe(true);
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
    it('should include all tools via ".*"', async () => {
      const include = await loadInclude('full');

      expect(include).toEqual(['.*']);
    });

    it('should match full-4-rule exclude snapshot (显式排除 8 工具面)', async () => {
      const exclude = await loadExclude('full');

      // 非空 exclude 会关闭默认 tag 排除（applyFilter 契约），
      // 因此 audit/monitoring/sse 必须显式列出，与 admin_user 一起快照锁定
      expect(exclude).toEqual(FULL_EXCLUDE_SNAPSHOT);
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
