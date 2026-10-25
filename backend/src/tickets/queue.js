import { priorities } from '../models/index.js';

// Compute ranks inside MongoDB before pagination; never persist derived queue fields.
export function adminQueuePipeline(filter,paging,order,fields) {
  const stages=[{$match:filter}];
  if(order==='urgency') {
    const unresolved={$in:['$status',['Open','In Progress']]};
    stages.push({$set:{
      queueStatusRank:{$cond:[unresolved,0,1]},
      queuePriorityRank:{$cond:[unresolved,{$switch:{branches:priorities.map((priority,index)=>({case:{$eq:['$priority',priority]},then:index})),default:priorities.length}},0]},
    }});
    stages.push({$sort:{queueStatusRank:1,queuePriorityRank:1,createdAt:1,_id:1}});
  } else {
    const direction=order==='oldest'?1:-1;
    stages.push({$sort:{createdAt:direction,_id:direction}});
  }
  stages.push({$skip:paging.offset},{$limit:paging.limit},{$project:Object.fromEntries(fields.map(field=>[field,1]))});
  return stages;
}
