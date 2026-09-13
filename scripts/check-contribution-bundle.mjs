import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
const root=new URL('../',import.meta.url);
for(const mode of ['accrue','replay','disabled','unmerged','balance','settle','denied','bad-config','ledger-denied']){
  test(`actual committed action bundle: ${mode} (all real network disabled)`,()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coinpay-bundle-'));
    try{
      const comment=['balance','settle','denied'].includes(mode);
      const event={action:comment?'created':'closed',repository:{id:123},
        ...(comment?{issue:{number:42,pull_request:{},html_url:'https://github.com/acme/project/pull/42'},
          comment:{id:900,body:mode==='settle'?'/coinpay settle --wallet verified_wallet --blockchain USDC_POL':'/coinpay balance',user:{id:99,login:'maintainer',type:'User'}}}:
          {pull_request:{number:42,merged:true}})};
      fs.writeFileSync(path.join(dir,'event.json'),JSON.stringify(event));fs.writeFileSync(path.join(dir,'output'),'');
      const result=spawnSync(process.execPath,['--import',new URL('./contribution-bundle-fixture.mjs',import.meta.url).pathname,new URL('../dist/index.js',import.meta.url).pathname],{
        cwd:root,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,
          GITHUB_REPOSITORY:'acme/project',GITHUB_EVENT_NAME:comment?'issue_comment':'pull_request_target',GITHUB_EVENT_PATH:path.join(dir,'event.json'),GITHUB_OUTPUT:path.join(dir,'output'),
          'INPUT_GITHUB-TOKEN':'fixture-github','INPUT_COINPAY-API-KEY':'fixture-scoped-key','INPUT_COINPAY-BUSINESS-ID':'fixture-business',
          ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.actions.invalid/token?fixture=true',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-request-token',
          BUNDLE_SCENARIO:mode,BUNDLE_RESULT:path.join(dir,'result.json')},
      });
      assert.ok(!result.error,result.error?.message);assert.ok(fs.existsSync(path.join(dir,'result.json')),result.stdout+'\n'+result.stderr);
      const report=JSON.parse(fs.readFileSync(path.join(dir,'result.json')));assert.equal(report.passed,true,JSON.stringify(report)+'\n'+result.stdout+'\n'+result.stderr);
      assert.ok(!result.stdout.includes('PRIVATE_UPSTREAM_TEXT'));
      const outputs=fs.readFileSync(path.join(dir,'output'),'utf8');
      const expectedAction={accrue:'contribution_accrued',replay:'contribution_already_accrued',disabled:'noop_disabled',balance:'contribution_balance',settle:'contribution_settlement',denied:'skipped'}[mode];
      if(expectedAction)assert.ok(outputs.includes(expectedAction),outputs);
      const expectedError={unmerged:'PULL_REQUEST_NOT_MERGED','bad-config':'Could not safely read the default-branch CoinPay configuration.','ledger-denied':'AUTHORIZATION_FAILED'}[mode];
      if(expectedError)assert.ok(result.stdout.includes(expectedError),result.stdout);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
}
