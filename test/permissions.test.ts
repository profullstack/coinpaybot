import { describe, it, expect } from 'vitest';
import { canCreateDirectly, canApprove, associationRank } from '../src/permissions.js';

describe('permissions', () => {
  it('lets owners/members/collaborators create directly at the default min role', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(canCreateDirectly(a, 'collaborator')).toBe(true);
    }
  });

  it('forces non-maintainers to request', () => {
    for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', 'anything-else']) {
      expect(canCreateDirectly(a, 'collaborator')).toBe(false);
    }
  });

  it('tightens direct creation when min role is raised', () => {
    expect(canCreateDirectly('COLLABORATOR', 'member')).toBe(false);
    expect(canCreateDirectly('MEMBER', 'member')).toBe(true);
    expect(canCreateDirectly('MEMBER', 'owner')).toBe(false);
    expect(canCreateDirectly('OWNER', 'owner')).toBe(true);
  });

  it('gates approval at collaborator level', () => {
    expect(canApprove('COLLABORATOR')).toBe(true);
    expect(canApprove('CONTRIBUTOR')).toBe(false);
  });

  it('treats unknown associations as untrusted', () => {
    expect(associationRank('SOMETHING_NEW')).toBe(0);
  });
});
