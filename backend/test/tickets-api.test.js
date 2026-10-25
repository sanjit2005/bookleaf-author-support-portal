import { geminiResponse } from './helpers/gemini.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { User, Author, Book, Ticket, TicketMessage, InternalNote, categories } from '../src/models/index.js';
import { createJwtService } from '../src/auth/jwt.js';
import { adminInternalNoteDTO, authorTicketDTO, publicMessageDTO } from '../src/db/serialization.js';
import { ticketTransaction } from '../src/tickets/service.js';
import { transitions } from '../src/tickets/validation.js';
import { createAIService } from '../src/ai/service.js';

const id=()=>new mongoose.Types.ObjectId();
const same=(a,b)=>a===null?b===null:String(a)===String(b);
function matches(record,filter) {
  return Object.entries(filter).every(([key,value])=>{
    if(key==='$or')return value.some(branch=>matches(record,branch));
    if(value&&typeof value==='object'&&('$gte' in value||'$lt' in value)) {
      return (!('$gte' in value)||record[key]>=value.$gte)&&(!('$lt' in value)||record[key]<value.$lt);
    }
    return same(value,record[key]);
  });
}
function compare(sort) {
  return (a,b)=>{
    for(const [key,direction] of Object.entries(sort)) if(String(a[key])!==String(b[key]))return (a[key]<b[key]?-1:1)*direction;
    return 0;
  };
}
// Small isolated interpreter for the MongoDB expressions used by the queue.
// Expected ticket orders below are explicit fixtures, independent of this evaluator.
function expression(value,record) {
  if(typeof value==='string'&&value.startsWith('$'))return record[value.slice(1)];
  if(Array.isArray(value))return value.map(item=>expression(item,record));
  if(!value||typeof value!=='object')return value;
  const [operator,args]=Object.entries(value)[0];
  if(operator==='$in'){const [item,array]=expression(args,record);return array.includes(item);}
  if(operator==='$eq'){const [a,b]=expression(args,record);return same(a,b);}
  if(operator==='$cond'){const [condition,yes,no]=args;return expression(expression(condition,record)?yes:no,record);}
  if(operator==='$switch'){const branch=args.branches.find(item=>expression(item.case,record));return expression(branch?branch.then:args.default,record);}
  assert.fail('Unsupported aggregation expression '+operator);
}
function fixture(t) {
  const author1=id(),author2=id(),user1=id(),user2=id(),admin=id(),disabled=id(),unlinked=id();
  const users=[user1,user2,admin,disabled,unlinked].map(_id=>({_id,email:'fixture@example.com',role:[admin,disabled].includes(_id)?'admin':'author',accountStatus:_id===disabled?'disabled':'active',tokenVersion:0}));
  const authors=[{_id:author1,user:user1,author_id:'AUTH901',name:'Fixture author'},{_id:author2,user:user2,author_id:'AUTH902',name:'Other fixture'}];
  const books=[{_id:id(),book_id:'BK901',author:author1,title:'Fixture',isbn:'PLACEHOLDER',status:'Published & Live'},{_id:id(),book_id:'BK902',author:author2,title:'Other',isbn:'PLACEHOLDER',status:'Published & Live'}];
  const baseline=new Ticket({_id:id(),author:author2,subject:'Other author ticket',description:'Private to other author',createdAt:new Date('2024-01-01'),updatedAt:new Date('2024-01-01'),__v:0}).toObject();
  const state={store:{Ticket:new Map([[String(baseline._id),baseline]]),TicketMessage:new Map(),InternalNote:new Map()},commits:0,aborts:0,ended:0,queries:[],writes:0,failTicketSave:false,conflict:false,dbError:false,inactive:false,retry:false};
  const sources={User:users,Author:authors,Book:books};
  function populatedTicket(record) {
    return {...record,passwordHash:'PRIVATE',internalNotes:['PRIVATE'],credentials:{secret:'PRIVATE'},
      author:{...authors.find(a=>same(a._id,record.author)),email:'PRIVATE',user:{passwordHash:'PRIVATE'},internalNotes:['PRIVATE']},
      book:record.book?{...books.find(b=>same(b._id,record.book)),passwordHash:'PRIVATE',internalNotes:['PRIVATE']}:null,
      assignee:record.assignee?{_id:record.assignee,role:'admin',email:'PRIVATE',passwordHash:'PRIVATE'}:null};
  }
  t.mock.method(Ticket,'aggregate',async(pipeline,options)=>{
    assert.deepEqual(options,{allowDiskUse:true});
    state.queries.push({name:'Ticket',filter:pipeline[0].$match,pipeline});
    if(state.dbError)throw new Error('PRIVATE_DATABASE_DETAIL');
    let records=[...state.store.Ticket.values()];
    for(const stage of pipeline) {
      if(stage.$match)records=records.filter(record=>matches(record,stage.$match));
      else if(stage.$set)records=records.map(record=>({...record,...Object.fromEntries(Object.entries(stage.$set).map(([key,value])=>[key,expression(value,record)]))}));
      else if(stage.$sort)records.sort(compare(stage.$sort));
      else if('$skip' in stage)records=records.slice(stage.$skip);
      else if(stage.$limit)records=records.slice(0,stage.$limit);
      else if(stage.$project)records=records.map(record=>Object.fromEntries(Object.keys(stage.$project).filter(key=>Object.hasOwn(record,key)).map(key=>[key,record[key]])));
      else assert.fail('Unsupported aggregation stage');
    }
    return records;
  });
  t.mock.method(Ticket,'populate',async(records,paths)=>{
    assert.deepEqual(paths,[{path:'author',select:'author_id name'},{path:'book',select:'book_id title isbn status'},{path:'assignee',select:'role'}]);
    return records.map(populatedTicket);
  });
  const sessionFactory=()=>({
    active:false,hasEnded:false,stage:null,inTransaction(){return this.active;},
    async withTransaction(callback){
      const attempt=async()=>{
        this.stage=Object.fromEntries(Object.entries(state.store).map(([key,map])=>[key,new Map(map)]));this.active=!state.inactive;
        return callback();
      };
      try {
        let result=await attempt();
        if(state.retry){state.retry=false;if(state.concurrentChange){state.concurrentChange();state.concurrentChange=null;}result=await attempt();}
        state.store=this.stage;state.commits++;return result;
      } catch(error){state.aborts++;throw error;} finally {this.active=false;this.stage=null;}
    },
    async endSession(){this.hasEnded=true;state.ended++;},
  });
  t.mock.method(mongoose,'startSession',async()=>sessionFactory());
  function query(Model,filter,single=false) {
    let session=null,offset=0,limit=Infinity,populate=false,sort={};
    const name=Model.modelName;state.queries.push({name,filter});
    async function execute(lean=false) {
      if(state.dbError)throw new Error('PRIVATE_DATABASE_DETAIL');
      if(session)assert.equal(session.inTransaction(),true);
      const values=sources[name]??[...(session?session.stage:state.store)[name].values()];
      const selected=values.filter(record=>matches(record,filter));
      selected.sort(compare(sort));
      const found=selected.slice(offset,offset+limit).map(record=>{
        if(sources[name])return {...record};
        const document=Model.hydrate(record);
        if(name==='Ticket'&&lean) {
          const result={...document.toObject(),passwordHash:'PRIVATE',internalNotes:['PRIVATE'],credentials:{secret:'PRIVATE'}};
          return populate?populatedTicket(result):result;
        }
        if(populate&&name!=='Ticket'){
          const raw=document.toObject.bind(document),senderKey=name==='TicketMessage'?'sender':'createdBy';
          document.toObject=()=>({...raw(),[senderKey]:{_id:record[senderKey],role:users.find(u=>same(u._id,record[senderKey]))?.role,passwordHash:'PRIVATE',email:'PRIVATE',internalNotes:['PRIVATE']},ticket:{_id:record.ticket,passwordHash:'PRIVATE'},internalNotes:['PRIVATE']});
        }
        return lean?document.toObject():document;
      });
      return single?(found[0]??null):found;
    }
    return {
      select(){return this;},populate(){populate=true;return this;},session(value){session=value;return this;},
      sort(value){sort=value;return this;},skip(value){offset=value;return this;},limit(value){limit=value;return this;},
      lean(){return execute(true);},then(resolve,reject){return execute().then(resolve,reject);},
    };
  }
  for(const Model of [Author,Book,User,Ticket,TicketMessage,InternalNote]){
    t.mock.method(Model,'findOne',filter=>query(Model,filter,true));
    if(!sources[Model.modelName]){
      t.mock.method(Model,'find',filter=>query(Model,filter));
      t.mock.method(Model,'countDocuments',async filter=>{
        state.queries.push({name:Model.modelName,filter});
        if(state.dbError)throw new Error('PRIVATE_DATABASE_DETAIL');
        return [...state.store[Model.modelName].values()].filter(record=>matches(record,filter)).length;
      });
      t.mock.method(Model.prototype,'save',async function({session}){
        assert.equal(session.inTransaction(),true);await this.validate();
        if(Model===Ticket&&state.failTicketSave)throw new Error('PRIVATE_SAVE_FAILURE');
        if(Model===Ticket&&state.conflict)throw new mongoose.Error.VersionError(this,0,['status']);
        const old=session.stage[Model.modelName].get(String(this._id));
        if(old)assert.equal(this.__v,old.__v);
        this.__v=old?old.__v+1:0;this.createdAt??=new Date();this.updatedAt=new Date();this.isNew=false;
        session.stage[Model.modelName].set(String(this._id),this.toObject());state.writes++;return this;
      });
    }else t.mock.method(Model.prototype,'save',()=>assert.fail('Source profiles, books and accounts must remain unchanged'));
    t.mock.method(Model,'createIndexes',()=>assert.fail('No real indexes'));
  }
  t.mock.method(User,'findById',value=>({select:async()=>users.find(user=>same(user._id,value))??null}));
  return {state,author1,author2,user1,user2,admin,disabled,unlinked,users,books,baseline};
}

