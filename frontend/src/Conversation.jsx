import { ErrorBox, Empty, Loading, Icon } from './ui'
import { date } from './format'

export default function Conversation({history,privateNotes=false,children}) {
  const label=privateNotes?'notes':'replies'
  return <section className={`panel ${privateNotes?'private-notes':'conversation'}`} aria-label={privateNotes?'Private internal notes':'Public conversation'}>
    <div className="panel-heading"><h2>{privateNotes&&<Icon name="lock" size={16}/>} {privateNotes?'Internal notes':'Public conversation'}</h2>
      {privateNotes?<span className="private-label">Admin only</span>:<span className="muted small-copy">{history.items.length} replies loaded</span>}
    </div>
    {privateNotes&&<p className="history-status muted">Private workspace. Never visible to the author.</p>}
    <div className="history-status" role="status" aria-live="polite">{history.pending?`New ${label} available. Your reading position has been kept.`:`Latest ${label} first. Older history loads below.`}</div>
    <div className="history-actions"><button className="button secondary small" disabled={history.busy} onClick={history.showLatest}>Show latest {label}</button>{history.busy&&<span role="status">Loading {label}…</span>}</div>
    <ErrorBox message={history.error} retry={history.retry}/>
    {!history.ready?!history.error&&<Loading/>:!history.items.length?<Empty title={privateNotes?'No internal notes yet':'No public replies yet'}>New {label} will appear here.</Empty>:
      <div className={privateNotes?'history-notes':'message-list'}>{history.items.map(entry=>privateNotes?
        <article className="internal-note" key={entry._id}><small>{date(entry.createdAt)}</small><p className="prose-text">{entry.body}</p></article>:
        <article key={entry._id} className={`message ${entry.sender?.role==='admin'?'team-message':''}`}><div className="message-heading"><span className="avatar small">{entry.sender?.role==='admin'?'BL':'A'}</span><strong>{entry.sender?.role==='admin'?'BookLeaf support':'Author'}</strong><time dateTime={entry.sentAt||entry.createdAt}>{date(entry.sentAt||entry.createdAt)}</time></div><p className="prose-text">{entry.body}</p></article>)}</div>}
    {history.ready&&<div className="history-actions"><button className="button secondary small" disabled={history.busy||!history.hasMore} onClick={history.loadOlder}>Load older {label}</button>{!history.hasMore&&<span className="muted small-copy">Beginning of {privateNotes?'internal notes':'conversation'}.</span>}</div>}
    {children}
  </section>
}
