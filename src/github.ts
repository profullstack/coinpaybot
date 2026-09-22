/**
 * Thin GitHub surface the handler depends on. Defined as an interface so the
 * handler can be driven by an in-memory fake in tests (no network, no octokit).
 */

import * as github from '@actions/github';

export interface IssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface ThreadComment {
  body: string;
  authorLogin: string;
  authorType: string;
  /** True only when the runtime matched the exact configured Action identity. */
  trustedAuthor?: boolean;
  id?: number;
  authorId?: number;
  createdAt?: string;
  issueUrl?: string;
}

export interface LinkedIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface PullRequestContext {
  number: number;
  title: string;
  url: string;
  author: string;
  linkedIssues: LinkedIssue[];
}

export interface GitHubClient {
  listComments(ref: IssueRef): Promise<ThreadComment[]>;
  /** Bounded, numeric-identity-verified comments for read-only invoice status. */
  listRecentComments?(ref: IssueRef): Promise<ThreadComment[]>;
  getSourceComment?(ref: IssueRef, commentId: number): Promise<ThreadComment>;
  getPullRequestContext(ref: IssueRef): Promise<PullRequestContext | null>;
  createComment(ref: IssueRef, body: string): Promise<void>;
  addLabels(ref: IssueRef, labels: string[]): Promise<void>;
}

export function isTrustedAuthor(comment: ThreadComment): boolean {
  return comment.trustedAuthor === true;
}

interface IssueCoordinates {
  owner: string;
  repo: string;
  number: number;
}

export function linkedIssueCoordinates(
  body: string,
  fallback: Pick<IssueRef, 'owner' | 'repo'>,
): IssueCoordinates[] {
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+))|(?:(?:([\w.-]+)\/([\w.-]+))?#(\d+)))/gi;
  const found = new Map<string, IssueCoordinates>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const owner = match[1] ?? match[4] ?? fallback.owner;
    const repo = match[2] ?? match[5] ?? fallback.repo;
    const number = Number(match[3] ?? match[6]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    found.set(`${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`, {
      owner,
      repo,
      number,
    });
    if (found.size === 5) break;
  }
  return [...found.values()];
}

/** Octokit-backed implementation used by the Action at runtime. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: ReturnType<typeof github.getOctokit>;
  private readonly trustedAuthorLogin: string;

  constructor(
    token: string,
    trustedAuthorLogin = 'github-actions[bot]',
    octokit?: ReturnType<typeof github.getOctokit>,
  ) {
    this.octokit = octokit ?? github.getOctokit(token);
    this.trustedAuthorLogin = trustedAuthorLogin.trim().toLowerCase();
  }

  async listComments(ref: IssueRef): Promise<ThreadComment[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      per_page: 100,
    });
    return comments.map((comment) => {
      const authorLogin = comment.user?.login ?? '';
      return {
        body: comment.body ?? '',
        authorLogin,
        authorType: comment.user?.type ?? '',
        trustedAuthor:
          this.trustedAuthorLogin.length > 0 &&
          authorLogin.toLowerCase() === this.trustedAuthorLogin,
      };
    });
  }

  async listRecentComments(ref: IssueRef): Promise<ThreadComment[]> {
    if (!this.trustedAuthorLogin) throw new Error('Missing bot identity');
    const identity = await this.octokit.rest.users.getByUsername({
      username: this.trustedAuthorLogin,
      request: { signal: AbortSignal.timeout(10000) },
    });
    if (
      !Number.isSafeInteger(identity.data.id) ||
      identity.data.id <= 0 ||
      identity.data.login.toLowerCase() !== this.trustedAuthorLogin
    ) {
      throw new Error('Invalid bot identity');
    }
    const page = (number: number) =>
      this.octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        per_page: 100,
        page: number,
        request: { signal: AbortSignal.timeout(10000) },
      });
    const first = await page(1);
    const lastLink = /<([^>]+)>;\s*rel="last"/.exec(
      first.headers.link ?? '',
    )?.[1];
    const lastPage = lastLink
      ? Number(new URL(lastLink).searchParams.get('page'))
      : 1;
    if (!Number.isSafeInteger(lastPage) || lastPage < 1)
      throw new Error('Invalid comment pagination');
    let comments = first.data;
    if (lastPage > 1) {
      const last = await page(lastPage);
      const previous =
        last.data.length < 100
          ? (lastPage === 2 ? first : await page(lastPage - 1)).data
          : [];
      comments = [...previous, ...last.data];
    }
    return [...new Map(comments.map((c) => [c.id, c])).values()]
      .sort((a, b) => a.id - b.id)
      .slice(-100)
      .map((c) => ({
        body: c.body ?? '',
        authorLogin: c.user?.login ?? '',
        authorType: c.user?.type ?? '',
        authorId: c.user?.id,
        id: c.id,
        createdAt: c.created_at,
        issueUrl: c.issue_url,
        trustedAuthor: c.user?.id === identity.data.id,
      }));
  }

  async getSourceComment(
    ref: IssueRef,
    commentId: number,
  ): Promise<ThreadComment> {
    const { data: c } = await this.octokit.rest.issues.getComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId,
      request: { signal: AbortSignal.timeout(10000) },
    });
    return {
      body: c.body ?? '',
      id: c.id,
      authorId: c.user?.id,
      authorLogin: c.user?.login ?? '',
      authorType: c.user?.type ?? '',
      createdAt: c.created_at,
      issueUrl: c.issue_url,
    };
  }

  async getPullRequestContext(ref: IssueRef): Promise<PullRequestContext | null> {
    let response: Awaited<ReturnType<typeof this.octokit.rest.pulls.get>>;
    try {
      response = await this.octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.issueNumber,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return null;
      throw error;
    }

    const pull = response.data;
    const coordinates = linkedIssueCoordinates(pull.body ?? '', ref);
    const resolvedIssues = await Promise.all(
      coordinates.map(async (issue): Promise<LinkedIssue | null> => {
        try {
          const result = await this.octokit.rest.issues.get({
            owner: issue.owner,
            repo: issue.repo,
            issue_number: issue.number,
          });
          return {
            ...issue,
            title: result.data.title,
            url: result.data.html_url,
          };
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 403 || status === 404 || status === 410) return null;
          throw error;
        }
      }),
    );
    const linkedIssues = resolvedIssues.filter(
      (issue): issue is LinkedIssue => issue !== null,
    );

    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      author: pull.user?.login ?? 'unknown',
      linkedIssues,
    };
  }

  async createComment(ref: IssueRef, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      body,
    });
  }

  async addLabels(ref: IssueRef, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.octokit.rest.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      labels,
    });
  }
}
