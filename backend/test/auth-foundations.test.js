import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {validateEnvironment,validSigningSecret,loadEnvironment} from '../src/config/environment.js';
import {createJwtService,JWT_SETTINGS} from '../src/auth/jwt.js';
import {validPasswordHash} from '../src/auth/password-policy.js';
import {User} from '../src/models/index.js';
import {startServer} from '../src/server.js';
import app from '../src/app.js';
const env=()=>({MONGODB_URI:'mongodb://127.0.0.1:27017/test_only',JWT_SECRET:randomBytes(32).toString('hex'),NODE_ENV:'test'});
const sub='1234567890abcdef12345678';
test('environment accepts random hex key and rejects missing, placeholder and weak settings',async()=>{
 const values=env();const config=validateEnvironment(values);assert.equal(config.jwtSecret.length,32);assert.equal(config.port,5000);
 for(const secret of [undefined,'','x'.repeat(64),'a'.repeat(64),'0123456789abcdef'.repeat(4),randomBytes(16).toString('hex'),'<GENERATE_32_RANDOM_BYTES_AS_HEX>'])assert.equal(validSigningSecret(secret),false);
 for(const patch of [{MONGODB_URI:''},{MONGODB_URI:'https://example.com/db'},{MONGODB_URI:'mongodb://<user>:<password>@host/db'},{JWT_SECRET:'private-test-marker'},{PORT:'0'},{PORT:'1e3'},{NODE_ENV:'other'}])assert.throws(()=>validateEnvironment({...values,...patch}),e=>!e.message.includes('private-test-marker'));
 const loaded=await loadEnvironment(values,new URL('./file-that-does-not-exist.env',import.meta.url));assert.equal(loaded.port,5000);
});
test('JWT enforces claims, algorithm, issuer, audience, expiry and version shape',()=>{
 const config=validateEnvironment(env()),service=createJwtService(config);
 const token=service.sign({userId:sub,tokenVersion:0,email:'excluded@example.com',role:'admin'});
 const decoded=jwt.decode(token,{complete:true});assert.equal(decoded.header.alg,'HS256');assert.equal(decoded.payload.exp-decoded.payload.iat,900);
 assert.deepEqual(Object.keys(decoded.payload).sort(),['aud','exp','iat','iss','sub','tokenVersion']);assert.deepEqual(service.verify(token),{userId:sub,tokenVersion:0});
 const now=Math.floor(Date.now()/1000);
 const payload={sub,tokenVersion:0,iat:now,exp:now+900,iss:JWT_SETTINGS.issuer,aud:JWT_SETTINGS.audience};
 for(const patch of [{sub:'bad'},{tokenVersion:-1},{tokenVersion:0.5},{tokenVersion:'0'},{tokenVersion:null},{tokenVersion:Number.MAX_SAFE_INTEGER+1},{exp:undefined},{iat:undefined},{exp:now-1},{iat:now+30,exp:now+930},{iss:'other'},{aud:'other'},{role:'admin'}]){
   const claims={...payload,...patch};
   for(const key of Object.keys(claims)) if(claims[key]===undefined) delete claims[key];
   const candidate=jwt.sign(claims,config.jwtSecret,{algorithm:'HS256',...(Object.hasOwn(patch,'iat')&&patch.iat===undefined?{noTimestamp:true}:{})});assert.throws(()=>service.verify(candidate),/Invalid or expired/);
 }
 assert.throws(()=>service.verify(jwt.sign(payload,config.jwtSecret,{algorithm:'HS384'})));
 assert.throws(()=>service.verify(jwt.sign(payload,'',{algorithm:'none'})));
 assert.throws(()=>service.verify(token+'x'));assert.throws(()=>service.sign({userId:sub,tokenVersion:-1}));
 assert.throws(()=>createJwtService({jwtSecret:Buffer.alloc(16)}));
});
test('bcrypt works; hash format/cost and tokenVersion validation are enforced',async()=>{
 const hash=await bcrypt.hash('isolated test password',10);assert.ok(validPasswordHash(hash));assert.ok(await bcrypt.compare('isolated test password',hash));
 for(const invalid of ['plaintext',hash.replace('$10$','$04$'),hash.replace('$10$','$15$'),hash.replace('$2b$','$2y$'),hash.slice(0,-1)])assert.equal(validPasswordHash(invalid),false);
 const user=new User({email:' AUTHOR@Example.com ',accountStatus:'active',passwordHash:hash});await user.validate();assert.equal(user.email,'author@example.com');assert.equal(user.tokenVersion,0);assert.equal(user.toJSON().passwordHash,undefined);
 for(const version of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null]){user.tokenVersion=version;await assert.rejects(user.validate());}
 assert.equal(User.schema.path('passwordHash').options.select,false);
});
test('unselected hash permits ordinary saves but cannot bypass activation or hash validation',async t=>{
 const user=User.hydrate({_id:new mongoose.Types.ObjectId(),email:'a@example.com',accountStatus:'active',role:'author',tokenVersion:0},{passwordHash:0});
 assert.equal(user.isSelected('passwordHash'),false);user.lastLoginAt=new Date();await user.validate();user.tokenVersion=1;await user.validate();
 let savedUpdate;
 t.mock.method(User.collection,'updateOne',async(_filter,update)=>{savedUpdate=update;return {matchedCount:1,modifiedCount:1};});
 await user.save();assert.ok(savedUpdate.$set.lastLoginAt);assert.equal(savedUpdate.$set.tokenVersion,1);assert.equal(Object.hasOwn(savedUpdate.$set,'passwordHash'),false);
 const pending=User.hydrate({_id:new mongoose.Types.ObjectId(),email:'b@example.com',accountStatus:'pending'},{passwordHash:0});pending.accountStatus='active';await assert.rejects(pending.validate());
 user.passwordHash=null;await assert.rejects(user.validate());
});
test('User security query updates and replacements are blocked before database access',async t=>{
 const update=t.mock.method(User.collection,'updateOne',async()=>({matchedCount:1,modifiedCount:1}));
 const queries=[User.updateOne({},{$set:{passwordHash:'bad'}}),User.updateOne({},{$set:{accountStatus:'active'}}),User.updateOne({},{$inc:{tokenVersion:1}}),User.updateMany({},{$unset:{passwordHash:1}}),User.findOneAndUpdate({},{$set:{accountStatus:'active'}}),User.updateOne({},{$rename:{email:'passwordHash'}}),User.updateOne({},[{$set:{accountStatus:'active'}}],{updatePipeline:true}),User.replaceOne({},{email:'a@example.com'}),User.findOneAndReplace({},{email:'a@example.com'}),User.updateOne({},{$set:{lastLoginAt:new Date()}},{upsert:true})];
 for(const query of queries)await assert.rejects(query.exec(),/validated User/);
 await assert.rejects(User.bulkWrite([{updateOne:{filter:{},update:{$set:{accountStatus:'active'}}}}]),/validated User/);
 assert.equal(update.mock.callCount(),0);
 await User.updateOne({},{$set:{lastLoginAt:new Date()}}).exec();assert.equal(update.mock.callCount(),1);
});
function fakeApplication(events){const server=new EventEmitter();server.close=callback=>{events.push('http-close');callback();};return {server,listen(){events.push('listen');queueMicrotask(()=>server.emit('listening'));return server;}};}
test('startup connects before listening and shutdown closes HTTP then MongoDB once',async()=>{
 const events=[],application=fakeApplication(events);const instance=await startServer({application,loadConfig:async()=>{events.push('config');return {port:5000,mongodbUri:'not-a-real-uri'};},connect:async()=>{events.push('connect');},disconnect:async()=>{events.push('db-close');}});
 assert.deepEqual(events,['config','connect','listen']);await Promise.all([instance.shutdown(),instance.shutdown()]);assert.deepEqual(events,['config','connect','listen','http-close','db-close']);
});
test('startup failures never listen and sanitize connection failures',async()=>{
 let listened=false,closed=false;const application={listen(){listened=true;}};
 await assert.rejects(startServer({application,loadConfig:async()=>{throw new Error('Invalid configuration');},connect:async()=>{throw new Error('Must not connect');}}));assert.equal(listened,false);
 await assert.rejects(startServer({application,loadConfig:async()=>({port:5000}),connect:async()=>{throw new Error('sensitive database detail');},disconnect:async()=>{closed=true;}}),e=>e.message==='Backend startup failed');assert.equal(listened,false);assert.equal(closed,true);
});
test('health reflects database connection state without a database or network',async t=>{
 const layer=app.router.stack.find(l=>l.route?.path==='/api/health');const handler=layer.route.stack[0].handle;
 const original=Object.getOwnPropertyDescriptor(mongoose.connection,'readyState');let state=0;
 Object.defineProperty(mongoose.connection,'readyState',{configurable:true,get:()=>state});t.after(()=>{if(original)Object.defineProperty(mongoose.connection,'readyState',original);else delete mongoose.connection.readyState;});
 let code,body;const res={status(v){code=v;return this;},json(v){body=v;}};
 handler({},res);assert.equal(code,503);assert.equal(body.database,'disconnected');state=1;handler({},res);assert.equal(code,200);assert.equal(body.database,'connected');
});

test('listen failure closes the attempted HTTP server and database safely',async()=>{
 const events=[],application=fakeApplication(events);
 application.listen=()=>{queueMicrotask(()=>application.server.emit('error',new Error('private listen details')));return application.server;};
 await assert.rejects(startServer({application,loadConfig:async()=>({port:5000}),connect:async()=>{},disconnect:async()=>events.push('db-close')}),e=>e.message==='Backend startup failed');
 assert.deepEqual(events,['http-close','db-close']);
});
test('shutdown deadline forces HTTP closure and still attempts database cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const events=[],application=fakeApplication(events);
 application.server.close=()=>events.push('http-close-requested');
 application.server.closeAllConnections=()=>events.push('http-forced');
 const running=await startServer({application,loadConfig:async()=>({port:5000}),connect:async()=>{},disconnect:async()=>events.push('db-close')});
 const stopped=assert.rejects(running.shutdown(),/Shutdown timed out/);
 t.mock.timers.tick(10000);await stopped;
 assert.deepEqual(events,['listen','http-close-requested','http-forced','db-close']);
});
