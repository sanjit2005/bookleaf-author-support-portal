import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { EventEmitter } from 'node:events';
import { guardCollection, WRITE_METHODS, IntegrationSafetyError, assertOwned } from '../integration/guards.js';
import { createLifecycle, trackRouter } from '../integration/lifecycle.js';
import { fixtureCapabilities } from '../integration/fixtures.js';
import { assertCaseSource } from '../integration/case-policy.js';
import { openHarness } from '../integration/harness.js';

const safety=error=>error instanceof IntegrationSafetyError;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('aggregation rejects write options and every nested writing stage before constructing a cursor',()=>{
  let constructed=0;const raw={aggregate:()=>{constructed++;return {};}};
  guardCollection(raw,async()=>{});
  for(const options of [{out:'foreign'},{cursor:{}},{session:{}},{dbName:'foreign'},{authdb:'foreign'},{allowDiskUse:true,out:'foreign'}])assert.throws(()=>raw.aggregate([],options),safety);
  for(const pipeline of [[{$out:'foreign'}],[{$merge:'foreign'}],[{$facet:{items:[{$out:'foreign'}]}}],[{$lookup:{pipeline:[{$merge:'foreign'}]}}]])assert.throws(()=>raw.aggregate(pipeline),safety);
  assert.equal(constructed,0);
});
test('read aggregation snapshots BSON data and exposes only checked toArray execution',async()=>{
  let checks=0,constructed=0,closed=0,seen;
  const raw={aggregate:(pipeline,options)=>{constructed++;seen={pipeline,options};return {toArray:async()=>[{safe:true}],close:async()=>{closed++;}};}};
  guardCollection(raw,async()=>{checks++;});
  const pipeline=[{$match:{status:'Open'}}],options={allowDiskUse:true},cursor=raw.aggregate(pipeline,options);
  assert.equal(constructed,0);
  pipeline.push({$out:'foreign'});pipeline[0].$match.status='Closed';options.out='foreign';
  for(const method of ['out','addStage','clone','next','explain','stream','pipeline','client','db'])assert.throws(()=>cursor[method],safety);
  assert.throws(()=>Object.defineProperty(cursor,'out',{value:()=>{}}),TypeError);
  assert.deepEqual(await cursor.toArray(),[{safe:true}]);
  assert.deepEqual(seen,{pipeline:[{$match:{status:'Open'}}],options:{allowDiskUse:true}});
  assert.equal(checks,1);assert.equal(constructed,1);assert.equal(closed,1);
});
test('every aggregation execution revalidates identity immediately and closes failed cursors',async()=>{
  let allowed=true,constructed=0,closed=0;
  const raw={aggregate:()=>{constructed++;return {toArray:async()=>{throw Object.assign(new Error('Synthetic read failure'),{code:123});},close:async()=>{closed++;}};}};
  guardCollection(raw,async()=>{if(!allowed)throw new IntegrationSafetyError('Refused');});
  const cursor=raw.aggregate([]);
  await assert.rejects(cursor.toArray(),/Synthetic read failure/);assert.equal(closed,1);
  allowed=false;await assert.rejects(cursor.toArray(),safety);assert.equal(constructed,1);
});
test('namespace overrides and aliases cannot reach any supported write or read method',async()=>{
  let constructed=0;
  const methods=[...WRITE_METHODS,'findOne','find','listIndexes','countDocuments'];
  const raw=Object.fromEntries(methods.map(method=>[method,async()=>{constructed++;}]));
  guardCollection(raw,async()=>{});
  for(const method of methods)for(const key of ['dbName','authdb','DBNAME','AuthDb']) {
    const args=method==='listIndexes'?[{[key]:'foreign'}]:method==='updateOne'?[{}, {},{[key]:'foreign'}]:[{}, {[key]:'foreign'}];
    assert.throws(()=>raw[method](...args),safety);
  }
  for(const method of ['findOneAndUpdate','findOneAndReplace','findOneAndDelete','updateMany','bulkWrite','replaceOne'])assert.throws(()=>raw[method]({}, {}, {dbName:'foreign'}),safety);
  assert.equal(constructed,0);
});
test('options are copied before awaiting guards; accessors and inherited namespace values cannot escape',async()=>{
  const gate=deferred();let seen;
  const raw={updateOne:async(...args)=>{seen=args;}};
  guardCollection(raw,()=>gate.promise);
  const options={upsert:false},pending=raw.updateOne({},{$set:{value:1}},options);
  options.dbName='foreign';options.upsert=true;gate.resolve();await pending;
  assert.deepEqual(seen[2],{upsert:false});
  let read=false;const getter={get dbName(){read=true;return 'foreign';}};
  assert.throws(()=>raw.updateOne({}, {},getter),safety);assert.equal(read,false);
  await raw.updateOne({}, {},Object.create({dbName:'foreign'}));assert.equal(Object.hasOwn(seen[2],'dbName'),false);
  assert.throws(()=>raw.updateOne({}, {},{toBSON:()=>({dbName:'foreign'})}),safety);
});
test('raw collection and ODM-style forwarding share restrictions; omitted write APIs deny by default',async()=>{
  let writes=0;
  const inherited={futureWriteMethod(){writes++;}};
  const raw=Object.assign(Object.create(inherited),{insertOne:async()=>{writes++;},createSearchIndex:async()=>{writes++;}});
  guardCollection(raw,async()=>{});
  const odm={save:options=>raw.insertOne({synthetic:true},options),findOneAndUpdate:(...args)=>raw.findOneAndUpdate(...args)};
  assert.throws(()=>odm.save({dbName:'foreign'}),safety);
  assert.throws(()=>odm.findOneAndUpdate({}, {},{authdb:'foreign'}),safety);
  for(const method of ['createSearchIndex','createSearchIndexes','dropSearchIndex','updateSearchIndex','initializeOrderedBulkOp','initializeUnorderedBulkOp','drop','rename'])assert.throws(()=>raw[method](),safety);
  assert.throws(()=>raw.futureWriteMethod(),safety);
  assert.equal(writes,0);await odm.save({});assert.equal(writes,1);
});
test('actual ODM save/query/aggregate paths reach only the mocked guarded collection',async()=>{
  const name='HarnessOfflineGuard',schema=new mongoose.Schema({value:String},{bufferCommands:false,autoCreate:false,autoIndex:false});
  const Model=mongoose.model(name,schema);let writes=0;
  Model.collection.insertOne=async doc=>{writes++;return {acknowledged:true,insertedId:doc._id};};
  Model.collection.updateOne=async()=>{writes++;return {acknowledged:true,matchedCount:1};};
  Model.collection.aggregate=()=>({toArray:async()=>[{value:'read'}],close:async()=>{}});
  guardCollection(Model.collection,async()=>{});
  try {
    await new Model({value:'fixture'}).save();assert.equal(writes,1);
    await assert.rejects(Model.updateOne({},{$set:{value:'changed'}},{dbName:'foreign'}),safety);
    for(const operation of ['findOneAndUpdate','findOneAndReplace','findOneAndDelete'])await assert.rejects(Model[operation]({}, {value:'fixture'},{authdb:'foreign'}),safety);
    await assert.rejects(Model.aggregate([{$match:{}}],{out:'foreign'}).exec(),safety);
    assert.deepEqual(await Model.aggregate([{$match:{}}],{allowDiskUse:true}).exec(),[{value:'read'}]);
    await assert.rejects(new Model({value:'fixture'}).save({session:{hasEnded:false}}),safety);
    assert.equal(writes,1);assert.equal(mongoose.connection.readyState,0);
  } finally {mongoose.deleteModel(name);}
});
test('fixture capabilities return detached records and deny models, clients, databases and cursors',async()=>{
  const stored={_id:'synthetic',passwordHash:'synthetic-only',value:1};
  const fake={findOne:()=>({lean:async()=>({...stored})}),countDocuments:async()=>1,listIndexes:async()=>[]};
  const api=fixtureCapabilities({models:{Ticket:fake},track:(_kind,work)=>work(),request:async()=>({status:200}),source:null});
  for(const field of ['models','db','client','connection','useDb','getClient','transaction','services','collection'])assert.throws(()=>api[field],safety);
  for(const field of ['db','client','collection','useDb','constructor'])assert.throws(()=>api.records[field],safety);
  assert.throws(()=>api.records.one.constructor,safety);assert.equal(Object.getPrototypeOf(api.records.one),null);
  const data=await api.records.one('Ticket',{});assert.equal(data.passwordHash,undefined);data.value=2;assert.equal(stored.value,1);
  assert.equal(await api.records.count('Ticket'),1);assert.equal(await api.records.indexes('Ticket').then(x=>x.length),0);
  await assert.rejects(api.records.one('Other',{}),safety);
});
test('fixture errors preserve only safe error codes and source snapshots are immutable',async()=>{
  const raw=Object.assign(new Error('Synthetic private driver details'),{code:11000,client:{unsafe:true}});
  const api=fixtureCapabilities({models:{User:{countDocuments:async()=>{throw raw;}}},track:(_kind,work)=>work(),source:{authors:[{author_id:'AUTH900001'}],books:[]}});
  await assert.rejects(api.records.count('User'),error=>error!==raw&&error.code===11000&&!error.client&&!error.message.includes('private'));
  assert.throws(()=>{api.source.authors[0].author_id='Changed';},TypeError);
});
test('case-source gate rejects direct, computed and imported database/runtime access before loading cases',async()=>{
  const source=await readFile(new URL('../integration/cases.js',import.meta.url),'utf8');assertCaseSource(source);
  for(const extra of ["h.models.User.findOne({});","h['db'];","h.records['collection'];","process.env;","h.useDb('other');","await import('../src/server.js');","import '../src/server.js';","const x = require('mongoose');","const x=Function('return 1');"] )assert.throws(()=>assertCaseSource(source+'\n'+extra),safety);
  assert.throws(()=>assertCaseSource(source.replace("import bcrypt from 'bcrypt';","import bcrypt from '../src/server.js';")),safety);
});
test('cleanup waits for delayed handlers, transactions and database operations rather than socket events',async()=>{
  const lifecycle=createLifecycle({timeoutMs:1000}),gate=deferred(),events=[];
  const handler=lifecycle.track('handler',()=>lifecycle.track('transaction',()=>lifecycle.track('operation',async()=>{events.push('started');await gate.promise;events.push('settled');})));
  const cleaning=lifecycle.maintain(async()=>{events.push('cleanup');});
  await tick();assert.deepEqual(events,['started']);assert.equal(lifecycle.pending(),3);
  await assert.rejects(lifecycle.track('request',async()=>{}),safety);
  gate.resolve();await handler;await cleaning;assert.deepEqual(events,['started','settled','cleanup']);
});
test('router tracks the actual returned handler promise despite response/socket closure',async()=>{
  const lifecycle=createLifecycle({timeoutMs:1000}),gate=deferred();let cleaned=false;
  const router={stack:[{handle:async(_req,res)=>{res.closed=true;await gate.promise;}}]};trackRouter(router,lifecycle);
  const response={},pending=router.stack[0].handle({},response,error=>{throw error;});assert.equal(response.closed,true);
  const cleaning=lifecycle.maintain(async()=>{cleaned=true;});await tick();assert.equal(cleaned,false);
  gate.resolve();await pending;await cleaning;assert.equal(cleaned,true);
});
test('asynchronous error handlers are drained before cleanup and retain their Express signature',async()=>{
  const life=createLifecycle({timeoutMs:1000}),gate=deferred();let cleaned=false;
  const router={stack:[{handle:async(_error,_req,_res,_next)=>{await gate.promise;}}]};trackRouter(router,life);
  assert.equal(router.stack[0].handle.length,4);
  const pending=router.stack[0].handle(new Error('Synthetic'),{},{},()=>assert.fail());
  const cleanup=life.maintain(async()=>{cleaned=true;});await tick();assert.equal(cleaned,false);
  gate.resolve();await pending;await cleanup;assert.equal(cleaned,true);
});
test('drain timeout permanently refuses cleanup and further admission',async()=>{
  const lifecycle=createLifecycle({timeoutMs:15}),gate=deferred();let cleaned=false;
  const pending=lifecycle.track('handler',()=>gate.promise);
  await assert.rejects(lifecycle.maintain(async()=>{cleaned=true;}),safety);assert.equal(cleaned,false);
  await assert.rejects(lifecycle.track('operation',async()=>{}),safety);
  gate.resolve();await pending;await assert.rejects(lifecycle.maintain(async()=>{cleaned=true;}),safety);assert.equal(cleaned,false);
});
test('interruption never grants active work cleanup permissions, but quiescent private maintenance can clean',async()=>{
  const controller=new AbortController(),lifecycle=createLifecycle({signal:controller.signal,timeoutMs:1000}),gate=deferred();
  const pending=lifecycle.track('handler',async()=>{await gate.promise;await lifecycle.track('operation',async()=>assert.fail());});
  controller.abort();const failed=assert.rejects(pending,safety);gate.resolve();await failed;
  let cleaned=false;await lifecycle.maintain(()=>lifecycle.track('operation',async()=>{cleaned=true;}),{terminal:true});assert.equal(cleaned,true);
  await assert.rejects(lifecycle.track('handler',async()=>{}),safety);
});
test('detached tasks cannot acquire database capabilities after their parent handler finishes',async()=>{
  const lifecycle=createLifecycle(),gate=deferred();let detached;
  await lifecycle.track('handler',async()=>{detached=gate.promise.then(()=>lifecycle.track('operation',async()=>assert.fail()));});
  const failed=assert.rejects(detached,safety);gate.resolve();await failed;
});
test('unknown database outcomes block cleanup, while a definitive duplicate rejection does not',async()=>{
  for(const code of [11000,undefined]) {
    const lifecycle=createLifecycle();let cleaned=false;
    await assert.rejects(lifecycle.track('operation',async()=>{throw Object.assign(new Error('Synthetic failure'),{code});}));
    const cleanup=lifecycle.maintain(async()=>{cleaned=true;});
    if(code===11000){await cleanup;assert.equal(cleaned,true);}else {await assert.rejects(cleanup,safety);assert.equal(cleaned,false);}
  }
});

