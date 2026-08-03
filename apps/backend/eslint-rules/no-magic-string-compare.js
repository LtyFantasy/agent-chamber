/**
 * 自定义 ESLint 规则：禁止魔法字符串比较
 *
 * 检测模式：=== 'xxx', !== 'xxx', == 'xxx', != 'xxx'
 * 以及反向：'xxx' === yyy, 'xxx' !== yyy
 *
 * 维护一个黑名单，每发现新的魔法字符串就加进来。
 * 测试文件 (.spec.ts) 豁免，因为测试中常需要直接比较字符串。
 */

const MAGIC_STRINGS = [
  // ActorType
  'human',
  'agent',
  'system',

  // AgentStatus / UserStatus
  'active',
  'inactive',

  // TaskStatus
  'backlog',
  'in_progress',
  'done',
  'archived',
  'todo',

  // TopicStatus
  'open',
  'closed',

  // Visibility
  'private',
  'public',

  // Priority
  'p0',
  'p1',
  'p2',
  'p3',

  // MessageType
  'chat',
  'status_update',
  'thinking',
  'proposal',
  'vote',
  'task',
  'artifact',

  // ActivityAction
  'created',
  'updated',
  'deleted',
  'moved',
  'assigned',

  // DependencyType
  'blocks',
  'relates_to',
  'duplicates',
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
