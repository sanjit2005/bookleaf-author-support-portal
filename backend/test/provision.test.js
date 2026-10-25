import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { User, Author, Book } from '../src/models/index.js';
import { prepareAccount, provisionAccount, parseSelection, safeProvisionError, ProvisionError } from '../src/provision/account.js';
import { runProvisionCommand } from '../src/provision/run.js';
import { promptLine } from '../src/provision/prompt.js';
import { normalizeEmail } from '../src/auth/email.js';
import { validPasswordInput, validNewPasswordInput, NEW_PASSWORD_MIN_LENGTH, BCRYPT_COST } from '../src/auth/password-policy.js';

const password='isolated-test-password';
function fixture(t) {
  const profile={_id:new mongoose.Types.ObjectId(),author_id:'AUTH999',name:'Fixture Author',email:'source@example.com',phone:'fixture-phone',city:'Fixture',joined_date:'2024-01-01',user:null,__v:0};
  const state={users:[],profile,missing:false,linked:false,duplicate:false,failLink:false,connected:0,disconnected:0,ended:0,commits:0,aborts:0,reads:0};
  let draft;
  const session={
    active:false,hasEnded:false,inTransaction(){return this.active;},
    async withTransaction(callback){
      this.active=true;draft={users:[],link:null};
      try {await callback();state.users.push(...draft.users);if(draft.link)state.profile.user=draft.link;state.commits++;}
      catch(error){state.aborts++;throw error;}
      finally{this.active=false;draft=undefined;}
    },
    async endSession(){this.hasEnded=true;state.ended++;},
  };
  t.mock.method(User,'findOne',filter=>({session:async s=>{
    assert.equal(s,session);state.reads++;assert.equal(filter.email,'login@example.com');
    return state.duplicate?{_id:new mongoose.Types.ObjectId()}:null;
  }}));
  t.mock.method(Author,'findOne',filter=>({session:async s=>{
    assert.equal(s,session);state.reads++;assert.deepEqual(filter,{author_id:'AUTH999'});
    if(state.missing)return null;
    return Author.hydrate({...state.profile,user:state.linked?new mongoose.Types.ObjectId():state.profile.user});
  }}));
  t.mock.method(User.prototype,'save',async function(options){
    assert.equal(options.session,session);assert.equal(session.active,true);await this.validate();
    const user=this.toObject();assert.equal(user.password,undefined);
    draft.users.push(user);return this;
  });
  t.mock.method(Author.prototype,'save',async function(options){
    assert.equal(options.session,session);assert.equal(session.active,true);await this.validate();
    assert.deepEqual(this.modifiedPaths(),['user']);
    for(const key of ['author_id','name','email','phone','city','joined_date'])assert.equal(this[key],profile[key]);
    if(state.failLink)throw new Error('PRIVATE_DATABASE_DETAIL');
    draft.link=this.user;return this;
  });
  t.mock.method(Book,'find',()=>{throw new Error('Books must not be accessed');});
  for(const model of [User,Author,Book])t.mock.method(model,'createIndexes',()=>{throw new Error('Indexes must not be created');});
  const deps={
    prompt:async label=>label==='Email: '?' LOGIN@Example.com ':password,
    loadConfig:async()=>({mongodbUri:'isolated-not-a-real-uri'}),
    connect:async()=>{state.connected++;return {startSession:async()=>session};},
    disconnect:async()=>{state.disconnected++;},
  };
  return {state,session,deps};
}

