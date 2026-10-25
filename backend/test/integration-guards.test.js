// Offline tests only: no openUri/connect call is permitted to reach a real driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { integrationConfig, assertIdentity, assertTopology, assertOwned, guardCollection, WRITE_METHODS, IntegrationSafetyError } from '../integration/guards.js';
import { openHarness, isolatedModels } from '../integration/harness.js';
import { runIntegration } from '../integration/runner.js';
import { integrationCases } from '../integration/cases.js';
import { User, Author, Book } from '../src/models/index.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createTicketServices } from '../src/tickets/service.js';

const database='bookleaf_test_guard123';
const valid=()=>({NODE_ENV:'test',RUN_DB_INTEGRATION_TESTS:'1',TEST_DATABASE_NAME:database,TEST_MONGODB_HOSTS:'localhost:27018',TEST_MONGODB_URI:`mongodb://synthetic:synthetic-password@localhost:27018/${database}?replicaSet=test_rs&authSource=admin`});
const identity=()=>({readyState:1,name:database,db:{databaseName:database},getClient:()=>({options:{dbName:database}})});
const config={database};
const safety=error=>error instanceof IntegrationSafetyError&&!/synthetic-password|mongodb:|secret-query/.test(error.message);

test('integration import graph excludes startup, application environment and administrative CLIs',async()=>{
  const visited=new Set();
  async function visit(url) {
    if(visited.has(url.href))return;visited.add(url.href);
    const source=await readFile(url,'utf8');
    for(const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))if(match[1].startsWith('.'))await visit(new URL(match[1],url));
  }
  await visit(new URL('../integration/run.js',import.meta.url));
  for(const suffix of ['/src/server.js','/src/app.js','/src/config/environment.js','/src/seed/run.js','/src/provision/run.js','/src/db/indexes.js'])assert.equal([...visited].some(path=>path.endsWith(suffix)),false,suffix);
  assert.equal(mongoose.connection.readyState,0);
});

