import path from 'path';
import fs from 'fs';
import os from 'os';
import { loadProfile, resolveProfilePath } from './profile-loader';

describe('profile-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-profile-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: unknown): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content), 'utf-8');
    return filePath;
  }

  describe('resolveProfilePath', () => {
    it('should resolve profile from config/mcp-profiles', () => {
      const expected = writeFile(path.join('config', 'mcp-profiles', 'agent.json'), {
        include: ['agent_controller_get_me'],
      });

      expect(resolveProfilePath('agent', tmpDir)).toBe(expected);
    });

    it('should resolve profile from apps/backend/config/mcp-profiles', () => {
      const expected = writeFile(
        path.join('apps', 'backend', 'config', 'mcp-profiles', 'agent.json'),
        { include: ['agent_controller_get_me'] }
      );

      expect(resolveProfilePath('agent', tmpDir)).toBe(expected);
    });

    it('should prefer config/mcp-profiles over apps/backend/config', () => {
      const preferred = writeFile(path.join('config', 'mcp-profiles', 'agent.json'), {
        include: ['preferred'],
      });
      writeFile(
        path.join('apps', 'backend', 'config', 'mcp-profiles', 'agent.json'),
        { include: ['fallback'] }
      );

      expect(resolveProfilePath('agent', tmpDir)).toBe(preferred);
    });

    it('should throw when profile not found', () => {
      expect(() => resolveProfilePath('missing', tmpDir)).toThrow(
        'Profile "missing" not found'
      );
    });
  });

  describe('loadProfile', () => {
    it('should load include/exclude/tags with name and description', async () => {
      const filePath = writeFile('test.json', {
        name: 'Agent Profile',
        description: 'Agent 高频工具',
        include: ['agent_controller_get_me', 'topic_controller_find_all'],
        exclude: ['admin_.*'],
        tags: ['Agents', 'Topics'],
      });

      const profile = await loadProfile(filePath);

      expect(profile.name).toBe('Agent Profile');
      expect(profile.description).toBe('Agent 高频工具');
      expect(profile.include).toEqual([
        'agent_controller_get_me',
        'topic_controller_find_all',
      ]);
      expect(profile.exclude).toEqual(['admin_.*']);
      expect(profile.tags).toEqual(['Agents', 'Topics']);
    });

    it('should accept empty profile', async () => {
      const filePath = writeFile('empty.json', {});

      const profile = await loadProfile(filePath);

      expect(profile.include).toBeUndefined();
      expect(profile.exclude).toBeUndefined();
      expect(profile.tags).toBeUndefined();
    });

    it('should throw for non-object JSON', async () => {
      const filePath = writeFile('invalid.json', 'not-an-object');

      await expect(loadProfile(filePath)).rejects.toThrow(
        'must be a JSON object'
      );
    });

    it('should throw for invalid array field type', async () => {
      const filePath = writeFile('bad-array.json', { include: 'agent' });

      await expect(loadProfile(filePath)).rejects.toThrow(
        'must be an array of strings'
      );
    });

    it('should throw for non-string array items', async () => {
      const filePath = writeFile('bad-items.json', { include: [123] });

      await expect(loadProfile(filePath)).rejects.toThrow(
        'must be an array of strings'
      );
    });
  });
});
