/**
 * Action entrypoint wiring: event filtering (created-only), actor identity
 * passthrough, resolved config defaults, and outputs. The handler and GitHub
 * transports are mocked; nothing leaves the process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const context = {
    eventName: 'issue_comment',
    payload: {} as Record<string, unknown>,
    repo: { owner: 'acme', repo: 'widgets' },
  };
  return {
    context,
    getInput: vi.fn((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'gh-token',
        'coinpay-api-key': 'cp_live_test',
        'coinpay-business-id': 'biz_123',
      };
      return inputs[name] ?? '';
    }),
    info: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    handleComment: vi.fn(),
    getOctokit: vi.fn(() => ({
      rest: { repos: { getContent: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })) } },
    })),
  };
});

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  info: mocks.info,
  setOutput: mocks.setOutput,
  setFailed: mocks.setFailed,
}));
vi.mock('@actions/github', () => ({
  context: mocks.context,
  getOctokit: mocks.getOctokit,
}));
vi.mock('../src/handler.js', () => ({ handleComment: mocks.handleComment }));

async function runEntrypoint(): Promise<void> {
  vi.resetModules();
  const { run } = await import('../src/main.js');
  // The module self-invokes run() on import; awaiting our own call keeps the
  // assertions deterministic. Call counts below account for both invocations.
  await run();
}

describe('Action entrypoint', () => {
  beforeEach(() => {
    mocks.handleComment.mockReset();
    mocks.setOutput.mockReset();
    mocks.handleComment.mockResolvedValue({ action: 'invoice_published', invoiceId: 'inv-1' });
  });

  it('ignores edited comments entirely', async () => {
    mocks.context.payload = {
      action: 'edited',
      comment: { id: 9001, body: '/coinpay create @hubber 25 "x"', user: { id: 555, login: 'octocat', type: 'User' } },
      issue: { number: 42, html_url: 'https://github.com/acme/widgets/issues/42' },
    };

    await runEntrypoint();

    expect(mocks.handleComment).not.toHaveBeenCalled();
  });

  it('ignores non-comment events', async () => {
    mocks.context.payload = { action: 'created' };

    await runEntrypoint();

    expect(mocks.handleComment).not.toHaveBeenCalled();
  });

  it('passes immutable actor identity and safe config defaults to the handler', async () => {
    mocks.context.payload = {
      action: 'created',
      repository: {id: 1234},
      comment: {
        id: 9001,
        body: '/coinpay create @hubber 25 "x"',
        author_association: 'NONE',
        user: { id: 555, login: 'octocat', type: 'User' },
      },
      issue: { number: 42, html_url: 'https://github.com/acme/widgets/issues/42' },
    };

    await runEntrypoint();

    expect(mocks.handleComment).toHaveBeenCalled();
    const [evt, deps] = mocks.handleComment.mock.calls[0]!;
    expect(evt).toMatchObject({
      ref: { owner: 'acme', repo: 'widgets', issueNumber: 42 },
      repositoryId: 1234,
      commentId: 9001,
      actor: 'octocat',
      actorId: 555,
      actorType: 'User',
      isPullRequest: false,
    });
    // Without a repo config file, the invoice flow must resolve disabled.
    expect(deps.config.githubInvoices).toEqual({
      enabled: false,
      maxAmountUsd: 1000,
      repositoryHourlyCap: 20,
    });
    expect(mocks.setOutput).toHaveBeenCalledWith('action', 'invoice_published');
    expect(mocks.setOutput).toHaveBeenCalledWith('invoice_id', 'inv-1');
  });
});
