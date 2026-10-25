import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { categories, priorities } from '../models/index.js';
import { PROMPT_VERSION } from './knowledge-base.js';
import { AI_BOOK_FIELDS, bookFacts, unavailableBook } from './book-context.js';
import { instructions } from './prompts.js';
import { safeDraft } from './draft-safety.js';

export const AI_LIMITS=Object.freeze({timeoutMs:12000,subject:200,description:4000,history:6,message:700,maxDraft:3000,responseBytes:65536});
export const DEFAULT_AI_MODEL='gemini-3.5-flash-lite';
const safeCodes=new Set(['UNAVAILABLE','TIMEOUT','RATE_LIMIT','PROVIDER_ERROR','INVALID_OUTPUT','LOCAL_LIMIT']);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function aiFailure(code='UNAVAILABLE',attemptCount=0) {
  return {state:'failed',errorCode:safeCodes.has(code)?code:'PROVIDER_ERROR',attemptCount:attemptCount===1?1:0};
}
export const validClassification = value => value?.state==='completed'&&categories.includes(value.category)&&priorities.includes(value.priority)&&typeof value.model==='string'&&/^[a-z0-9][a-z0-9.-]{0,99}$/.test(value.model)&&value.promptVersion===PROMPT_VERSION&&value.classifiedAt instanceof Date&&!Number.isNaN(value.classifiedAt.valueOf());
export function boundedContext(ticket,messages=[],book=unavailableBook('general')) {
  const subject=String(ticket.subject??''),description=String(ticket.description??'');
  const verifiedBook=book.state==='available'?bookFacts(book.fields):unavailableBook(book.state==='general'?'general':'unavailable');
  if(verifiedBook.fields&&Array.isArray(book.missingFields))verifiedBook.missingFields=[...new Set([...verifiedBook.missingFields,...book.missingFields.filter(key=>AI_BOOK_FIELDS.includes(key))])];
  return {subject:subject.slice(0,AI_LIMITS.subject),description:description.slice(0,AI_LIMITS.description),
    // Caller supplies newest first; send only the six latest, in chronological order.
    conversation:messages.slice(0,AI_LIMITS.history).reverse().map(message=>({body:String(message.body??'').slice(0,AI_LIMITS.message)})),
    verifiedBook,contextQuality:{subjectTruncated:subject.length>AI_LIMITS.subject,descriptionTruncated:description.length>AI_LIMITS.description,
      historyTruncated:messages.length>AI_LIMITS.history,messageTruncated:messages.slice(0,AI_LIMITS.history).some(message=>String(message.body??'').length>AI_LIMITS.message),
      unavailableBookFields:verifiedBook.fields?Object.keys(verifiedBook.fields).filter(key=>verifiedBook.fields[key]===null):[]}};
}
function contextWarnings(context) {
  const quality=context.contextQuality;
  return [quality.subjectTruncated&&'SUBJECT_TRUNCATED',quality.descriptionTruncated&&'DESCRIPTION_TRUNCATED',quality.historyTruncated&&'HISTORY_TRUNCATED',quality.messageTruncated&&'MESSAGE_TRUNCATED',context.verifiedBook.state==='unavailable'&&'BOOK_UNAVAILABLE',quality.unavailableBookFields.length>0&&'BOOK_FIELDS_UNAVAILABLE'].filter(Boolean);
}
const classificationSchema={type:'object',properties:{category:{type:'string',enum:categories},priority:{type:'string',enum:priorities}},required:['category','priority'],additionalProperties:false};
const draftSchema={type:'object',properties:{draft:{type:'string'}},required:['draft'],additionalProperties:false};
export function createAIService({apiKey='',model=DEFAULT_AI_MODEL,fetchImpl=globalThis.fetch,timeoutMs=AI_LIMITS.timeoutMs}={}) {
  const buckets=new Map();let active=0;
  async function request(kind,context,budgetKey) {
    if(!apiKey) return {ok:false,...aiFailure()};
    const now=Date.now();
    for(const [key,bucket] of buckets)if(bucket.until<=now)buckets.delete(key);
    const bucket=buckets.get(budgetKey)??{count:0,until:now+15*60*1000};
    if(bucket.count>=20||active>=4||(!buckets.has(budgetKey)&&buckets.size>=1000))return {ok:false,...aiFailure('LOCAL_LIMIT')};
    bucket.count++;buckets.set(budgetKey,bucket);active++;
    const controller=new AbortController();let timer;
    try {
      const operation=async()=>{
        let dispatched=false;
        // Explicit Developer API client: never inherit Vertex/project credentials.
        // Keep the injected fetch boundary so offline tests exercise the real SDK
        // serializers without network access. It also bounds the entire body.
        const client=new GoogleGenAI({apiKey,enterprise:false,apiVersion:'v1beta',httpOptions:{
          baseUrl:'https://generativelanguage.googleapis.com',timeout:timeoutMs,retryOptions:{attempts:1},
          fetch:async(url,options)=>{
            if(dispatched||new URL(url).origin!=='https://generativelanguage.googleapis.com')throw new Error();
            dispatched=true;
            const response=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal}).catch(()=>{throw new Error('Provider request failed');});
            if(!response.ok) {
              await response.body?.cancel();
              // SDK receives only a synthetic error envelope; raw provider error
              // text (which can contain request details) is discarded, not logged.
              return new Response(JSON.stringify({error:{code:response.status,message:'Provider request failed'}}),{status:response.status,headers:{'Content-Type':'application/json'}});
            }
            const reader=response.body?.getReader();if(!reader)throw new Error();
            let size=0;const chunks=[];
            try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>AI_LIMITS.responseBytes)throw Object.assign(new Error(),{invalidOutput:true});chunks.push(Buffer.from(value));}}
            finally {await reader.cancel();}
            return new Response(Buffer.concat(chunks),{headers:{'Content-Type':'application/json'}});
          },
        }});
        let result;
        try {
          result=await client.models.generateContent({model,contents:[{role:'user',parts:[{text:JSON.stringify(context)}]}],config:{
            systemInstruction:instructions(kind),responseMimeType:'application/json',responseJsonSchema:kind==='classification'?classificationSchema:draftSchema,
            maxOutputTokens:kind==='classification'?128:800,candidateCount:1,store:false,
            thinkingConfig:{thinkingLevel:ThinkingLevel.MINIMAL,includeThoughts:false},
            automaticContinuation:false,automaticFunctionCalling:{disable:true},abortSignal:controller.signal,
          }});
        } catch(error) {return {ok:false,...aiFailure(controller.signal.aborted?'TIMEOUT':error.status===429?'RATE_LIMIT':error.invalidOutput?'INVALID_OUTPUT':'PROVIDER_ERROR',1)};}
        if(result.promptFeedback?.blockReason||!Array.isArray(result.candidates)||result.candidates.length!==1)throw new Error();
        const candidate=result.candidates[0],parts=candidate.content?.parts;
        if(candidate.finishReason!=='STOP'||!Array.isArray(parts)||parts.length!==1||typeof parts[0].text!=='string'||parts[0].thought===true||parts[0].text.includes(apiKey))throw new Error();
        const value=JSON.parse(parts[0].text);
        const valid=kind==='classification'
          ? exact(value,['category','priority'])&&categories.includes(value.category)&&priorities.includes(value.priority)
          : exact(value,['draft'])&&typeof value.draft==='string'&&value.draft.trim().length>0&&value.draft.length<=AI_LIMITS.maxDraft&&!value.draft.includes('\0')&&safeDraft(value.draft);
        if(!valid)throw new Error();
        return {ok:true,state:'completed',...value,model,promptVersion:PROMPT_VERSION,classifiedAt:new Date(),attemptCount:1,contextWarnings:contextWarnings(context)};
      };
      const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({ok:false,...aiFailure('TIMEOUT',1)});},timeoutMs);});
      // Deadline covers response-body reads too. Race also makes test/noncompliant fetch adapters bounded.
      return await Promise.race([operation().catch(error=>({ok:false,...aiFailure(controller.signal.aborted?'TIMEOUT':error.code==='PROVIDER_ERROR'?'PROVIDER_ERROR':'INVALID_OUTPUT',1)})),deadline]);
    } catch {return {ok:false,...aiFailure('PROVIDER_ERROR',1)};}
    finally {clearTimeout(timer);active--;}
  }
  return Object.freeze({
    classify:(ticket,budgetKey='local',book)=>request('classification',boundedContext(ticket,[],book),budgetKey),
    draft:(ticket,messages=[],budgetKey='local',book)=>request('draft',boundedContext(ticket,messages,book),budgetKey),
  });
}
export const disabledAI=createAIService();
