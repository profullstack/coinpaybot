import { describe, expect, it, vi } from 'vitest';
import {
  isTrustedAuthor,
  linkedIssueCoordinates,
  OctokitGitHubClient,
} from '../src/github.js';

function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`GitHub returned ${status}`), { status });
}

function fakeOctokit() {
  return {
    paginate: vi.fn().mockResolvedValue([]),
    rest: {
      issues: {
        listComments: vi.fn(),
        get: vi.fn(),
        createComment: vi.fn(),
        addLabels: vi.fn(),
      },
      pulls: { get: vi.fn() },
    },
  };
}

const REF = { owner: 'acme', repo: 'widgets', issueNumber: 42 };

describe('linkedIssueCoordinates', () => {
  it('finds same-repository, cross-repository, and canonical issue links', () => {
    const body = [
      'Fixes #7',
      'Resolves platform/api#9',
      'Closes https://github.com/other/project/issues/11',
      'Fixes #7',
    ].join('\n');

    expect(
      linkedIssueCoordinates(body, { owner: 'acme', repo: 'widgets' }),
    ).toEqual([
      { owner: 'acme', repo: 'widgets', number: 7 },
      { owner: 'platform', repo: 'api', number: 9 },
      { owner: 'other', repo: 'project', number: 11 },
    ]);
  });

  it('ignores plain issue mentions that do not use a closing keyword', () => {
    expect(
      linkedIssueCoordinates('Related to #4 and see #5', {
        owner: 'acme',
        repo: 'widgets',
      }),
    ).toEqual([]);
  });

  it('caps linked issue lookups to five unique references', () => {
    const body = Array.from({ length: 8 }, (_, index) => `Fixes #${index + 1}`).join(
      '\n',
    );

    expect(
      linkedIssueCoordinates(body, { owner: 'acme', repo: 'widgets' }),
    ).toHaveLength(5);
  });
});

describe('trusted Action identity', () => {
  it('trusts only an exact, case-insensitive configured login', async () => {
    const api = fakeOctokit();
    api.paginate.mockResolvedValue([
      { body: 'ours', user: { login: 'GitHub-Actions[bot]', type: 'Bot' } },
      { body: 'foreign', user: { login: 'dependabot[bot]', type: 'Bot' } },
      { body: 'user', user: { login: 'github-actions-lookalike', type: 'User' } },
    ]);
    const client = new OctokitGitHubClient(
      'token',
      'github-actions[bot]',
      api as never,
    );

    const comments = await client.listComments(REF);

    expect(comments.map(isTrustedAuthor)).toEqual([true, false, false]);
  });

  it('fails closed when the configured trusted login is blank', async () => {
    const api = fakeOctokit();
    api.paginate.mockResolvedValue([
      { body: 'marker', user: { login: '', type: 'Bot' } },
    ]);
    const client = new OctokitGitHubClient('token', '   ', api as never);

    expect((await client.listComments(REF)).map(isTrustedAuthor)).toEqual([false]);
  });
});

describe('OctokitGitHubClient.getPullRequestContext', () => {
  function pullResponse(body: string) {
    return {
      data: {
        number: 42,
        title: 'Fix checkout',
        body,
        html_url: 'https://github.com/acme/widgets/pull/42',
        user: { login: 'octocat' },
      },
    };
  }

  it.each([403, 404, 410])(
    'skips an unavailable linked issue returning %s without losing the PR',
    async (status) => {
      const api = fakeOctokit();
      api.rest.pulls.get.mockResolvedValue(pullResponse('Fixes #7\nFixes #8'));
      api.rest.issues.get.mockImplementation(async ({ issue_number }) => {
        if (issue_number === 7) throw apiError(status);
        return {
          data: {
            title: 'Live issue',
            html_url: 'https://github.com/acme/widgets/issues/8',
          },
        };
      });
      const client = new OctokitGitHubClient(
        'token',
        'github-actions[bot]',
        api as never,
      );

      await expect(client.getPullRequestContext(REF)).resolves.toMatchObject({
        number: 42,
        linkedIssues: [{ number: 8, title: 'Live issue' }],
      });
    },
  );

  it('propagates an unexpected linked-issue server error', async () => {
    const api = fakeOctokit();
    api.rest.pulls.get.mockResolvedValue(pullResponse('Fixes #7'));
    api.rest.issues.get.mockRejectedValue(apiError(500));
    const client = new OctokitGitHubClient(
      'token',
      'github-actions[bot]',
      api as never,
    );

    await expect(client.getPullRequestContext(REF)).rejects.toMatchObject({ status: 500 });
  });

  it('returns null only when the pull request itself is not found', async () => {
    const api = fakeOctokit();
    api.rest.pulls.get.mockRejectedValue(apiError(404));
    const client = new OctokitGitHubClient(
      'token',
      'github-actions[bot]',
      api as never,
    );

    await expect(client.getPullRequestContext(REF)).resolves.toBeNull();
  });
});
