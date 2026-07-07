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

export interface GitHubClient {
  listCommentBodies(ref: IssueRef): Promise<string[]>;
  createComment(ref: IssueRef, body: string): Promise<void>;
  addLabels(ref: IssueRef, labels: string[]): Promise<void>;
}

/** Octokit-backed implementation used by the Action at runtime. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: ReturnType<typeof github.getOctokit>;
  constructor(token: string) {
    this.octokit = github.getOctokit(token);
  }

  async listCommentBodies(ref: IssueRef): Promise<string[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      per_page: 100,
    });
    return comments.map((c) => c.body ?? '');
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
