export function serialize(value) {
  if (value == null) return value;
  if (value._bsontype === 'Decimal128') return value.toString();
  if (value._bsontype === 'ObjectId') return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value.toObject) return serialize(value.toObject());
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,serialize(v)]));
  return value;
}
// Shape filtering is not authorization: services must scope records to the caller.
function raw(value) { return value?.toObject ? value.toObject({ depopulate: false }) : value; }
function id(value) {
  if (value == null) return value;
  if (value._bsontype === 'ObjectId') return value.toHexString();
  if (typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)) return value;
  throw new TypeError('Expected an ObjectId reference');
}
function scalar(value) {
  if (value == null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.toISOString();
  throw new TypeError('Unexpected nested value in public scalar field');
}
function pick(value, fields) {
  const source = raw(value);
  return Object.fromEntries(fields.filter(k => Object.hasOwn(source,k)).map(k => [k,k === '_id' ? id(source[k]) : scalar(source[k])]));
}
function reference(value, fields) {
  if (value == null || value._bsontype === 'ObjectId' || typeof value === 'string') return id(value);
  return pick(value,fields);
}
export const publicAuthorDTO = value => reference(value,['_id','author_id','name']);
export const publicBookDTO = value => reference(value,['_id','book_id','title','isbn','status']);
export const publicSenderDTO = value => reference(value,['_id','role']);
export const publicAssigneeDTO = value => reference(value,['_id','role']);
export const publicUserDTO = value => pick(value,['_id','email','role']);
export const BOOK_DETAIL_FIELDS = Object.freeze(['book_id','title','isbn','genre','publication_date','status','mrp','author_royalty_per_copy','total_copies_sold','total_royalty_earned','royalty_paid','royalty_pending','last_royalty_payout_date','print_partner','available_on']);
const bookMoneyFields = ['mrp','author_royalty_per_copy','total_royalty_earned','royalty_paid','royalty_pending'];
export function bookDetailsDTO(book,{includeAuthor=false}={}) {
  const source=raw(book);
  const result=pick(source,BOOK_DETAIL_FIELDS.filter(k=>!bookMoneyFields.includes(k)&&k!=='available_on'));
  for(const key of bookMoneyFields) {
    const value=source[key];
    if(value===null) result[key]=null;
    else if(value?._bsontype==='Decimal128') result[key]=value.toString();
    else if(typeof value==='string') result[key]=value;
    else throw new TypeError('Expected an exact decimal book amount');
  }
  if(!Array.isArray(source.available_on)||source.available_on.some(v=>typeof v!=='string')) throw new TypeError('Invalid public availability');
  result.available_on=[...source.available_on];
  if(includeAuthor) result.author=publicAuthorDTO(source.author);
  return result;
}
function referenceId(value) {
  if (value == null || value._bsontype === 'ObjectId' || typeof value === 'string') return id(value);
  return id(raw(value)._id);
}
export function authorTicketDTO(ticket) {
  const source = raw(ticket);
  const result = pick(source,['_id','subject','description','category','priority','status','createdAt','updatedAt','lastActivityAt','resolvedAt','closedAt']);
  for (const [key, mapper] of Object.entries({author:publicAuthorDTO,book:publicBookDTO,assignee:publicAssigneeDTO})) {
    if (Object.hasOwn(source,key)) result[key] = mapper(source[key]);
  }
  return result;
}
export function adminTicketDTO(ticket) {
  const source=raw(ticket);
  const result={...authorTicketDTO(ticket),...pick(source,['categorySource','prioritySource','categoryOverriddenAt','priorityOverriddenAt'])};
  for(const key of ['categoryOverriddenBy','priorityOverriddenBy']) if(Object.hasOwn(source,key)) result[key]=publicSenderDTO(source[key]);
  const state=['pending','completed','failed'].includes(source.aiClassification?.state)?source.aiClassification.state:'pending';
  const reviewed=!!source.category&&['category','priority'].every(field=>source[field+'Source']==='manual'&&source[field+'OverriddenBy']&&source[field+'OverriddenAt']);
  result.revision=Number.isSafeInteger(source.__v)&&source.__v>=0?source.__v:null;
  result.classification={state,manuallyReviewed:reviewed,needsManualReview:state!=='completed'&&!reviewed,
    ...pick(source.aiClassification??{},['suggestedCategory','suggestedPriority','model','promptVersion','classifiedAt','errorCode','attemptCount'])};
  return result;
}
// Call only after admin authorization; never include in an author response.
export function adminInternalNoteDTO(note) {
  if(note.constructor?.modelName!=='InternalNote') throw new Error('Expected an InternalNote document');
  const source=raw(note);
  return {...pick(source,['_id','body','createdAt','updatedAt']),ticket:referenceId(source.ticket),createdBy:publicSenderDTO(source.createdBy)};
}
export function publicMessageDTO(message) {
  if (message.constructor?.modelName !== 'TicketMessage') throw new Error('Expected a TicketMessage document');
  const source = raw(message);
  const result = pick(source,['_id','body','sentAt','createdAt']);
  result.ticket = referenceId(source.ticket);
  result.sender = publicSenderDTO(source.sender);
  result.attachments = (source.attachments ?? []).map(a => pick(a,['originalName','mediaType','sizeBytes']));
  return result;
}
