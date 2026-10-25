import mongoose from 'mongoose';
import { Ticket, TicketMessage, InternalNote, Book, User } from '../models/index.js';
import { requireTransaction } from '../db/transaction.js';
import { TicketError, transitions } from './validation.js';
import { authorTicketDTO, adminTicketDTO, publicMessageDTO, adminInternalNoteDTO } from '../db/serialization.js';
import { disabledAI, aiFailure, validClassification } from '../ai/service.js';
import { AI_BOOK_FIELDS, bookFacts, unavailableBook } from '../ai/book-context.js';

export const ticketScope = (auth,ticketId) => ({_id:ticketId,...(auth.user.role==='author'?{author:auth.authorId}:{})});
export async function ticketTransaction(work) {
  const session=await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async()=>{requireTransaction(session);result=await work(session);},{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:5000});
    return result;
  } finally {await session.endSession();}
}
// Explicit injection lets an isolated connection exercise the same production logic.
export function createTicketServices({models={Ticket,TicketMessage,InternalNote,Book,User},transaction=ticketTransaction}={}) {
  const {Ticket,TicketMessage,InternalNote,Book,User}=models;
  async function save(document,session) {requireTransaction(session);await document.save({session});}
  async function ownedTicket(auth,ticketId,session) {
    const ticket=await Ticket.findOne(ticketScope(auth,ticketId)).session(session);
    if(!ticket) throw new TicketError(404,'Ticket not found');
    return ticket;
  }
  async function createTicket(auth,input,ai=disabledAI) {
    // Reject foreign/missing book IDs before any paid call. Recheck in the transaction.
    const selectedBook=input.book_id===null?null:await Book.findOne({book_id:input.book_id,author:auth.authorId}).select('_id '+AI_BOOK_FIELDS.join(' ')).lean();
    if(input.book_id!==null&&!selectedBook)throw new TicketError(404,'Book not found');
    const bookContext=selectedBook?bookFacts(selectedBook):unavailableBook('general');
    let classification;
    try {classification=await ai.classify(input,String(auth.user._id),bookContext);} catch {classification=aiFailure('PROVIDER_ERROR');}
    if(!classification||classification.state==='completed'&&!validClassification(classification))classification=aiFailure('INVALID_OUTPUT',1);
    return transaction(async session=>{
      let book=null;
      if(input.book_id!==null) {
        book=await Book.findOne({book_id:input.book_id,author:auth.authorId}).select('_id').session(session);
        if(!book) throw new TicketError(404,'Book not found');
      }
      const ticket=new Ticket({author:auth.authorId,book:book?._id??null,subject:input.subject,description:input.description,category:input.category,categorySource:input.category===null?'pending':'manual'});
      if(classification.state==='completed') {
        ticket.aiClassification={state:'completed',suggestedCategory:classification.category,suggestedPriority:classification.priority,model:classification.model,promptVersion:classification.promptVersion,classifiedAt:classification.classifiedAt,attemptCount:1};
        if(ticket.categorySource!=='manual'){ticket.category=classification.category;ticket.categorySource='ai';}
        ticket.priority=classification.priority;ticket.prioritySource='ai';
      } else ticket.aiClassification=aiFailure(classification.errorCode,classification.attemptCount);
      await save(ticket,session);
      return authorTicketDTO(ticket);
    });
  }
  async function patchTicket(auth,ticketId,input,revision) {
    return transaction(async session=>{
      const ticket=await ownedTicket(auth,ticketId,session);
      if(!Number.isSafeInteger(revision)||revision<0)throw new TicketError(428,'Ticket revision required; refresh ticket details');
      if(ticket.__v!==revision)throw new TicketError(409,'Ticket changed; refresh and reconcile your edits');
      if(Object.hasOwn(input,'assignee')&&input.assignee!==null) {
        const assignee=await User.findOne({_id:input.assignee,role:'admin',accountStatus:'active'}).select('_id').session(session);
        if(!assignee) throw new TicketError(400,'Assignee must be an active admin');
      }
      const now=new Date();
      if(input.status!==undefined&&input.status!==ticket.status) {
        if(!transitions[ticket.status]?.includes(input.status)) throw new TicketError(409,'Invalid ticket status transition');
        ticket.status=input.status;
        if(input.status==='Open'||input.status==='In Progress') {ticket.resolvedAt=null;ticket.closedAt=null;}
        if(input.status==='Resolved') {ticket.resolvedAt=now;ticket.closedAt=null;}
        if(input.status==='Closed') ticket.closedAt=now;
      }
      for(const field of ['category','priority']) if(Object.hasOwn(input,field)) {
        ticket[field]=input[field];ticket[field+'Source']='manual';ticket[field+'OverriddenBy']=auth.user._id;ticket[field+'OverriddenAt']=now;
      }
      if(Object.hasOwn(input,'assignee')) ticket.assignee=input.assignee;
      if(ticket.isModified()) {ticket.lastActivityAt=now;await save(ticket,session);}
      return adminTicketDTO(ticket);
    });
  }
  async function addEntry(auth,ticketId,input,{privateNote=false}={}) {
    // Defense in depth, in addition to router role checks.
    if(privateNote&&auth.user.role!=='admin') throw new TicketError(403,'Forbidden');
    return transaction(async session=>{
      const ticket=await ownedTicket(auth,ticketId,session);
      if(!privateNote&&!['Open','In Progress'].includes(ticket.status)) throw new TicketError(409,'Reopen the ticket before replying');
      const entry=privateNote?new InternalNote({ticket:ticket._id,createdBy:auth.user._id,body:input.body}):new TicketMessage({ticket:ticket._id,sender:auth.user._id,body:input.body});
      await save(entry,session);
      ticket.lastActivityAt=new Date();await save(ticket,session);
      return privateNote?{note:adminInternalNoteDTO(entry)}:{message:publicMessageDTO(entry)};
    });
  }
  return {createTicket,patchTicket,addEntry};
}
const defaults=createTicketServices();
export const createTicket=defaults.createTicket;
export const patchTicket=defaults.patchTicket;
export const addEntry=defaults.addEntry;
