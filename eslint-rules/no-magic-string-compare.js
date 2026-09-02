/**
 * 自定义 ESLint 规则：禁止魔法字符串比较
 *
 * 检测模式：=== 'xxx', !== 'xxx', == 'xxx', != 'xxx'
 * 以及反向：'xxx' === yyy, 'xxx' !== yyy
 *
 * 维护一个黑名单，每发现新的魔法字符串就加进来。
 * 分组注释与 packages/shared/src/enums/index.ts 对齐（评审任务 ed67b65e 对账）。
 * 测试文件 (.spec.ts) 豁免，因为测试中常需要直接比较字符串。
 *
 * 通用词误报面大的值不入黑名单（历史决策，见 ed67b65e 汇报）：
 * - 'dev'/'ready'（MilestoneStatus）：常见语境词（环境/就绪）
 * - 'completed'：与 ACP 工具结果态透传值撞值（roundtable.service setPresence）
 * - 'create'/'update'/'delete'（AuditAction）：与 ResourceAction 策略动作撞值
 * - 'patch'/'import'（versionSource）：通用词（HTTP 方法 / 导入语义）
 * 8fab2a9d 已并入（原「resourceType 族全为赋值无单源」项）：
 * - 'topic'/'board'/'message'/'doc'：ResourceType 枚举（shared enums，events
 *   resourceType 值域；'task' 已在 MessageType 组同值并入）
 * 150bf876 已并入（原「待建枚举后并入」项）：
 * - 'mention'：WakePolicy 枚举建立后并入（与 EventType.MENTION 双义，两处同值）
 * - 'normal'/'roundtable'：TopicKind 枚举（shared enums）
 * - 'online'/'busy'/'offline'：SEAT_RUNTIME_STATUSES（协议包）+ runner 行状态 +
 *   presence 相位（PRESENCE_PHASES，shared enums）三处同值
 * - 'removed'/'parked'：SEAT_LIFECYCLE_STATUSES（shared enums）
 */

const MAGIC_STRINGS = [
  // ActorType（'system' 亦为 MessageType.SYSTEM / EventType.SYSTEM 同值）
  'human',
  'agent',
  'system',

  // AgentStatus / TopicStatus / ParticipantStatus / MilestoneStatus / ApiKeyStatus 共用（'active'）
  'active',
  // AgentStatus / WebhookStatus / 圆桌权限请求状态共用（'pending'）
  'pending',

  // AgentStatus
  'disabled',
  // ApiKeyStatus（'active' 见上）
  'revoked',

  // TaskStatus
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
  'archived',

  // TopicStatus（active/paused/closed；'open' 与 Visibility.OPEN 同值，见 Visibility 组；
  // draft/voting 已删——2026-08-31 死契约清理）
  'paused',
  'closed',

  // Visibility（'open' = Visibility.OPEN，与 TopicStatus.OPEN 同值；'public' 为已废弃旧值）
  'private',
  'open',

  // Priority
  'p0',
  'p1',
  'p2',
  'p3',

  // MessageType（'system' 已在 ActorType 组）
  'chat',
  'proposal',
  'vote',
  'task',
  'artifact',
  'status_update',
  'thinking',

  // ActivityAction（shared 枚举 = created/updated/moved/assigned/commented/status_changed；
  // 'deleted' 不在 shared，为历史死条目已清）
  'created',
  'updated',
  'moved',
  'assigned',
  'commented',
  'status_changed',

  // DependencyType（TaskDependencyType）
  'blocks',
  'relates_to',
  'duplicates',

  // ParticipantStatus（邀请/离开；'active' 见上）
  'invited',
  'left',

  // 角色（UserRole.ADMIN/EDITOR、BoardMemberRole、TopicParticipantRole 共用值域）
  'admin',
  'editor',
  'member',
  'moderator',

  // MilestoneStatus（'active' 见上；'dev'/'ready'/'completed' 未入，理由见文件头）
  'planned',
  'cancelled',
  'deployed',
  'verified',

  // AuditAction（'create'/'update'/'delete' 与 ResourceAction 撞值未入，理由见文件头）
  'login',
  'logout',
  'reset_api_key',
  'toggle_agent',
  'pause_topic',
  'resume_topic',
  'move_doc',

  // EventType（'system' 已入；'mention' 与 WakePolicy.MENTION 双义，见 WakePolicy 组）
  'new_message',
  'task_update',
  'topic_status_change',
  'agent_joined',
  'agent_left',
  'task_assigned',
  'doc_created',
  'doc_updated',
  'doc_deleted',
  'doc_moved',

  // WebhookStatus（'pending' 见上）
  'success',
  'failed',

  // 圆桌权限请求状态（单源 PERMISSION_REQUEST_STATUS，roundtable.service 模块常量）
  'orphaned',
  'approved',
  'rejected',

  // DocSpace 文档源哨兵（单源 DOC_SOURCE_NATIVE，docspace 模块常量；ingest 来源开放不枚举）
  'native',

  // DocRoute codeEntryType（单源 CODE_ENTRY_TYPE，docspace 模块常量）
  'exact',
  'pattern',

  // Doc 版本来源 versionSource（'upsert' 缺省 / 'append'；'patch'/'import' 通用词未入）
  'upsert',
  'append',

  // WakePolicy（'mention' 亦为 EventType.MENTION 同值，双义并入）
  'mention',

  // TopicKind（topics.kind 列值域）
  'normal',
  'roundtable',

  // SEAT_RUNTIME_STATUSES（协议包，SeatEvent 运行态）+ runner 行状态（online/offline）
  // + presence 相位（PRESENCE_PHASES 的 offline）三处同值
  'online',
  'busy',
  'offline',

  // SEAT_LIFECYCLE_STATUSES（roundtable_seats.status 生命周期五值）
  'removed',
  'parked',

  // ResourceType（events.resourceType 值域；'task' 已在 MessageType 组同值并入）
  'topic',
  'board',
  'message',
  'doc',
];

const COMPARE_OPERATORS = ['===', '!==', '==', '!='];

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow magic string comparisons, use enum/constant instead',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      noMagicStringCompare:
        "Magic string comparison: '{{value}}'. Use enum or constant instead. Add to MAGIC_STRINGS list if this is a new business value.",
    },
  },

  create(context) {
    function checkLiteral(node) {
      if (node.type !== 'Literal' || typeof node.value !== 'string') {
        return;
      }
      const lowerValue = node.value.toLowerCase();
      if (MAGIC_STRINGS.includes(lowerValue)) {
        context.report({
          node,
          messageId: 'noMagicStringCompare',
          data: { value: node.value },
        });
      }
    }

    return {
      BinaryExpression(node) {
        if (!COMPARE_OPERATORS.includes(node.operator)) {
          return;
        }
        checkLiteral(node.left);
        checkLiteral(node.right);
      },
    };
  },
};
