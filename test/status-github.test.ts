import { expect, it, vi } from 'vitest';
import { OctokitGitHubClient } from '../src/github.js';
const ref = { owner: 'acme', repo: 'widgets', issueNumber: 42 };
function fixture() {
  return {
    rest: {
      users: {
        getByUsername: vi.fn(async () => ({
          data: { id: 77, login: 'github-actions[bot]' },
        })),
      },
      issues: { listComments: vi.fn(), getComment: vi.fn() },
    },
    paginate: vi.fn(),
  };
}
it('reads the actual newest 100 of 205 comments with numeric bot identity', async () => {
  const api = fixture();
  const comments = Array.from({ length: 205 }, (_, i) => ({
    id: i + 1,
    body: 'marker',
    created_at: '2026-09-20T10:00:00Z',
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/42',
    user: {
      id: i === 204 ? 88 : 77,
      login: 'github-actions[bot]',
      type: 'Bot',
    },
  }));
  api.rest.issues.listComments.mockImplementation(async ({ page }) => ({
    data: comments.slice((page - 1) * 100, page * 100),
    headers:
      page === 1
        ? {
            link: '<https://api.github.com/repos/acme/widgets/issues/42/comments?page=3&per_page=100>; rel="last"',
          }
        : {},
  }));
  const result = await new OctokitGitHubClient(
    'token',
    'github-actions[bot]',
    api as never,
  ).listRecentComments(ref);
  expect(result).toHaveLength(100);
  expect(result[0]!.id).toBe(106);
  expect(result.at(-1)!.id).toBe(205);
  expect(result[0]!.trustedAuthor).toBe(true);
  expect(result.at(-1)!.trustedAuthor).toBe(false);
  expect(api.rest.issues.listComments).toHaveBeenCalledTimes(3);
  expect(api.paginate).not.toHaveBeenCalled();
  expect(api.rest.issues.listComments).toHaveBeenCalledWith(
    expect.objectContaining({ request: { signal: expect.any(AbortSignal) } }),
  );
});
it('reuses page one as the previous page in a 105-comment thread', async () => {
  const api = fixture();
  const row = (id: number) => ({
    id,
    body: '',
    user: { id: 77, login: 'github-actions[bot]' },
  });
  api.rest.issues.listComments.mockImplementation(async ({ page }) => ({
    data: Array.from({ length: page === 1 ? 100 : 5 }, (_, i) =>
      row((page - 1) * 100 + i + 1),
    ),
    headers:
      page === 1
        ? { link: '<https://api.github.com/comments?page=2>; rel="last"' }
        : {},
  }));
  const rows = await new OctokitGitHubClient(
    'token',
    'github-actions[bot]',
    api as never,
  ).listRecentComments(ref);
  expect(rows[0]?.id).toBe(6);
  expect(rows.at(-1)?.id).toBe(105);
  expect(api.rest.issues.listComments).toHaveBeenCalledTimes(2);
});
it('reads only one page for short threads and returns source comment identity', async () => {
  const api = fixture();
  api.rest.issues.listComments.mockResolvedValue({ data: [], headers: {} });
  const client = new OctokitGitHubClient(
    'token',
    'github-actions[bot]',
    api as never,
  );
  expect(await client.listRecentComments(ref)).toEqual([]);
  expect(api.rest.issues.listComments).toHaveBeenCalledOnce();
  api.rest.issues.getComment.mockResolvedValue({
    data: {
      id: 55,
      user: { id: 3, login: 'alice', type: 'User' },
      body: 'create',
      created_at: '2026-09-20T10:00:00Z',
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/42',
    },
  });
  expect(await client.getSourceComment(ref, 55)).toMatchObject({
    id: 55,
    authorId: 3,
    authorType: 'User',
  });
  expect(api.rest.issues.getComment).toHaveBeenCalledWith(
    expect.objectContaining({ comment_id: 55 }),
  );
});
it('fails closed if the configured posting identity cannot be verified', async () => {
  const api = fixture();
  api.rest.users.getByUsername.mockResolvedValue({
    data: { id: 77, login: 'impostor' },
  });
  await expect(
    new OctokitGitHubClient(
      'token',
      'github-actions[bot]',
      api as never,
    ).listRecentComments(ref),
  ).rejects.toThrow('Invalid bot identity');
  expect(api.rest.issues.listComments).not.toHaveBeenCalled();
});