test('selection rejects absent/ambiguous commands and any password arguments',()=>{
  assert.deepEqual(parseSelection(['admin']),{role:'admin'});
  assert.deepEqual(parseSelection(['author','AUTH999']),{role:'author',authorId:'AUTH999'});
  for(const args of [[],['author'],['admin','AUTH999'],['author','bad'],['author','AUTH999','password'],['admin','--password=PRIVATE']])assert.throws(()=>parseSelection(args));
});
test('shared email/password rules and hashed preparation reject unsafe inputs',async()=>{
  assert.equal(normalizeEmail(' LOGIN@Example.com '),'login@example.com');
  for(const p of ['',null,'a'.repeat(73),'x\0y','😀'.repeat(19)])assert.equal(validPasswordInput(p),false);
  assert.equal(validPasswordInput('a'.repeat(72)),true);
  for(const input of [{password:''},{password:'a'.repeat(73)},{email:{$ne:null}},{email:'bad'}])await assert.rejects(prepareAccount({role:'admin',email:'login@example.com',password,...input}));
  const prepared=await prepareAccount({role:'admin',email:' LOGIN@Example.com ',password});
  assert.equal(prepared.password,undefined);assert.equal(prepared.email,'login@example.com');
  assert.equal(bcrypt.getRounds(prepared.passwordHash),BCRYPT_COST);
  assert.equal(await bcrypt.compare(password,prepared.passwordHash),true);
});
test('author account and link commit atomically and preserve source fields',async t=>{
  const {state,deps}=fixture(t);const original={...state.profile};
  await runProvisionCommand(['author','AUTH999'],deps);
  assert.equal(state.users.length,1);const user=state.users[0];
  assert.equal(user.role,'author');assert.equal(user.accountStatus,'active');assert.equal(user.tokenVersion,0);
  assert.equal(String(state.profile.user),String(user._id));assert.equal(state.commits,1);assert.equal(state.aborts,0);
  for(const key of ['author_id','name','email','phone','city','joined_date'])assert.equal(state.profile[key],original[key]);
  assert.equal(state.ended,1);assert.equal(state.disconnected,1);
});
test('admin account creates no Author link',async t=>{
  const {state,deps}=fixture(t);
  t.mock.method(Author,'findOne',()=>{throw new Error('Admin must not access Author');});
  await runProvisionCommand(['admin'],deps);
  assert.equal(state.users[0].role,'admin');assert.equal(state.profile.user,null);assert.equal(state.disconnected,1);
});
for(const [name,flag,code] of [['duplicate email','duplicate','DUPLICATE'],['missing author','missing','AUTHOR_MISSING'],['already-linked author','linked','AUTHOR_LINKED']]){
  test(name+' fails without changing existing users/links',async t=>{
    const {state,deps}=fixture(t);state[flag]=true;
    await assert.rejects(runProvisionCommand(['author','AUTH999'],deps),e=>e instanceof ProvisionError&&e.code===code);
    assert.equal(state.users.length,0);assert.equal(state.profile.user,null);assert.equal(state.aborts,1);assert.equal(state.ended,1);assert.equal(state.disconnected,1);
  });
}
test('link failure rolls back the staged User and always closes session/connection',async t=>{
  const {state,deps}=fixture(t);state.failLink=true;
  await assert.rejects(runProvisionCommand(['author','AUTH999'],deps));
  assert.equal(state.users.length,0);assert.equal(state.profile.user,null);assert.equal(state.commits,0);assert.equal(state.aborts,1);assert.equal(state.ended,1);assert.equal(state.disconnected,1);
});
test('invalid selection, email, password or confirmation never connects',async()=>{
  let connected=0,prompted=0;
  const deps={prompt:async()=>{prompted++;return 'x';},loadConfig:async()=>{throw new Error('Must not load config');},connect:async()=>{connected++;}};
  await assert.rejects(runProvisionCommand([],deps));assert.equal(prompted,0);
  await assert.rejects(runProvisionCommand(['admin'],deps));
  await assert.rejects(runProvisionCommand(['admin'],{...deps,prompt:async label=>label==='Email: '?'login@example.com':''}));
  let count=0;await assert.rejects(runProvisionCommand(['admin'],{...deps,prompt:async()=>['login@example.com',password,'different'][count++]}));
  assert.equal(connected,0);
});
test('provision core refuses missing/inactive transaction before reads or writes',async t=>{
  const {state}=fixture(t);
  for(const session of [null,{}, {inTransaction:()=>false},{inTransaction:()=>true,hasEnded:true}])await assert.rejects(provisionAccount({},session));
  assert.equal(state.reads,0);assert.equal(state.users.length,0);
});
test('connection/start-session failures and interruption close resources',async t=>{
  const {state,deps}=fixture(t);
  await assert.rejects(runProvisionCommand(['admin'],{...deps,connect:async()=>{throw new Error('PRIVATE');}}));
  assert.equal(state.disconnected,1);
  await assert.rejects(runProvisionCommand(['admin'],{...deps,connect:async()=>({startSession:async()=>{throw new Error('PRIVATE');}})}));
  assert.equal(state.disconnected,2);
  const controller=new AbortController();
  t.mock.method(User.prototype,'save',async()=>controller.abort());
  await assert.rejects(runProvisionCommand(['author','AUTH999'],{...deps,signal:controller.signal}),e=>e.code==='INTERRUPTED');
  assert.equal(state.aborts,1);assert.equal(state.users.length,0);assert.equal(state.profile.user,null);
  assert.equal(state.ended,1);assert.equal(state.disconnected,3);
});
function terminal() {
  const input=new PassThrough(),output=new PassThrough();
  input.isTTY=output.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};
  let displayed='';output.on('data',chunk=>{displayed+=chunk;});
  return {input,output,displayed:()=>displayed};
}
test('hidden prompts never echo password or paste contents and restore terminal',async()=>{
  const io=terminal();const result=promptLine('Password: ',{...io,secret:true});
  io.input.write(password+'\r');assert.equal(await result,password);
  assert.equal(io.displayed(),'Password: \n');assert.equal(io.input.isRaw,false);
  assert.equal(io.input.listenerCount('keypress'),0);
  const cancelled=promptLine('Password: ',{...io,secret:true});
  io.input.write('PRIVATE');io.input.write('\x03');
  await assert.rejects(cancelled,e=>e.code==='INTERRUPTED');assert.equal(io.input.isRaw,false);assert.equal(io.displayed().includes('PRIVATE'),false);
});
test('noninteractive and externally interrupted prompts fail without echoing',async()=>{
  await assert.rejects(promptLine('Password: ',{input:{isTTY:false},output:{isTTY:false}}),e=>e.code==='TERMINAL');
  const io=terminal(),controller=new AbortController();
  const pending=promptLine('Password: ',{...io,secret:true,signal:controller.signal});controller.abort();
  await assert.rejects(pending,e=>e.code==='INTERRUPTED');assert.equal(io.input.isRaw,false);
});
test('safe errors never return database details, hashes, emails or arguments',()=>{
  const privateText='PRIVATE passwordHash mongodb://credentials private@example.com';
  for(const error of [new Error(privateText),Object.assign(new Error(privateText),{code:11000}),new ProvisionError('DUPLICATE'),new ProvisionError('AUTHOR_LINKED'),new ProvisionError('INTERRUPTED')]){
    const output=safeProvisionError(error);assert.equal(output.includes(privateText),false);assert.equal(output.includes('private@example.com'),false);assert.equal(output.includes('mongodb://'),false);
  }
});

