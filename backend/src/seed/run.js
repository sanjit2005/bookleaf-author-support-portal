import { pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { Author, Book } from '../models/index.js';
import { readSource, authorFields, bookFields, bookPayload, conflicts } from './source.js';
import { requireTransaction } from '../db/transaction.js';
export { requireTransaction } from '../db/transaction.js';
// Only inserts: no update/replace/delete operation is used. Transactions prevent partial imports.
export async function seed(source, session) {
 requireTransaction(session);
 const options={session};
 const authors=new Map((await Author.find({author_id:{$in:source.authors.map(a=>a.author_id)}}).session(session)).map(a=>[a.author_id,a]));
 const books=new Map((await Book.find({book_id:{$in:source.books.map(b=>b.book_id)}}).session(session)).map(b=>[b.book_id,b]));
 const issues=[];
 for(const a of source.authors) {const old=authors.get(a.author_id);if(old){const keys=conflicts(old,a,authorFields);if(keys.length) issues.push(`${a.author_id}: ${keys.join(',')}`);}else authors.set(a.author_id,new Author(a));}
 const prepared=source.books.map(b=>new Book(bookPayload(b,authors.get(b.author_id)._id)));
 for(const b of prepared) {const old=books.get(b.book_id);if(old){const keys=conflicts(old,b,[...bookFields,'author','sourceOrder']);if(keys.length) issues.push(`${b.book_id}: ${keys.join(',')}`);}}
 if(issues.length) throw new Error(`Seed conflicts: ${issues.join('; ')}`);
 let insertedAuthors=0,insertedBooks=0;
 for(const a of authors.values()) if(a.isNew){requireTransaction(session);await a.save(options);insertedAuthors++;}
 for(const b of prepared) if(!books.has(b.book_id)){requireTransaction(session);await b.save(options);insertedBooks++;}
 for(const b of prepared){const saved=await Book.findOne({book_id:b.book_id}).session(session);if(!saved||conflicts(saved,b,[...bookFields,'author','sourceOrder']).length) throw new Error(`Readback failed: ${b.book_id}`);}
 for(const a of source.authors){const saved=await Author.findOne({author_id:a.author_id}).session(session);if(!saved||conflicts(saved,a,authorFields).length) throw new Error(`Readback failed: ${a.author_id}`);}
 return {insertedAuthors,insertedBooks,skippedAuthors:10-insertedAuthors,skippedBooks:18-insertedBooks};
}
async function main(){
 const source=await readSource(process.argv.slice(2).find(arg=>!arg.startsWith('--'))||process.env.SAMPLE_DATA_PATH);
 if(process.argv.includes('--validate-only')){console.log('Source validated: 10 authors, 18 books; no connection opened');return;}
 const db=await connectDatabase();
 try {
  await Author.createIndexes();await Book.createIndexes();
  const session=await db.startSession();
  try {let result;await session.withTransaction(async()=>{result=await seed(source,session);});console.log(JSON.stringify(result));}
  finally {await session.endSession();}
 }finally{await disconnectDatabase();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message.startsWith('Seed conflicts:')?error.message:'Seed failed (no credentials logged). Check source path/fingerprint, MONGODB_URI, indexes and transaction support.');process.exitCode=1;});