test('integration opt-in, environment isolation and no application URI fallback',()=>{
  assert.equal(integrationConfig(valid()).database,database);
  for(const patch of [{NODE_ENV:undefined},{NODE_ENV:'production'},{RUN_DB_INTEGRATION_TESTS:undefined},{RUN_DB_INTEGRATION_TESTS:'true'},{TEST_MONGODB_URI:undefined,MONGODB_URI:valid().TEST_MONGODB_URI},{NODE_OPTIONS:'--env-file=.env'}])assert.throws(()=>integrationConfig({...valid(),...patch}),safety);
  for(const flag of ['--env-file=.env','--env-file-if-exists=.env','--import=anything','--require=anything','-r','-ranything'])assert.throws(()=>integrationConfig(valid(),[flag]),safety);
  assert.equal(mongoose.connection.readyState,0);
});
test('approved database name must be explicit, unambiguous and exclusively test-only',()=>{
  for(const name of [undefined,'','admin','config','local','bookleaf_support','bookleaf_test_demo1234','bookleaf_test_prod1234','bookleaf_test_support12','bookleaf_test_short','bookleaf_test_ABCDEF123','another_test_db','bookleaf_test_guard123/other'])assert.throws(()=>integrationConfig({...valid(),TEST_DATABASE_NAME:name}),safety);
  for(const path of ['', 'admin','bookleaf_support',database+'/',database+'/other',database+'%2fother','%62ookleaf_test_guard123'])assert.throws(()=>integrationConfig({...valid(),TEST_MONGODB_URI:'mongodb://synthetic:synthetic-password@localhost:27018/'+path}),safety);
});
test('URI scheme, authentication, parser errors, query ambiguity and unsafe options fail closed',()=>{
  for(const uri of ['', 'https://example.test/'+database, 'mongodb://localhost:27018/'+database,'mongodb://user@localhost:27018/'+database,'mongodb://user:@localhost:27018/'+database,'mongodb://user:%00@localhost:27018/'+database,'mongodb://user:%ZZ@localhost:27018/'+database,valid().TEST_MONGODB_URI+'#secret-query',valid().TEST_MONGODB_URI+' '])assert.throws(()=>integrationConfig({...valid(),TEST_MONGODB_URI:uri}),safety);
  for(const query of ['dbName=admin','authSource=config','replicaSet=bad%20name','tls=maybe','tlsAllowInvalidCertificates=true','tlsInsecure=true','directConnection=true','retryWrites=false','w=1','authSource=admin&authSource=admin','tls=true&TLS=true'])assert.throws(()=>integrationConfig({...valid(),TEST_MONGODB_URI:`mongodb://synthetic:synthetic-password@localhost:27018/${database}?${query}`}),safety);
});
test('hosts require exact independent approval and remote TLS; SRV is parsed without DNS',()=>{
  for(const hosts of [undefined,'','*','localhost',' localhost:27018','localhost:27018,localhost:27018','other.example:27018'])assert.throws(()=>integrationConfig({...valid(),TEST_MONGODB_HOSTS:hosts}),safety);
  const remote={...valid(),TEST_MONGODB_HOSTS:'test-host.example:27017',TEST_MONGODB_URI:`mongodb://synthetic:synthetic-password@test-host.example:27017/${database}?tls=true`};
  assert.equal(integrationConfig(remote).database,database);
  assert.throws(()=>integrationConfig({...remote,TEST_MONGODB_URI:remote.TEST_MONGODB_URI.replace('tls=true','tls=false')}),safety);
  assert.throws(()=>integrationConfig({...remote,TEST_MONGODB_URI:`mongodb://synthetic:synthetic-password@test-host.example:27017,other.example:27017/${database}?tls=true`}),safety);
  assert.equal(integrationConfig({...remote,TEST_MONGODB_HOSTS:'cluster.example.test',TEST_MONGODB_URI:`mongodb+srv://synthetic:synthetic-password@cluster.example.test/${database}`}).database,database);
});
test('actual identity checks all driver/connection names and refuses default/disconnected connections',()=>{
  assertIdentity(identity(),config);
  for(const connection of [mongoose.connection,{...identity(),readyState:0},{...identity(),name:'bookleaf_support'},{...identity(),db:{databaseName:'admin'}},{...identity(),getClient:()=>({options:{dbName:'bookleaf_support'}})},{...identity(),getClient:()=>null}])assert.throws(()=>assertIdentity(connection,config),safety);
});
test('transaction topology requires real session support and appropriate replica/sharded wire version',()=>{
  const replica={setName:'test_rs',maxWireVersion:7,logicalSessionTimeoutMinutes:30};
  assertTopology(replica);assertTopology({msg:'isdbgrid',maxWireVersion:8,logicalSessionTimeoutMinutes:30});
  for(const value of [null,{}, {...replica,setName:undefined},{...replica,setName:true},{...replica,maxWireVersion:undefined},{...replica,maxWireVersion:6},{...replica,logicalSessionTimeoutMinutes:null},{...replica,logicalSessionTimeoutMinutes:0},{msg:'isdbgrid',maxWireVersion:7,logicalSessionTimeoutMinutes:30}])assert.throws(()=>assertTopology(value),safety);
});
test('collection name, marker and immutable UUID are all required before writes or cleanup',()=>{
  const owned={name:'run_collection',marker:'synthetic-run',uuid:'abcd'},info={name:owned.name,options:{validator:{$jsonSchema:{description:owned.marker}}},info:{uuid:Buffer.from('abcd','hex')}};
  assertOwned(info,owned);
  for(const value of [null,{...info,name:'authors'},{...info,options:{}},{...info,info:{}},{...info,info:{uuid:Buffer.from('0123','hex')}}])assert.throws(()=>assertOwned(value,owned),safety);
});
test('every exposed write is guarded; destructive methods and writing aggregations are blocked',async()=>{
  const methods=WRITE_METHODS;
  let permitted=false,writes=0,checks=0;
  const collection=Object.fromEntries(methods.map(method=>[method,async()=>{writes++;return 'written';}]));
  collection.aggregate=()=> ({toArray:async()=> 'read result'});
  guardCollection(collection,async()=>{checks++;if(!permitted)throw new IntegrationSafetyError('Refused');});
  for(const method of methods)await assert.rejects(collection[method]({}),safety);
  assert.equal(writes,0);permitted=true;
  for(const method of methods)assert.equal(await collection[method]({}),'written');
  assert.equal(writes,methods.length);assert.equal(checks,methods.length*2);
  for(const method of ['drop','dropIndex','dropIndexes','rename','findOneAndUpdate','findOneAndReplace','findOneAndDelete','bulkWrite','insertMany','createSearchIndexes'])assert.throws(()=>collection[method](),safety);
  for(const pipeline of [[{$out:'authors'}],[{$merge:{into:'authors'}}],[{$facet:{nested:[{$out:'authors'}]}}]])assert.throws(()=>collection.aggregate(pipeline),safety);
  assert.equal(await collection.aggregate([{$match:{}}]).toArray(),'read result');
});
test('isolated model schemas preserve indexes and references without binding to the default connection',async()=>{
  const connection=mongoose.createConnection(); // Disconnected; no URI and no network.
  try {
    const models=isolatedModels(connection,'blit_'+'a'.repeat(24),()=>{});
    for(const model of Object.values(models)){assert.equal(model.db,connection);assert.match(model.collection.name,/^blit_a{24}_/);assert.equal(model.schema.options.autoIndex,false);assert.equal(model.schema.options.autoCreate,false);}
    for(const template of [User,Author,Book])assert.deepEqual(models[template.modelName].schema.indexes(),template.schema.indexes());
    assert.equal(models.Book.schema.path('author').options.ref,'Author');assert.equal(connection.model('Author'),models.Author);assert.notEqual(models.Author,Author);
    assert.throws(()=>isolatedModels(mongoose.connection,'blit_'+'a'.repeat(24),()=>{}),safety);
    assert.throws(()=>isolatedModels(connection,'authors',()=>{}),safety);
  } finally {await connection.close();}
});
test('invalid configuration and missing/unverified source fail before constructing a connection',async()=>{
  let connections=0;const createConnection=()=>{connections++;throw new Error('Must never run');};
  await assert.rejects(openHarness({}, {createConnection}),safety);
  await assert.rejects(openHarness({...valid(),TEST_SOURCE_DATA_PATH:'Z:/nonexistent-original-file.json'},{createConnection}),safety);
  await assert.rejects(openHarness({...valid(),TEST_SOURCE_DATA_PATH:fileURLToPath(new URL('../package.json',import.meta.url))},{createConnection}),safety);
  assert.equal(connections,0);
});
test('setup failure sanitizes driver errors and always closes its fake connection',async()=>{
  let opened=0,closed=0;
  const fake={readyState:0,openUri:async()=>{opened++;throw new Error(valid().TEST_MONGODB_URI);},close:async()=>{closed++;}};
  await assert.rejects(openHarness(valid(),{createConnection:()=>fake}),safety);
  assert.equal(opened,1);assert.equal(closed,1);
  await assert.rejects(openHarness(valid(),{createConnection:()=>mongoose.connection}),safety);
  const controller=new AbortController();controller.abort();
  await assert.rejects(openHarness(valid(),{createConnection:()=>fake,signal:controller.signal}),safety);
  assert.equal(opened,1);assert.equal(closed,2);
});
test('simulated connected identity and topology failures perform no writes and close',async()=>{
  for(const wrongName of [true,false]) {
    let closed=0,writes=0;
    const fake={...identity(),readyState:0,openUri:async()=>{fake.readyState=1;},close:async()=>{closed++;}};
    fake.name=wrongName?'bookleaf_support':database;
    fake.db={databaseName:fake.name,command:async()=>({maxWireVersion:25,logicalSessionTimeoutMinutes:30}),createCollection:async()=>{writes++;}};
    await assert.rejects(openHarness(valid(),{createConnection:()=>fake}),safety);
    assert.equal(writes,0);assert.equal(closed,1);
  }
});
test('write and cleanup boundaries recheck changed database identities and collection ownership',async()=>{
  const connection=identity(),owned={name:'run_only',marker:'run-marker',uuid:'abcd'};
  let info={name:owned.name,options:{validator:{$jsonSchema:{description:owned.marker}}},info:{uuid:Buffer.from('abcd','hex')}},writes=0;
  const collection={insertOne:async()=>{writes++;},deleteMany:async()=>{writes++;}};
  guardCollection(collection,async()=>{assertIdentity(connection,config);assertOwned(info,owned);});
  await collection.insertOne({});assert.equal(writes,1);
  connection.name='bookleaf_support';
  await assert.rejects(collection.insertOne({}),safety);await assert.rejects(collection.deleteMany({}),safety);assert.equal(writes,1);
  connection.name=database;info={...info,options:{}};
  await assert.rejects(collection.deleteMany({}),safety);assert.equal(writes,1);
});
test('runner closes after assertions and redacts errors; missing source is an explicit incomplete run',async()=>{
  const output=[];let closed=0,cleared=0;
  const open=async()=>({runCase:work=>work({}),clearRecords:async()=>{cleared++;},close:async()=>{closed++;}});
  const report=line=>output.push(line);
  assert.equal(await runIntegration({}, {open,report,cases:[['synthetic pass',async()=>{}],['synthetic failure',async()=>{throw new Error(valid().TEST_MONGODB_URI);}]]}),1);
  assert.equal(closed,1);assert.equal(cleared,2);assert.equal(output.join().includes('synthetic-password'),false);
  assert.equal(await runIntegration({}, {open,report,cases:[['original source',async()=>false]]}),2);
  assert.equal(closed,2);assert.equal(integrationCases.length,9);
  await assert.rejects(runIntegration({}, {open,report,cases:[['guard',async()=>{throw new IntegrationSafetyError('Refused');}],['never reached',async()=>assert.fail()]]}),safety);
  assert.equal(closed,3);
  const controller=new AbortController();controller.abort();
  await assert.rejects(runIntegration({}, {open,report,cases:[['interrupted',async()=>assert.fail()]],signal:controller.signal}),safety);assert.equal(closed,4);
});
test('injected authentication and transaction dependencies bypass application model bindings',async()=>{
  const id=new mongoose.Types.ObjectId(),user={_id:id,role:'author',accountStatus:'active',tokenVersion:0};
  let userReads=0,authorReads=0,next=0;
  const middleware=createAuthMiddleware({User:{findById:()=>({select:async()=>{userReads++;return user;}})},Author:{findOne:filter=>({select:()=>({lean:async()=>{authorReads++;assert.equal(filter.user,id);return {_id:id};}})})}});
  const req={get:()=> 'Bearer synthetic-token',app:{locals:{jwtService:{verify:()=>({userId:String(id),tokenVersion:0})}}}};
  await middleware.authenticate(req,{},()=>next++);await middleware.resolveAuthor(req,{},()=>next++);
  assert.equal(userReads,1);assert.equal(authorReads,1);assert.equal(next,2);assert.equal(req.auth.authorId,id);
  let transactions=0;
  const services=createTicketServices({models:{},transaction:async()=>{transactions++;throw new Error('Injected offline transaction');}});
  await assert.rejects(services.patchTicket({},id,{},0),/Injected offline transaction/);assert.equal(transactions,1);
  assert.equal(mongoose.connection.readyState,0);
});

test('ordinary unit imports never reach the executable entry point; runner requires explicit fakes',async()=>{
  const visited=new Set();
  async function visit(url) {
    if(visited.has(url.href))return;visited.add(url.href);
    const source=await readFile(url,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
      if(match[1].startsWith('.'))await visit(new URL(match[1],url));
    }
  }
  for(const name of await readdir(new URL('./',import.meta.url)))if(name.endsWith('.test.js'))await visit(new URL(name,import.meta.url));
  assert.equal([...visited].some(url=>url.endsWith('/integration/run.js')),false);
  const runner=await readFile(new URL('../integration/runner.js',import.meta.url),'utf8');
  assert.equal(/openHarness|loadCases|process\.env|main\(/.test(runner),false);
  await assert.rejects(runIntegration({}),safety);
  const script=await readFile(new URL('../scripts/check.js',import.meta.url),'utf8');
  assert.ok(script.includes("['--check',file]"));
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.test,'node --test');assert.equal(pkg.scripts.check,'node scripts/check.js');
  assert.equal(pkg.scripts['test:integration'],'node integration/run.js');
  assert.equal(mongoose.connection.readyState,0);
});