test('creation requires 12 code points while retaining the exact 72-byte limit',async()=>{
  assert.equal(NEW_PASSWORD_MIN_LENGTH,12);
  for(const role of ['admin','author']){
    for(const submitted of ['x','x'.repeat(11),'x'.repeat(73),'😀'.repeat(19),'valid-prefix\0tail','valid-prefix\ttail','valid-prefix\u0085tail','valid-prefix\ud800tail']){
      assert.equal(validNewPasswordInput(submitted),false);
      await assert.rejects(prepareAccount({role,...(role==='author'?{authorId:'AUTH999'}:{}),email:'fixture@example.com',password:submitted}),error=>{
        assert.equal(error.code,'PASSWORD');
        assert.equal(safeProvisionError(error).includes(submitted),false);
        return true;
      });
    }
  }
  for(const submitted of ['x'.repeat(12),'x'.repeat(72),'é'.repeat(12),'😀'.repeat(18),'  keep-spaces  ','Cafe\u0301-EXACT-value']){
    assert.equal(validNewPasswordInput(submitted),true);
  }
  const submitted='  keep-spaces  ';
  const account=await prepareAccount({role:'admin',email:'fixture@example.com',password:submitted});
  assert.equal(await bcrypt.compare(submitted,account.passwordHash),true);
  assert.equal(await bcrypt.compare(submitted.trim(),account.passwordHash),false);
  const boundary=await prepareAccount({role:'admin',email:'fixture@example.com',password:'x'.repeat(12)});
  assert.equal(await bcrypt.compare('x'.repeat(12),boundary.passwordHash),true);
  assert.equal(validPasswordInput('x'),true);
});

test('confirmation compares exact strings without trimming or Unicode normalization',async()=>{
  for(const pair of [['  keep-spaces  ','keep-spaces'],['Cafe\u0301-EXACT-value','Caf\u00e9-EXACT-value']]){
    let index=0,connected=false;
    await assert.rejects(runProvisionCommand(['admin'],{
      prompt:async()=>['fixture@example.com',...pair][index++],
      connect:async()=>{connected=true;throw new Error('Must not connect');},
      loadConfig:async()=>{throw new Error('Must not load config');},
    }),error=>error.code==='CONFIRM');
    assert.equal(connected,false);
  }
});

test('hidden prompt rejects controls, nulls and unsupported keys rather than dropping them',async()=>{
  for(const forbidden of ['\0','\x01','\t','\x0b','\x1b','\u0085','\u009f','\x1b[A']){
    const io=terminal();
    const pending=promptLine('Password: ',{...io,secret:true});
    io.input.write('PRIVATE-prefix'+forbidden);
    await assert.rejects(pending,error=>{
      assert.equal(error.code,'PASSWORD_INPUT');
      const message=safeProvisionError(error);
      assert.match(message,/Retry/);assert.equal(message.includes('PRIVATE-prefix'),false);
      return true;
    });
    assert.equal(io.displayed(),'Password: \n');
    assert.equal(io.input.isRaw,false);assert.equal(io.input.listenerCount('keypress'),0);
  }
});

test('hidden prompts preserve permitted Unicode and whitespace exactly',async()=>{
  const io=terminal(),submitted='  Café-😀-exact  ';
  const pending=promptLine('Password: ',{...io,secret:true});
  io.input.write(submitted+'\r');
  assert.equal(await pending,submitted);
  assert.equal(io.displayed(),'Password: \n');
});
