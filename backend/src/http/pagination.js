// Reject duplicates/objects, unsafe integers and unexpected query parameters.
export function pagination(query, extraKeys=[]) {
  if(Object.keys(query).some(key=>!['page','limit',...extraKeys].includes(key))) return null;
  const values={page:query.page??'1',limit:query.limit??'10'};
  for(const value of Object.values(values)) if(typeof value!=='string'||!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))) return null;
  const page=Number(values.page),limit=Number(values.limit);
  if(page>10000||limit>50) return null;
  return {page,limit,offset:(page-1)*limit};
}
export const pageMetadata = (paging,total) => ({page:paging.page,limit:paging.limit,total,totalPages:Math.ceil(total/paging.limit)});
