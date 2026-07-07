/**
 * Authorization gate (PRD §14.1).
 *
 * GitHub's `author_association` on the comment tells us the actor's relationship
 * to the repo. Owners / members / collaborators may create invoices directly;
 * everyone else creates a pending request a maintainer must approve.
 */

import type { MinRole } from './config.js';

export type AuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'MANNEQUIN'
  | 'NONE'
  | (string & {});

/** Ranks from most to least privileged. Higher index = more trusted. */
const RANK: Record<string, number> = {
  NONE: 0,
  MANNEQUIN: 0,
  FIRST_TIMER: 0,
  FIRST_TIME_CONTRIBUTOR: 0,
  CONTRIBUTOR: 1,
  COLLABORATOR: 2,
  MEMBER: 3,
  OWNER: 4,
};

const MIN_ROLE_RANK: Record<MinRole, number> = {
  collaborator: 2,
  member: 3,
  owner: 4,
};

export function associationRank(assoc: AuthorAssociation): number {
  return RANK[assoc?.toUpperCase?.() ?? ''] ?? 0;
}

/** Can this actor create an invoice directly (vs. only request one)? */
export function canCreateDirectly(assoc: AuthorAssociation, minRole: MinRole): boolean {
  return associationRank(assoc) >= MIN_ROLE_RANK[minRole];
}

/** Can this actor approve a pending request? Maintainer-equivalent only. */
export function canApprove(assoc: AuthorAssociation): boolean {
  return associationRank(assoc) >= MIN_ROLE_RANK.collaborator;
}

/** Alias — cancel requires the same trust level as approve (PRD §8 table). */
export const canCancel = canApprove;
