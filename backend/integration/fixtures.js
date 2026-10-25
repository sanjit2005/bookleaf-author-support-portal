import { serialize } from '../src/db/serialization.js';
import { createTicketServices } from '../src/tickets/service.js';
import { bookPayload, authorFields, bookFields } from '../src/seed/source.js';
import { capabilityView, IntegrationSafetyError, snapshotArguments } from './guards.js';

function freezeData(value) {if(value&&typeof value==='object'){for(const item of Object.values(value))freezeData(item);Object.freeze(value);}return value;}

// Never return a Model, document, query, cursor, session, database or connection.
export function fixtureCapabilities({models,services,transaction,track,request,source}) {
  const model=name=>{if(!Object.hasOwn(models,name))throw new IntegrationSafetyError('Unknown fixture type');return models[name];};
  const detached=value=>{const result=serialize(value);if(result&&typeof result==='object')delete result.passwordHash;return result;};
  const perform=work=>track('fixture',async()=>{
    try {return await work();}
    catch(error) {
      if(error instanceof IntegrationSafetyError)throw error;
      const safe=new Error(error.message==='SYNTHETIC_ABORT'?'SYNTHETIC_ABORT':'Fixture operation failed (details suppressed)');
      if(Number.isInteger(error.code))safe.code=error.code;
      throw safe;
    }
  });
  const records=capabilityView({
    insert:(name,fields)=>perform(async()=>{const Model=model(name);return new Model(snapshotArguments([fields])[0]).save().then(detached);}),
    one:(name,filter)=>perform(async()=>detached(await model(name).findOne(snapshotArguments([filter])[0]).lean())),
    count:(name,filter={})=>perform(()=>model(name).countDocuments(snapshotArguments([filter])[0])),
    indexes:name=>perform(()=>model(name).listIndexes().then(detached)),
  });
  return capabilityView({records,request,
    activity:(actor,id,input,{privateNote=false,abortAfterWrite=false}={})=>perform(async()=>{
      const chosen=abortAfterWrite?createTicketServices({models,transaction:work=>transaction(async active=>{await work(active);throw new Error('SYNTHETIC_ABORT');})}):services;
      return detached(await chosen.addEntry(actor,id,input,{privateNote}));
    }),
    source:source?freezeData(structuredClone(source)):null,
    sourceFields:Object.freeze({authors:Object.freeze([...authorFields]),books:Object.freeze([...bookFields])}),
    sourceBook:(book,author)=>serialize(bookPayload(snapshotArguments([book])[0],author)),
  });
}
