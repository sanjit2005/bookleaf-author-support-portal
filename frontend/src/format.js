export const CATEGORIES=['Royalty & Payments','ISBN & Metadata Issues','Printing & Quality','Distribution & Availability','Book Status & Production Updates','General Inquiry']
export const STATUSES=['Open','In Progress','Resolved','Closed']
export const PRIORITIES=['Critical','High','Medium','Low']
export const date=value=>value?new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric',...(value.length===10?{timeZone:'UTC'}:{})}).format(new Date(value.length===10?value+'T00:00:00Z':value)):'Not available'
export const money=value=>value===null||value===undefined?'—':new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(value))
export const refId=value=>typeof value==='string'?value:value?._id
