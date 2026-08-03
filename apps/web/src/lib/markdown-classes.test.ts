import { MARKDOWN_CLASSES, MARKDOWN_CHAT_CLASSES } from './markdown-classes';

/**
 * MARKDOWN 类常量守卫测试（铁律 #17）：
 * 防聊天/文档两份清单再次漂移——双导出必须共享同一基底的关键元素覆盖，
 * 且聊天版不得引入 [&_p] margin（whitespace-pre-wrap 决策，见常量文件头注释）。
 */
describe('markdown-classes', () => {
  /** 双导出必须共享的基底元素覆盖（缺一个即漂移） */
  const SHARED_SELECTORS = [
    '[&_strong]:text-foreground',
    '[&_strong]:font-bold',
    '[&_em]:italic',
    '[&_del]:opacity-70',
    '[&_img]:max-w-full',
    '[&_hr]:border-border/50',
    '[&_input]:accent-primary',
    '[&_a]:text-primary',
    '[&_a]:underline-offset-2',
    '[&_li>p]:my-0',
    '[&_blockquote]:border-l-2',
    '[&_pre]:overflow-x-auto',
  ];

  describe.each([
    ['MARKDOWN_CLASSES（文档完整版）', MARKDOWN_CLASSES],
    ['MARKDOWN_CHAT_CLASSES（聊天紧凑版）', MARKDOWN_CHAT_CLASSES],
  ])('%s', (_label, classes) => {
    it.each(SHARED_SELECTORS)('包含共享覆盖 %s', (selector) => {
      expect(classes).toContain(selector);
    });

    it('覆盖 h1-h6 全部标题档', () => {
      for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        expect(classes).toContain(`[&_${tag}]:`);
      }
    });
  });

  it('聊天版标题压到紧凑档（text-base 封顶）', () => {
    expect(MARKDOWN_CHAT_CLASSES).toContain('[&_h1]:text-base');
    expect(MARKDOWN_CHAT_CLASSES).not.toContain('[&_h1]:text-2xl');
  });

  it('聊天版不含 [&_p] margin（pre-wrap 已提供段落间距，叠加会双倍空行）', () => {
    expect(MARKDOWN_CHAT_CLASSES).not.toContain('[&_p]:my-');
  });

  it('文档版保留段落 margin 与文档级 h1', () => {
    expect(MARKDOWN_CLASSES).toContain('[&_p]:my-2');
    expect(MARKDOWN_CLASSES).toContain('[&_h1]:text-2xl');
  });
});
