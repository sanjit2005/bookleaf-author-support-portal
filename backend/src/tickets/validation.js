import mongoose from 'mongoose';
import { Ticket, categories, priorities, validDateOnly } from '../models/index.js';
import { pagination } from '../http/pagination.js';

export class TicketError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
export const badRequest = () => {throw new TicketError(400,'Invalid ticket request');};
export const validId = value => typeof value==='string'&&/^[a-f0-9]{24}$/i.test(value);
export const statuses = Object.freeze([...Ticket.schema.path('status').enumValues]);
export const transitions = Object.freeze({
  Open:['In Progress','Resolved','Closed'],
  'In Progress':['Open','Resolved','Closed'],
  Resolved:['In Progress','Closed'],
  Closed:['In Progress'],
});
function bodyShape(body,allowed) {
  if(!body||typeof body!=='object'||Array.isArray(body)||!Object.keys(body).length||Object.keys(body).some(key=>!allowed.includes(key))) badRequest();
}
function text(value,max) {return typeof value==='string'&&value.length<=max&&value.trim().length>0&&!value.includes('\0');}
export function createInput(body) {
  bodyShape(body,['subject','description','category','book_id']);
  if(!text(body.subject,200)||!text(body.description,10000)) badRequest();
  if(Object.hasOwn(body,'category')&&body.category!==null&&!categories.includes(body.category)) badRequest();
  if(Object.hasOwn(body,'book_id')&&body.book_id!==null&&(typeof body.book_id!=='string'||body.book_id.length>200||!/^BK\d+$/.test(body.book_id))) badRequest();
  return {subject:body.subject,description:body.description,category:body.category??null,book_id:body.book_id??null};
}
export function messageInput(body) {
  bodyShape(body,['body']);if(!text(body.body,10000)) badRequest();return {body:body.body};
}
export function patchInput(body) {
  bodyShape(body,['status','priority','category','assignee']);
  for(const [key,values] of [['status',statuses],['priority',priorities],['category',[...categories,null]]]) if(Object.hasOwn(body,key)&&!values.includes(body[key])) badRequest();
  if(Object.hasOwn(body,'assignee')&&body.assignee!==null&&!validId(body.assignee)) badRequest();
  return {...body};
}
export function listInput(query,admin) {
  const paging=pagination(query,admin?['status','priority','category','assignee','startDate','endDate','sort']:['status']);
  if(!paging) badRequest();
  const filter={};
  for(const [key,values] of [['status',statuses],['priority',priorities],['category',categories]]) if(Object.hasOwn(query,key)) {
    if(typeof query[key]!=='string'||!values.includes(query[key])) {
      if(admin&&key==='category'&&query[key]==='unclassified') {filter.category=null;continue;}
      badRequest();
    }
    filter[key]=query[key];
  }
  if(Object.hasOwn(query,'assignee')) {
    if(query.assignee==='unassigned') filter.assignee=null;
    // Aggregation does not apply Mongoose query casting.
    else if(validId(query.assignee)) filter.assignee=new mongoose.Types.ObjectId(query.assignee);
    else badRequest();
  }
  const order=admin?(query.sort??'urgency'):'newest';
  if(!['urgency','newest','oldest'].includes(order)) badRequest();
  if(admin) {
    for(const key of ['startDate','endDate']) if(Object.hasOwn(query,key)&&!validDateOnly(query[key])) badRequest();
    if(query.startDate&&query.endDate&&query.startDate>query.endDate) badRequest();
    // UTC calendar dates: >= start midnight and < midnight after the end date.
    if(query.startDate||query.endDate) {
      filter.createdAt={};
      if(query.startDate) filter.createdAt.$gte=new Date(query.startDate+'T00:00:00.000Z');
      if(query.endDate) filter.createdAt.$lt=new Date(new Date(query.endDate+'T00:00:00.000Z').valueOf()+86400000);
    }
  }
  return {paging,filter,order};
}
export function conversationInput(query,admin=false) {
  if(Object.hasOwn(query,'view')) {
    if(query.view!=='summary'||Object.keys(query).length!==1)badRequest();
    return {summary:true};
  }
  const paging=pagination(query,admin?['notesPage','notesLimit']:[]);
  const notesPaging=admin?pagination({page:query.notesPage??'1',limit:query.notesLimit??'10'}):null;
  if(!paging||admin&&!notesPaging)badRequest();
  return {paging,notesPaging,summary:false};
}
export function noQuery(query) {if(Object.keys(query).length)badRequest();}

// Strong revision precondition: a single quoted, nonnegative safe integer.
export function ticketRevision(value) {
  if(value===undefined)throw new TicketError(428,'Ticket revision required; refresh ticket details');
  if(typeof value!=='string'||!/^"(0|[1-9]\d*)"$/.test(value))badRequest();
  const revision=Number(value.slice(1,-1));
  if(!Number.isSafeInteger(revision))badRequest();
  return revision;
}
