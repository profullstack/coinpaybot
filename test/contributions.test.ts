import {describe, expect, it, vi} from 'vitest';
import {resolveConfig} from '../src/config.js';
import {ContributionClient, centsUsd, millsUsd, parseBalance} from '../src/contributions.js';
import type {ContributionIdentity, SettlementRequest} from '../src/contributions.js';
import {githubId, handleContribution, parseContributionCommand} from '../src/contribution-handler.js';
import type {ContributionEvent} from '../src/contribution-handler.js';

const enabled = resolveConfig({contributionRewards:{enabled:true,rateUsd:'0.001',payment:'manual'}});
const balance = {currency:'USD' as const,accrued_mills:'21',reserved_mills:'0',paid_mills:'0',available_mills:'21',payable_cents:'2',remainder_mills:'1'};
const identity: ContributionIdentity = {repository_id:'123',repository_owner_id:'7',repository_full_name:'acme/project',
  pull_request_id:'456',pull_request_number:42,contributor_id:'8',contributor_login:'author',
  merged_at:'2026-09-13T10:00:00Z',merge_commit_sha:'a'.repeat(40)};
const settlementRequest: SettlementRequest = {repository_id:'123',repository_owner_id:'7',repository_full_name:'acme/project',
  contributor_id:'8',recipient_wallet:'verified_wallet',blockchain:'USDC_POL',idempotency_key:'github-comment:900'};
const checkout = {id:'11111111-1111-4111-8111-111111111111',status:'awaiting_payment' as const,amount_cents:'2',
  contributor_id:'8',currency:'USD' as const,
  payment_url:'https://coinpayportal.com/pay/22222222-2222-4222-8222-222222222222',payment_status:'pending'};

function fixture(body?: string) {
  const pull = {id:456,number:42,merged:true,state:'closed',merged_at:identity.merged_at,merge_commit_sha:identity.merge_commit_sha,
    user:{id:8,login:'author'},base:{repo:{id:123,full_name:'acme/project',owner:{id:7}}},head:{repo:{id:999,full_name:'author/fork'}}};
  const evt: ContributionEvent = {eventName:body?'issue_comment':'pull_request_target',action:body?'created':'closed',
    merged:!body,ref:{owner:'acme',repo:'project',issueNumber:42},repositoryId:123,
    ...(body?{comment:{id:900,body,login:'maintainer',type:'User'}}:{})};
  const pulls = vi.fn().mockResolvedValue({data:pull});
  const permission = vi.fn().mockResolvedValue({data:{permission:'write'}});
  const octokit = {rest:{pulls:{get:pulls},repos:{getCollaboratorPermissionLevel:permission}}};
  const gh = {listComments:vi.fn().mockResolvedValue([]),createComment:vi.fn().mockResolvedValue(undefined),
    addLabels:vi.fn(),getPullRequestContext:vi.fn()};
  const ledger = {accrue:vi.fn().mockResolvedValue({replayed:false,balance}),balance:vi.fn().mockResolvedValue(balance),
    settle:vi.fn().mockResolvedValue({settlement:checkout,balance})};
  const getIdToken = vi.fn().mockResolvedValue('private-oidc');
  const deps = {config:enabled,octokit:octokit as never,github:gh,ledger,getIdToken};
  return {evt,deps,pull,pulls,permission,gh,ledger,getIdToken};
}

describe('strict prospective contribution opt-in',()=>{
  it('defaults off and accepts only exact string mill/manual terms',()=>{
    expect(resolveConfig().contributionRewards).toEqual({enabled:false,rateUsd:'0.001',payment:'manual'});
    expect(enabled.contributionRewards.enabled).toBe(true);
  });
  it.each([null,'enabled',{}, {enabled:true}, {enabled:'true',rateUsd:'0.001',payment:'manual'},
    {enabled:true,rateUsd:0.001,payment:'manual'}, {enabled:true,rateUsd:'0.0010',payment:'manual'},
    {enabled:true,rateUsd:'0.01',payment:'manual'}, {enabled:true,rateUsd:'0.001',payment:'automatic'},
    {enabled:true,rateUsd:'0.001',payment:'manual',amount:100}])('rejects malformed configuration %#',value=>{
    expect(()=>resolveConfig({contributionRewards:value} as never)).toThrow(/contributionRewards/);
  });
});

