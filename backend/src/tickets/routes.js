import { Router } from 'express';
import mongoose from 'mongoose';
import { Ticket, TicketMessage, InternalNote, Book } from '../models/index.js';
import { authenticate, requireRole, resolveAuthor } from '../auth/middleware.js';
import { authorTicketDTO, adminTicketDTO, publicMessageDTO, adminInternalNoteDTO } from '../db/serialization.js';
import { pageMetadata } from '../http/pagination.js';
import { TicketError, badRequest, validId, createInput, messageInput, patchInput, listInput, conversationInput, noQuery, ticketRevision } from './validation.js';
import { ticketScope, createTicket, patchTicket, addEntry } from './service.js';
import { disabledAI, AI_LIMITS } from '../ai/service.js';
import { adminQueuePipeline } from './queue.js';
import { historyInput, historyFilter, historyCursor } from './history.js';
import { loadBookContext } from '../ai/book-context.js';

const publicFields='_id author book subject description category priority status assignee createdAt updatedAt lastActivityAt resolvedAt closedAt';
const adminFields=publicFields+' categorySource prioritySource categoryOverriddenBy priorityOverriddenBy categoryOverriddenAt priorityOverriddenAt aiClassification __v';
const ticketPopulation=[
    {path:'author',select:'author_id name'},
    {path:'book',select:'book_id title isbn status'},
    {path:'assignee',select:'role'},
];
export function createTicketsRouter({models={Ticket,TicketMessage,InternalNote,Book},auth={authenticate,requireRole,resolveAuthor},services={createTicket,patchTicket,addEntry}}={}) {
  const {Ticket,TicketMessage,InternalNote,Book}=models;
  const {authenticate,requireRole,resolveAuthor}=auth;
  const {createTicket,patchTicket,addEntry}=services;
  function ticketQuery(query,admin) {
    return query.select(admin?adminFields:publicFields).populate(ticketPopulation);
  }
  async function list(req,res,admin) {
    const {paging,filter,order}=listInput(req.query,admin);
    if(!admin) filter.author=req.auth.authorId;
    const [records,total]=await Promise.all([
      admin
        ? Ticket.aggregate(adminQueuePipeline(filter,paging,order,adminFields.split(' ')),{allowDiskUse:true})
        : ticketQuery(Ticket.find(filter),false).sort({createdAt:-1,_id:-1}).skip(paging.offset).limit(paging.limit).lean(),
      Ticket.countDocuments(filter),
    ]);
    const tickets=admin?await Ticket.populate(records,ticketPopulation):records;
    res.json({tickets:tickets.map(admin?adminTicketDTO:authorTicketDTO),pagination:pageMetadata(paging,total)});
  }
  async function detail(req,res,admin) {
    const {paging,notesPaging,summary}=conversationInput(req.query,admin);
    const ticket=await ticketQuery(Ticket.findOne(ticketScope(req.auth,req.params.ticketId)),admin).lean();
    if(!ticket) throw new TicketError(404,'Ticket not found');
    if(summary)return res.json({ticket:(admin?adminTicketDTO:authorTicketDTO)(ticket)});
    const filter={ticket:ticket._id};
    const [messages,total]=await Promise.all([
      TicketMessage.find(filter).select('_id ticket sender body sentAt createdAt attachments').populate({path:'sender',select:'role'}).sort({createdAt:1,_id:1}).skip(paging.offset).limit(paging.limit),
      TicketMessage.countDocuments(filter),
    ]);
    const result={ticket:(admin?adminTicketDTO:authorTicketDTO)(ticket),messages:messages.map(publicMessageDTO),pagination:pageMetadata(paging,total)};
    if(admin) {
      const [notes,noteTotal]=await Promise.all([
        InternalNote.find(filter).select('_id ticket createdBy body createdAt updatedAt').populate({path:'createdBy',select:'role'}).sort({createdAt:1,_id:1}).skip(notesPaging.offset).limit(notesPaging.limit),
        InternalNote.countDocuments(filter),
      ]);
      result.notes=notes.map(adminInternalNoteDTO);result.notesPagination=pageMetadata(notesPaging,noteTotal);
    }
    res.json(result);
  }
  async function history(req,res,privateNotes=false) {
    const {limit,before}=historyInput(req.query);
    const ticket=await Ticket.findOne(ticketScope(req.auth,req.params.ticketId)).select('_id').lean();
    if(!ticket)throw new TicketError(404,'Ticket not found');
    const Model=privateNotes?InternalNote:TicketMessage;
    const fields=privateNotes?'_id ticket createdBy body createdAt updatedAt':'_id ticket sender body sentAt createdAt attachments';
    const entries=await Model.find(historyFilter(ticket._id,before)).select(fields)
      .populate({path:privateNotes?'createdBy':'sender',select:'role'})
      .sort({createdAt:-1,_id:-1}).limit(limit+1);
    const hasMore=entries.length>limit,items=entries.slice(0,limit);
    res.json({[privateNotes?'notes':'messages']:items.map(privateNotes?adminInternalNoteDTO:publicMessageDTO),
      pagination:{limit,hasMore,nextCursor:hasMore?historyCursor(items.at(-1)):null}});
  }
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use('/me/tickets',authenticate,requireRole('author'),resolveAuthor);
  router.use('/admin/tickets',authenticate,requireRole('admin'));
  router.param('ticketId',(_req,_res,next,value)=>{if(!validId(value))badRequest();next();});
  router.get('/me/tickets',(req,res)=>list(req,res,false));
  router.get('/admin/tickets',(req,res)=>list(req,res,true));
  router.post('/me/tickets',async(req,res)=>{
    noQuery(req.query);const input=createInput(req.body);
    res.status(201).json({ticket:await createTicket(req.auth,input,req.app.locals.aiService??disabledAI)});
  });
  router.get('/me/tickets/:ticketId',(req,res)=>detail(req,res,false));
  router.get('/admin/tickets/:ticketId',(req,res)=>detail(req,res,true));
  router.get('/me/tickets/:ticketId/messages',(req,res)=>history(req,res));
  router.get('/admin/tickets/:ticketId/messages',(req,res)=>history(req,res));
  router.get('/admin/tickets/:ticketId/notes',(req,res)=>history(req,res,true));
  router.patch('/admin/tickets/:ticketId',async(req,res)=>{
    noQuery(req.query);const input=patchInput(req.body);
    res.json({ticket:await patchTicket(req.auth,req.params.ticketId,input,ticketRevision(req.get('If-Match')))});
  });
  router.post('/admin/tickets/:ticketId/draft',async(req,res)=>{
    noQuery(req.query);
    if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))badRequest();
    const ticket=await Ticket.findOne({_id:req.params.ticketId}).select('subject description book author').lean();
    if(!ticket)throw new TicketError(404,'Ticket not found');
    const [messages,bookContext]=await Promise.all([
      TicketMessage.find({ticket:ticket._id}).select('body').sort({createdAt:-1,_id:-1}).limit(AI_LIMITS.history+1).lean(),
      loadBookContext(ticket,Book),
    ]);
    const result=await (req.app.locals.aiService??disabledAI).draft(ticket,messages,String(req.auth.user._id),bookContext);
    if(result.state!=='completed')return res.status(503).json({error:'AI draft unavailable; write a manual reply',code:result.errorCode});
    res.json({draft:result.draft,requiresReview:true,contextWarnings:result.contextWarnings??[]});
  });
  for(const path of ['/me/tickets/:ticketId/messages','/admin/tickets/:ticketId/messages','/admin/tickets/:ticketId/notes']) {
    router.post(path,async(req,res)=>{
      noQuery(req.query);const input=messageInput(req.body);
      res.status(201).json(await addEntry(req.auth,req.params.ticketId,input,{privateNote:path.endsWith('/notes')}));
    });
  }
  router.use((error,_req,res,next)=>{
    if(error instanceof TicketError) return res.status(error.status).json({error:error.message});
    if(error instanceof mongoose.Error.ValidationError) return res.status(400).json({error:'Invalid ticket request'});
    if(error instanceof mongoose.Error.VersionError) return res.status(409).json({error:'Ticket changed; retry request'});
    next(error);
  });
  return router;
}
