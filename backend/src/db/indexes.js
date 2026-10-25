import { pathToFileURL } from 'node:url';
import { User, Author, Book, Ticket, TicketMessage, InternalNote } from '../models/index.js';
import { connectDatabase, disconnectDatabase } from './connection.js';
export const indexedModels = [User, Author, Book, Ticket, TicketMessage, InternalNote];
// Ordered and repeatable. Never sync/drop existing indexes. Conflicts stop setup.
export async function setupIndexes() {
  for (const model of indexedModels) await model.createIndexes();
}
async function main() {
  await connectDatabase();
  try { await setupIndexes(); console.log('Indexes configured for all six models'); }
  finally { await disconnectDatabase(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Index setup failed; check connection, permissions and existing index/data conflicts'); process.exitCode = 1; });
}
