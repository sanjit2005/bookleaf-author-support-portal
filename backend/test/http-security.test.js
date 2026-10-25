import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { httpConfiguration, configureHttp, httpSecurity } from '../src/config/http-security.js';
import { validateEnvironment } from '../src/config/environment.js';
import { createLoginLimiter } from '../src/auth/routes.js';
import { readFile } from 'node:fs/promises';

test('production requires exact HTTPS origins and explicit IP/CIDR proxies, never wildcard or hop-count trust',()=>{
  const env={MONGODB_URI:'mongodb://127.0.0.1/isolated',JWT_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'production'};
  assert.throws(()=>validateEnvironment(env),/CORS_ALLOWED_ORIGINS/);
  assert.throws(()=>validateEnvironment({...env,CORS_ALLOWED_ORIGINS:'https://portal.example.test'}),/TRUSTED_PROXY_CIDRS/);
  for(const origin of ['*','null','https://*.example.test','http://portal.example.test','https://portal.example.test/path','https://portal.example.test/','https://user:password@portal.example.test','https://portal.example.test?query']) {
    assert.throws(()=>httpConfiguration({CORS_ALLOWED_ORIGINS:origin,TRUSTED_PROXY_CIDRS:'192.0.2.1'},'production'),/CORS_ALLOWED_ORIGINS/);
  }
  for(const proxies of ['true','1','*','0.0.0.0/0','::/0','192.0.2.1/-1','192.0.2.1/33','192.0.2.1/','loopback','192.0.2.1/32/1'])assert.throws(()=>httpConfiguration({TRUSTED_PROXY_CIDRS:proxies}),/TRUSTED_PROXY_CIDRS/);
  const config=validateEnvironment({...env,CORS_ALLOWED_ORIGINS:'https://portal.example.test,https://preview.example.test',TRUSTED_PROXY_CIDRS:'192.0.2.0/24,2001:db8::/32'});
  assert.equal(config.httpSecurity.trustProxy('192.0.2.9'),true);assert.equal(config.httpSecurity.trustProxy('::ffff:192.0.2.9'),true);
  assert.equal(config.httpSecurity.trustProxy('2001:db8::1'),true);assert.equal(config.httpSecurity.trustProxy('198.51.100.3'),false);
  assert.equal(httpConfiguration({}).trustProxy,false);
});
async function harness(t,env,mode='test') {
  const app=express();configureHttp(app,httpConfiguration(env,mode));app.use(httpSecurity);
  app.post('/login',createLoginLimiter({limit:2,validate:{xForwardedForHeader:false}}),(_req,res)=>res.status(401).json({error:'Authentication failed'}));
  app.get('/identity',(req,res)=>res.json({ip:req.ip}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return (path,options={})=>fetch('http://127.0.0.1:'+server.address().port+path,options);
}
test('CORS preflight permits exact configured origins and Bearer/JSON/revision headers without cookies',async t=>{
  const request=await harness(t,{CORS_ALLOWED_ORIGINS:'https://portal.example.test',TRUSTED_PROXY_CIDRS:'127.0.0.1/32'},'production');
  const headers={Origin:'https://portal.example.test','Access-Control-Request-Method':'PATCH','Access-Control-Request-Headers':'authorization, content-type, if-match'};
  const preflight=await request('/identity',{method:'OPTIONS',headers});assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),headers.Origin);assert.equal(preflight.headers.has('access-control-allow-credentials'),false);
  assert.match(preflight.headers.get('access-control-allow-headers'),/If-Match/);assert.match(preflight.headers.get('vary'),/Origin/);
  for(const origin of ['https://portal.example.test.evil.test','https://other.example.test','null']) {
    const response=await request('/identity',{headers:{Origin:origin}});assert.equal(response.status,403);assert.equal(response.headers.has('access-control-allow-origin'),false);
  }
  assert.equal((await request('/identity',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Method':'DELETE'}})).status,400);
  assert.equal((await request('/identity',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'x-unexpected'}})).status,400);
  const response=await request('/identity',{headers:{Origin:headers.Origin,'X-Forwarded-Proto':'https'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000');
  assert.equal((await request('/identity')).headers.has('strict-transport-security'),false);
});
test('untrusted forwarded IPs cannot bypass login limits; a verified proxy separates clients and ignores spoofed prefixes',async t=>{
  const direct=await harness(t,{});
  for(let index=0;index<3;index++)assert.equal((await direct('/login',{method:'POST',headers:{'X-Forwarded-For':'198.51.100.'+(index+1)}})).status,index<2?401:429);
  const proxied=await harness(t,{TRUSTED_PROXY_CIDRS:'127.0.0.1/32'});
  for(let index=0;index<3;index++)assert.equal((await proxied('/login',{method:'POST',headers:{'X-Forwarded-For':`192.0.2.${index+1}, 198.51.100.1`}})).status,index<2?401:429);
  assert.equal((await proxied('/login',{method:'POST',headers:{'X-Forwarded-For':'198.51.100.2'}})).status,401);
  const response=await proxied('/identity',{headers:{'X-Forwarded-For':'192.0.2.99, 198.51.100.1'}});assert.equal((await response.json()).ip,'198.51.100.1');
});
test('Vercel frontend header policy does not accidentally apply the JSON-only API CSP',async()=>{
  const config=JSON.parse(await readFile(new URL('../../frontend/vercel.json',import.meta.url),'utf8'));
  const headers=Object.fromEntries(config.headers[0].headers.map(({key,value})=>[key,value]));
  assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.equal(headers['X-Frame-Options'],'DENY');assert.equal(headers['Content-Security-Policy'],undefined);
});
