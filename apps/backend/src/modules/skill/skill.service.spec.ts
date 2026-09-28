/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §14. Skill 分发 (Skills)
 *   - 补充: ./agents/skills/agent-chamber/SKILL.md
 *
 * [踩坑索引]
 *
 * [铁律关联] #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillService } from './skill.service';

describe('SkillService', () => {
  let service: SkillService;
  let tempDir: string;

  /**
   * 在临时目录下创建测试用的 Skill 文件。
   */
  function createSkillFile(relativePath: string, content: string): void {
    const fullPath = path.resolve(tempDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-service-test-'));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SkillService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(tempDir),
          },
        },
      ],
    }).compile();

    service = moduleRef.get<SkillService>(SkillService);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findAll', () => {
    it('should return skills with frontmatter metadata', async () => {
      createSkillFile(
        'agent-chamber/SKILL.md',
        `---
name: agent-chamber
description: Agent collaboration platform guide.
version: 1.3.1
updatedAt: 2026-06-16
---

# Agent Chamber
`,
      );
      createSkillFile(
        'another-skill/SKILL.md',
        `---
name: another-skill
description: Another skill.
version: 0.0.1
updatedAt: 2026-06-01
---

# Another Skill
`,
      );

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(result.map((item) => item.name)).toContain('agent-chamber');
      expect(result.map((item) => item.name)).toContain('another-skill');

      const mainSkill = result.find((item) => item.name === 'agent-chamber');
      expect(mainSkill).toMatchObject({
        name: 'agent-chamber',
        description: 'Agent collaboration platform guide.',
        version: '1.3.1',
        updatedAt: '2026-06-16',
      });
    });

    it('should ignore directories without SKILL.md', async () => {
      createSkillFile('with-skill/SKILL.md', '# With Skill\n');
      fs.mkdirSync(path.resolve(tempDir, 'without-skill'), { recursive: true });

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('with-skill');
    });

    it('should return empty array when skill directory does not exist', async () => {
      fs.rmSync(tempDir, { recursive: true, force: true });

      const result = await service.findAll();

      expect(result).toEqual([]);
    });

    it('should exclude internal skills from list', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
description: Project-local skill, not for distribution.
internal: true
---

# Internal Skill
`,
      );
      createSkillFile(
        'public-skill/SKILL.md',
        `---
name: public-skill
description: Public skill.
---

# Public Skill
`,
      );

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('public-skill');
    });
  });

  describe('findOne', () => {
    it('should return main skill detail including content', async () => {
      createSkillFile(
        'agent-chamber/SKILL.md',
        `---
name: agent-chamber
description: Main skill.
version: 1.0.0
updatedAt: 2026-06-17
---

# Main Skill Content
`,
      );

      const result = await service.findOne('agent-chamber');

      expect(result).toMatchObject({
        name: 'agent-chamber',
        description: 'Main skill.',
        version: '1.0.0',
        updatedAt: '2026-06-17',
        content: '\n# Main Skill Content\n',
      });
    });

    it('should throw NotFoundException when skill does not exist', async () => {
      await expect(service.findOne('missing-skill')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for invalid name with directory traversal', async () => {
      await expect(service.findOne('../etc/passwd')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for internal skill', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
internal: true
---

# Internal
`,
      );

      await expect(service.findOne('internal-skill')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findSubSkill', () => {
    it('should return sub skill detail', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      createSkillFile(
        'agent-chamber/taskboard/SKILL.md',
        `---
name: taskboard
description: Task board skill.
version: 1.1.0
updatedAt: 2026-06-10
---

# Taskboard
`,
      );

      const result = await service.findSubSkill('agent-chamber', 'taskboard');

      expect(result).toMatchObject({
        name: 'taskboard',
        description: 'Task board skill.',
        version: '1.1.0',
        updatedAt: '2026-06-10',
        content: '\n# Taskboard\n',
      });
    });

    it('should throw NotFoundException when sub skill does not exist', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      await expect(service.findSubSkill('agent-chamber', 'missing-sub')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for invalid subpath', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      await expect(service.findSubSkill('agent-chamber', '..')).rejects.toThrow(NotFoundException);
      await expect(service.findSubSkill('agent-chamber', 'sub/path')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should block directory traversal even if name is valid', async () => {
      createSkillFile('other-skill/SKILL.md', '# Other\n');
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');

      await expect(service.findSubSkill('agent-chamber', '../other-skill')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when parent skill is internal', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
internal: true
---

# Internal
`,
      );
      createSkillFile('internal-skill/sub/SKILL.md', '# Sub\n');

      await expect(service.findSubSkill('internal-skill', 'sub')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findSubSkills', () => {
    it('should return sub skill metadata list', async () => {
      createSkillFile(
        'agent-chamber/SKILL.md',
        `---
name: agent-chamber
description: Main skill.
version: 1.0.0
updatedAt: 2026-06-17
---

# Main Skill
`,
      );
      createSkillFile(
        'agent-chamber/taskboard/SKILL.md',
        `---
name: taskboard
description: Task board skill.
version: 1.1.0
updatedAt: 2026-06-10
---

# Taskboard
`,
      );
      createSkillFile(
        'agent-chamber/topics/SKILL.md',
        `---
name: topics
description: Topics skill.
version: 1.2.0
updatedAt: 2026-06-11
---

# Topics
`,
      );

      const result = await service.findSubSkills('agent-chamber');

      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'taskboard',
            description: 'Task board skill.',
            version: '1.1.0',
            updatedAt: '2026-06-10',
          }),
          expect.objectContaining({
            name: 'topics',
            description: 'Topics skill.',
            version: '1.2.0',
            updatedAt: '2026-06-11',
          }),
        ]),
      );
    });

    it('should return empty array when main skill has no sub directories', async () => {
      createSkillFile(
        'agent-chamber/SKILL.md',
        `---
name: agent-chamber
---
# Main
`,
      );

      const result = await service.findSubSkills('agent-chamber');

      expect(result).toEqual([]);
    });

    it('should skip sub directories without SKILL.md', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      fs.mkdirSync(path.resolve(tempDir, 'agent-chamber', 'empty-dir'), { recursive: true });

      const result = await service.findSubSkills('agent-chamber');

      expect(result).toEqual([]);
    });

    it('should throw NotFoundException when main skill does not exist', async () => {
      await expect(service.findSubSkills('missing-skill')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for invalid name with directory traversal', async () => {
      await expect(service.findSubSkills('../etc/passwd')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when parent skill is internal', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
internal: true
---

# Internal
`,
      );
      createSkillFile('internal-skill/sub/SKILL.md', '# Sub\n');

      await expect(service.findSubSkills('internal-skill')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRaw', () => {
    it('should return raw markdown content', async () => {
      const markdown = `---
name: agent-chamber
---

# Raw Content
`;
      createSkillFile('agent-chamber/SKILL.md', markdown);

      const result = await service.getRaw('agent-chamber');

      expect(result).toBe(markdown);
    });

    it('should throw NotFoundException when skill does not exist', async () => {
      await expect(service.getRaw('missing-skill')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for internal skill', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
internal: true
---

# Internal
`,
      );

      await expect(service.getRaw('internal-skill')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSubRaw', () => {
    it('should return raw sub skill markdown content', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      const markdown = `---
name: taskboard
description: Task board skill.
---

# Raw Sub Content
`;
      createSkillFile('agent-chamber/taskboard/SKILL.md', markdown);

      const result = await service.getSubRaw('agent-chamber', 'taskboard');

      expect(result).toBe(markdown);
    });

    it('should throw NotFoundException when sub skill does not exist', async () => {
      createSkillFile('agent-chamber/SKILL.md', '# Main\n');
      await expect(service.getSubRaw('agent-chamber', 'missing-sub')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for invalid subpath', async () => {
      await expect(service.getSubRaw('agent-chamber', 'sub/path')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when parent skill is internal', async () => {
      createSkillFile(
        'internal-skill/SKILL.md',
        `---
name: internal-skill
internal: true
---

# Internal
`,
      );
      createSkillFile('internal-skill/sub/SKILL.md', '# Sub\n');

      await expect(service.getSubRaw('internal-skill', 'sub')).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * name/dirname 一致性不变量。
   *
   * 列表名取自 frontmatter `name`（缺失时回退目录名，见 toListItem），而**访问键恒为目录名**
   * （resolveSkillFile）。二者错位时 `GET /skills` 列出的名字点进详情必 404——web 列表页与
   * install-skill.sh 都按列表名发请求，属静默坏链，故用不变量测试守住。
   */
  describe('name/dirname 一致性不变量', () => {
    it('findAll 的每个 name 都能被 findOne / findSubSkills 解析（正向）', async () => {
      createSkillFile(
        'agent-chamber/SKILL.md',
        `---
name: agent-chamber
description: Main skill.
version: 1.43.0
---
# Main
`,
      );
      createSkillFile(
        'agent-chamber/topics/SKILL.md',
        `---
name: topics
description: Topics sub skill.
---
# Topics
`,
      );
      createSkillFile(
        'solo-skill/SKILL.md',
        `---
name: solo-skill
description: Skill without sub skills.
---
# Solo
`,
      );

      const list = await service.findAll();
      expect(list.map((item) => item.name).sort()).toEqual(['agent-chamber', 'solo-skill']);

      for (const item of list) {
        // 列表名必须可作访问键（详情端点按 name 解析）
        await expect(service.findOne(item.name)).resolves.toMatchObject({ name: item.name });
        // 子列表端点同理；父 Skill 无子目录时必须返回空数组而非 404
        expect(Array.isArray(await service.findSubSkills(item.name))).toBe(true);
      }

      // 子 Skill 的列表名必须可作 findSubSkill 的 subpath
      const subs = await service.findSubSkills('agent-chamber');
      expect(subs.map((item) => item.name)).toEqual(['topics']);
      for (const sub of subs) {
        await expect(service.findSubSkill('agent-chamber', sub.name)).resolves.toMatchObject({
          name: sub.name,
        });
      }
    });

    it('frontmatter name 与目录名错位时可被检测（反例）', async () => {
      // 目录 y 下写 frontmatter `name: x`：列表报 x，但访问键是目录名 y
      createSkillFile(
        'y/SKILL.md',
        `---
name: x
description: Name/dirname mismatch.
---
# Mismatched
`,
      );

      const list = await service.findAll();
      expect(list.map((item) => item.name)).toEqual(['x']);

      // 列表名 x 不可访问——这正是本不变量要防的静默坏链
      await expect(service.findOne('x')).rejects.toThrow(NotFoundException);
      await expect(service.findSubSkills('x')).rejects.toThrow(NotFoundException);
      // 目录名 y 虽可访问，但列表里不叫这个名字（错位的事实证据）
      await expect(service.findOne('y')).resolves.toMatchObject({ name: 'x' });
    });
  });
});
