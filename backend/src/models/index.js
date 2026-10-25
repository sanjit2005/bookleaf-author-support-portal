import mongoose from 'mongoose';
import { validPasswordHash } from '../auth/password-policy.js';
import { validMoney } from '../db/money.js';
import { serialize } from '../db/serialization.js';
const { Schema } = mongoose;
export const categories = ['Royalty & Payments','ISBN & Metadata Issues','Printing & Quality','Distribution & Availability','Book Status & Production Updates','General Inquiry'];
export const priorities = ['Critical','High','Medium','Low'];
export const bookStatuses = ['Published & Live','In Production - Cover Design','In Production - Typesetting'];
export const platforms = ['Amazon India','Flipkart','Amazon US','Amazon UK','BookLeaf Store'];
export const moneyFields = ['mrp','author_royalty_per_copy','total_royalty_earned','royalty_paid','royalty_pending'];
export function validDateOnly(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v; }
const text = (max=200) => ({type:String,required:true,maxlength:max,validate:v=>v.trim().length>0});
const ref = (name, required=false) => ({type:Schema.Types.ObjectId,ref:name,required,...(required?{}:{default:null})});
const choice = (values, fallback) => ({type:String,enum:values,default:fallback});
const dateOnly = (nullable=false) => ({type:String,...(nullable?{default:null}:{required:true}),validate:v=>nullable && v===null || validDateOnly(v)});
const integer = {type:Number,required:true,min:0,validate:Number.isSafeInteger};
const money = nullable => ({type:Schema.Types.Decimal128,...(nullable?{default:null}:{required:true}),validate:v=>nullable && v===null || validMoney(v)});
function schema(fields, collection) {
  return new Schema(fields,{collection,strict:'throw',timestamps:true,bufferCommands:false,autoIndex:false,autoCreate:false,optimisticConcurrency:true,toJSON:{transform:(_doc,ret)=>{delete ret.passwordHash;return serialize(ret);}}});
}
const userSchema = schema({email:{...text(254),lowercase:true,trim:true,match:/^[^\s@]+@[^\s@]+\.[^\s@]+$/},passwordHash:{type:String,default:null,select:false,required:function(){return this.accountStatus==='active' && (this.isNew || this.isSelected('passwordHash') || this.isModified('passwordHash') || this.isModified('accountStatus'));},validate:v=>v===null || validPasswordHash(v)},role:{...choice(['author','admin'],'author'),required:true},accountStatus:{...choice(['pending','active','disabled'],'pending'),required:true},lastLoginAt:{type:Date,default:null},tokenVersion:{...integer,default:0}},'users');
userSchema.index({email:1},{unique:true});
userSchema.pre('validate',function(){
  if(this.accountStatus==='active' && (this.isNew||this.isModified('passwordHash')||this.isModified('accountStatus')) && !validPasswordHash(this.passwordHash)) this.invalidate('passwordHash','Active accounts require a valid selected bcrypt hash');
});
// Security-field query updates lack full document state. Require validated document saves.
for(const operation of ['updateOne','updateMany','findOneAndUpdate']) userSchema.pre(operation,function(){
  const update=this.getUpdate();
  const protectedFields=['passwordHash','accountStatus','tokenVersion'];
  const touches = key => protectedFields.some(field=>key===field||key.startsWith(field+'.'));
  if(Array.isArray(update)||this.getOptions().upsert||Object.entries(update??{}).some(([key,value])=>key.startsWith('$')?Object.entries(value??{}).some(([path,target])=>touches(path)||key==='$rename'&&touches(target)):touches(key))) throw new Error('Use a validated User document save for security changes');
  this.setOptions({runValidators:true});
});
for(const operation of ['replaceOne','findOneAndReplace','bulkWrite']) userSchema.pre(operation,function(){throw new Error('Use validated User document saves');});

