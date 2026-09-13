// Offline transport fixture loaded before the real committed action bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
const mode=process.env.BUNDLE_SCENARIO;
const calls=[],comments=[];let oidcRequests=0;
const deny=()=>{throw new Error('Real network disabled in bundle fixture.');};
http.request=deny;http.get=deny;https.get=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;tls.connect=deny;
https.request=(options,callback)=>{
  assert.equal(options.host,'oidc.actions.invalid');
  assert.equal(new URL('https://oidc.actions.invalid'+options.path).searchParams.get('audience'),'coinpayportal.com');
  oidcRequests++;
  const request=new EventEmitter();request.setTimeout=()=>request;request.write=()=>{};
  request.end=()=>queueMicrotask(()=>{const response=Readable.from([Buffer.from(JSON.stringify({value:'fixture-oidc'}))]);
    response.statusCode=200;response.headers={'content-type':'application/json'};callback(response);});
  return request;
};
syncBuiltinESMExports();
const balance={currency:'USD',accrued_mills:'21',reserved_mills:'0',paid_mills:'0',available_mills:'21',payable_cents:'2',remainder_mills:'1'};
globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url),method=options.method||'GET';
  const body=options.body?JSON.parse(options.body):undefined;
  calls.push({host:url.host,path:url.pathname,method,body});
  let data;
  if(url.host==='coinpayportal.com'){
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer fixture-scoped-key');
    if(mode==='ledger-denied')return new Response(JSON.stringify({error:'PRIVATE_UPSTREAM_TEXT'}),{status:403});
    if(url.pathname.endsWith('/accrue')){
      assert.equal(options.headers['X-GitHub-Actions-Token'],'fixture-oidc');
      assert.deepEqual(Object.keys(body).sort(),['repository_id','repository_owner_id','repository_full_name','pull_request_id','pull_request_number','contributor_id','contributor_login','merged_at','merge_commit_sha'].sort());
      assert.equal(body.repository_id,'123');assert.equal(body.contributor_id,'8');assert.equal(body.pull_request_id,'456');
      data={success:true,replayed:mode==='replay',contribution:{id:'fixture',amount_mills:'1',currency:'USD'},balance};
    }else if(url.pathname.endsWith('/balance')){
      assert.equal(method,'GET');assert.equal(url.searchParams.get('contributor_id'),'8');data={success:true,balance};
    }else if(url.pathname.endsWith('/settlements')){
      assert.equal(body.recipient_wallet,'verified_wallet');assert.equal(body.blockchain,'USDC_POL');
      assert.equal(body.idempotency_key,'github-comment:900');assert.equal(body.contributor_id,'8');
      data={success:true,settlement:{id:'11111111-1111-4111-8111-111111111111',status:'awaiting_payment',amount_cents:'2',
        contributor_id:'8',currency:'USD',
        payment_url:'https://coinpayportal.com/pay/22222222-2222-4222-8222-222222222222',payment_status:'pending'},
        balance:{...balance,reserved_mills:'20',available_mills:'1',payable_cents:'0',remainder_mills:'1'}};
    }else throw new Error('Unexpected financial endpoint');
  }else{
    assert.equal(url.host,'api.github.com');
    if(decodeURIComponent(url.pathname).endsWith('/contents/.github/coinpay.yml')){
      const rate=mode==='bad-config'?'0.002':'0.001';
      data={encoding:'base64',content:Buffer.from(`enabled: true\ncontributionRewards:\n  enabled: ${mode!=='disabled'}\n  rateUsd: '${rate}'\n  payment: manual\n`).toString('base64')};
    }else if(url.pathname.endsWith('/collaborators/maintainer/permission'))data={permission:mode==='denied'?'read':'write'};
    else if(url.pathname.endsWith('/pulls/42'))data={id:456,number:42,merged:mode!=='unmerged',state:'closed',merged_at:'2026-09-13T10:00:00Z',merge_commit_sha:'a'.repeat(40),
      user:{id:8,login:'author'},base:{repo:{id:123,full_name:'acme/project',owner:{id:7}}}};
    else if(url.pathname.endsWith('/issues/42/comments')&&method==='GET')data=[];
    else if(url.pathname.endsWith('/issues/42/comments')&&method==='POST'){comments.push(body.body);data={id:901};}
    else throw new Error('Unexpected GitHub request');
  }
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
// @actions/github bundles Undici; intercept it in addition to global fetch.
globalThis[Symbol.for('undici.globalDispatcher.1')]={
  dispatch(options,handler){void(async()=>{
    handler.onConnect(()=>{});let body=options.body;
    if(body&&typeof body!=='string'&&!Buffer.isBuffer(body)){const chunks=[];for await(const c of body)chunks.push(Buffer.from(c));body=Buffer.concat(chunks).toString('utf8');}
    const response=await globalThis.fetch(new URL(options.path,options.origin).href,{method:options.method,body});
    handler.onHeaders(response.status,[Buffer.from('content-type'),Buffer.from('application/json')],()=>{},'OK');
    handler.onData(Buffer.from(await response.text()));handler.onComplete([]);
  })().catch(e=>handler.onError(e));return true;},close:async()=>{},destroy:async()=>{},
};
process.on('beforeExit',()=>{
  const finance=calls.filter(c=>c.host==='coinpayportal.com');
  try{
    const expectedFailure=['bad-config','ledger-denied','unmerged'].includes(mode);
    assert.equal(process.exitCode||0,expectedFailure?1:0);
    assert.equal(finance.length,['accrue','replay','balance','settle','ledger-denied'].includes(mode)?1:0);
    assert.equal(oidcRequests,['accrue','replay','settle','ledger-denied'].includes(mode)?1:0);
    assert.equal(comments.length,['balance','settle'].includes(mode)?1:0);
    if(mode==='balance')assert.ok(comments[0].includes('$0.021'));
    if(mode==='settle'){assert.ok(comments[0].includes('Reserved $0.02'));assert.ok(!comments[0].includes('is paid'));}
    fs.writeFileSync(process.env.BUNDLE_RESULT,JSON.stringify({mode,passed:true,realNetworkCalls:0,ledgerRequests:finance.length,oidcRequests,mockedComments:comments.length}));
  }catch{process.exitCode=1;fs.writeFileSync(process.env.BUNDLE_RESULT,JSON.stringify({mode,passed:false,calls,oidcRequests,mockedComments:comments.length}));}
});