describe('trusted merged PR event',()=>{
  it('derives decimal identity from current base PR, not fork head or sender, with fixed audience',async()=>{
    const f=fixture();expect(await handleContribution(f.evt,f.deps)).toEqual({action:'contribution_accrued'});
    expect(f.pulls).toHaveBeenCalledWith({owner:'acme',repo:'project',pull_number:42});
    expect(f.ledger.accrue).toHaveBeenCalledWith(identity,'private-oidc');
    expect(f.getIdToken).toHaveBeenCalledWith('coinpayportal.com');expect(f.gh.createComment).not.toHaveBeenCalled();
  });
  it('reports exact ledger replay without creating payment or a comment',async()=>{
    const f=fixture();f.ledger.accrue.mockResolvedValue({replayed:true,balance});
    expect(await handleContribution(f.evt,f.deps)).toEqual({action:'contribution_already_accrued'});
    expect(f.ledger.settle).not.toHaveBeenCalled();expect(f.gh.createComment).not.toHaveBeenCalled();
  });
  it('disabled config never reads GitHub or requests OIDC',async()=>{
    const f=fixture();f.deps.config=resolveConfig();await handleContribution(f.evt,f.deps);
    expect(f.pulls).not.toHaveBeenCalled();expect(f.getIdToken).not.toHaveBeenCalled();
  });
  it.each(['pull_request','workflow_dispatch','push'])('cannot accrue from %s',async eventName=>{
    const f=fixture();f.evt.eventName=eventName;await handleContribution(f.evt,f.deps);
    expect(f.pulls).not.toHaveBeenCalled();expect(f.ledger.accrue).not.toHaveBeenCalled();
  });
  it.each(['opened','synchronize','reopened'])('ignores target action %s',async action=>{
    const f=fixture();f.evt.action=action;await handleContribution(f.evt,f.deps);expect(f.ledger.accrue).not.toHaveBeenCalled();
  });
  it('ignores a closed but unmerged event without reads',async()=>{
    const f=fixture();f.evt.merged=false;await handleContribution(f.evt,f.deps);expect(f.pulls).not.toHaveBeenCalled();
  });
  it.each(['foreignRepoId','foreignRepoName','wrongPr','notMerged','open','invalidDate','invalidSha','unsafeId','unknownOwner'])('fails closed on current PR %s',async kind=>{
    const f=fixture();
    if(kind==='foreignRepoId')f.pull.base.repo.id=999;
    if(kind==='foreignRepoName')f.pull.base.repo.full_name='other/project';
    if(kind==='wrongPr')f.pull.number=43;
    if(kind==='notMerged')f.pull.merged=false;
    if(kind==='open')f.pull.state='open';
    if(kind==='invalidDate')f.pull.merged_at='2026-02-30T10:00:00Z';
    if(kind==='invalidSha')f.pull.merge_commit_sha='untrusted-ref';
    if(kind==='unsafeId')f.pull.user.id=Number.MAX_SAFE_INTEGER+1;
    if(kind==='unknownOwner')f.pull.base.repo.owner.id=0;
    await expect(handleContribution(f.evt,f.deps)).rejects.toThrow(/CoinPay contribution/);
    expect(f.ledger.accrue).not.toHaveBeenCalled();expect(f.getIdToken).not.toHaveBeenCalled();
  });
  it('accepts real bot authors while keeping immutable contributor identity',async()=>{
    const f=fixture();f.pull.user.login='dependabot[bot]';await handleContribution(f.evt,f.deps);
    expect(f.ledger.accrue.mock.calls[0]![0].contributor_login).toBe('dependabot[bot]');
  });
  it('hides upstream GitHub error payloads',async()=>{
    const f=fixture();f.pulls.mockRejectedValue(new Error('private secret response'));
    await expect(handleContribution(f.evt,f.deps)).rejects.toThrow('CONTRIBUTION_UNAVAILABLE');
  });
});

