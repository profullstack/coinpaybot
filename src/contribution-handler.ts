import type * as github from '@actions/github';
import type { ResolvedConfig } from './config.js';
import type { GitHubClient, IssueRef } from './github.js';
import { isTrustedAuthor } from './github.js';
import { SUPPORTED_CRYPTO } from './parser.js';
import { CONTRIBUTIONS_AUDIENCE, ContributionError, centsUsd, millsUsd } from './contributions.js';
import type { ContributionBalance, ContributionClient, ContributionIdentity } from './contributions.js';

export interface ContributionEvent {
  eventName: string;
  action?: string;
  ref: IssueRef;
  repositoryId: unknown;
  merged?: boolean;
  comment?: {id: unknown; body: string; login: string; type: string};
}

type Command = {kind: 'balance'} | {kind: 'settle'; wallet: string; blockchain: string} | {kind: 'invalid'};
type Octokit = ReturnType<typeof github.getOctokit>;
export interface ContributionDeps {
  config: ResolvedConfig;
  octokit: Octokit;
  github: GitHubClient;
  ledger: Pick<ContributionClient, 'accrue' | 'balance' | 'settle'>;
  getIdToken: (audience: string) => Promise<string>;
}

export function parseContributionCommand(body: string): Command | null {
  if (!/^\/coinpay (?:balance|settle)(?:\s|$)/.test(body)) return null;
  if (/^\/coinpay balance\s*$/.test(body)) return {kind: 'balance'};
  // No multiline commands, aliases, implicit wallet lookup or arbitrary amount.
  const match = /^\/coinpay settle --wallet ([A-Za-z0-9:_-]{10,256}) --blockchain ([A-Z][A-Z0-9_]{1,15})\s*$/.exec(body);
  if (match && !body.trim().includes('\n') && SUPPORTED_CRYPTO.has(match[2]!.toLowerCase())) {
    return {kind: 'settle', wallet: match[1]!, blockchain: match[2]!};
  }
  return {kind: 'invalid'};
}

export function githubId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  throw new ContributionError('INVALID_GITHUB_IDENTITY');
}

function summary(balance: ContributionBalance): string {
  return `Accrued: $${millsUsd(balance.accrued_mills)} USD. Reserved: $${millsUsd(balance.reserved_mills)} USD. ` +
    `Paid: $${millsUsd(balance.paid_mills)} USD. Available: $${millsUsd(balance.available_mills)} USD. ` +
    `Whole cents available for manual payment: $${centsUsd(balance.payable_cents)} USD; ` +
    `${balance.remainder_mills} mill(s) remain below one cent. Ten merged PRs earn one cent. ` +
    'Amounts are nominal rewards; checkout fees and the actual recipient amount are shown before payment.';
}

async function currentIdentity(evt: ContributionEvent, octokit: Octokit, requireMerged: boolean): Promise<ContributionIdentity> {
  if (!Number.isSafeInteger(evt.ref.issueNumber) || evt.ref.issueNumber <= 0) throw new ContributionError('INVALID_GITHUB_IDENTITY');
  const {data: pull} = await octokit.rest.pulls.get({owner: evt.ref.owner, repo: evt.ref.repo, pull_number: evt.ref.issueNumber});
  const repository = pull.base.repo;
  if (!repository || githubId(repository.id) !== githubId(evt.repositoryId) ||
      repository.full_name.toLowerCase() !== `${evt.ref.owner}/${evt.ref.repo}`.toLowerCase() ||
      pull.number !== evt.ref.issueNumber || !repository.owner || !pull.user) throw new ContributionError('INVALID_GITHUB_IDENTITY');
  if (requireMerged && (pull.merged !== true || pull.state !== 'closed' ||
      typeof pull.merged_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(pull.merged_at) ||
      !Number.isFinite(Date.parse(pull.merged_at)) ||
      ![new Date(pull.merged_at).toISOString(), new Date(pull.merged_at).toISOString().replace('.000Z', 'Z')].includes(pull.merged_at) ||
      !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha ?? ''))) {
    throw new ContributionError('PULL_REQUEST_NOT_MERGED');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i.test(pull.user.login)) throw new ContributionError('INVALID_GITHUB_IDENTITY');
  return {
    repository_id: githubId(repository.id), repository_owner_id: githubId(repository.owner.id),
    repository_full_name: repository.full_name, pull_request_id: githubId(pull.id), pull_request_number: pull.number,
    contributor_id: githubId(pull.user.id), contributor_login: pull.user.login,
    merged_at: pull.merged_at ?? '', merge_commit_sha: pull.merge_commit_sha ?? '',
  };
}

