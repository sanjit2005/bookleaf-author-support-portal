import mongoose from 'mongoose';
import { Book, bookStatuses, moneyFields, validDateOnly } from '../models/index.js';
import { validMoney } from '../db/money.js';

export const AI_BOOK_FIELDS=Object.freeze(['title','isbn','genre','publication_date','status','mrp','total_copies_sold','author_royalty_per_copy','total_royalty_earned','royalty_paid','royalty_pending','last_royalty_payout_date']);
export const BOOK_CONTEXT_BYTES=6000;
const textLimits={title:500,isbn:100,genre:200};
export const unavailableBook = (state='unavailable') => ({state,fields:null,missingFields:[]});

// Internal AI allowlist, independent of public DTOs. Never serialize the full document.
export function bookFacts(record) {
  if(!record)return unavailableBook();
  const fields={},missingFields=[];
  for(const key of AI_BOOK_FIELDS) {
    const value=record[key];let safe=null;
    if(value===null){fields[key]=null;continue;}
    if(Object.hasOwn(textLimits,key)) {
      if(typeof value==='string'&&value.length>0&&value.length<=textLimits[key])safe=value;
    } else if(key==='status') {
      if(bookStatuses.includes(value))safe=value;
    } else if(key==='publication_date'||key==='last_royalty_payout_date') {
      if(validDateOnly(value))safe=value;
    } else if(key==='total_copies_sold') {
      if(Number.isSafeInteger(value)&&value>=0)safe=value;
    } else if(moneyFields.includes(key)) {
      const decimal=value?._bsontype==='Decimal128'?value.toString():typeof value==='string'?value:null;
      if(decimal&&decimal.length<=100&&validMoney(decimal))safe=decimal;
    }
    fields[key]=safe;
    if(safe===null)missingFields.push(key);
  }
  const result={state:'available',fields,missingFields};
  return Buffer.byteLength(JSON.stringify(result),'utf8')<=BOOK_CONTEXT_BYTES?result:unavailableBook();
}
export async function loadBookContext(ticket,BookModel=Book) {
  if(ticket.book==null)return unavailableBook('general');
  if(!mongoose.isObjectIdOrHexString(ticket.book)||!mongoose.isObjectIdOrHexString(ticket.author))return unavailableBook();
  try {
    const book=await BookModel.findOne({_id:ticket.book,author:ticket.author}).select(AI_BOOK_FIELDS.join(' ')+' -_id').lean();
    return bookFacts(book);
  } catch {return unavailableBook();}
}
