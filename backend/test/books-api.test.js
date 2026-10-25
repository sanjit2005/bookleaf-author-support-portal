import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { User, Author, Book } from '../src/models/index.js';
import { createJwtService } from '../src/auth/jwt.js';
import { bookDetailsDTO, BOOK_DETAIL_FIELDS } from '../src/db/serialization.js';
import { readSource, bookPayload, bookFields } from '../src/seed/source.js';

const id=()=>new mongoose.Types.ObjectId();
function fixture(book_id,author,production=false) {
  return {
    _id:id(),book_id,author,title:'Fixture book',isbn:'978-93-5XXXX-01-1',genre:'Fiction',
    publication_date:production?null:'2024-02-29',status:production?'In Production - Cover Design':'Published & Live',
    mrp:production?null:mongoose.Types.Decimal128.fromString('399.50'),
    author_royalty_per_copy:production?null:mongoose.Types.Decimal128.fromString('0.01'),
    total_copies_sold:0,total_royalty_earned:mongoose.Types.Decimal128.fromString('0'),
    royalty_paid:mongoose.Types.Decimal128.fromString('0'),royalty_pending:mongoose.Types.Decimal128.fromString('0'),
    last_royalty_payout_date:null,print_partner:production?null:'In-House',available_on:production?[]:['Amazon India'],
    sourceOrder:0,__v:9,passwordHash:'PRIVATE',internalNotes:['PRIVATE'],credentials:{secret:'PRIVATE'},createdAt:new Date(),
  };
}

test('book DTO explicitly permits only source fields and a restricted admin author summary',()=>{
  const book=fixture('BK001',{_id:id(),author_id:'AUTH001',name:'Fixture author',email:'PRIVATE',phone:'PRIVATE',user:{passwordHash:'PRIVATE'},passwordHash:'PRIVATE',internalNotes:['PRIVATE']});
  const own=bookDetailsDTO(book),admin=bookDetailsDTO(book,{includeAuthor:true});
  assert.deepEqual(Object.keys(own).sort(),[...BOOK_DETAIL_FIELDS].sort());
  assert.deepEqual(Object.keys(admin).sort(),[...BOOK_DETAIL_FIELDS,'author'].sort());
  assert.deepEqual(Object.keys(admin.author).sort(),['_id','author_id','name']);
  assert.equal(JSON.stringify(admin).includes('PRIVATE'),false);
  assert.equal(own.mrp,'399.50');assert.equal(own.author_royalty_per_copy,'0.01');
  assert.equal(own.publication_date,'2024-02-29');assert.equal(own.last_royalty_payout_date,null);
  assert.deepEqual(bookDetailsDTO(fixture('BK002',id(),true)).available_on,[]);
  for(const patch of [{title:{passwordHash:'PRIVATE'}},{mrp:{passwordHash:'PRIVATE'}},{available_on:[{passwordHash:'PRIVATE'}]}]) {
    assert.throws(()=>bookDetailsDTO({...book,...patch}),TypeError);
  }
  assert.throws(()=>bookDetailsDTO({...book,author:{name:{passwordHash:'PRIVATE'}}},{includeAuthor:true}),TypeError);
});

test('Books DTO preserves all permitted fields from the original 18-book dataset',{
  skip:!process.env.SAMPLE_DATA_PATH&&'Set SAMPLE_DATA_PATH to check the original file',
},async()=>{
  const source=await readSource(process.env.SAMPLE_DATA_PATH);
  assert.equal(source.authors.length,10);assert.equal(source.books.length,18);
  assert.deepEqual([...BOOK_DETAIL_FIELDS].sort(),[...bookFields].sort());
  const money=['mrp','author_royalty_per_copy','total_royalty_earned','royalty_paid','royalty_pending'];
  for(const sourceBook of source.books){
    const doc=new Book(bookPayload(sourceBook,id()));
    await doc.validate();
    const dto=bookDetailsDTO(doc);
    for(const key of bookFields)assert.deepEqual(dto[key],money.includes(key)&&sourceBook[key]!==null?String(sourceBook[key]):sourceBook[key],sourceBook.book_id+'.'+key);
  }
});