describe('maintainer-only contribution commands',()=>{
  it.each(['read','triage','none','unexpected'])('rejects current %s despite author association',async permission=>{
    const f=fixture('/coinpay balance');f.permission.mockResolvedValue({data:{permission}});
    expect((await handleContribution(f.evt,f.deps))?.action).toBe('skipped');
    expect(f.pulls).not.toHaveBeenCalled();expect(f.ledger.balance).not.toHaveBeenCalled();expect(f.gh.createComment).not.toHaveBeenCalled();
  });
  it.each(['Bot','Organization',''])('ignores nonhuman command author %s',async type=>{
    const f=fixture('/coinpay balance');f.evt.comment!.type=type;await handleContribution(f.evt,f.deps);
    expect(f.permission).not.toHaveBeenCalled();expect(f.gh.createComment).not.toHaveBeenCalled();
  });
  it('permission failures do not request financial credentials or reply',async()=>{
    const f=fixture('/coinpay balance');f.permission.mockRejectedValue(new Error('secret'));
    expect((await handleContribution(f.evt,f.deps))?.detail).toBe('permission_lookup_failed');expect(f.getIdToken).not.toHaveBeenCalled();
  });
  it('balance is private-key read only and reports exact cent floor/remainder',async()=>{
    const f=fixture('/coinpay balance');await handleContribution(f.evt,f.deps);
    expect(f.ledger.balance).toHaveBeenCalledWith('123','8');expect(f.getIdToken).not.toHaveBeenCalled();
    expect(f.gh.createComment.mock.calls[0]![1]).toContain('$0.021 USD');
    expect(f.gh.createComment.mock.calls[0]![1]).toContain('$0.02 USD; 1 mill');
  });
  it('settlement derives current contributor, explicit terms and stable comment key',async()=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');
    expect((await handleContribution(f.evt,f.deps))?.action).toBe('contribution_settlement');
    expect(f.ledger.settle).toHaveBeenCalledWith(settlementRequest,'private-oidc');
    const reply=f.gh.createComment.mock.calls[0]![1];expect(reply).toContain('Reserved $0.02');
    expect(reply).toContain('Open the CoinPay checkout');expect(reply).not.toContain('is paid');expect(reply).not.toContain('verified_wallet');
  });
  it('below-cent balance does not imply a payment',async()=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');
    f.ledger.settle.mockResolvedValue({settlement:null,balance:{...balance,accrued_mills:'9',available_mills:'9',payable_cents:'0',remainder_mills:'9'}});
    await handleContribution(f.evt,f.deps);expect(f.gh.createComment.mock.calls[0]![1]).toContain('No checkout was created');
  });
  it('pending reservation remains retryable with same comment identity',async()=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');
    f.ledger.settle.mockResolvedValue({settlement:{...checkout,payment_url:null,status:'reserved',payment_status:null},balance});
    expect((await handleContribution(f.evt,f.deps))?.action).toBe('contribution_settlement_pending');
    expect(f.gh.createComment.mock.calls[0]![1]).not.toContain('coinpay-contribution-comment');
    await handleContribution(f.evt,f.deps);expect(f.ledger.settle.mock.calls[1]![0].idempotency_key).toBe('github-comment:900');
  });
  it.each(['expired','forwarding','forwarding_failed','confirmed'])('keeps %s payment reserved without claiming a new checkout',async payment_status=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');
    f.ledger.settle.mockResolvedValue({settlement:{...checkout,payment_url:null,payment_status},balance});
    expect((await handleContribution(f.evt,f.deps))?.action).toBe('contribution_settlement_pending');
    const reply=f.gh.createComment.mock.calls[0]![1];
    expect(reply).toContain('remains reserved until forwarding is verified');
    expect(reply).toContain('do not send a duplicate payment');
    expect(reply).not.toContain('still being prepared');expect(reply).not.toContain('is paid');
  });
  it('shows reconciled reserved and paid totals separately from available funds',async()=>{
    const f=fixture('/coinpay balance');
    f.ledger.balance.mockResolvedValue({...balance,accrued_mills:'31',reserved_mills:'20',paid_mills:'10',available_mills:'1',payable_cents:'0'});
    await handleContribution(f.evt,f.deps);
    expect(f.gh.createComment.mock.calls[0]![1]).toContain('Reserved: $0.020 USD. Paid: $0.010 USD. Available: $0.001 USD.');
  });
  it('refuses to publish a settlement for a different contributor',async()=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');
    f.ledger.settle.mockResolvedValue({settlement:{...checkout,contributor_id:'9'},balance});
    await expect(handleContribution(f.evt,f.deps)).rejects.toThrow('INVALID_RESPONSE');
    expect(f.gh.createComment.mock.calls[0]![1]).not.toContain('Open the CoinPay checkout');
  });
  it('retry after ambiguous failure keeps same key and does not mark paid/handled',async()=>{
    const f=fixture('/coinpay settle --wallet verified_wallet --blockchain USDC_POL');f.ledger.settle.mockRejectedValueOnce(new Error('private-key-token'));
    await expect(handleContribution(f.evt,f.deps)).rejects.toThrow('CONTRIBUTION_UNAVAILABLE');
    const reply=f.gh.createComment.mock.calls[0]![1];expect(reply).not.toContain('private-key-token');expect(reply).not.toContain('coinpay-contribution-comment');
    await handleContribution(f.evt,f.deps);expect(f.ledger.settle.mock.calls[1]![0]).toEqual(settlementRequest);
  });
  it('trusts only the configured Action author for handled markers',async()=>{
    const f=fixture('/coinpay balance');const c={body:'<!-- coinpay-contribution-comment:900 -->',authorLogin:'attacker',authorType:'User',trustedAuthor:false};
    f.gh.listComments.mockResolvedValue([c]);await handleContribution(f.evt,f.deps);expect(f.ledger.balance).toHaveBeenCalledTimes(1);
    f.gh.listComments.mockResolvedValue([{...c,trustedAuthor:true}]);expect((await handleContribution(f.evt,f.deps))?.action).toBe('noop_duplicate');
    expect(f.ledger.balance).toHaveBeenCalledTimes(1);
  });
  it.each(['/coinpay settle','/coinpay settle 25','/coinpay settle --wallet verified_wallet','/coinpay settle --wallet verified_wallet --blockchain usdc_pol',
    '/coinpay settle --wallet verified_wallet --blockchain USDC_POL --amount 99','/coinpay balance\n/coinpay settle','/coinpay balance --all'])('rejects ambiguous command %s',async body=>{
    const f=fixture(body);expect((await handleContribution(f.evt,f.deps))?.detail).toBe('invalid_contribution_command');
    expect(f.pulls).not.toHaveBeenCalled();expect(f.ledger.settle).not.toHaveBeenCalled();
  });
  it('leaves legacy commands alone',()=>expect(parseContributionCommand('/coinpay create 25 USD')).toBeNull());
});

