import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import mongoose from 'mongoose';
import {startServer} from '../src/server.js';
import {validateEnvironment,loadEnvironment} from '../src/config/environment.js';
import {connectDatabase} from '../src/db/connection.js';

const privateMarker='PRIVATE-STARTUP-TEST-MARKER';
const values=()=>({NODE_ENV:'production',MONGODB_URI:`mongodb://synthetic:${privateMarker}@example.test/test_only`,JWT_SECRET:randomBytes(32).toString('hex'),CORS_ALLOWED_ORIGINS:'https://portal.example.test'});
function fixture(overrides={}) {
  const logs=[],events=[];
  const options={application:{locals:{},set(){},listen(){events.push('listen');throw new Error(privateMarker);}},
    loadConfig:async()=>validateEnvironment(values()),connect:async()=>events.push('connect'),disconnect:async()=>events.push('disconnect'),
    reportDiagnostic:entry=>logs.push(entry),...overrides};
  return {logs,events,options};
}
async function fails(f,stage,category) {
  await assert.rejects(startServer(f.options),error=>error.message==='Backend startup failed'&&!error.cause);
  assert.equal(f.logs.length,1);assert.equal(f.logs[0].stage,stage);assert.equal(f.logs[0].category,category);
  assert.deepEqual(Object.keys(f.logs[0]),['event','stage','category','message']);
  const output=JSON.stringify(f.logs);
  for(const forbidden of [privateMarker,'mongodb://','mongodb+srv://','stack','cause','synthetic:'])assert.equal(output.includes(forbidden),false);
}

test('startup validation failures identify the setting without logging values or attempting a connection',async()=>{
  for(const [patch,category] of [
    [{JWT_SECRET:privateMarker},'JWT_SECRET_INVALID'],[{MONGODB_URI:privateMarker},'MONGODB_URI_INVALID'],
    [{PORT:privateMarker},'PORT_INVALID'],[{NODE_ENV:privateMarker},'NODE_ENV_INVALID'],
    [{GEMINI_MODEL:privateMarker},'GEMINI_MODEL_INVALID'],[{CORS_ALLOWED_ORIGINS:undefined},'CORS_REQUIRED'],
    [{CORS_ALLOWED_ORIGINS:privateMarker},'CORS_INVALID'],[{TRUSTED_PROXY_CIDRS:privateMarker},'PROXY_CONFIGURATION_INVALID'],
  ]) {
    const f=fixture({loadConfig:async()=>validateEnvironment({...values(),...patch})});
    await fails(f,'environment_validation',category);assert.deepEqual(f.events,[]);
  }
});

test('environment-file loading failures are distinguished from validation failures without reading real .env',async()=>{
  // Reading this test directory as a file fails before parsing; no real secrets are loaded.
  const f=fixture({loadConfig:()=>loadEnvironment(values(),new URL('./',import.meta.url))});
  await fails(f,'environment_load','ENVIRONMENT_LOAD_FAILED');assert.deepEqual(f.events,[]);
  const unknown=fixture({loadConfig:async()=>{throw new Error(privateMarker);}});
  await fails(unknown,'environment_load','ENVIRONMENT_LOAD_FAILED');assert.deepEqual(unknown.events,[]);
});

test('MongoDB driver failures expose only allowlisted categories and cleanup still runs (mocked driver)',async t=>{
  for(const [properties,category] of [
    [{code:18},'DATABASE_AUTHENTICATION_FAILED'],[{code:'ENOTFOUND'},'DATABASE_DNS_FAILED'],
    [{code:'EAI_AGAIN'},'DATABASE_DNS_FAILED'],[{code:'ETIMEDOUT'},'DATABASE_TIMEOUT'],
    [{name:'MongoNetworkTimeoutError'},'DATABASE_TIMEOUT'],[{code:'ECONNRESET'},'DATABASE_NETWORK_FAILED'],
    [{code:'ECONNREFUSED'},'DATABASE_NETWORK_FAILED'],[{name:'MongoNetworkError'},'DATABASE_NETWORK_FAILED'],
    [{name:'MongoServerSelectionError'},'DATABASE_SELECTION_FAILED'],[{name:'MongooseServerSelectionError'},'DATABASE_SELECTION_FAILED'],
    [{code:privateMarker,name:privateMarker},'DATABASE_CONNECTION_FAILED'],
  ]) {
    const error=Object.assign(new Error(privateMarker),properties,{cause:new Error(privateMarker)});
    const mocked=t.mock.method(mongoose,'connect',async()=>{throw error;});
    const f=fixture({connect:connectDatabase});await fails(f,'database_connection',category);
    assert.deepEqual(f.events,['disconnect']);assert.equal(mocked.mock.callCount(),1);
    assert.equal(mocked.mock.calls[0].arguments[1].autoCreate,false);
    assert.equal(mocked.mock.calls[0].arguments[1].autoIndex,false);mocked.mock.restore();
  }
});

test('HTTP listener errors identify safe categories, close HTTP and disconnect without leaking raw errors',async()=>{
  for(const [code,category] of [['EADDRINUSE','HTTP_ADDRESS_IN_USE'],['EACCES','HTTP_PERMISSION_DENIED'],[privateMarker,'HTTP_LISTEN_FAILED']]) {
    const f=fixture(),server=new EventEmitter();server.close=()=>f.events.push('close');
    f.options.application.listen=()=>{queueMicrotask(()=>server.emit('error',Object.assign(new Error(privateMarker),{code})));return server;};
    await fails(f,'http_listener',category);assert.deepEqual(f.events,['connect','close','disconnect']);
  }
});

test('application configuration and logging/cleanup failures keep the generic outward failure',async()=>{
  const f=fixture({application:{locals:{},set(){throw new Error(privateMarker);}}});
  await fails(f,'environment_validation','APPLICATION_CONFIGURATION_FAILED');assert.deepEqual(f.events,[]);
  let closed=false;
  await assert.rejects(startServer({application:{},loadConfig:async()=>({}),connect:async()=>{throw new Error(privateMarker);},
    disconnect:async()=>{closed=true;throw new Error(privateMarker);},reportDiagnostic:()=>{throw new Error(privateMarker);}}),/^Error: Backend startup failed$/);
  assert.equal(closed,true);
});

test('default production logger emits only safe structured diagnostic output',async t=>{
  const logger=t.mock.method(console,'error',()=>{});
  const f=fixture({reportDiagnostic:undefined,connect:async()=>{throw new Error(privateMarker);}});
  await assert.rejects(startServer(f.options),/Backend startup failed/);
  assert.equal(logger.mock.callCount(),1);
  const [line]=logger.mock.calls[0].arguments;
  assert.deepEqual(JSON.parse(line),{event:'backend_startup_failed',stage:'database_connection',category:'DATABASE_CONNECTION_FAILED',message:'Database connection failed'});
});