test('read-only Books API uses authenticated ownership and isolated model reads',async t=>{
  const service=createJwtService({jwtSecret:randomBytes(32)});app.locals.jwtService=service;
  const user1=id(),user2=id(),admin=id(),unlinked=id(),author1=id(),author2=id();
  const users=new Map([user1,user2,admin,unlinked].map(value=>[String(value),{_id:value,email:'fixture@example.com',role:value===admin?'admin':'author',accountStatus:'active',tokenVersion:0}]));
  const links=new Map([[String(user1),author1],[String(user2),author2]]);
  const books=[fixture('BK001',author1),fixture('BK002',author2),fixture('BK003',author1,true)];
  let dbError=false;
  const filters=[],selections=[],populations=[];
  t.mock.method(User,'findById',value=>({select:async()=>users.get(String(value))??null}));
  const authorRead=t.mock.method(Author,'findOne',filter=>{
    assert.deepEqual(Object.keys(filter),['user']);assert.ok(users.has(String(filter.user)));
    return {select:selection=>{assert.equal(selection,'_id');return {lean:async()=>{
      if(dbError)throw new Error('PRIVATE_DATABASE_ERROR');
      const linked=links.get(String(filter.user));return linked?{_id:linked}:null;
    }};}};
  });
  const matches=(book,filter)=>Object.entries(filter).every(([key,value])=>String(book[key])===String(value));
  function query(filter,single=false) {
    filters.push(filter);
    let offset=0,limit=10,populate=false;
    return {
      select(value){selections.push(value);return this;},
      sort(value){assert.deepEqual(value,{book_id:1,_id:1});return this;},
      skip(value){offset=value;return this;},limit(value){limit=value;return this;},
      populate(value){assert.deepEqual(value,{path:'author',select:'author_id name'});populations.push(value);populate=true;return this;},
      async lean(){
        if(dbError)throw new Error('PRIVATE_DATABASE_ERROR');
        const selected=books.filter(book=>matches(book,filter));
        if(single)return selected[0]??null;
        return selected.slice(offset,offset+limit).map(book=>populate?{...book,author:{_id:book.author,author_id:String(book.author)===String(author1)?'AUTH001':'AUTH002',name:'Fixture author',email:'PRIVATE',phone:'PRIVATE',user:{passwordHash:'PRIVATE'},internalNotes:['PRIVATE']}}:book);
      },
    };
  }
  const find=t.mock.method(Book,'find',filter=>query(filter));
  const findOne=t.mock.method(Book,'findOne',filter=>{assert.deepEqual(Object.keys(filter).sort(),['author','book_id']);return query(filter,true);});
  t.mock.method(Book,'countDocuments',async filter=>{filters.push(filter);if(dbError)throw new Error('PRIVATE_DATABASE_ERROR');return books.filter(book=>matches(book,filter)).length;});
  for(const model of [User,Author,Book])for(const method of ['create','updateOne','deleteOne'])t.mock.method(model,method,()=>assert.fail('Unexpected database write'));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{delete app.locals.jwtService;return new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const token=user=>service.sign({userId:user,tokenVersion:0});
  const request=async(path,user=user1,method='GET')=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:user?{Authorization:'Bearer '+token(user)}:{}});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };

  await t.test('each author lists only their books, with ownership-scoped counts and safe DTOs',async()=>{
    for(const [user,author,expected] of [[user1,author1,['BK001','BK003']],[user2,author2,['BK002']]]){
      const start=filters.length,result=await request('/api/me/books',user);
      assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
      assert.deepEqual(result.body.books.map(book=>book.book_id),expected);
      assert.deepEqual(result.body.pagination,{page:1,limit:10,total:expected.length,totalPages:1});
      for(const filter of filters.slice(start))assert.deepEqual(filter,{author});
      for(const book of result.body.books)assert.deepEqual(Object.keys(book).sort(),[...BOOK_DETAIL_FIELDS].sort());
      assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);
    }
    assert.equal(populations.length,0);
  });
  await t.test('owned detail uses both source book ID and linked Author ObjectId',async()=>{
    const result=await request('/api/me/books/BK001');assert.equal(result.status,200);
    assert.deepEqual(filters.at(-1),{book_id:'BK001',author:author1});
    assert.deepEqual(Object.keys(result.body),['book']);assert.equal(result.body.book.mrp,'399.50');
    assert.equal(result.body.book.author_royalty_per_copy,'0.01');assert.equal(result.body.book.publication_date,'2024-02-29');
    const production=await request('/api/me/books/BK003');assert.equal(production.status,200);
    for(const field of ['publication_date','mrp','author_royalty_per_copy','last_royalty_payout_date','print_partner'])assert.equal(production.body.book[field],null);
    assert.deepEqual(production.body.book.available_on,[]);assert.equal(production.body.book.royalty_pending,'0');
  });
  await t.test('foreign and absent books have identical 404 responses, without an existence lookup',async()=>{
    const before=findOne.mock.callCount();
    const foreign=await request('/api/me/books/BK002'),missing=await request('/api/me/books/BK999');
    assert.equal(foreign.status,404);assert.equal(missing.status,404);assert.deepEqual(foreign.body,missing.body);
    assert.equal(findOne.mock.callCount()-before,2);
    for(const filter of filters.slice(-2))assert.equal(String(filter.author),String(author1));
  });
  await t.test('malformed IDs and supplied ownership parameters fail before any Book query',async()=>{
    const before=filters.length;
    for(const path of ['/api/me/books/not-an-id','/api/me/books/'+String(id()),'/api/me/books/BK-1','/api/me/books/'+'BK'+'1'.repeat(199),'/api/me/books/BK001?author_id=AUTH002'])assert.equal((await request(path)).status,400);
    assert.equal(filters.length,before);
  });
  await t.test('authentication, active status, role and missing author link gate queries',async()=>{
    const before=find.mock.callCount()+findOne.mock.callCount(),beforeAuthor=authorRead.mock.callCount();
    assert.equal((await request('/api/me/books',null)).status,401);
    users.get(String(user1)).accountStatus='disabled';assert.equal((await request('/api/me/books')).status,401);users.get(String(user1)).accountStatus='active';
    assert.equal((await request('/api/admin/books')).status,403);
    assert.equal((await request('/api/me/books',admin)).status,403);
    assert.equal((await request('/api/me/books/BK001',admin)).status,403);
    assert.equal(authorRead.mock.callCount(),beforeAuthor);
    assert.equal((await request('/api/me/books',unlinked)).status,403);
    assert.equal(find.mock.callCount()+findOne.mock.callCount(),before);
  });
  await t.test('admin lists across authors with explicitly selected safe summaries',async()=>{
    const before=authorRead.mock.callCount(),result=await request('/api/admin/books',admin);
    assert.equal(result.status,200);assert.equal(result.body.pagination.total,3);
    assert.deepEqual(result.body.books.map(book=>book.book_id),['BK001','BK002','BK003']);
    assert.deepEqual(filters.at(-1),{});assert.equal(authorRead.mock.callCount(),before);
    assert.equal(populations.length,1);
    for(const book of result.body.books){assert.deepEqual(Object.keys(book).sort(),[...BOOK_DETAIL_FIELDS,'author'].sort());assert.deepEqual(Object.keys(book.author).sort(),['_id','author_id','name']);}
    assert.equal(JSON.stringify(result.body).includes('PRIVATE'),false);
    assert.ok(selections.every(value=>value.includes('-_id')&&!value.includes('passwordHash')));
  });
  await t.test('pagination supports boundaries, empty pages and scoped totals',async()=>{
    const second=await request('/api/me/books?page=2&limit=1');assert.equal(second.status,200);
    assert.deepEqual(second.body.books.map(book=>book.book_id),['BK003']);assert.deepEqual(second.body.pagination,{page:2,limit:1,total:2,totalPages:2});
    const boundary=await request('/api/admin/books?page=10000&limit=50',admin);assert.equal(boundary.status,200);
    assert.deepEqual(boundary.body.books,[]);assert.deepEqual(boundary.body.pagination,{page:10000,limit:50,total:3,totalPages:1});
    links.set(String(unlinked),id());const empty=await request('/api/me/books',unlinked);
    assert.equal(empty.status,200);assert.deepEqual(empty.body,{books:[],pagination:{page:1,limit:10,total:0,totalPages:0}});links.delete(String(unlinked));
  });
  await t.test('invalid pagination and client ownership/role inputs are rejected on both lists',async()=>{
    const before=filters.length;
    for(const query of ['page=0','page=-1','page=1.5','page=1e2','page=01','page=','page=10001','page=9007199254740992','page=1&page=2','limit=0','limit=-1','limit=1.5','limit=51','limit=','limit=2&limit=3','author_id=AUTH002','author=abc','role=admin']){
      for(const [path,user] of [['/api/me/books',user1],['/api/admin/books',admin]])assert.equal((await request(path+'?'+query,user)).status,400,query);
    }
    assert.equal(filters.length,before);
  });
  await t.test('database failures in author resolution and Book reads use sanitized JSON',async()=>{
    dbError=true;
    for(const [path,user] of [['/api/me/books',user1],['/api/admin/books',admin]]){
      const result=await request(path,user);assert.equal(result.status,500);assert.deepEqual(result.body,{error:'Internal server error'});
    }
    dbError=false;
  });
  await t.test('no write routes are exposed',async()=>{
    for(const method of ['POST','PUT','DELETE'])assert.equal((await request('/api/me/books/BK001',user1,method)).status,404);
  });
});
