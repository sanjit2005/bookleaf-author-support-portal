import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Author, Book, User, TicketMessage, InternalNote } from '../src/models/index.js';
import { authorTicketDTO, publicMessageDTO, publicAuthorDTO, publicBookDTO, publicSenderDTO, publicAssigneeDTO } from '../src/db/serialization.js';
import { validMoney } from '../src/db/money.js';
import { seed, requireTransaction } from '../src/seed/run.js';
import { indexedModels, setupIndexes } from '../src/db/indexes.js';
const id = () => new mongoose.Types.ObjectId();
const polluted = () => ({_id:id(),author_id:'AUTH001',book_id:'BK001',name:'Author',title:'Book',isbn:'XXXX',status:'Published & Live',role:'admin',passwordHash:'PRIVATE',credentials:{key:'PRIVATE'},internalNotes:['PRIVATE'],unexpected:{nested:'PRIVATE'},email:'private@example.com',user:{passwordHash:'PRIVATE'}});

test('nested reference DTOs expose only explicitly permitted fields', () => {
  const value = polluted();
  for (const [dto,keys] of [[publicAuthorDTO,['_id','author_id','name']],[publicBookDTO,['_id','book_id','title','isbn','status']],[publicSenderDTO,['_id','role']],[publicAssigneeDTO,['_id','role']]]) {
    assert.deepEqual(Object.keys(dto(value)).sort(),keys.sort());
    assert.ok(!JSON.stringify(dto(value)).includes('PRIVATE'));
    const bare=id();assert.equal(dto(bare),bare.toHexString());assert.equal(dto(null),null);
  }
  const output=authorTicketDTO({author:value,book:value,assignee:value,subject:'Query',internalNotes:['PRIVATE'],credentials:'PRIVATE'});
  assert.deepEqual(Object.keys(output).sort(),['assignee','author','book','subject']);
  assert.ok(!JSON.stringify(output).includes('PRIVATE'));
  assert.throws(()=>publicAuthorDTO({...value,name:{passwordHash:'PRIVATE'}}),TypeError);
});
test('public messages redact populated sender, ticket and attachment internals', () => {
  const message=new TicketMessage({ticket:id(),sender:new User({email:'private@example.com',passwordHash:null}),body:'Reply'});
  assert.deepEqual(Object.keys(publicMessageDTO(message).sender).sort(),['_id','role']);
  const ticketId=id();
  message.toObject=()=>({_id:id(),ticket:{_id:ticketId,internalNotes:['PRIVATE']},sender:polluted(),body:'Reply',internalNotes:['PRIVATE'],passwordHash:'PRIVATE',attachments:[{originalName:'file.pdf',mediaType:'application/pdf',sizeBytes:10,storageKey:'PRIVATE',credentials:{key:'PRIVATE'}}]});
  const output=publicMessageDTO(message);
  assert.equal(output.ticket,ticketId.toHexString());
  assert.deepEqual(output.attachments,[{originalName:'file.pdf',mediaType:'application/pdf',sizeBytes:10}]);
  assert.deepEqual(Object.keys(output).sort(),['_id','attachments','body','sender','ticket']);
  assert.ok(!JSON.stringify(output).includes('PRIVATE'));
  assert.throws(()=>publicMessageDTO(new InternalNote({ticket:id(),createdBy:id(),body:'PRIVATE'})));
});
test('INR validation handles exponent notation exactly and rejects precision/range errors', async () => {
  for(const v of ['0','399','0.01','1E-2','1.2300','100E-2','999999999999.99','0E-6176']) assert.equal(validMoney(mongoose.Types.Decimal128.fromString(v)),true,v);
  for(const v of ['-1','0.001','1E-7','1000000000000','NaN','Infinity','-Infinity','999999999999.991']) assert.equal(validMoney(mongoose.Types.Decimal128.fromString(v)),false,v);
  for(const [value,allowed] of [[null,true],['0.01',true],['399',true],['1.234',false],['1000000000000',false]]) {
    const book=new Book({book_id:'BK999',author:id(),sourceOrder:0,title:'Book',isbn:'XXXX',genre:'Test',status:'Published & Live',available_on:[],total_copies_sold:0,total_royalty_earned:'0',royalty_paid:'0',royalty_pending:'0',mrp:value});
    if(allowed) await book.validate(); else await assert.rejects(book.validate());
    book.total_royalty_earned=null;await assert.rejects(book.validate());
  }
});
test('missing, ended or inactive transaction fails before reads or writes',async t=>{
  const read=t.mock.method(Author,'find',()=>{throw new Error('Unexpected read');});
  const save=t.mock.method(Author.prototype,'save',()=>{throw new Error('Unexpected write');});
  for(const session of [undefined,null,{}, {inTransaction:()=>false},{inTransaction:()=>true,hasEnded:true},{inTransaction:()=>1}]) await assert.rejects(seed({},session),/active transaction/);
  assert.equal(read.mock.callCount(),0);assert.equal(save.mock.callCount(),0);
});
test('driver session state is checked without connecting',async()=>{
  const client=new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27017');
  const session=client.startSession();
  assert.throws(()=>requireTransaction(session),/active transaction/);
  session.startTransaction();requireTransaction(session);
  await session.abortTransaction();assert.throws(()=>requireTransaction(session),/active transaction/);
  await session.endSession();assert.throws(()=>requireTransaction(session),/active transaction/);
  assert.equal(mongoose.connection.readyState,0);
});
test('transaction state is rechecked immediately before insertion',async t=>{
  let active=true;
  const session={inTransaction:()=>active};
  t.mock.method(Author,'find',()=>({session:async()=>[]}));
  t.mock.method(Book,'find',()=>({session:async()=>{active=false;return [];}}));
  const save=t.mock.method(Author.prototype,'save',()=>{throw new Error('Unexpected write');});
  await assert.rejects(seed({authors:[{author_id:'AUTH001'}],books:[]},session),/active transaction/);
  assert.equal(save.mock.callCount(),0);
});
test('index setup covers all six models in deterministic order without dropping',async t=>{
  const calls=[];
  assert.deepEqual(indexedModels.map(m=>m.modelName),['User','Author','Book','Ticket','TicketMessage','InternalNote']);
  for(const model of indexedModels) {
    assert.ok(model.schema.indexes().length>0);
    assert.equal(model.schema.options.autoIndex,false);
    t.mock.method(model,'createIndexes',async()=>calls.push(model.modelName));
    t.mock.method(model,'syncIndexes',()=>{throw new Error('Must not drop indexes');});
  }
  await setupIndexes();await setupIndexes();
  assert.deepEqual(calls,[...indexedModels,...indexedModels].map(m=>m.modelName));
});

test('index setup stops on conflict without continuing to later models',async t=>{
  const calls=[];
  for(const model of indexedModels) t.mock.method(model,'createIndexes',async()=>{calls.push(model.modelName);if(model===Author)throw new Error('Index conflict');});
  await assert.rejects(setupIndexes(),/Index conflict/);
  assert.deepEqual(calls,['User','Author']);
});