test('ticket HTTP APIs isolate authors, validate writes and separate private notes using mocked transactions',async t=>{
  const f=fixture(t),{state,user1,user2,admin,disabled,unlinked,author1,author2,baseline}=f;
  const service=createJwtService({jwtSecret:randomBytes(32)});app.locals.jwtService=service;
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{delete app.locals.jwtService;return new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const request=async(path,{user=user1,body,method=body?'POST':'GET',revision}={})=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{...(method==='PATCH'&&revision!==null?{'If-Match':JSON.stringify(String(revision??state.store.Ticket.get(path.split('/').at(-1))?.__v??0))}:{}),...(user?{Authorization:'Bearer '+service.sign({userId:user,tokenVersion:0})}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const own='/api/me/tickets',queue='/api/admin/tickets';let ticketId;
  const originalSources=JSON.stringify({books:f.books,users:f.users});
  const queueRow=(number,patch={})=>new Ticket({_id:new mongoose.Types.ObjectId(number.toString(16).padStart(24,'0')),author:author1,subject:'Queue fixture '+number,description:'Isolated queue fixture',createdAt:new Date('2024-02-29T12:00:00Z'),updatedAt:new Date('2025-01-01T00:00:00Z'),...patch}).toObject();
  async function withQueue(records,run) {
    const previous=state.store.Ticket;
    state.store.Ticket=new Map(records.map(record=>[String(record._id),record]));
    const original=JSON.stringify([...state.store.Ticket]),writes=state.writes;
    try {await run();assert.equal(JSON.stringify([...state.store.Ticket]),original);assert.equal(state.writes,writes);}
    finally {state.store.Ticket=previous;}
  }

  await t.test('author creates book-specific and general tickets with server-owned defaults',async()=>{
    const result=await request(own,{body:{subject:'Royalty question',description:'Please clarify',book_id:'BK901',category:categories[0]}});
    assert.equal(result.status,201);assert.equal(result.headers.get('cache-control'),'no-store');ticketId=result.body.ticket._id;
    assert.equal(result.body.ticket.author,String(author1));assert.equal(result.body.ticket.book,String(f.books[0]._id));
    assert.equal(result.body.ticket.priority,'Medium');assert.equal(result.body.ticket.status,'Open');
    assert.equal(result.body.ticket.aiClassification,undefined);assert.equal(result.body.ticket.internalNotes,undefined);
    const saved=state.store.Ticket.get(ticketId);assert.equal(saved.categorySource,'manual');assert.equal(saved.prioritySource,'fallback');assert.equal(saved.aiClassification.state,'failed');assert.equal(saved.aiClassification.errorCode,'UNAVAILABLE');
    assert.ok(state.queries.some(q=>q.name==='Book'&&q.filter.book_id==='BK901'&&same(q.filter.author,author1)));
    const general=await request(own,{body:{subject:'General',description:'Question'}});assert.equal(general.status,201);
    assert.equal(general.body.ticket.book,null);assert.equal(general.body.ticket.category,null);
    assert.equal(state.store.Ticket.get(general.body.ticket._id).categorySource,'pending');
  });
  await t.test('foreign and missing book references both fail with 404 and no inserts',async()=>{
    const count=state.store.Ticket.size;
    const foreign=await request(own,{body:{subject:'Help',description:'Question',book_id:'BK902'}});
    const missing=await request(own,{body:{subject:'Help',description:'Question',book_id:'BK999'}});
    assert.equal(foreign.status,404);assert.equal(missing.status,404);assert.deepEqual(foreign.body,missing.body);assert.equal(state.store.Ticket.size,count);
  });
  await t.test('author list and counts are scoped in the database, with validated status filtering',async()=>{
    const before=state.queries.length,result=await request(own+'?status=Open&limit=1&page=1');
    assert.equal(result.status,200);assert.equal(result.body.tickets.length,1);assert.deepEqual(result.body.pagination,{page:1,limit:1,total:2,totalPages:2});
    for(const q of state.queries.slice(before).filter(q=>q.name==='Ticket'))assert.deepEqual(q.filter,{status:'Open',author:author1});
    const other=await request(own,{user:user2});assert.equal(other.body.tickets.length,1);assert.equal(other.body.tickets[0]._id,String(baseline._id));
    assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);
  });
  await t.test('owned retrieval uses the scoped ID; foreign and absent tickets share 404 and never query conversations',async()=>{
    const ownResult=await request(own+'/'+ticketId);assert.equal(ownResult.status,200);
    assert.deepEqual(Object.keys(ownResult.body).sort(),['messages','pagination','ticket']);assert.deepEqual(ownResult.body.messages,[]);
    const before=state.queries.length;
    const foreign=await request(own+'/'+baseline._id),missing=await request(own+'/'+id());
    assert.equal(foreign.status,404);assert.equal(missing.status,404);assert.deepEqual(foreign.body,missing.body);
    for(const q of state.queries.slice(before).filter(q=>q.name!=='Author')){assert.equal(q.name,'Ticket');assert.ok(same(q.filter.author,author1));assert.ok(q.filter._id);}
  });
  await t.test('author reply is public, sender is derived, and ticket activity changes atomically',async()=>{
    const before=state.commits,result=await request(own+'/'+ticketId+'/messages',{body:{body:'Author reply'}});
    assert.equal(result.status,201);assert.equal(result.body.message.sender,String(user1));assert.equal(state.commits,before+1);
    const detail=await request(own+'/'+ticketId);assert.equal(detail.body.messages.length,1);assert.equal(detail.body.messages[0].body,'Author reply');
    assert.deepEqual(Object.keys(detail.body.messages[0].sender).sort(),['_id','role']);assert.equal(JSON.stringify(detail.body).includes('PRIVATE'),false);
    assert.equal(state.store.Ticket.get(ticketId).lastActivityAt instanceof Date,true);
  });
  await t.test('foreign reply is denied without any writes',async()=>{
    const count=state.writes,result=await request(own+'/'+baseline._id+'/messages',{body:{body:'Forged'}});
    assert.equal(result.status,404);assert.equal(state.writes,count);
  });
  await t.test('admin sets active assignee and manual priority/category with provenance',async()=>{
    const result=await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'In Progress',priority:'High',category:categories[1],assignee:String(admin)}});
    assert.equal(result.status,200);assert.equal(result.body.ticket.status,'In Progress');assert.equal(result.body.ticket.assignee,String(admin));
    const saved=state.store.Ticket.get(ticketId);assert.equal(saved.prioritySource,'manual');assert.equal(saved.categorySource,'manual');
    assert.ok(same(saved.priorityOverriddenBy,admin));assert.ok(saved.priorityOverriddenAt instanceof Date);assert.equal(saved.aiClassification.state,'failed');
    for(const assignee of [String(user1),String(disabled),String(id())])assert.equal((await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{assignee}})).status,400);
    assert.equal(state.store.Ticket.get(ticketId).assignee.toString(),String(admin));
  });
  await t.test('admin queue filters all declared values and returns safe summaries across authors',async()=>{
    const result=await request(queue,{user:admin});assert.equal(result.status,200);assert.equal(result.body.pagination.total,3);
    const query='?status=In%20Progress&priority=High&category='+encodeURIComponent(categories[1])+'&assignee='+admin;
    const filtered=await request(queue+query,{user:admin});assert.equal(filtered.status,200);assert.equal(filtered.body.tickets.length,1);assert.equal(filtered.body.tickets[0]._id,ticketId);
    const pending=await request(queue+'?category=unclassified&assignee=unassigned',{user:admin});assert.equal(pending.status,200);assert.equal(pending.body.pagination.total,2);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);
  });
  await t.test('UTC creation-date boundaries include the whole end day, leap day, and consistent pages',async()=>{
    const times=['2024-02-28T23:59:59.999Z','2024-02-29T00:00:00.000Z','2024-02-29T18:30:00.000Z','2024-02-29T23:59:59.999Z','2024-03-01T00:00:00.000Z','2024-03-01T23:59:59.999Z','2024-03-02T00:00:00.000Z'];
    await withQueue(times.map((time,index)=>queueRow(index+1,{createdAt:new Date(time)})),async()=>{
      const query=queue+'?startDate=2024-02-29&endDate=2024-02-29&sort=oldest&limit=2';
      const first=await request(query,{user:admin}),second=await request(query+'&page=2',{user:admin});
      assert.equal(first.status,200);assert.deepEqual(first.body.pagination,{page:1,limit:2,total:3,totalPages:2});
      assert.deepEqual(first.body.tickets.map(ticket=>ticket.subject),['Queue fixture 2','Queue fixture 3']);
      assert.deepEqual(second.body.tickets.map(ticket=>ticket.subject),['Queue fixture 4']);assert.equal(second.body.pagination.total,3);
      assert.deepEqual((await request(query+'&page=3',{user:admin})).body.tickets,[]);
      const twoDays=await request(queue+'?startDate=2024-02-29&endDate=2024-03-01',{user:admin});assert.equal(twoDays.body.pagination.total,5);
      const unassigned=await request(queue+'?startDate=2024-02-29&endDate=2024-02-29&category=unclassified&assignee=unassigned',{user:admin});assert.equal(unassigned.body.pagination.total,3);
      assert.equal((await request(queue+'?startDate=2024-03-01',{user:admin})).body.pagination.total,3);
      assert.equal((await request(queue+'?endDate=2024-02-29',{user:admin})).body.pagination.total,4);
      const match=state.queries.findLast(query=>query.pipeline).filter;
      assert.equal(match.createdAt.$lt.toISOString(),'2024-03-01T00:00:00.000Z');
      assert.equal(JSON.stringify(first.body).includes('PRIVATE'),false);
      for(const ticket of first.body.tickets){assert.equal(ticket.queueStatusRank,undefined);assert.equal(ticket.queuePriorityRank,undefined);}
    });
  });
  await t.test('dates combine with every existing admin filter and cast assignee IDs for aggregation',async()=>{
    const matching={status:'In Progress',priority:'High',category:categories[1],assignee:admin};
    await withQueue([
      queueRow(1,matching),queueRow(2,{...matching,createdAt:new Date('2024-02-29T23:59:59.999Z')}),
      queueRow(3,{...matching,status:'Closed'}),queueRow(4,{...matching,priority:'Low'}),
      queueRow(5,{...matching,category:categories[0]}),queueRow(6,{...matching,assignee:null}),
      queueRow(7,{...matching,createdAt:new Date('2024-03-01T00:00:00.000Z')}),
    ],async()=>{
      const query=queue+'?startDate=2024-02-29&endDate=2024-02-29&status=In%20Progress&priority=High&category='+encodeURIComponent(categories[1])+'&assignee='+admin+'&limit=1';
      const first=await request(query,{user:admin}),second=await request(query+'&page=2',{user:admin});
      assert.equal(first.status,200);assert.equal(first.body.pagination.total,2);assert.equal(first.body.pagination.totalPages,2);
      assert.equal(first.body.tickets[0].subject,'Queue fixture 1');assert.equal(second.body.tickets[0].subject,'Queue fixture 2');
      const pipeline=state.queries.findLast(query=>query.pipeline).pipeline,filter=pipeline[0].$match;
      assert.ok(filter.assignee instanceof mongoose.Types.ObjectId);
      assert.equal(filter.createdAt.$gte.toISOString(),'2024-02-29T00:00:00.000Z');
      assert.deepEqual(Object.keys(pipeline).map(key=>Object.keys(pipeline[key])[0]),['$match','$set','$sort','$skip','$limit','$project']);
      assert.equal(pipeline[3].$skip,1);assert.equal(pipeline[4].$limit,1);
      assert.equal(JSON.stringify(first.body).includes('PRIVATE'),false);
    });
  });
  await t.test('invalid dates, reversed ranges, duplicate inputs and unsupported sort fail before ticket queries',async()=>{
    for(const suffix of ['?startDate=','?endDate=2024-02-30','?startDate=2023-02-29','?startDate=2024-2-01','?endDate=2024-13-01','?startDate=2024-01-01T00:00:00Z','?startDate=10000-01-01','?startDate=2024-03-01&endDate=2024-02-29','?startDate=2024-01-01&startDate=2024-01-02','?endDate=2024-01-01&endDate=2024-01-02','?sort=urgent','?sort=','?sort=newest&sort=oldest']) {
      const before=state.queries.length,result=await request(queue+suffix,{user:admin});
      assert.equal(result.status,400,suffix);assert.deepEqual(result.body,{error:'Invalid ticket request'});
      assert.equal(state.queries.length,before);
    }
    for(const suffix of ['?startDate=2024-01-01','?endDate=2024-02-01','?sort=urgency','?sort=newest'])assert.equal((await request(own+suffix)).status,400);
    assert.equal((await request(queue+'?startDate=9999-12-31&endDate=9999-12-31',{user:admin})).status,200);
  });
  await t.test('global urgency finds buried critical tickets, respects priority before age, and breaks ties across pages',async()=>{
    const records=[
      queueRow(1,{priority:'Critical',createdAt:new Date('2020-01-01')}),
      queueRow(3,{priority:'High',createdAt:new Date('2019-01-01')}),
      queueRow(2,{priority:'Critical',status:'In Progress',createdAt:new Date('2020-01-01')}),
      queueRow(4,{priority:'High',status:'In Progress',createdAt:new Date('2021-01-01')}),
      queueRow(5,{priority:'Medium',createdAt:new Date('2018-01-01')}),
      queueRow(6,{priority:'Low',createdAt:new Date('2010-01-01')}),
      queueRow(7,{priority:'Critical',status:'Resolved',createdAt:new Date('2000-01-01')}),
      queueRow(8,{priority:'Critical',status:'Closed',createdAt:new Date('2001-01-01')}),
      ...Array.from({length:12},(_,index)=>queueRow(index+9,{priority:'Low',createdAt:new Date('2026-01-01')})),
    ];
    await withQueue([...records].reverse(),async()=>{
      const expected=[1,2,3,4,5,6,...Array.from({length:12},(_,index)=>index+9),7,8].map(number=>'Queue fixture '+number);
      const found=[];
      for(let page=1;page<=10;page++) {
        const result=await request(queue+'?limit=2&page='+page,{user:admin});assert.equal(result.status,200);
        assert.deepEqual(result.body.pagination,{page,limit:2,total:20,totalPages:10});found.push(...result.body.tickets.map(ticket=>ticket.subject));
      }
      assert.deepEqual(found,expected);assert.equal(new Set(found).size,20);
      const repeat=await request(queue+'?sort=urgency&limit=2',{user:admin});assert.deepEqual(repeat.body.tickets.map(ticket=>ticket.subject),expected.slice(0,2));
      const newest=await request(queue+'?sort=newest&limit=10',{user:admin});assert.ok(newest.body.tickets.every(ticket=>ticket.priority==='Low'));
      const oldest=await request(queue+'?sort=oldest&limit=2',{user:admin});assert.deepEqual(oldest.body.tickets.map(ticket=>ticket.subject),['Queue fixture 7','Queue fixture 8']);
      const high=await request(queue+'?priority=High&limit=1&page=2',{user:admin});assert.equal(high.body.tickets[0].subject,'Queue fixture 4');assert.equal(high.body.pagination.total,2);
      // Author order remains newest first, without aggregate ranks or admin filters.
      const author=await request(own+'?limit=2');assert.deepEqual(author.body.tickets.map(ticket=>ticket.subject),['Queue fixture 20','Queue fixture 19']);
    });
  });
  await t.test('admin public replies appear for authors, private notes are queried only by admins',async()=>{
    const message=await request(queue+'/'+ticketId+'/messages',{user:admin,body:{body:'Public admin reply'}});assert.equal(message.status,201);
    const note=await request(queue+'/'+ticketId+'/notes',{user:admin,body:{body:'PRIVATE_INTERNAL_NOTE'}});assert.equal(note.status,201);
    assert.equal(note.body.note.createdBy,String(admin));assert.equal(note.body.message,undefined);
    const before=state.queries.filter(q=>q.name==='InternalNote').length;
    const publicResult=await request(own+'/'+ticketId);assert.equal(publicResult.status,200);assert.equal(publicResult.body.messages.length,2);
    assert.equal(JSON.stringify(publicResult.body).includes('PRIVATE'),false);assert.equal(publicResult.body.notes,undefined);
    assert.equal(state.queries.filter(q=>q.name==='InternalNote').length,before);
    const adminResult=await request(queue+'/'+ticketId,{user:admin});assert.equal(adminResult.status,200);assert.equal(adminResult.body.notes.length,1);
    assert.equal(adminResult.body.notes[0].body,'PRIVATE_INTERNAL_NOTE');assert.deepEqual(Object.keys(adminResult.body.notes[0].createdBy).sort(),['_id','role']);
    assert.equal(adminResult.body.notes[0].passwordHash,undefined);assert.equal(adminResult.body.notes[0].internalNotes,undefined);
    const paged=await request(own+'/'+ticketId+'?page=2&limit=1');assert.equal(paged.body.messages.length,1);assert.deepEqual(paged.body.pagination,{page:2,limit:1,total:2,totalPages:2});
  });
  await t.test('summary reads exclude conversation queries and legacy notes have independent pagination',async()=>{
    const before=state.queries.length,summary=await request(queue+'/'+ticketId+'?view=summary',{user:admin});
    assert.equal(summary.status,200);assert.deepEqual(Object.keys(summary.body),['ticket']);
    assert.ok(state.queries.slice(before).every(query=>!['TicketMessage','InternalNote'].includes(query.name)));
    const detail=await request(queue+'/'+ticketId+'?page=2&limit=1&notesPage=1&notesLimit=2',{user:admin});
    assert.equal(detail.status,200);assert.equal(detail.body.pagination.page,2);assert.equal(detail.body.messages.length,1);
    assert.equal(detail.body.notesPagination.page,1);assert.equal(detail.body.notesPagination.limit,2);assert.equal(detail.body.notes.length,1);
    for(const suffix of ['?notesPage=1','?notesLimit=2'])assert.equal((await request(own+'/'+ticketId+suffix)).status,400);
    for(const suffix of ['?notesPage=0','?notesLimit=51','?notesPage=1&notesPage=2','?view=invalid','?view=summary&page=1'])assert.equal((await request(queue+'/'+ticketId+suffix,{user:admin})).status,400);
  });
  await t.test('cursor history starts with latest replies and stays stable when new replies arrive between older reads',async()=>{
    const oldMessages=state.store.TicketMessage,oldNotes=state.store.InternalNote;
    const history=Array.from({length:31},(_,index)=>new TicketMessage({_id:new mongoose.Types.ObjectId((1000+index).toString(16).padStart(24,'0')),ticket:ticketId,sender:admin,body:'Public history '+(index+1),createdAt:new Date(Date.UTC(2024,0,1,0,0,Math.floor(index/3)))}).toObject());
    state.store.TicketMessage=new Map(history.map(entry=>[String(entry._id),entry]));
    state.store.InternalNote=new Map([[String(id()),new InternalNote({ticket:ticketId,createdBy:admin,body:'PRIVATE_HISTORY_NOTE'}).toObject()]]);
    try {
      const endpoint=own+'/'+ticketId+'/messages',before=state.queries.length;
      const latest=await request(endpoint);assert.equal(latest.status,200);
      assert.deepEqual(latest.body.messages.map(entry=>entry.body),Array.from({length:10},(_,index)=>'Public history '+(31-index)));
      assert.deepEqual(Object.keys(latest.body).sort(),['messages','pagination']);assert.equal(latest.body.pagination.hasMore,true);
      assert.equal(JSON.stringify(latest.body).includes('PRIVATE'),false);assert.ok(state.queries.slice(before).every(query=>query.name!=='InternalNote'));
      const second=await request(endpoint+'?before='+latest.body.pagination.nextCursor);
      assert.deepEqual(second.body.messages.map(entry=>entry.body),Array.from({length:10},(_,index)=>'Public history '+(21-index)));
      const sent=await request(queue+'/'+ticketId+'/messages',{user:admin,body:{body:'New while reading history'}});assert.equal(sent.status,201);
      const third=await request(endpoint+'?before='+second.body.pagination.nextCursor);
      assert.deepEqual(third.body.messages.map(entry=>entry.body),Array.from({length:10},(_,index)=>'Public history '+(11-index)));
      const last=await request(endpoint+'?before='+third.body.pagination.nextCursor);
      assert.deepEqual(last.body.messages.map(entry=>entry.body),['Public history 1']);assert.deepEqual(last.body.pagination,{limit:10,hasMore:false,nextCursor:null});
      const all=[latest,second,third,last].flatMap(page=>page.body.messages.map(entry=>entry._id));assert.equal(all.length,31);assert.equal(new Set(all).size,31);
      assert.equal((await request(endpoint)).body.messages[0]._id,sent.body.message._id);
      const adminHistory=await request(queue+'/'+ticketId+'/messages',{user:admin});assert.equal(JSON.stringify(adminHistory.body).includes('PRIVATE'),false);
      const notes=await request(queue+'/'+ticketId+'/notes',{user:admin});assert.equal(notes.status,200);assert.equal(notes.body.notes[0].body,'PRIVATE_HISTORY_NOTE');assert.equal(notes.body.messages,undefined);
    } finally {state.store.TicketMessage=oldMessages;state.store.InternalNote=oldNotes;}
  });
  await t.test('history validates cursors and limits, scopes every read, and denies author note access',async()=>{
    const endpoint=own+'/'+ticketId+'/messages';
    const badCursor=Buffer.from(JSON.stringify(['not-a-date',String(id())])).toString('base64url');
    for(const suffix of ['?before=','?before=bad!','?before='+badCursor,'?before=abc&before=def','?page=1','?limit=0','?limit=51','?limit=1&limit=2','?author_id=AUTH902'])assert.equal((await request(endpoint+suffix)).status,400,suffix);
    const before=state.queries.length;
    const foreign=await request(own+'/'+baseline._id+'/messages'),missing=await request(own+'/'+id()+'/messages');
    assert.equal(foreign.status,404);assert.deepEqual(foreign.body,missing.body);
    assert.ok(state.queries.slice(before).every(query=>!['TicketMessage','InternalNote'].includes(query.name)));
    const noteReads=state.queries.filter(query=>query.name==='InternalNote').length;
    assert.equal((await request(own+'/'+ticketId+'/notes')).status,404);
    assert.equal((await request(queue+'/'+ticketId+'/notes')).status,403);
    assert.equal(state.queries.filter(query=>query.name==='InternalNote').length,noteReads);
    assert.equal((await request(endpoint+'?limit=50')).status,200);
    const publicSummary=await request(own+'/'+ticketId+'?view=summary');assert.deepEqual(Object.keys(publicSummary.body),['ticket']);assert.equal(JSON.stringify(publicSummary.body).includes('PRIVATE'),false);
  });
  await t.test('private note cursors remain independent and empty histories return recoverable metadata',async()=>{
    const oldMessages=state.store.TicketMessage,oldNotes=state.store.InternalNote;
    const notes=Array.from({length:13},(_,index)=>new InternalNote({_id:new mongoose.Types.ObjectId((2000+index).toString(16).padStart(24,'0')),ticket:ticketId,createdBy:admin,body:'Private history '+(index+1),createdAt:new Date(Date.UTC(2024,0,1,0,0,Math.floor(index/2)))}).toObject());
    state.store.InternalNote=new Map(notes.map(entry=>[String(entry._id),entry]));
    try {
      const endpoint=queue+'/'+ticketId+'/notes';
      const first=await request(endpoint+'?limit=5',{user:admin});assert.equal(first.status,200);
      assert.deepEqual(first.body.notes.map(entry=>entry.body),['Private history 13','Private history 12','Private history 11','Private history 10','Private history 9']);
      const publicBefore=await request(own+'/'+ticketId+'/messages');
      const saved=await request(endpoint,{user:admin,body:{body:'New private note'}});assert.equal(saved.status,201);
      const second=await request(endpoint+'?limit=5&before='+first.body.pagination.nextCursor,{user:admin});
      const third=await request(endpoint+'?limit=5&before='+second.body.pagination.nextCursor,{user:admin});
      assert.deepEqual(second.body.notes.map(entry=>entry.body),['Private history 8','Private history 7','Private history 6','Private history 5','Private history 4']);
      assert.deepEqual(third.body.notes.map(entry=>entry.body),['Private history 3','Private history 2','Private history 1']);
      assert.equal(third.body.pagination.hasMore,false);assert.equal(third.body.pagination.nextCursor,null);
      assert.equal(new Set([first,second,third].flatMap(page=>page.body.notes.map(entry=>entry._id))).size,13);
      assert.equal((await request(endpoint,{user:admin})).body.notes[0]._id,saved.body.note._id);
      assert.deepEqual((await request(own+'/'+ticketId+'/messages')).body,publicBefore.body);
      state.store.TicketMessage=new Map();state.store.InternalNote=new Map();
      assert.deepEqual((await request(own+'/'+ticketId+'/messages')).body,{messages:[],pagination:{limit:10,hasMore:false,nextCursor:null}});
      assert.deepEqual((await request(endpoint,{user:admin})).body,{notes:[],pagination:{limit:10,hasMore:false,nextCursor:null}});
    } finally {state.store.TicketMessage=oldMessages;state.store.InternalNote=oldNotes;}
  });
  await t.test('status transitions maintain timestamps; closed/resolved replies require explicit reopen',async()=>{
    let result=await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'Resolved'}});assert.equal(result.status,200);assert.ok(result.body.ticket.resolvedAt);assert.equal(result.body.ticket.closedAt,null);
    const resolvedAt=result.body.ticket.resolvedAt;
    assert.equal((await request(own+'/'+ticketId+'/messages',{body:{body:'Not reopened'}})).status,409);
    assert.equal((await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'Open'}})).status,409);
    result=await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'Closed'}});assert.equal(result.status,200);assert.ok(result.body.ticket.closedAt);assert.equal(result.body.ticket.resolvedAt,resolvedAt);
    assert.equal((await request(queue+'/'+ticketId+'/messages',{user:admin,body:{body:'Not reopened'}})).status,409);
    assert.equal((await request(queue+'/'+ticketId+'/notes',{user:admin,body:{body:'Closed-ticket audit'}})).status,201);
    assert.equal((await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'Resolved'}})).status,409);
    result=await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'In Progress',assignee:null}});
    assert.equal(result.status,200);assert.equal(result.body.ticket.resolvedAt,null);assert.equal(result.body.ticket.closedAt,null);assert.equal(result.body.ticket.assignee,null);
  });
  await t.test('every state pair enforces the documented transition table including idempotent requests',async()=>{
    for(const from of Object.keys(transitions))for(const to of Object.keys(transitions)){
      const record=new Ticket({author:author1,subject:'Transition fixture',description:'Fixture',status:from,createdAt:new Date(),updatedAt:new Date(),__v:0}).toObject();
      state.store.Ticket.set(String(record._id),record);
      try {
        const result=await request(queue+'/'+record._id,{user:admin,method:'PATCH',body:{status:to}});
        const allowed=from===to||transitions[from].includes(to);
        assert.equal(result.status,allowed?200:409,from+' -> '+to);
        assert.equal(state.store.Ticket.get(String(record._id)).status,allowed?to:from);
      } finally {state.store.Ticket.delete(String(record._id));}
    }
  });
  await t.test('forged protected fields are rejected rather than silently ignored',async()=>{
    const before=state.writes;
    for(const field of ['author','author_id','role','status','priority','assignee','internalNotes','aiClassification','categorySource','attachments','__v']){
      assert.equal((await request(own,{body:{subject:'Help',description:'Question',[field]:'forged'}})).status,400,field);
    }
    for(const field of ['sender','role','ticket','private','attachments','internalNotes'])assert.equal((await request(own+'/'+ticketId+'/messages',{body:{body:'Reply',[field]:'forged'}})).status,400,field);
    for(const field of ['author','book','description','aiClassification','prioritySource','categoryOverriddenBy','__v'])assert.equal((await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{[field]:'forged'}})).status,400,field);
    assert.equal(state.writes,before);
  });
  await t.test('invalid body shapes, text lengths, IDs and enums fail before writes',async()=>{
    const before=state.writes;
    for(const body of [null,[],{},'bad',{subject:' ',description:'x'},{subject:'x'.repeat(201),description:'x'},{subject:'x',description:'x'.repeat(10001)},{subject:'x',description:'a\0b'},{subject:'x',description:'x',category:'bad'},{subject:'x',description:'x',book_id:{$ne:null}}])assert.equal((await request(own,{body,method:'POST'})).status,400);
    for(const body of [{body:''},{body:' '},{body:'x'.repeat(10001)},{body:{}},[]])assert.equal((await request(own+'/'+ticketId+'/messages',{body,method:'POST'})).status,400);
    for(const body of [{status:'bad'},{priority:null},{category:'bad'},{assignee:'not-id'},{}])assert.equal((await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body})).status,400);
    for(const prefix of [own,queue])assert.equal((await request(prefix+'/not-an-id',{user:prefix===queue?admin:user1})).status,400);
    assert.equal((await request(own+'/'+ticketId+'/messages?role=admin',{body:{body:'x'}})).status,400);
    assert.equal((await request(queue+'/'+id(),{user:admin,method:'PATCH',body:{status:'Open'}})).status,404);
    assert.equal(state.writes,before);
  });
  await t.test('pagination bounds, unknown/duplicate filters and detail query validation',async()=>{
    for(const suffix of ['?page=0','?page=-1','?page=1.5','?page=01','?page=10001','?page=1&page=2','?limit=0','?limit=51','?limit=2&limit=3','?status=unknown','?author_id=AUTH902','?status=Open&status=Closed']){
      assert.equal((await request(own+suffix)).status,400,suffix);assert.equal((await request(queue+suffix,{user:admin})).status,400,suffix);
    }
    for(const suffix of ['?priority=invalid','?assignee=bad','?category=invalid','?category=unclassified&category=invalid'])assert.equal((await request(queue+suffix,{user:admin})).status,400);
    assert.equal((await request(own+'?priority=High')).status,400);
    const empty=await request(own+'?page=10000&limit=50');assert.equal(empty.status,200);assert.deepEqual(empty.body.tickets,[]);assert.equal(empty.body.pagination.limit,50);
    assert.equal((await request(own+'/'+ticketId+'?limit=51')).status,400);assert.equal((await request(queue+'/'+ticketId+'?status=Open',{user:admin})).status,400);
  });
  await t.test('role, active account and author-link checks gate all admin/note paths',async()=>{
    const before=state.writes;
    assert.equal((await request(own,{user:null})).status,401);assert.equal((await request(queue,{user:disabled})).status,401);assert.equal((await request(own,{user:unlinked})).status,403);
    assert.equal((await request(own,{user:admin})).status,403);
    for(const [path,method,body] of [[queue,'GET'],[queue+'/'+ticketId,'GET'],[queue+'/'+ticketId,'PATCH',{status:'Closed'}],[queue+'/'+ticketId+'/messages','POST',{body:'forged'}],[queue+'/'+ticketId+'/notes','POST',{body:'forged'}]])assert.equal((await request(path,{method,body})).status,403);
    assert.equal((await request(own+'/'+ticketId+'/notes',{body:{body:'forged'}})).status,404);assert.equal(state.writes,before);
  });
  await t.test('reply/note plus activity rollback together, session always closes, errors stay sanitized',async()=>{
    for(const suffix of ['messages','notes']){
      const before={messages:state.store.TicketMessage.size,notes:state.store.InternalNote.size,activity:state.store.Ticket.get(ticketId).lastActivityAt,ended:state.ended};
      state.failTicketSave=true;
      const result=await request(queue+'/'+ticketId+'/'+suffix,{user:admin,body:{body:'Do not commit'}});state.failTicketSave=false;
      assert.equal(result.status,500);assert.deepEqual(result.body,{error:'Internal server error'});
      assert.equal(state.store.TicketMessage.size,before.messages);assert.equal(state.store.InternalNote.size,before.notes);assert.equal(state.store.Ticket.get(ticketId).lastActivityAt,before.activity);assert.equal(state.ended,before.ended+1);
    }
    state.conflict=true;const conflict=await request(queue+'/'+ticketId,{user:admin,method:'PATCH',body:{status:'Closed'}});state.conflict=false;
    assert.equal(conflict.status,409);assert.deepEqual(conflict.body,{error:'Ticket changed; retry request'});assert.equal(state.store.Ticket.get(ticketId).status,'In Progress');
  });
  await t.test('inactive transaction cannot write; driver callback retry returns only committed entry',async()=>{
    const before=state.store.TicketMessage.size,writes=state.writes;
    state.inactive=true;assert.equal((await request(own+'/'+ticketId+'/messages',{body:{body:'No context'}})).status,500);state.inactive=false;assert.equal(state.writes,writes);
    state.retry=true;const result=await request(own+'/'+ticketId+'/messages',{body:{body:'One committed entry'}});
    assert.equal(result.status,201);assert.equal(state.store.TicketMessage.size,before+1);assert.ok(state.store.TicketMessage.has(result.body.message._id));
    state.dbError=true;const failure=await request(queue,{user:admin});state.dbError=false;
    assert.equal(failure.status,500);assert.deepEqual(failure.body,{error:'Internal server error'});
  });
  await t.test('AI classification applies valid suggestions once despite transaction retry and retains admin overrides',async()=>{
    let calls=0;
    app.locals.aiService=createAIService({apiKey:'isolated-ai-key',fetchImpl:async()=>{calls++;return geminiResponse({category:categories[1],priority:'High'});}});
    try {
      state.retry=true;const result=await request(own,{body:{subject:'ISBN problem',description:'Wrong book linked'}});
      assert.equal(result.status,201);assert.equal(calls,1);assert.equal(result.body.ticket.category,categories[1]);assert.equal(result.body.ticket.priority,'High');
      const stored=state.store.Ticket.get(result.body.ticket._id);assert.equal(stored.aiClassification.state,'completed');assert.equal(stored.prioritySource,'ai');
      const changed=await request(queue+'/'+stored._id,{user:admin,method:'PATCH',body:{category:categories[5],priority:'Low'}});
      assert.equal(changed.status,200);assert.equal(changed.body.ticket.category,categories[5]);assert.equal(changed.body.ticket.priority,'Low');assert.equal(stored.aiClassification.suggestedPriority,'High');
      assert.equal(changed.body.ticket.classification.state,'completed');assert.equal(changed.body.ticket.classification.manuallyReviewed,true);assert.equal(changed.body.ticket.classification.needsManualReview,false);
      assert.equal(changed.body.ticket.classification.suggestedCategory,categories[1]);assert.equal(changed.body.ticket.classification.suggestedPriority,'High');
      const manual=await request(own,{body:{subject:'Manual selection',description:'Question',category:categories[0]}});
      assert.equal(manual.status,201);assert.equal(manual.body.ticket.category,categories[0]);
    } finally {delete app.locals.aiService;}
  });
  await t.test('unavailable or invalid AI never prevents valid ticket creation and admins see manual-review state',async()=>{
    for(const ai of [{classify:async()=>{throw new Error('PRIVATE_API_KEY');}},{classify:async()=>({state:'completed',category:'invented',priority:'Urgent'})}]){
      app.locals.aiService=ai;
      try {
        const result=await request(own,{body:{subject:'Fallback',description:'Question'}});assert.equal(result.status,201);assert.equal(result.body.ticket.priority,'Medium');assert.equal(result.body.ticket.category,null);
        const read=await request(queue+'/'+result.body.ticket._id,{user:admin});assert.equal(read.body.ticket.classification.state,'failed');assert.equal(read.body.ticket.classification.needsManualReview,true);assert.equal(JSON.stringify(read.body).includes('PRIVATE_API_KEY'),false);
      } finally {delete app.locals.aiService;}
    }
  });
  await t.test('failed classification review needs both explicit admin corrections and preserves failure provenance',async()=>{
    const created=await request(own,{body:{subject:'Manual review fixture',description:'Question'}});
    const path=queue+'/'+created.body.ticket._id;
    const original=(await request(path,{user:admin})).body.ticket.classification;
    assert.equal(original.state,'failed');assert.equal(original.manuallyReviewed,false);
    const category=await request(path,{user:admin,method:'PATCH',body:{category:categories[0]}});
    assert.equal(category.body.ticket.classification.needsManualReview,true);
    assert.equal(category.body.ticket.classification.manuallyReviewed,false);
    const completed=await request(path,{user:admin,method:'PATCH',body:{priority:'High'}});
    assert.equal(completed.body.ticket.classification.needsManualReview,false);
    assert.equal(completed.body.ticket.classification.manuallyReviewed,true);
    for(const field of ['state','errorCode','attemptCount','suggestedCategory','suggestedPriority'])assert.deepEqual(completed.body.ticket.classification[field],original[field]);
    const second=await request(own,{body:{subject:'Priority only fixture',description:'Question',category:categories[0]}});
    const priority=await request(queue+'/'+second.body.ticket._id,{user:admin,method:'PATCH',body:{priority:'Low'}});
    assert.equal(priority.body.ticket.classification.manuallyReviewed,false,'author-selected category is not an admin review');
    assert.equal(priority.body.ticket.classification.needsManualReview,true);
    const authorRead=await request(own+'/'+created.body.ticket._id);
    assert.equal('classification' in authorRead.body.ticket,false);assert.equal('revision' in authorRead.body.ticket,false);
  });
  await t.test('revision preconditions reject stale forms after management, public replies and private notes without writes',async()=>{
    const created=await request(own,{body:{subject:'Concurrency fixture',description:'Question'}});
    const path=queue+'/'+created.body.ticket._id;
    assert.equal((await request(path,{user:admin,method:'PATCH',body:{priority:'High'},revision:null})).status,428);
    assert.equal((await request(path,{user:admin,method:'PATCH',body:{priority:'High'},revision:'bad'})).status,400);
    const changes=[{category:categories[1]},{priority:'High'},{status:'In Progress'},{assignee:String(admin)}];
    for(const body of changes) {
      const revision=(await request(path,{user:admin})).body.ticket.revision;
      const current=await request(path,{user:admin,method:'PATCH',body,revision});assert.equal(current.status,200);
      assert.equal(current.body.ticket.revision,revision+1);
      const snapshot=JSON.stringify([...state.store.Ticket]),writes=state.writes;
      const stale=await request(path,{user:admin,method:'PATCH',body:{status:'Closed',priority:'Low',category:categories[5],assignee:null},revision});
      assert.equal(stale.status,409);assert.match(stale.body.error,/reconcile/);
      assert.equal(JSON.stringify([...state.store.Ticket]),snapshot);assert.equal(state.writes,writes);
    }
    for(const endpoint of ['messages','notes']) {
      const revision=(await request(path,{user:admin})).body.ticket.revision;
      assert.equal((await request(path+'/'+endpoint,{user:admin,body:{body:'Concurrent activity'}})).status,201);
      const writes=state.writes;
      assert.equal((await request(path,{user:admin,method:'PATCH',body:{priority:'Critical'},revision})).status,409);
      assert.equal(state.writes,writes);
      const fresh=(await request(path,{user:admin})).body.ticket.revision;
      assert.equal((await request(path,{user:admin,method:'PATCH',body:{priority:'Critical'},revision:fresh})).status,200);
    }
  });
  await t.test('transaction callback retries recheck the submitted revision after another admin commits',async()=>{
    const created=await request(own,{body:{subject:'Retry concurrency fixture',description:'Question'}});
    const path=queue+'/'+created.body.ticket._id;
    const revision=(await request(path,{user:admin})).body.ticket.revision;
    state.retry=true;state.concurrentChange=()=>{
      const stored=state.store.Ticket.get(created.body.ticket._id);
      state.store.Ticket.set(created.body.ticket._id,{...stored,priority:'High',__v:stored.__v+1});
    };
    const result=await request(path,{user:admin,method:'PATCH',body:{priority:'Low',category:categories[1],status:'Closed',assignee:String(admin)},revision});
    assert.equal(result.status,409);
    const stored=state.store.Ticket.get(created.body.ticket._id);
    assert.equal(stored.priority,'High');assert.equal(stored.category,null);assert.equal(stored.status,'Open');assert.equal(stored.assignee,null);assert.equal(stored.__v,revision+1);
  });
  await t.test('draft is admin only, uses six latest public messages and never persists or sends output',async()=>{
    let calls=0,sent;
    app.locals.aiService=createAIService({apiKey:'isolated-ai-key',fetchImpl:async(_url,options)=>{calls++;sent=JSON.parse(options.body);return geminiResponse({draft:'Thank you. Please share photos for verification.'});}});
    const added=[];
    for(let i=0;i<10;i++){
      const message=new TicketMessage({ticket:ticketId,sender:user1,body:'message-'+i+' '+('x'.repeat(900)),createdAt:new Date(Date.now()+1000*i)}).toObject();state.store.TicketMessage.set(String(message._id),message);added.push(String(message._id));
    }
    try {
      assert.equal((await request(queue+'/'+ticketId+'/draft',{method:'POST'})).status,403);assert.equal(calls,0);
      const writes=state.writes,notes=state.store.InternalNote.size,messages=state.store.TicketMessage.size;
      const result=await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'});
      assert.equal(result.status,200);assert.deepEqual(Object.keys(result.body).sort(),['contextWarnings','draft','requiresReview']);assert.equal(result.body.requiresReview,true);
      assert.ok(result.body.contextWarnings.includes('HISTORY_TRUNCATED'));assert.ok(result.body.contextWarnings.includes('MESSAGE_TRUNCATED'));
      const context=JSON.parse(sent.contents[0].parts[0].text);assert.equal(context.conversation.length,6);assert.match(context.conversation[0].body,/^message-4 /);assert.ok(context.conversation.every(x=>x.body.length<=700));
      assert.equal(JSON.stringify(sent).includes('PRIVATE_INTERNAL_NOTE'),false);assert.equal(state.writes,writes);assert.equal(state.store.InternalNote.size,notes);assert.equal(state.store.TicketMessage.size,messages);
      assert.equal((await request(queue+'/'+ticketId+'/draft',{user:admin,body:{prompt:'override'}})).status,400);
      assert.equal((await request(queue+'/'+id()+'/draft',{user:admin,method:'POST'})).status,404);
      assert.equal((await request(queue+'/bad/draft',{user:admin,method:'POST'})).status,400);
      delete app.locals.aiService;
      const missing=await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'});assert.equal(missing.status,503);assert.deepEqual(missing.body,{error:'AI draft unavailable; write a manual reply',code:'UNAVAILABLE'});
    } finally {delete app.locals.aiService;for(const messageId of added)state.store.TicketMessage.delete(messageId);}
  });
  await t.test('AI receives only the linked author-owned book facts; foreign, missing and general links cannot disclose another book',async()=>{
    const source=f.books[0],backup={...source},stored=state.store.Ticket.get(ticketId),originalBook=stored.book;
    Object.assign(source,{genre:'Fiction',publication_date:'2024-01-01',mrp:mongoose.Types.Decimal128.fromString('399.50'),total_copies_sold:200,author_royalty_per_copy:mongoose.Types.Decimal128.fromString('20'),total_royalty_earned:mongoose.Types.Decimal128.fromString('4000'),royalty_paid:mongoose.Types.Decimal128.fromString('1000'),royalty_pending:mongoose.Types.Decimal128.fromString('3000'),last_royalty_payout_date:null,passwordHash:'NEVER_SEND',bankDetails:'NEVER_SEND'});
    let sent,calls=0;
    app.locals.aiService=createAIService({apiKey:'isolated-ai-key',fetchImpl:async(_url,options)=>{
      calls++;sent=JSON.parse(options.body);const classification=Object.hasOwn(sent.generationConfig.responseJsonSchema.properties,'category');
      return geminiResponse(classification?{category:categories[0],priority:'High'}:{draft:'The recorded royalties pending are INR 3000. Please confirm which quarter needs review.'});
    }});
    try {
      const beforeWrites=state.writes;
      const result=await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'});assert.equal(result.status,200);assert.equal(state.writes,beforeWrites);
      const context=JSON.parse(sent.contents[0].parts[0].text);assert.equal(context.verifiedBook.state,'available');assert.equal(context.verifiedBook.fields.mrp,'399.50');assert.equal(context.verifiedBook.fields.royalty_pending,'3000');assert.equal(context.verifiedBook.fields.last_royalty_payout_date,null);
      const lookup=state.queries.findLast(query=>query.name==='Book');assert.ok(same(lookup.filter._id,source._id));assert.ok(same(lookup.filter.author,author1));
      for(const privateValue of ['NEVER_SEND',String(author1),String(user1),String(source._id)])assert.equal(JSON.stringify(sent).includes(privateValue),false);
      for(const reference of [f.books[1]._id,id()]) {
        stored.book=reference;
        const response=await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'});assert.equal(response.status,200);assert.ok(response.body.contextWarnings.includes('BOOK_UNAVAILABLE'));
        assert.equal(JSON.parse(sent.contents[0].parts[0].text).verifiedBook.state,'unavailable');assert.equal(JSON.parse(sent.contents[0].parts[0].text).verifiedBook.fields,null);
        assert.equal(JSON.stringify(sent).includes(f.books[1].title),false);
      }
      stored.book=null;const queries=state.queries.filter(query=>query.name==='Book').length;
      assert.equal((await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'})).status,200);
      assert.equal(JSON.parse(sent.contents[0].parts[0].text).verifiedBook.state,'general');assert.equal(state.queries.filter(query=>query.name==='Book').length,queries);
      const created=await request(own,{body:{subject:'Book royalty question',description:'Please review the recorded amount',book_id:'BK901'}});assert.equal(created.status,201);
      assert.equal(JSON.parse(sent.contents[0].parts[0].text).verifiedBook.fields.royalty_pending,'3000');assert.equal(created.body.ticket.contextWarnings,undefined);
      const count=calls;assert.equal((await request(own,{body:{subject:'Foreign book',description:'Question',book_id:'BK902'}})).status,404);assert.equal(calls,count);
      assert.equal(state.writes,beforeWrites+1);
    } finally {
      stored.book=originalBook;delete app.locals.aiService;
      for(const key of Object.keys(source))delete source[key];Object.assign(source,backup);
    }
  });
  await t.test('real AI adapter failure modes still create tickets and unsupported draft claims never send a reply',async()=>{
    const providers=[async()=>new Response('rate limited',{status:429}),async()=>new Response('failure',{status:500}),async()=>new Response('not JSON'),async()=>new Promise(()=>{})];
    try {
      for(const fetchImpl of providers) {
        app.locals.aiService=createAIService({apiKey:'isolated-ai-key',timeoutMs:5,fetchImpl});
        const result=await request(own,{body:{subject:'Manual fallback',description:'Please investigate',book_id:'BK901'}});
        assert.equal(result.status,201);assert.equal(result.body.ticket.priority,'Medium');
        const stored=state.store.Ticket.get(result.body.ticket._id);assert.equal(stored.aiClassification.state,'failed');
      }
      app.locals.aiService=createAIService({apiKey:'isolated-ai-key',fetchImpl:async()=>geminiResponse({draft:'We have processed your payment.'})});
      const writes=state.writes,status=state.store.Ticket.get(ticketId).status;
      const result=await request(queue+'/'+ticketId+'/draft',{user:admin,method:'POST'});
      assert.equal(result.status,503);assert.deepEqual(result.body,{error:'AI draft unavailable; write a manual reply',code:'INVALID_OUTPUT'});assert.equal(state.writes,writes);assert.equal(state.store.Ticket.get(ticketId).status,status);
    } finally {delete app.locals.aiService;}
  });
  assert.equal(JSON.stringify({books:f.books,users:f.users}),originalSources);
  assert.ok(state.aborts>0);assert.equal(mongoose.connection.readyState,0);
  assert.ok(same(state.store.Ticket.get(String(baseline._id)).author,author2));
});

