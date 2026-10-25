import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { User, Author, Book, Ticket, TicketMessage, InternalNote, validDateOnly, moneyFields } from '../src/models/index.js';
import { readSource, transformSource, conflicts, authorFields, bookFields, bookPayload } from '../src/seed/source.js';
import { serialize, authorTicketDTO, publicMessageDTO } from '../src/db/serialization.js';
import { connectDatabase } from '../src/db/connection.js';
const id=()=>new mongoose.Types.ObjectId();
const path=process.env.SAMPLE_DATA_PATH;
test('imports do not connect; invalid connection configuration fails locally',async()=>{assert.equal(mongoose.connection.readyState,0);await assert.rejects(connectDatabase(''),/required/);assert.equal(mongoose.connection.readyState,0);});
test('real calendar dates remain date-only',()=>{assert.ok(validDateOnly('2024-02-29'));for(const v of ['2023-02-29','2024-02-30','2024-13-01','2024-01-01T00:00:00Z'])assert.equal(validDateOnly(v),false);});
test('user requires hash when active, rejects plaintext, hides hash in JSON',async()=>{await new User({email:'a@example.com'}).validate();await assert.rejects(new User({email:'a@example.com',accountStatus:'active'}).validate());await assert.rejects(new User({email:'a@example.com',passwordHash:'plaintext'}).validate());assert.equal(new User({email:'a@example.com',passwordHash:null}).toJSON().passwordHash,undefined);});
test('ticket defaults and private note serialization boundary',async()=>{const t=new Ticket({author:id(),subject:'Help',description:'Details'});await t.validate();assert.equal(t.category,null);assert.equal(t.aiClassification.state,'pending');assert.equal(t.priority,'Medium');const n=new InternalNote({ticket:t._id,createdBy:id(),body:'Private'});await n.validate();assert.throws(()=>publicMessageDTO(n));assert.equal(authorTicketDTO({...t.toObject(),internalNotes:[n]}).internalNotes,undefined);const m=new TicketMessage({ticket:t._id,sender:id(),body:'Reply'});await m.validate();assert.equal(publicMessageDTO(m).body,'Reply');assert.throws(()=>new TicketMessage({ticket:id(),sender:id(),body:'Reply',private:true}));});
test('text, enums, AI completion and unknown fields are validated',async()=>{for(const patch of [{subject:' '},{subject:'a'.repeat(201)},{status:'bad'},{category:'bad'},{aiClassification:{state:'completed'}}])await assert.rejects(new Ticket({author:id(),subject:'Help',description:'Details',...patch}).validate());assert.throws(()=>new Author({unexpected:true}));});
test('unique and privacy indexes are declared',()=>{assert.ok(Author.schema.indexes().some(([keys,opts])=>keys.author_id&&opts.unique));assert.ok(Author.schema.indexes().some(([keys,opts])=>keys.user&&opts.partialFilterExpression));assert.notEqual(TicketMessage.collection.name,InternalNote.collection.name);});
test('actual source round-trips all 10 authors and 18 books', {skip:!path&&'Set SAMPLE_DATA_PATH to run original-file checks'},async()=>{const source=await readSource(path);const raw=JSON.parse(await readFile(path,'utf8'));assert.equal(source.authors.length,10);assert.equal(source.books.length,18);let nullPayout=0;for(const a of raw.authors){const mapped=source.authors.find(x=>x.author_id===a.author_id);assert.deepEqual(mapped,Object.fromEntries(authorFields.map(k=>[k,a[k]])));const author=id();for(const [index,b] of a.books.entries()){const mappedBook=source.books.find(x=>x.book_id===b.book_id);const doc=new Book(bookPayload(mappedBook,author));await doc.validate();assert.equal(doc.sourceOrder,index);const out=serialize(doc);for(const k of bookFields)assert.deepEqual(out[k],moneyFields.includes(k)&&b[k]!==null?String(b[k]):b[k],`${b.book_id}.${k}`);assert.ok(out.isbn.includes('XXXX'));if(out.last_royalty_payout_date===null)nullPayout++;assert.deepEqual(conflicts(doc,bookPayload(mappedBook,author),[...bookFields,'author','sourceOrder']),[]);assert.deepEqual(conflicts(doc,{...bookPayload(mappedBook,author),title:'Changed'},bookFields),['title']);assert.deepEqual(conflicts(doc,bookPayload(mappedBook,id()),['author']),['author']);}}
assert.equal(nullPayout,6);
for(const mutate of [d=>delete d.authors[0].phone,d=>d.authors[0].books[0].extra=1,d=>d.authors[0].books[0].mrp='399',d=>d.authors[1].author_id=d.authors[0].author_id,d=>d.authors[0].books[0].total_copies_sold=-1,d=>d.authors[0].books[0].publication_date='2023-02-30']){const bad=structuredClone(raw);mutate(bad);await assert.rejects(transformSource(bad));}
const production=new Book(bookPayload(source.books.find(x=>x.book_id==='BK013'),id()));production.mrp='NaN';await assert.rejects(production.validate());
});

test('seed skips identical records and stops before saves on conflict', {skip:!path&&'Set SAMPLE_DATA_PATH'},async(t)=>{
 const {seed}=await import('../src/seed/run.js');
 const source=await readSource(path);
 const authors=source.authors.map(a=>new Author(a));
 const books=source.books.map(b=>new Book(bookPayload(b,authors.find(a=>a.author_id===b.author_id)._id)));
 for(const d of [...authors,...books]) d.isNew=false;
 t.mock.method(Author,'find',()=>({session:async()=>authors}));
 t.mock.method(Book,'find',()=>({session:async()=>books}));
 t.mock.method(Author,'findOne',q=>({session:async()=>authors.find(a=>a.author_id===q.author_id)}));
 t.mock.method(Book,'findOne',q=>({session:async()=>books.find(b=>b.book_id===q.book_id)}));
 const saveAuthor=t.mock.method(Author.prototype,'save',()=>{throw new Error('Unexpected write');});
 const saveBook=t.mock.method(Book.prototype,'save',()=>{throw new Error('Unexpected write');});
 assert.deepEqual(await seed(source,{inTransaction:()=>true}),{insertedAuthors:0,insertedBooks:0,skippedAuthors:10,skippedBooks:18});
 books[0].title='Existing changed title';
 await assert.rejects(seed(source,{inTransaction:()=>true}),/Seed conflicts: BK001: title/);
 assert.equal(saveAuthor.mock.callCount(),0);assert.equal(saveBook.mock.callCount(),0);
});
