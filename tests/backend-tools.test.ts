import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendAttempt } from '../src/domains/runtime/backend-tools';

test('backend capability authenticates, deduplicates, stages closure and revokes on exit', async () => {
  let calls = 0;
  const bridge = new BackendAttempt((name,input) => { calls++; return {value:{ok:true}, ...(name === 'finish' ? {closure:input} : {})}; });
  await bridge.open(); const env = bridge.environment();
  const send = (name:string,input = {},requestId: string = crypto.randomUUID(),token = env.ORBIT_AGENT_TOKEN) => fetch(env.ORBIT_AGENT_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({name,input,requestId})});
  try {
    assert.equal((await send('read',{},'unauthorized','wrong')).status,403);
    assert.equal(calls,0);
    assert.equal((await send('read',{},'same')).status,200);
    assert.equal((await send('read',{},'same')).status,200); assert.equal(calls,1);
    assert.equal((await send('read',{changed:true},'same')).status,400);
    assert.equal(bridge.staged,undefined);
    assert.equal((await send('finish',{summary:'first'})).status,200);
    assert.equal((await send('finish',{summary:'conflict'})).status,400);
    assert.deepEqual(bridge.staged,{summary:'first'});
  } finally { await bridge.close(); }
  await assert.rejects(send('read'));
});
