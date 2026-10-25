import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

async function fixtures(h) {
  const passwordHash=await bcrypt.hash(randomBytes(24).toString('hex'),10);
  const users=[];
  for(const [index,role] of ['author','author','admin','admin'].entries())users.push(await h.records.insert('User',{email:`fixture${index}@example.test`,passwordHash,role,accountStatus:'active'}));
  const authors=[];
  for(let index=0;index<2;index++)authors.push(await h.records.insert('Author',{author_id:'AUTH90000'+(index+1),name:'Synthetic fixture',email:`profile${index}@example.test`,phone:'synthetic-only',city:'Fixture',joined_date:'2024-01-01',user:users[index]._id}));
  const books=[];
  for(let index=0;index<2;index++)books.push(await h.records.insert('Book',{book_id:'BK90000'+(index+1),author:authors[index]._id,sourceOrder:0,title:'Synthetic book',isbn:'SYNTHETIC-XXXX',genre:'Fixture',status:'Published & Live',publication_date:'2024-01-01',mrp:'100',author_royalty_per_copy:'10',total_copies_sold:20,total_royalty_earned:'200',royalty_paid:'100',royalty_pending:'100',available_on:[]}));
  return {author:authors[0],otherAuthor:authors[1],user:users[0],otherUser:users[1],admin:users[2],otherAdmin:users[3],book:books[0],otherBook:books[1]};
}
const auth=(user,author)=>({user,authorId:author?._id});
const ticket=(h,f,patch={})=>h.records.insert('Ticket',{author:f.author._id,book:f.book._id,subject:'Synthetic ticket',description:'Integration fixture only',lastActivityAt:new Date('2020-01-01'),...patch});
const endpoint=t=>'/api/admin/tickets/'+t._id;
const revision=async(h,t)=>(await h.records.one('Ticket',{_id:t._id})).__v;
async function noPublicLeaks(result) {
  const value=JSON.stringify(result);
  for(const forbidden of ['PRIVATE_NOTE_ONLY','passwordHash','tokenVersion','aiClassification','classification','OverriddenBy','notesPagination','"notes"','internalNotes','"__v"'])assert.equal(value.includes(forbidden),false);
}
const objectId=value=>value;
const duplicate=error=>error.code===11000;
export const integrationCases=[
  ['transaction commit and public/private rollback',async h=>{
    const f=await fixtures(h),t=await ticket(h,f),actor=auth(f.admin);
    await h.activity(actor,t._id,{body:'Committed public fixture'});
    assert.equal(await h.records.count('TicketMessage',{ticket:t._id}),1);
    const before=await h.records.one('Ticket',{_id:t._id});
    for(const privateNote of [false,true]) {
      await assert.rejects(h.activity(actor,t._id,{body:'Must roll back'},{privateNote,abortAfterWrite:true}),/SYNTHETIC_ABORT/);
      assert.equal(await h.records.count('TicketMessage',{ticket:t._id}),1);
      assert.equal(await h.records.count('InternalNote',{ticket:t._id}),0);
      const after=await h.records.one('Ticket',{_id:t._id});
      assert.equal(after.__v,before.__v);assert.equal(after.lastActivityAt.valueOf(),before.lastActivityAt.valueOf());
    }
  }],
  ['real unique indexes and normalized email',async h=>{
    const f=await fixtures(h);
    await assert.rejects(h.records.insert('User',{email:' FIXTURE0@EXAMPLE.TEST ',accountStatus:'pending'}),duplicate);
    const profile={...f.author};delete profile._id;delete profile.__v;
    await assert.rejects(h.records.insert('Author',{...profile,user:null}),duplicate);
    await assert.rejects(h.records.insert('Author',{...profile,author_id:'AUTH999999',email:'different@example.test'}),duplicate);
    const book={...f.book};delete book._id;delete book.__v;
    await assert.rejects(h.records.insert('Book',book),duplicate);
    const expected={User:1,Author:2,Book:1};
    for(const [name,count] of Object.entries(expected))assert.equal((await h.records.indexes(name)).filter(index=>index.unique&&index.name!=='_id_').length,count);
    const link=(await h.records.indexes('Author')).find(index=>index.key.user===1);
    assert.equal(link.unique,true);assert.deepEqual(link.partialFilterExpression,{user:{$type:'objectId'}});
  }],
  ['concurrent admin PATCH with identical revision',async h=>{
    const f=await fixtures(h),t=await ticket(h,f),v=t.__v;
    const bodies=[{status:'In Progress',category:'Royalty & Payments',priority:'High',assignee:String(f.admin._id)},{status:'Resolved',category:'ISBN & Metadata Issues',priority:'Low',assignee:String(f.otherAdmin._id)}];
    const results=await Promise.all([f.admin,f.otherAdmin].map((user,index)=>h.request(endpoint(t),{user,method:'PATCH',body:bodies[index],revision:v})));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
    const winner=results.findIndex(result=>result.status===200),stored=await h.records.one('Ticket',{_id:t._id});
    for(const [key,value] of Object.entries(bodies[winner]))assert.equal(String(stored[key]),value);
    assert.equal(stored.__v,v+1);
  }],
  ['public replies and private notes invalidate old revisions',async h=>{
    const f=await fixtures(h);
    for(const kind of ['messages','notes']) {
      const t=await ticket(h,f),v=t.__v;
      const entry=await h.request(endpoint(t)+'/'+kind,{user:f.admin,body:{body:'Synthetic activity'}});
      assert.equal(entry.status,201);assert.equal(await revision(h,t),v+1);
      assert.equal((await h.request(endpoint(t),{user:f.otherAdmin,method:'PATCH',body:{priority:'Critical'},revision:v})).status,409);
      assert.equal((await h.records.one('Ticket',{_id:t._id})).priority,'Medium');
    }
  }],
  ['UTC date boundaries, combined filters and pages',async h=>{
    const f=await fixtures(h),common={status:'In Progress',priority:'High',category:'ISBN & Metadata Issues',assignee:f.admin._id};
    const dates=['2024-02-28T23:59:59.999Z','2024-02-29T00:00:00.000Z','2024-02-29T23:59:59.999Z','2024-03-01T00:00:00.000Z'];
    const records=[];
    for(const date of dates)records.push(await ticket(h,f,{...common,createdAt:new Date(date)}));
    await ticket(h,f,{...common,priority:'Low',createdAt:new Date(dates[1])});
    const query='/api/admin/tickets?startDate=2024-02-29&endDate=2024-02-29&status=In%20Progress&priority=High&category=ISBN%20%26%20Metadata%20Issues&assignee='+f.admin._id+'&limit=1';
    const first=await h.request(query,{user:f.admin}),second=await h.request(query+'&page=2',{user:f.admin});
    assert.equal(first.status,200);assert.deepEqual(first.body.pagination,{page:1,limit:1,total:2,totalPages:2});
    assert.equal(first.body.tickets[0]._id,String(records[1]._id));assert.equal(second.body.tickets[0]._id,String(records[2]._id));
    for(const range of ['startDate=2024-03-01&endDate=2024-02-29','endDate=2024-02-30'])assert.equal((await h.request('/api/admin/tickets?'+range,{user:f.admin})).status,400);
  }],
  ['cross-page urgency ordering and stable ties',async h=>{
    const f=await fixtures(h),records=[];
    const combinations=[['Critical','Open','2020-01-01'],['Critical','In Progress','2020-01-01'],['High','Open','2019-01-01'],['Medium','Open','2018-01-01'],['Low','Open','2010-01-01'],['Critical','Resolved','2000-01-01'],['Critical','Closed','2001-01-01']];
    for(const [index,[priority,status,date]] of combinations.entries())records.push(await ticket(h,f,{_id:objectId((index+1).toString(16).padStart(24,'0')),priority,status,createdAt:new Date(date)}));
    const recent=[];for(let index=0;index<12;index++)recent.push(await ticket(h,f,{priority:'Low',createdAt:new Date('2026-01-01')}));
    const expected=[...records.slice(0,5),...recent.sort((a,b)=>String(a._id).localeCompare(String(b._id))),...records.slice(5)].map(record=>String(record._id)),found=[];
    for(let page=1;page<=Math.ceil(expected.length/2);page++) {
      const result=await h.request('/api/admin/tickets?limit=2&page='+page,{user:f.admin});assert.equal(result.status,200);
      found.push(...result.body.tickets.map(item=>item._id));assert.equal(result.body.pagination.total,expected.length);
    }
    assert.deepEqual(found,expected);assert.equal(new Set(found).size,found.length);
    const newest=await h.request('/api/admin/tickets?sort=newest&limit=2',{user:f.admin});assert.ok(newest.body.tickets.every(item=>item.priority==='Low'));
  }],
  ['equal-time cursors, arrivals and independent private history',async h=>{
    const f=await fixtures(h),t=await ticket(h,f),time=new Date('2024-01-01');
    for(let index=1;index<=5;index++)await h.records.insert('TicketMessage',{_id:objectId(index.toString(16).padStart(24,'0')),ticket:t._id,sender:f.admin._id,body:'Public '+index,createdAt:time});
    await h.records.insert('InternalNote',{ticket:t._id,createdBy:f.admin._id,body:'PRIVATE_NOTE_ONLY',createdAt:time});
    const publicPath='/api/me/tickets/'+t._id+'/messages',first=await h.request(publicPath+'?limit=2',{user:f.user});
    assert.deepEqual(first.body.messages.map(message=>message.body),['Public 5','Public 4']);
    await h.records.insert('TicketMessage',{_id:objectId('000000000000000000000099'),ticket:t._id,sender:f.admin._id,body:'New arrival',createdAt:time});
    const second=await h.request(publicPath+'?limit=2&before='+first.body.pagination.nextCursor,{user:f.user});
    const third=await h.request(publicPath+'?limit=2&before='+second.body.pagination.nextCursor,{user:f.user});
    assert.deepEqual(second.body.messages.map(message=>message.body),['Public 3','Public 2']);assert.deepEqual(third.body.messages.map(message=>message.body),['Public 1']);
    assert.equal(third.body.pagination.hasMore,false);
    assert.equal((await h.request(publicPath+'?limit=2',{user:f.user})).body.messages[0].body,'New arrival');
    const notes=await h.request(endpoint(t)+'/notes?limit=1',{user:f.admin});assert.equal(notes.body.notes[0].body,'PRIVATE_NOTE_ONLY');assert.equal(notes.body.pagination.hasMore,false);
    await noPublicLeaks(first.body);await noPublicLeaks(second.body);await noPublicLeaks(third.body);
  }],
  ['ownership, role boundaries and every author ticket response',async h=>{
    const f=await fixtures(h),own=await ticket(h,f),foreign=await ticket(h,f,{author:f.otherAuthor._id,book:f.otherBook._id});
    await h.activity(auth(f.admin),own._id,{body:'PRIVATE_NOTE_ONLY'},{privateNote:true});
    for(const path of ['/api/me/tickets','/api/me/tickets/'+own._id,'/api/me/tickets/'+own._id+'?view=summary','/api/me/tickets/'+own._id+'/messages']) {
      const result=await h.request(path,{user:f.user});assert.equal(result.status,200);await noPublicLeaks(result.body);
    }
    assert.equal((await h.request('/api/me/tickets/'+foreign._id,{user:f.user})).status,404);
    assert.equal((await h.request('/api/me/tickets/'+foreign._id+'/messages',{user:f.user})).status,404);
    assert.equal((await h.request('/api/me/tickets/'+foreign._id+'/messages',{user:f.user,body:{body:'Forged reply'}})).status,404);
    const books=await h.request('/api/me/books',{user:f.user});assert.deepEqual(books.body.books.map(book=>book.book_id),[f.book.book_id]);
    assert.equal((await h.request('/api/me/books/'+f.otherBook.book_id,{user:f.user})).status,404);
    assert.equal((await h.request(endpoint(own)+'/notes',{user:f.user})).status,403);
    assert.equal((await h.request('/api/me/tickets/'+own._id+'/notes',{user:f.user})).status,404);
    const reply=await h.request('/api/me/tickets/'+own._id+'/messages',{user:f.user,body:{body:'Public author reply'}});assert.equal(reply.status,201);await noPublicLeaks(reply.body);
    const created=await h.request('/api/me/tickets',{user:f.user,body:{subject:'Synthetic new ticket',description:'No AI call',book_id:f.book.book_id}});assert.equal(created.status,201);await noPublicLeaks(created.body);
    assert.equal((await h.records.one('Ticket',{_id:created.body.ticket._id})).aiClassification.state,'failed');
    assert.equal((await h.request('/api/me/tickets',{user:f.user,body:{subject:'Forged',description:'Fixture',author:String(f.otherAuthor._id)}})).status,400);
  }],
  ['pinned source: exactly ten authors and eighteen books',async h=>{
    if(!h.source)return false; // Explicitly reported as SKIP, never replaced with invented records.
    assert.equal(h.source.authors.length,10);assert.equal(h.source.books.length,18);
    const authors=new Map();
    for(const profile of h.source.authors)authors.set(profile.author_id,await h.records.insert('Author',profile));
    for(const book of h.source.books)await h.records.insert('Book',h.sourceBook(book,authors.get(book.author_id)._id));
    assert.equal(await h.records.count('Author',{}),10);assert.equal(await h.records.count('Book',{}),18);assert.equal(await h.records.count('User',{}),0);
    for(const expected of h.source.authors) {
      const stored=await h.records.one('Author',{author_id:expected.author_id});
      for(const key of h.sourceFields.authors)assert.deepEqual(stored[key],expected[key]);assert.equal(stored.user,null);
    }
    for(const expected of h.source.books) {
      const stored=await h.records.one('Book',{book_id:expected.book_id}),payload=h.sourceBook(expected,authors.get(expected.author_id)._id);
      for(const key of [...h.sourceFields.books,'author','sourceOrder'])assert.deepEqual(stored[key],payload[key]);
    }
  }],
];
