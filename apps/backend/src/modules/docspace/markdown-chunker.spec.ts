import { chunkMarkdown, estimateTokens } from './markdown-chunker';

describe('markdown-chunker', () => {
  // ─── estimateTokens ─────────────────────────────────────────

  describe('estimateTokens', () => {
    it('estimates pure English text: ceil(len/4)', () => {
      // "hello" = 5 chars → ceil(5/4) = 2
      expect(estimateTokens('hello')).toBe(2);
      // "hello world" = 11 chars → ceil(11/4) = 3
      expect(estimateTokens('hello world')).toBe(3);
    });

    it('estimates pure CJK: 1 char ≈ 1 token', () => {
      // "你好" = 2 CJK chars → 2 tokens
      expect(estimateTokens('你好')).toBe(2);
      // "这是测试" = 4 CJK chars → 4 tokens
      expect(estimateTokens('这是测试')).toBe(4);
    });

    it('estimates mixed CJK + English correctly', () => {
      // "你好world" = 2 CJK + 5 non-CJK → 2 + ceil(5/4) = 2 + 2 = 4
      expect(estimateTokens('你好world')).toBe(4);
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('includes Japanese and Korean characters as CJK', () => {
      // "日本語" = 3 CJK chars
      expect(estimateTokens('日本語')).toBe(3);
      // "한국어" = 3 CJK chars
      expect(estimateTokens('한국어')).toBe(3);
    });
  });

  // ─── chunkMarkdown ──────────────────────────────────────────

  describe('chunkMarkdown', () => {
    it('returns a single level-0 chunk for an empty document', () => {
      const result = chunkMarkdown('', 'My Title');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        headingPath: 'My Title',
        headingLevel: 0,
        position: 0,
      });
      expect(result[0].content).toBe('');
    });

    it('returns a single level-0 chunk when no headings exist', () => {
      const content = 'This is some text\nwithout any headings.\nJust paragraphs.';
      const result = chunkMarkdown(content, 'No Headings Doc');
      expect(result).toHaveLength(1);
      expect(result[0].headingLevel).toBe(0);
      expect(result[0].headingPath).toBe('No Headings Doc');
      expect(result[0].position).toBe(0);
      expect(result[0].content).toContain('This is some text');
      expect(result[0].tokenEstimate).toBeGreaterThan(0);
    });

    it('strips frontmatter (defensive skip of --- blocks)', () => {
      const content = [
        '---',
        'title: Frontmatter Test',
        'tags: [test]',
        '---',
        '',
        '# Real Heading',
        '',
        'Actual content here.',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Actual content here');
      expect(result[0].content).not.toContain('Frontmatter Test');
      expect(result[0].content).not.toContain('tags:');
    });

    it('frontmatter-only document returns empty level-0 chunk', () => {
      const content = [
        '---',
        'title: Only Frontmatter',
        '---',
      ].join('\n');

      const result = chunkMarkdown(content, 'Empty Doc');
      expect(result).toHaveLength(1);
      expect(result[0].headingLevel).toBe(0);
      expect(result[0].content).toBe('');
    });

    it('creates level-0 chunk for content before first heading', () => {
      const content = [
        'Intro paragraph before any heading.',
        '',
        '# Section 1',
        '',
        'Content under section 1.',
      ].join('\n');

      const result = chunkMarkdown(content, 'My Doc');
      expect(result).toHaveLength(2);
      expect(result[0].headingLevel).toBe(0);
      expect(result[0].headingPath).toBe('My Doc');
      expect(result[0].content).toContain('Intro paragraph');
      expect(result[1].headingLevel).toBe(1);
      expect(result[1].headingPath).toBe('Section 1');
      expect(result[1].content).toContain('Content under section 1');
    });

    it('splits by ATX headings (h1-h6)', () => {
      const content = [
        '# H1',
        'h1 content',
        '',
        '## H2',
        'h2 content',
        '',
        '### H3',
        'h3 content',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(3);
      expect(result[0].headingLevel).toBe(1);
      expect(result[0].headingPath).toBe('H1');
      expect(result[1].headingLevel).toBe(2);
      expect(result[1].headingPath).toBe('H1 § H2');
      expect(result[2].headingLevel).toBe(3);
      expect(result[2].headingPath).toBe('H1 § H2 § H3');
    });

    it('handles 6-level heading nesting', () => {
      const content = [
        '# L1',
        'l1',
        '## L2',
        'l2',
        '### L3',
        'l3',
        '#### L4',
        'l4',
        '##### L5',
        'l5',
        '###### L6',
        'l6',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(6);
      expect(result[5].headingLevel).toBe(6);
      expect(result[5].headingPath).toBe('L1 § L2 § L3 § L4 § L5 § L6');
    });

    it('rebuilds ancestor chain on same-level heading (resets sibling)', () => {
      const content = [
        '# A',
        'content a',
        '',
        '## B',
        'content b',
        '',
        '## C',
        'content c',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(3);
      expect(result[0].headingPath).toBe('A');
      expect(result[1].headingPath).toBe('A § B');
      // C is sibling of B, not child → headingPath = A § C
      expect(result[2].headingPath).toBe('A § C');
    });

    it('handles higher-level heading popping ancestors', () => {
      const content = [
        '## Deep',
        'deep content',
        '',
        '# Shallow',
        'shallow content',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(2);
      // Deep: starting h2 → path = "Deep" (no parent)
      expect(result[0].headingPath).toBe('Deep');
      // Shallow: h1 pops h2 → path = "Shallow"
      expect(result[1].headingPath).toBe('Shallow');
    });

    it('splits sections >4000 chars by paragraphs', () => {
      // Build a single section > 4000 chars with paragraph breaks
      const para = 'A'.repeat(800) + '\n'; // ~801 chars per paragraph
      let bigSection = '';
      for (let i = 0; i < 6; i++) {
        bigSection += para + '\n';
      }
      // Should be ~4800+ chars

      const content = '# Big\n' + bigSection;
      const result = chunkMarkdown(content, 'Doc');

      // Should have been split into multiple chunks with same headingPath
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.headingPath).toBe('Big');
        expect(chunk.headingLevel).toBe(1);
        expect(chunk.content.length).toBeLessThanOrEqual(4010); // generous allowance
      }
    });

    it('truncates headingPath to 512 characters', () => {
      // Build a deep heading chain with long names
      const longName = 'A'.repeat(200);
      const headings: string[] = [];
      for (let i = 1; i <= 6; i++) {
        headings.push(`${'#'.repeat(i)} ${longName}${i}`);
        headings.push(`content ${i}`);
      }

      const result = chunkMarkdown(headings.join('\n'), 'Doc');
      // Last heading's headingPath should be truncated to 512
      const lastHeading = result[result.length - 1];
      expect(lastHeading.headingPath.length).toBeLessThanOrEqual(512);
    });

    it('handles CRLF line endings', () => {
      const content = '# Title\r\n\r\nBody line 1\r\nBody line 2';
      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(1);
      expect(result[0].headingPath).toBe('Title');
      expect(result[0].content).toContain('Body line 1');
    });

    it('produces empty-content chunks for empty heading sections (round-trip fidelity)', () => {
      const content = [
        '# Section 1',
        'content 1',
        '',
        '# Section 2',
        '',
        '# Section 3',
        'content 3',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        headingPath: 'Section 1',
        headingLevel: 1,
        position: 0,
      });
      expect(result[0].content).toBe('content 1');
      // 空正文标题必须产 chunk，否则「全文读 + upsert 回写」往返会永久丢失该标题行
      expect(result[1]).toMatchObject({
        headingPath: 'Section 2',
        headingLevel: 1,
        position: 1,
        content: '',
        tokenEstimate: 0,
      });
      expect(result[2]).toMatchObject({
        headingPath: 'Section 3',
        headingLevel: 1,
        position: 2,
      });
      expect(result[2].content).toBe('content 3');
    });

    it('produces an empty-content chunk for a heading with no body at EOF', () => {
      const content = ['# A', 'content a', '', '# B'].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({
        headingPath: 'B',
        headingLevel: 1,
        position: 1,
        content: '',
        tokenEstimate: 0,
      });
    });

    it('empty parent heading still yields empty chunk while children get full path', () => {
      // ## A 无正文（空父标题）→ 自身产空 chunk；### B 的 headingPath 走祖先链 "A § B"
      const content = ['## A', '', '### B', '正文'].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        headingPath: 'A',
        headingLevel: 2,
        position: 0,
        content: '',
      });
      expect(result[1]).toMatchObject({
        headingPath: 'A § B',
        headingLevel: 3,
        position: 1,
        content: '正文',
      });
    });

    it('positions increment monotonically across empty and non-empty headings', () => {
      const content = [
        '# A',
        'content a',
        '',
        '## B', // 空标题
        '',
        '### C',
        'content c',
        '',
        '## D', // 空标题，EOF 无正文
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      expect(result).toHaveLength(4);
      for (let i = 0; i < result.length; i++) {
        expect(result[i].position).toBe(i);
      }
      expect(result.map((c) => c.content)).toEqual([
        'content a',
        '',
        'content c',
        '',
      ]);
    });

    it('positions increment monotonically', () => {
      const content = [
        '# A',
        'content a',
        '',
        '## B',
        'content b',
        '',
        '### C',
        'content c',
      ].join('\n');

      const result = chunkMarkdown(content, 'Doc');
      for (let i = 0; i < result.length; i++) {
        expect(result[i].position).toBe(i);
      }
    });

    it('tokenEstimate is consistent: CJK paragraph ≈ char count', () => {
      const chineseText = '这是中文文档的测试内容，用于验证token估算的准确性。深度学习模型在处理中文时通常按字分词。';
      const result = chunkMarkdown('# Title\n' + chineseText, 'Doc');
      expect(result).toHaveLength(1);
      // CJK estimate ≈ char count (each char ≈ 1 token)
      const cjkChars = chineseText.replace(/[^一-龥]/g, '').length;
      // Token estimate should be close to the number of CJK chars
      // (with small overhead for non-CJK chars like punctuation/spaces)
      const tokenEst = result[0].tokenEstimate;
      expect(tokenEst).toBeGreaterThanOrEqual(cjkChars * 0.8);
      expect(tokenEst).toBeLessThanOrEqual(cjkChars * 1.2);
    });

    // ─── 围栏代码块（bug f2549375 回归）──────────────────────────

    describe('fenced code blocks', () => {
      it('ignores ATX-like lines inside ``` fenced code blocks', () => {
        const content = [
          '# Real',
          'real content',
          '',
          '```bash',
          '# 只搜索消息',
          'curl -s https://example.com # 查看全部任务',
          '```',
          '',
          '## Child',
          'child content',
        ].join('\n');

        const result = chunkMarkdown(content, 'Doc');
        expect(result).toHaveLength(2);
        expect(result[0].headingPath).toBe('Real');
        expect(result[1].headingPath).toBe('Real § Child');
        // 围栏内的注释行完整保留在正文，不参与标题识别
        expect(result[0].content).toContain('# 只搜索消息');
        expect(result[0].content).toContain('```bash');
      });

      it('ignores ATX-like lines inside ~~~ fenced code blocks', () => {
        const content = [
          '# Real',
          'real content',
          '~~~',
          '# Not A Heading',
          '~~~',
          '## Child',
          'child content',
        ].join('\n');

        const result = chunkMarkdown(content, 'Doc');
        expect(result).toHaveLength(2);
        expect(result[0].headingPath).toBe('Real');
        expect(result[1].headingPath).toBe('Real § Child');
      });

      it('closes fence only on same marker char with length >= opening', () => {
        const content = [
          '# A',
          'a',
          '```',
          '~~~', // 异种围栏标记 → 仍是 ``` 围栏内的代码内容
          '# Not A Heading',
          '````', // 同字符且更长 → 合法闭合
          '## B',
          'b',
        ].join('\n');

        const result = chunkMarkdown(content, 'Doc');
        expect(result).toHaveLength(2);
        expect(result[0].headingPath).toBe('A');
        expect(result[1].headingPath).toBe('A § B');
      });

      it('treats everything after an unclosed fence as code (no headings)', () => {
        const content = ['# A', 'a', '```', '# Not A Heading', '## Also Not'].join('\n');

        const result = chunkMarkdown(content, 'Doc');
        expect(result).toHaveLength(1);
        expect(result[0].headingPath).toBe('A');
      });

      it('indented fence (≤3 spaces) still opens a code block', () => {
        const content = [
          '# Real',
          'real content',
          '  ```bash',
          '# Not A Heading',
          '  ```',
          '## Child',
          'child content',
        ].join('\n');

        const result = chunkMarkdown(content, 'Doc');
        expect(result).toHaveLength(2);
        expect(result[1].headingPath).toBe('Real § Child');
      });
    });
  });
});