function fakeConnection({missingUuidAt=0,delaySessionEnd,failSessionEnd=false,infos=new Map()}={}) {
  const deleted=[],events=[],createdNames=[];let created=0;
  const database='bookleaf_test_guard123';
  const client=Object.assign(new EventEmitter(),{options:{dbName:database}});
  const connection={readyState:0,name:database,getClient:()=>client,
    openUri:async()=>{connection.readyState=1;},close:async()=>{events.push('closed');connection.readyState=0;},
    startSession:async()=>{const active={id:{id:Buffer.alloc(16,1)},hasEnded:false,inTransaction:()=>true,withTransaction:async work=>{
      const result=await work();
      const event={commandName:'commitTransaction',requestId:1,connectionId:1,address:'fixture',databaseName:'admin'};
      client.emit('commandStarted',{...event,command:{lsid:active.id,txnNumber:1,autocommit:false}});
      client.emit('commandSucceeded',{...event,reply:{ok:1}});return result;
    },endSession:async()=>{if(delaySessionEnd)await delaySessionEnd();if(failSessionEnd)throw new Error('Synthetic closure failure');events.push('session-ended');active.hasEnded=true;}};return active;},
    model:(name,schema,collectionName)=>{
      const collection={name:collectionName,findOne:async()=>null,deleteMany:async()=>{deleted.push(collectionName);},createIndex:async()=> 'fixture_index'};
      return {schema,collection,createIndexes:async()=>collection.createIndex({fixture:1}),deleteMany:filter=>collection.deleteMany(filter),findOne:filter=>({session:()=>({lean:()=>collection.findOne(filter)})})};
    },
  };
  connection.db={databaseName:database,command:async()=>({setName:'fixture',maxWireVersion:25,logicalSessionTimeoutMinutes:30}),
    createCollection:async(name,options)=>{created++;createdNames.push(name);infos.set(name,{name,options,info:{uuid:Buffer.from((created).toString(16).padStart(32,'0'),'hex')}});},
    listCollections:({name})=>({hasNext:async()=>infos.has(name),next:async()=>{const info=infos.get(name);if(missingUuidAt&&infos.size===missingUuidAt&&name===Array.from(infos.keys()).at(-1))return {...info,info:{}};return info;}}),
  };
  return {connection,infos,deleted,events,createdNames};
}
const fakeEnv=()=>({NODE_ENV:'test',RUN_DB_INTEGRATION_TESTS:'1',TEST_DATABASE_NAME:'bookleaf_test_guard123',TEST_MONGODB_HOSTS:'localhost:27018',TEST_MONGODB_URI:'mongodb://synthetic:synthetic-only@localhost:27018/bookleaf_test_guard123'});
test('mocked full initialization closes its probe session before cleanup and exposes no model handles',async()=>{
  const fake=fakeConnection(),h=await openHarness(fakeEnv(),{createConnection:()=>fake.connection});
  assert.deepEqual(fake.events,['session-ended']);
  await h.runCase(async api=>{assert.throws(()=>api.models,safety);assert.throws(()=>api.records.db,safety);});
  await h.close();assert.equal(fake.deleted.length,6);assert.equal(fake.events.at(-1),'closed');
});
test('partial initialization never adopts or deletes the collection whose UUID was not registered',async()=>{
  const fake=fakeConnection({missingUuidAt:3});
  await assert.rejects(openHarness(fakeEnv(),{createConnection:()=>fake.connection}),safety);
  assert.equal(fake.infos.size,3);assert.equal(fake.deleted.length,2);assert.equal(fake.deleted.includes(Array.from(fake.infos.keys()).at(-1)),false);assert.equal(fake.events.at(-1),'closed');
});
test('concurrent run namespaces and stale markers cannot cause cross-run fixture cleanup',async()=>{
  const infos=new Map(),first=fakeConnection({infos}),second=fakeConnection({infos});
  const [a,b]=await Promise.all([openHarness(fakeEnv(),{createConnection:()=>first.connection}),openHarness(fakeEnv(),{createConnection:()=>second.connection})]);
  for(const name of first.createdNames)assert.equal(second.createdNames.includes(name),false);
  const firstName=first.createdNames[0],info=infos.get(firstName),foreign=infos.get(second.createdNames[0]);
  info.options=foreign.options; // Same name/UUID but another run's marker.
  await assert.rejects(a.clearRecords(),safety);await assert.rejects(a.close(),safety);assert.equal(first.deleted.length,0);
  await b.close();assert.deepEqual(second.deleted,second.createdNames);
  assert.throws(()=>assertOwned(info,{name:firstName,marker:'old-run',uuid:info.info.uuid.toString('hex')}),safety);
});
test('session-finalization failures or deadlines refuse all fixture cleanup and force connection closure',async()=>{
  for(const options of [{failSessionEnd:true},{delaySessionEnd:()=>new Promise(()=>{})}]) {
    const fake=fakeConnection(options);
    await assert.rejects(openHarness(fakeEnv(),{createConnection:()=>fake.connection,drainTimeoutMs:15}),safety);
    assert.equal(fake.deleted.length,0);assert.equal(fake.events.at(-1),'closed');
  }
});
test('maintenance itself is bounded and cannot continue issuing operations after a timeout',async()=>{
  const life=createLifecycle({timeoutMs:15}),gate=deferred();let late;
  await assert.rejects(life.maintain(async()=>{await gate.promise;late=life.track('operation',async()=>assert.fail());await late;}),safety);
  gate.resolve();await tick();await assert.rejects(late,safety);
});
