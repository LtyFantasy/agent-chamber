import { isCreatorOrOwner } from './is-resource-owner';

describe('isCreatorOrOwner (v1.37 owner 代理)', () => {
  it('returns true when creatorId equals currentUserId (direct creator)', () => {
    expect(isCreatorOrOwner('u1', 'u1', [])).toBe(true);
  });

  it('returns true when creatorId is one of my agent ids (owner proxy)', () => {
    expect(isCreatorOrOwner('agent-1', 'u1', ['agent-1', 'agent-2'])).toBe(true);
  });

  it('returns false when creatorId is someone else s agent (not mine)', () => {
    expect(isCreatorOrOwner('agent-9', 'u1', ['agent-1'])).toBe(false);
  });

  it('returns false for unauthenticated user', () => {
    expect(isCreatorOrOwner('u1', null, ['agent-1'])).toBe(false);
  });

  it('returns false when creatorId is missing', () => {
    expect(isCreatorOrOwner(null, 'u1', ['agent-1'])).toBe(false);
    expect(isCreatorOrOwner(undefined, 'u1', [])).toBe(false);
  });

  it('returns false when creatorId matches neither current user nor owned agents', () => {
    expect(isCreatorOrOwner('stranger', 'u1', [])).toBe(false);
  });
});