/** Returns null only for legacy commands which the invoice handler still owns. */
export async function handleContribution(evt: ContributionEvent, deps: ContributionDeps): Promise<{action: string; detail?: string} | null> {
  const isMerge = evt.eventName === 'pull_request_target' && evt.action === 'closed' && evt.merged === true;
  const isComment = evt.eventName === 'issue_comment' && evt.action === 'created' && evt.comment?.type === 'User';
  const candidate = evt.comment ? parseContributionCommand(evt.comment.body) : null;
  if (candidate && !isComment) return {action: 'skipped'};
  const command = isComment ? candidate : null;
  if (!isMerge && !command) return evt.eventName === 'pull_request_target' ? {action: 'skipped'} : null;
  if (deps.config.enabled !== true || !deps.config.contributionRewards.enabled) return {action: 'noop_disabled'};

  let marker = '';
  if (command) {
    const actor = evt.comment!;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(actor.login)) return {action: 'skipped', detail: 'not_current_maintainer'};
    // The Action repeats the reusable workflow's current permission check so
    // direct callers cannot bypass it by forging author_association.
    try {
      const {data} = await deps.octokit.rest.repos.getCollaboratorPermissionLevel({owner: evt.ref.owner, repo: evt.ref.repo, username: actor.login});
      if (!['write', 'maintain', 'admin'].includes(data.permission)) return {action: 'skipped', detail: 'not_current_maintainer'};
    } catch { return {action: 'skipped', detail: 'permission_lookup_failed'}; }
    marker = `<!-- coinpay-contribution-comment:${githubId(actor.id)} -->`;
    const comments = await deps.github.listComments(evt.ref);
    if (comments.some(c => isTrustedAuthor(c) && c.body.includes(marker))) return {action: 'noop_duplicate'};
    if (command.kind === 'invalid') {
      await deps.github.createComment(evt.ref, 'Use `/coinpay balance` or `/coinpay settle --wallet <verified-address> --blockchain USDC_POL`. Settlement requires an explicitly verified recipient address and chain.\n\n' + marker);
      return {action: 'error', detail: 'invalid_contribution_command'};
    }
  }

  try {
    const identity = await currentIdentity(evt, deps.octokit, isMerge);
    if (isMerge) {
      const result = await deps.ledger.accrue(identity, await deps.getIdToken(CONTRIBUTIONS_AUDIENCE));
      return {action: result.replayed ? 'contribution_already_accrued' : 'contribution_accrued'};
    }
    if (command?.kind === 'balance') {
      const balance = await deps.ledger.balance(identity.repository_id, identity.contributor_id);
      await deps.github.createComment(evt.ref, summary(balance) + '\n\n' + marker);
      return {action: 'contribution_balance'};
    }
    if (command?.kind === 'settle') {
      const {settlement, balance} = await deps.ledger.settle({
        repository_id: identity.repository_id, repository_owner_id: identity.repository_owner_id,
        repository_full_name: identity.repository_full_name, contributor_id: identity.contributor_id,
        recipient_wallet: command.wallet, blockchain: command.blockchain,
        idempotency_key: 'github-comment:' + githubId(evt.comment!.id),
      }, await deps.getIdToken(CONTRIBUTIONS_AUDIENCE));
      if (settlement && settlement.contributor_id !== identity.contributor_id) throw new ContributionError('INVALID_RESPONSE');
      const status = !settlement ? 'No checkout was created: the available reward is below one cent.' :
        settlement.status === 'paid' ? `The ledger confirms the $${centsUsd(settlement.amount_cents)} USD settlement is paid.` :
        `Reserved $${centsUsd(settlement.amount_cents)} USD for manual payment. ` +
          (settlement.payment_url ? `[Open the CoinPay checkout](${settlement.payment_url}). Review the chain, recipient and fee before paying.` :
            settlement.status === 'reserved' && !settlement.payment_status ?
              'Checkout is still being prepared. Re-run this same Action attempt to retry the same reservation; do not change its wallet or chain.' :
              'This payment has no active checkout link and remains reserved until forwarding is verified. Use `/coinpay balance` to reconcile its status; do not send a duplicate payment.');
      // A reserved response without a checkout remains retryable with this exact
      // comment's idempotency key. Do not stamp it as completely handled yet.
      const complete = !settlement || settlement.status === 'paid' || Boolean(settlement.payment_url);
      await deps.github.createComment(evt.ref, status + '\n\n' + summary(balance) + (complete ? '\n\n' + marker : ''));
      return {action: complete ? 'contribution_settlement' : 'contribution_settlement_pending'};
    }
  } catch (error) {
    const code = error instanceof ContributionError ? error.code : 'CONTRIBUTION_UNAVAILABLE';
    if (!command) throw new ContributionError(code);
    // No handled marker on failure: rerunning the same event must retry the
    // immutable reservation instead of creating a new financial identity.
    await deps.github.createComment(evt.ref, 'CoinPay could not complete this contribution request. No payment is confirmed. Check repository enrollment/scoped credentials and the Actions run. If a settlement was reserved, retry the same Action attempt with unchanged terms.');
    throw new ContributionError(code);
  }
  return {action: 'skipped'};
}