describe('integer-only fixed-origin ledger transport',()=>{
  function transport(payload: unknown,status=200) {
    const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}}));
    return {fetcher,client:new ContributionClient('private-api-key',fetcher)};
  }
  it('uses exact accrue body, fixed origin/audience token, no redirect and bounded timeout',async()=>{
    const f=transport({success:true,replayed:false,contribution:{id:'c',amount_mills:'1',currency:'USD'},balance});
    await f.client.accrue(identity,'private-oidc');const [url,request]=f.fetcher.mock.calls[0]!;
    expect(url).toBe('https://coinpayportal.com/api/github/contributions/accrue');
    expect(request.redirect).toBe('error');expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers['X-GitHub-Actions-Token']).toBe('private-oidc');expect(JSON.parse(request.body)).toEqual(identity);
    expect(request.body).not.toContain('amount');
  });
  it('balance GET sends no OIDC or body',async()=>{
    const f=transport({success:true,balance});await f.client.balance('123','8');const [url,req]=f.fetcher.mock.calls[0]!;
    expect(url).toContain('/balance?repository_id=123&contributor_id=8');expect(req.method).toBe('GET');expect(req.body).toBeUndefined();expect(req.headers['X-GitHub-Actions-Token']).toBeUndefined();
  });
  it('requires OIDC before writes',async()=>{
    const f=transport({});await expect(f.client.accrue(identity,'')).rejects.toThrow('OIDC_REQUIRED');expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('safe errors never include server/token/wallet details',async()=>{
    const f=transport({error:'private-api-key-wallet'},503);await expect(f.client.settle(settlementRequest,'oidc')).rejects.toThrow('UPSTREAM_UNAVAILABLE');
  });
  it('rejects cross-origin, javascript, path traversal and malformed checkout URLs',async()=>{
    for(const url of ['https://evil.invalid/pay/'+checkout.id,'javascript:alert(1)','https://coinpayportal.com.evil.invalid/pay/'+checkout.id,
      'https://coinpayportal.com/pay/'+checkout.id+'?redirect=evil','https://user@coinpayportal.com/pay/'+checkout.id,'https://coinpayportal.com/pay/'+'-'.repeat(36)]){
      const f=transport({success:true,settlement:{...checkout,payment_url:url},balance});await expect(f.client.settle(settlementRequest,'oidc')).rejects.toThrow('INVALID_RESPONSE');
    }
  });
  it('accepts canonical checkout and validates below-cent responses',async()=>{
    const f=transport({success:true,settlement:checkout,balance});expect((await f.client.settle(settlementRequest,'oidc')).settlement).toEqual(checkout);
    const bad=transport({success:true,settlement:null,code:'BELOW_CENT',balance});await expect(bad.client.settle(settlementRequest,'oidc')).rejects.toThrow('INVALID_RESPONSE');
  });
  it.each([{contributor_id:'9'},{currency:'EUR'},{status:'paid'},{payment_status:'expired'}])('rejects mismatched identity, currency or inactive checkout %#',async fields=>{
    const f=transport({success:true,settlement:{...checkout,...fields},balance});
    await expect(f.client.settle(settlementRequest,'oidc')).rejects.toThrow('INVALID_RESPONSE');
  });
  it.each([{currency:'EUR'},{reserved_mills:'1'},{paid_mills:'1'},{paid_mills:undefined}])('rejects inconsistent balance accounting %#',fields=>{
    expect(()=>parseBalance({...balance,...fields})).toThrow('INVALID_RESPONSE');
  });
  it('rejects oversized JSON',async()=>{
    const f=transport({success:true,balance,padding:'x'.repeat(65536)});await expect(f.client.balance('123','8')).rejects.toThrow('INVALID_RESPONSE');
  });
  it('never rounds or converts ledger amounts to floating point',()=>{
    expect(millsUsd('1')).toBe('0.001');expect(millsUsd('10')).toBe('0.010');expect(centsUsd('1')).toBe('0.01');
    expect(millsUsd('9007199254740993001')).toBe('9007199254740993.001');
    for(const value of [1,1.001,'1.001','1e3','-1','01',null])expect(()=>parseBalance({...balance,available_mills:value})).toThrow();
    expect(()=>parseBalance({...balance,payable_cents:'3'})).toThrow();expect(()=>parseBalance({...balance,remainder_mills:'0'})).toThrow();
  });
  it('rejects unsafe or noncanonical GitHub IDs',()=>{
    for(const value of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'01','+1','1.0'])expect(()=>githubId(value)).toThrow();
    expect(githubId('9007199254740993')).toBe('9007199254740993');
  });
});
