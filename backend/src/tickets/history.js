import mongoose from 'mongoose';
import { pagination } from '../http/pagination.js';
import { badRequest, validId } from './validation.js';

export function historyCursor(entry) {
  return Buffer.from(JSON.stringify([entry.createdAt.toISOString(),String(entry._id)])).toString('base64url');
}
export function historyInput(query) {
  if(Object.keys(query).some(key=>!['before','limit'].includes(key)))badRequest();
  const paging=pagination({limit:query.limit??'10'});
  if(!paging)badRequest();
  let before=null;
  if(Object.hasOwn(query,'before')) {
    try {
      const value=query.before;
      if(typeof value!=='string'||value.length>160||!value.length||!/^[a-zA-Z0-9_-]+$/.test(value))throw new Error();
      const decoded=Buffer.from(value,'base64url');
      if(decoded.toString('base64url')!==value)throw new Error();
      const pair=JSON.parse(decoded.toString('utf8'));
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||!validId(pair[1]))throw new Error();
      const date=new Date(pair[0]);
      if(Number.isNaN(date.valueOf())||date.toISOString()!==pair[0])throw new Error();
      before={createdAt:date,_id:new mongoose.Types.ObjectId(pair[1])};
    } catch {badRequest();}
  }
  return {limit:paging.limit,before};
}
export function historyFilter(ticket,before) {
  return {ticket,...(before?{$or:[
    {createdAt:{$lt:before.createdAt}},
    {createdAt:before.createdAt,_id:{$lt:before._id}},
  ]}:{})};
}