const authorSchema = schema({author_id:{...text(),match:/^AUTH\d+$/,immutable:true},name:text(),email:{...text(254),match:/^[^\s@]+@[^\s@]+\.[^\s@]+$/},phone:text(50),city:text(),joined_date:dateOnly(),user:ref('User')},'authors');
authorSchema.index({author_id:1},{unique:true});authorSchema.index({email:1});authorSchema.index({user:1},{unique:true,partialFilterExpression:{user:{$type:'objectId'}}});
const bookSchema = schema({book_id:{...text(),match:/^BK\d+$/,immutable:true},author:{...ref('Author',true),immutable:true},sourceOrder:integer,title:text(500),isbn:text(100),genre:text(),publication_date:dateOnly(true),status:{type:String,required:true,enum:bookStatuses},mrp:money(true),author_royalty_per_copy:money(true),total_copies_sold:integer,total_royalty_earned:money(false),royalty_paid:money(false),royalty_pending:money(false),last_royalty_payout_date:dateOnly(true),print_partner:choice(['In-House','Repro India','Epitome Books',null],null),available_on:{type:[{type:String,enum:platforms}],required:true,default:undefined,validate:v=>Array.isArray(v)&&new Set(v).size===v.length}},'books');
bookSchema.index({book_id:1},{unique:true});bookSchema.index({author:1,sourceOrder:1});bookSchema.index({isbn:1});
const attachment = new Schema({originalName:text(255),mediaType:text(100),sizeBytes:integer,storageKey:text(500)},{_id:false,strict:'throw'});
const attachments = {type:[attachment],default:[],validate:v=>v.length<=5};
const ai = new Schema({state:{...choice(['pending','completed','failed'],'pending'),required:true},suggestedCategory:choice([...categories,null],null),suggestedPriority:choice([...priorities,null],null),model:{type:String,maxlength:100,default:null},promptVersion:{type:String,maxlength:100,default:null},classifiedAt:{type:Date,default:null},errorCode:{type:String,maxlength:100,default:null},attemptCount:{...integer,default:0}},{_id:false,strict:'throw'});
ai.pre('validate',function(){if(this.state==='completed' && (!this.suggestedCategory || !this.suggestedPriority || !this.classifiedAt || !this.model || !this.promptVersion)) this.invalidate('state','Completed classification needs validated suggestions and provenance');});
const provenance = ['pending','fallback','ai','manual'];
const ticketSchema = schema({author:ref('Author',true),book:ref('Book'),subject:text(200),description:text(10000),category:choice([...categories,null],null),priority:{...choice(priorities,'Medium'),required:true},status:{...choice(['Open','In Progress','Resolved','Closed'],'Open'),required:true},assignee:ref('User'),lastActivityAt:{type:Date,default:Date.now,required:true},resolvedAt:{type:Date,default:null},closedAt:{type:Date,default:null},aiClassification:{type:ai,default:()=>({})},categorySource:choice(provenance,'pending'),prioritySource:choice(provenance,'fallback'),categoryOverriddenBy:ref('User'),priorityOverriddenBy:ref('User'),categoryOverriddenAt:{type:Date,default:null},priorityOverriddenAt:{type:Date,default:null},attachments},'tickets');
ticketSchema.index({author:1,createdAt:-1,_id:-1});ticketSchema.index({status:1,createdAt:1,_id:1});ticketSchema.index({status:1,category:1,priority:1,createdAt:1});ticketSchema.index({assignee:1,status:1,createdAt:1});
const messageSchema = schema({ticket:ref('Ticket',true),sender:ref('User',true),body:text(10000),sentAt:{type:Date,default:Date.now,required:true,immutable:true},attachments},'ticketMessages');
const noteSchema = schema({ticket:ref('Ticket',true),createdBy:ref('User',true),body:text(10000)},'internalNotes');
for(const s of [messageSchema,noteSchema]) s.index({ticket:1,createdAt:1,_id:1});
export const User = mongoose.model('User',userSchema);
export const Author = mongoose.model('Author',authorSchema);
export const Book = mongoose.model('Book',bookSchema);
export const Ticket = mongoose.model('Ticket',ticketSchema);
export const TicketMessage = mongoose.model('TicketMessage',messageSchema);
export const InternalNote = mongoose.model('InternalNote',noteSchema);
