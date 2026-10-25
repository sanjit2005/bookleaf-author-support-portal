import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Author, Book, moneyFields } from '../models/index.js';
import { serialize } from '../db/serialization.js';
export const checksum = '34fd3b03f4b26e68b466a6364c3b7fe2f3884d3d7dc65134b67cac8e006b59f8';
export const authorFields = ['author_id','name','email','phone','city','joined_date'];
export const bookFields = ['book_id','title','isbn','genre','publication_date','status','mrp','author_royalty_per_copy','total_copies_sold','total_royalty_earned','royalty_paid','royalty_pending','last_royalty_payout_date','print_partner','available_on'];
function exactKeys(obj,keys) { if(!obj || typeof obj!=='object' || Array.isArray(obj) || Object.keys(obj).sort().join('|')!==[...keys].sort().join('|')) throw new Error('Unexpected or missing source fields'); }
export async function readSource(path) {
 if(!path) throw new Error('Set SAMPLE_DATA_PATH or supply a source path');
 const raw = await readFile(path);
 if(createHash('sha256').update(raw).digest('hex')!==checksum) throw new Error('Source fingerprint differs; review before importing');
 return transformSource(JSON.parse(raw.toString('utf8')));
}
export async function transformSource(data) {
 exactKeys(data,['authors']);
 if(!Array.isArray(data.authors)||data.authors.length!==10) throw new Error('Expected 10 authors');
 const authors=[],books=[],ids=new Set(),bookIds=new Set(),emails=new Set();
 for(const a of data.authors) {
  exactKeys(a,[...authorFields,'books']);
  if(authorFields.some(k=>typeof a[k]!=='string')||!Array.isArray(a.books)) throw new Error('Invalid author source types');
  if(ids.has(a.author_id)||emails.has(a.email.toLowerCase())) throw new Error('Duplicate author identity');
  ids.add(a.author_id);emails.add(a.email.toLowerCase());
  const profile=Object.fromEntries(authorFields.map(k=>[k,a[k]]));
  const author=new Author(profile);await author.validate();authors.push(profile);
  for(const [sourceOrder,b] of a.books.entries()) {
   exactKeys(b,bookFields);
   if(bookIds.has(b.book_id)) throw new Error('Duplicate book ID');bookIds.add(b.book_id);
   for(const k of bookFields) {
    const v=b[k];
    if(moneyFields.includes(k)||k==='total_copies_sold') {
     if(v===null && ['mrp','author_royalty_per_copy'].includes(k)) continue;
     if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0) throw new Error(`Invalid numeric source field: ${k}`);
    } else if(k==='available_on') {if(!Array.isArray(v)||v.some(x=>typeof x!=='string')) throw new Error('Invalid availability');}
    else if(v===null && ['publication_date','last_royalty_payout_date','print_partner'].includes(k)) continue;
    else if(typeof v!=='string') throw new Error(`Invalid source type: ${k}`);
   }
   const mapped={...b,sourceOrder,author_id:a.author_id};
   const fields=bookPayload(mapped,author._id);await new Book(fields).validate();books.push(mapped);
  }
 }
 if(books.length!==18) throw new Error('Expected 18 books');
 return {authors,books};
}
export function bookPayload(book,author) {
 const payload=Object.fromEntries(bookFields.map(k=>[k,moneyFields.includes(k)&&book[k]!==null?mongoose.Types.Decimal128.fromString(String(book[k])):book[k]]));
 return {...payload,author,sourceOrder:book.sourceOrder};
}
export function conflicts(existing,expected,fields) {
 const a=serialize(existing),b=serialize(expected);
 return fields.filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
}
