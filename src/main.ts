/**
 * GitHub Action entrypoint (PRD §16/§25).
 *
 * Triggered on `issue_comment.created`. Reads config + secrets, builds the
 * runtime clients, and delegates to the transport-agnostic handler.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { parse as parseYaml } from 'yaml';
import { CoinPayClient } from './coinpay.js';
import { OctokitGitHubClient } from './github.js';
import { resolveConfig } from './config.js';
import type { ResolvedConfig } from './config.js';
import { handleComment } from './handler.js';
import type { CommentEvent } from './handler.js';

async function loadRepoConfig(gh: OctokitGitHubClient, token: string, ref: { owner: string; repo: string }): Promise<ResolvedConfig> {
  try {
    const octokit = github.getOctokit(token);
    const res = await octokit.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: '.github/coinpay.yml',
    });
    const data = res.data as { content?: string; encoding?: string };
    if (data.content && data.encoding === 'base64') {
      const yaml = Buffer.from(data.content, 'base64').toString('utf8');
      return resolveConfig(parseYaml(yaml));
    }
  } catch {
    // No config file (404) or unreadable — fall back to defaults.
  }
  return resolveConfig();
}

export async function run(): Promise<void> {
  const eventName = github.context.eventName;
  if (eventName !== 'issue_comment') {
    core.info(`Ignoring event: ${eventName}`);
    return;
  }
  const payload = github.context.payload;
  // Only newly created comments qualify. Edited comments are deliberately
  // ignored: the invoice identity is the original comment, and edits must not
  // re-trigger or alter money flows.
  if (payload.action !== 'created' || !payload.comment || !payload.issue) {
    core.info('Not a created issue comment; nothing to do.');
    return;
  }

  const token = core.getInput('github-token', { required: true });
  const apiKey = core.getInput('coinpay-api-key', { required: true });
  const businessId = core.getInput('coinpay-business-id', { required: true });
  const baseUrl = core.getInput('coinpay-base-url') || 'https://coinpayportal.com';
  const trustedCommentAuthor =
    core.getInput('trusted-comment-author') || 'github-actions[bot]';

  const ref = {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issueNumber: payload.issue.number as number,
  };

  const gh = new OctokitGitHubClient(token, trustedCommentAuthor);
  const config = await loadRepoConfig(gh, token, ref);
  const coinpay = new CoinPayClient({ baseUrl, apiKey, businessId });

  const evt: CommentEvent = {
    ref,
    repositoryId: payload.repository?.id as number | undefined,
    commentId: payload.comment.id as number,
    body: (payload.comment.body as string) ?? '',
    actor: (payload.comment.user?.login as string) ?? 'unknown',
    actorId: payload.comment.user?.id as number | undefined,
    actorType: payload.comment.user?.type as string | undefined,
    authorAssociation: (payload.comment.author_association as string) ?? 'NONE',
    issueUrl: (payload.issue.html_url as string) ?? '',
    isPullRequest: payload.issue.pull_request !== undefined,
  };

  const result = await handleComment(evt, { coinpay, github: gh, config });
  core.info(`coinpaybot action=${result.action}${result.detail ? ` detail=${result.detail}` : ''}`);
  core.setOutput('action', result.action);
  if (result.paymentId) core.setOutput('payment_id', result.paymentId);
  if (result.invoiceId) core.setOutput('invoice_id', result.invoiceId);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
