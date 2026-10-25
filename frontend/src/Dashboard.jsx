import { useCallback } from 'react'
import { useData } from './useData'
import { Heading, Icon, Resource, Refresh } from './ui'
import { TicketRows } from './TicketList'

export default function Dashboard({client,user,navigate}) {
  const admin=user.role==='admin',root=admin?'/admin':'/me'
  const load=useCallback(async signal=>{
    const [recent,open,progress,resolved,closed,books]=await Promise.all([
      client(`${root}/tickets?limit=5${admin?'&sort=newest':''}`,{signal}),...['Open','In Progress','Resolved','Closed'].map(status=>client(`${root}/tickets?limit=1&status=${encodeURIComponent(status)}`,{signal})),
      admin?Promise.resolve(null):client('/me/books?limit=1',{signal}),
    ])
    return {recent,open:open.pagination.total,progress:progress.pagination.total,resolved:resolved.pagination.total,closed:closed.pagination.total,books:books?.pagination.total}
  },[client,root,admin])
  const resource=useData(load),data=resource.data
  const cards=data?(admin?[['All tickets',data.recent.pagination.total,'Every author conversation','ticket'],['Open',data.open,'Waiting to be picked up','clock'],['In progress',data.progress,'Currently being handled','book'],['Resolved',data.resolved,'Resolution shared','check']]:[['My books',data.books,'Your publishing library','book'],['Active tickets',data.open+data.progress,'Open and in progress','ticket'],['Resolved',data.resolved,'Resolution shared','check'],['Closed',data.closed,'Completed conversations','clock']]):[]
  return <><Heading eyebrow={admin?'BOOKLEAF OPERATIONS':'YOUR AUTHOR WORKSPACE'} title={admin?'Overview':'A new chapter starts here.'} action={<Refresh onClick={resource.refresh}/>}>{admin?'Bring clarity, care and momentum to every author conversation.':'Your books, your questions, and a team that’s here for you.'}</Heading><div className="welcome-banner"><div><span className="banner-kicker">{admin?'AUTHOR CARE, THOUGHTFULLY DELIVERED':'FROM MANUSCRIPT TO MILESTONE'}</span><h2>{admin?'Every conversation deserves a thoughtful response.':'Focus on your next story. We’ll help with the rest.'}</h2><p>{admin?'Review the queue, investigate the details, and keep your authors informed.':'Track your titles and connect directly with your publishing support team.'}</p><button className="button light" onClick={()=>navigate(admin?'/tickets':'/tickets/new')}>{admin?'Open ticket queue':'Start a conversation'}<Icon name="arrow" size={17}/></button></div><div className="banner-art" aria-hidden="true"><div className="art-orbit"/><div className="art-book art-book-one"/><div className="art-book art-book-two"/><Icon name="leaf" size={72}/></div></div><Resource resource={resource}>{data&&<><div className="stat-grid">{cards.map(([label,value,caption,icon])=><section className="stat-card" key={label}><div><span>{label}</span><Icon name={icon}/></div><strong>{value}</strong><small>{caption}</small></section>)}</div><section className="panel"><div className="panel-heading"><div><h2>{admin?'Latest conversations':'Recent support tickets'}</h2><p className="muted small-copy">Actual records from your current workspace</p></div><button className="text-button" onClick={()=>navigate('/tickets')}>View all tickets <span aria-hidden="true">→</span></button></div><TicketRows tickets={data.recent.tickets} admin={admin} navigate={navigate} emptyAction={!admin&&<button className="button" onClick={()=>navigate('/tickets/new')}>Create your first ticket</button>}/></section></>}</Resource></>
}