test('private note DTO rejects public messages and public message DTO rejects private notes',()=>{
  const note=new InternalNote({ticket:id(),createdBy:id(),body:'Private'}),message=new TicketMessage({ticket:id(),sender:id(),body:'Public'});
  assert.throws(()=>publicMessageDTO(note));assert.throws(()=>adminInternalNoteDTO(message));
  const result=authorTicketDTO({_id:id(),subject:'Help',internalNotes:[note],passwordHash:'PRIVATE',aiClassification:{errorCode:'PRIVATE'}});
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(result.internalNotes,undefined);
});

test('transaction session closes after a thrown callback without a database',async t=>{
  let ended=0;
  t.mock.method(mongoose,'startSession',async()=>({inTransaction:()=>true,withTransaction:async callback=>callback(),endSession:async()=>{ended++;}}));
  await assert.rejects(ticketTransaction(async()=>{throw new Error('fixture');}),/fixture/);assert.equal(ended,1);
});

test('transition table explicitly bounds each allowed state change',()=>{
  assert.deepEqual(transitions.Closed,['In Progress']);assert.deepEqual(transitions.Resolved,['In Progress','Closed']);
  for(const [from,destinations] of Object.entries(transitions))for(const to of destinations){assert.notEqual(from,to);assert.ok(Object.hasOwn(transitions,to));}
});
