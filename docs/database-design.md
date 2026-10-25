# Database design and source-data preservation

Current database-layer reference. Six models, authentication, Books/Tickets APIs, AI assistance, frontend workflows, offline validation, seed and index-setup commands are implemented. Demo initialization and account provisioning were completed in separately authorized earlier work; this document does not independently verify current remote contents. Offline checks do not connect, migrate or seed. Based on `docs/assignment-reference.md` and the original BookLeaf sample JSON supplied separately with the assignment. Set SAMPLE_DATA_PATH to its actual local location; it is not bundled in this repository.

Source SHA-256: `34FD3B03F4B26E68B466A6364C3B7FE2F3884D3D7DC65134B67CAC8E006B59F8` (matches the assignment reference). The source remains unchanged outside the repository.

## 1. Verified source inventory

The root is an object with one field, `authors`, an array of **10 author objects**. Their nested `books` arrays contain **18 book objects**. IDs are unique: AUTH001–AUTH010 and BK001–BK018. Emails (case-insensitive comparison) and supplied ISBN strings are also unique. All records contain every field listed below; no fields are missing.

| Author field | Observed JSON type | Null count | Storage |
| --- | --- | --- | --- |
| author_id | string | 0 | String, immutable source ID |
| name | string | 0 | String |
| email | string | 0 | String, preserve original |
| phone | string | 0 | String, preserve punctuation/leading digits |
| city | string | 0 | String |
| joined_date | string, YYYY-MM-DD | 0 | Validated date-only String |
| books | array of book objects | 0 | Separate Book documents with author reference |

| Book field | Observed JSON type | Null count | Storage |
| --- | --- | --- | --- |
| book_id | string | 0 | String, immutable source ID |
| title | string | 0 | String, preserve Unicode |
| isbn | string | 0 | String; sample placeholders accepted |
| genre | string | 0 | String, no restrictive genre enum |
| publication_date | string, YYYY-MM-DD / null | 2 | Validated date-only String or null |
| status | string | 0 | String enum, see below |
| mrp | number (integer) / null | 2 | Decimal128 or null |
| author_royalty_per_copy | number (integer) / null | 2 | Decimal128 or null |
| total_copies_sold | number (integer) | 0 | Number, nonnegative safe integer |
| total_royalty_earned | number (integer) | 0 | Decimal128, nonnegative |
| royalty_paid | number (integer) | 0 | Decimal128, nonnegative |
| royalty_pending | number (integer) | 0 | Decimal128, nonnegative |
| last_royalty_payout_date | string, YYYY-MM-DD / null | 6 | Validated date-only String or null |
| print_partner | string / null | 2 | String enum or null |
| available_on | array of strings | 0 | String enum array; empty allowed |

Author → books mapping: AUTH001 → BK001–002; AUTH002 → BK003–004; AUTH003 → BK005; AUTH004 → BK006–007; AUTH005 → BK008–009; AUTH006 → BK010; AUTH007 → BK011–013; AUTH008 → BK014; AUTH009 → BK015–016; AUTH010 → BK017–018. Preserve source ordering with an additional nonnegative `sourceOrder` integer on Book if reconstructing the nested source.

### Exceptions and consistency findings

- 16 books are `Published & Live`. BK013 is `In Production - Cover Design`; BK015 is `In Production - Typesetting`. Both have null publication date, MRP, royalty per copy and print partner, zero sales/royalty totals, and empty availability arrays. Preserve null separately from zero or empty string.
- Payout date is null for BK005, BK010, BK013, BK015, BK016 and BK018. Do not infer a payout date from pending balances.
- All 18 ISBNs contain `XXXX`; these are supplied sample identifiers, not valid ISBN-13 values. Do not correct, replace, strip or enforce checksum validation on import. Production books already have ISBN strings; do not erase them based on stage order.
- All non-null dates are valid calendar dates. All books satisfy `royalty_paid + royalty_pending = total_royalty_earned`; all 16 priced books also satisfy `author_royalty_per_copy × total_copies_sold = total_royalty_earned`. These are audit results, not permission to recompute source totals.
- Phone strings look like sample data and include leading digits that strict national-number rules may reject. Retain them verbatim. Preserve BK017's Unicode apostrophe.
- Currency, bank details, platform-level sales, printing costs, platform commissions, shipping charges and historical transactions are absent. INR is suggested by the knowledge base but not declared by each source record. Do not fabricate these fields or claim to verify payout timeliness from aggregate data alone.

## 2. Collections and relationships

Use Mongoose ObjectId `_id` values for database references, while retaining the original `author_id` and `book_id` unchanged as unique business keys. Use `timestamps: true` for new system `createdAt`/`updatedAt` Date fields; these are import/activity times, not publication/join dates. Use strict schemas, explicit field allowlists and validation on all write paths. Text limits below are application decisions, not supplied requirements.

Date-only source strings avoid timezone shifts and must pass both YYYY-MM-DD format and real-calendar validation. Convert supplied monetary integers exactly to Decimal128 using decimal strings; do not multiply into minor units or replace totals. API serialization uses decimal strings for money, with explicit DTO allowlists.

### User (`users`)

- `email`: required String, canonical trimmed lowercase authentication address, basic email validation, maximum 254 characters; unique index. This normalization applies to login identity only, not Author's source email.
- `passwordHash`: String or null, excluded from ordinary query selection and all response DTOs; null permitted only for a non-active account. Active accounts require a supported password hash. No plaintext/password field.
- `role`: required enum `author | admin`; default `author`, role changes restricted to authorized administration.
- `accountStatus`: enum `pending | active | disabled`, default `pending`; disabled/pending accounts cannot log in.
- `tokenVersion`: nonnegative safe integer, default 0, used to invalidate all earlier account tokens on logout. Password hashes must be supported bcrypt format/cost (10–14); provisioning uses cost 12 and requires 12 characters through 72 UTF-8 bytes, without control characters or transformations. Login retains the documented legacy-length compatibility.
- `_id`, timestamps. Optional `lastLoginAt: Date | null`; login currently does not update it.

Users are not created by the business-data seed. An admin needs no Author profile. Each author login can link to at most one Author profile.

### Author (`authors`)

All six scalar author source fields above, required and preserved verbatim; `author_id` immutable, unique index. Nonempty strings; ID format `AUTH` followed by digits, without requiring exactly three digits. Source strings must be validated without trim/lowercase setters that silently rewrite them. `joined_date` is required.

Additional `user: ObjectId ref User | null`, default null. Unique partial index on `user` only when its BSON type is ObjectId; explicit nulls must not participate in uniqueness. Linking requires an author-role User and explicit identity verification; never attach accounts solely by an unchecked email match. Nonunique index on source `email` for administrative lookup. Books are queried by `Book.author`, not copied back into stored Author documents.

### Book (`books`)

All 16 supplied book fields above, plus required immutable `author: ObjectId ref Author` and `sourceOrder`. Unique `book_id` index; index `{ author: 1, sourceOrder: 1 }`; nonunique ISBN lookup index. No unique ISBN constraint until policy for real metadata errors is agreed.

Required non-null fields: book ID, title, ISBN, genre, status, sales count, earned/paid/pending totals and availability array. Nullable fields retain explicit null. Do not use Mongoose `required: true` on fields that must accept null; instead validate field presence in the importer and permit null in the schema. Reject negative/non-finite monetary values and invalid sales counts; accept zero. IDs use `BK` plus digits. Text must be nonempty; do not impose ISBN checksum or phone validation on sample data.

Initial status enum: `Published & Live`, `In Production - Cover Design`, `In Production - Typesetting`. This covers every supplied record; approve additional canonical status strings before supporting other production stages. Print partner enum: `In-House`, `Repro India`, `Epitome Books`, or null. Availability members: `Amazon India`, `Flipkart`, `Amazon US`, `Amazon UK`, `BookLeaf Store`; preserve order, allow empty arrays, reject duplicate members on future writes. Cross-field financial differences should trigger review, not automatic corrections.

### Ticket (`tickets`)

- Required `author: ObjectId ref Author`; `book: ObjectId ref Book | null` (null means general/account query).
- `subject`: required nonblank String, 1–200 characters; `description`: required nonblank String, 1–10,000 characters. Plain text, safely rendered later.
- `category`: one of `Royalty & Payments`, `ISBN & Metadata Issues`, `Printing & Quality`, `Distribution & Availability`, `Book Status & Production Updates`, `General Inquiry`; nullable while classification is pending/failed. Null must not be disguised as an AI-produced General Inquiry.
- `priority`: `Critical | High | Medium | Low`, fallback `Medium`; `status`: `Open | In Progress | Resolved | Closed`, default `Open`.
- Public admin `revision` maps to Mongoose `__v`; PATCH requires a matching If-Match revision. Effective management edits and public-message/private-note activity advance it, preventing silent stale overwrites.
- `assignee: ObjectId ref User | null`, default null; only active admins can be assigned. `lastActivityAt: Date` initialized on creation; `resolvedAt` and `closedAt`: Date or null, maintained on transitions/reopening; timestamps.
- `aiClassification`: bounded metadata object with `state: pending | completed | failed`, nullable `suggestedCategory`, `suggestedPriority`, `model`, `promptVersion`, `classifiedAt`, `errorCode`, and nonnegative integer `attemptCount`. No raw provider errors, API keys or full provider payloads. Successful suggestions must pass the enums before use.
- `categorySource` and `prioritySource`: `pending | fallback | ai | manual`; initially pending and fallback respectively. Nullable `categoryOverriddenBy`, `priorityOverriddenBy` User refs and matching override timestamps. Keep AI suggestions separate from effective values; a delayed AI result must not overwrite manual decisions.
- Optional bounded `attachments` metadata array, empty by default: `originalName`, `mediaType`, `sizeBytes`, opaque `storageKey`. Populate only after a real upload exists; attachment UI alone creates no invented storage records. Upload authorization/storage is deferred.

Indexes: `{ author: 1, createdAt: -1, _id: -1 }`; `{ status: 1, createdAt: 1, _id: 1 }`; `{ status: 1, category: 1, priority: 1, createdAt: 1 }`; `{ assignee: 1, status: 1, createdAt: 1 }`. These support ownership lists, oldest unresolved and admin filters; review query plans before adding more. Priority strings do not sort by urgency. The admin queue now computes temporary unresolved and Critical→High→Medium→Low ranks in an aggregation after filtering, then sorts by rank, original createdAt and _id before pagination. Resolved/Closed follow unresolved tickets and sort by createdAt/_id. Alternative newest/oldest orders are global. Admin startDate/endDate match inclusive UTC creation calendar days using an exclusive next-day end boundary. Age means time since original creation, not continuous unresolved time or time since reopening; the current model has no reopenedAt history. Existing index definitions are retained: existing indexes may support selective matches, but cannot directly supply computed-rank sorting. Unfiltered/date-only scans and ranking costs remain a scaling concern; allowDiskUse permits spill rather than removing that cost. Inspect real query plans and workload before adding a createdAt index or persisting maintained ranks. Live query-plan/integration verification remains outstanding.

### TicketMessage (`ticketMessages`) and InternalNote (`internalNotes`)

Separate collections prevent an accidental visibility flag change from publishing a note.

| Collection | Fields and rules |
| --- | --- |
| TicketMessage | Required `ticket: ref Ticket`, `sender: ref User`, nonblank `body` String (1–10,000), immutable `sentAt: Date`, timestamps. Stores only sent author-visible replies; no draft or private-note field. Optional verified attachment metadata follows Ticket rules. |
| InternalNote | Required `ticket: ref Ticket`, `createdBy: ref User` (admin), nonblank `body` String (1–10,000), timestamps. Admin-only reads/writes; never included in author serializers, searches or socket events. |

Both index `{ ticket: 1, createdAt: 1, _id: 1 }`. Independent GET message/note histories traverse this index in reverse using descending createdAt/_id keyset pagination: latest entries first, with an exclusive before cursor on timestamp then ObjectId. Each bounded read fetches limit+1 to detect more history; no count or offset is needed. New entries do not shift older cursor batches. The frontend stores separate public/private history state and deduplicates by ID; confirmed sends merge immediately and polled arrivals wait for explicit Show latest acknowledgement. Existing detail page/limit remains oldest-first for compatibility, with separate admin notesPage/notesLimit; view=summary avoids history queries. No new index or model change is required. Actual MongoDB execution/query plans remain integration checks. Original query remains on Ticket, not duplicated as a message. AI drafts remain unsent and admin-only, without persistence. The admin view attempts one initial draft per eligible ticket opening, preserves any local typing and never retries automatically; explicit manual regeneration remains available. Review and a separate public send are required. A sent edited draft becomes a normal admin-authored TicketMessage; do not store a full author/book snapshot in it.

### Integrity and access rules

References do not enforce foreign keys or authorization by themselves. Implemented services verify that a selected book belongs to the ticket author, resolve the author from the authenticated account, restrict author messages to their own tickets, and restrict notes/assignment to admins. Never trust caller-supplied ownership, role or AI metadata. Schema validation alone cannot enforce these cross-collection rules; route/service ownership queries and role checks enforce them.

Use explicit author/admin DTOs and scoped database queries; exclude notes and internal AI metadata from author responses/events. Use atomic/transactional writes where a reply and ticket activity must change together, and concurrency checks to protect manual overrides. Unique indexes are database constraints, not Mongoose validators; handle duplicate-key errors. Prefer disabling accounts and retaining referenced records over cascading deletion. Retention/deletion policy remains a later decision.

## 3. Idempotent seed strategy

1. Read the exact verified original file, verify fingerprint, parse and validate the entire document before any writes: 10 authors, 18 books, complete field sets, unique business IDs, types/nulls, dates and parent relationships. Report unexpected fields or changed source fingerprints for review. Never strip unknown data silently.
2. Prepare lossless field mappings. Preserve every original scalar value, null, array order and ID. Represent nesting using Book.author and sourceOrder. Log only IDs and counts, not profile details or credentials.
3. Ensure unique ID indexes exist. Compare by `author_id` and `book_id`, insert missing validated documents only, and resolve Book.author using Author ObjectIds. New authors have `user: null`; existing links are never reset. No update/upsert/replace/delete operations are used.
4. On an existing record, compare every mapped source field and relationship. Identical values mean skip; differing values mean report a conflict and stop before writes. Do not overwrite current business data, relink books, reset account links, delete extra records or update timestamps on a no-op rerun. A deliberate refresh would need a separate approved operation.
5. Require an active driver transaction, checked with session.inTransaction() before reads and every insert. Standalone deployments are unsupported; use a replica set or supported Atlas deployment. The CLI uses withTransaction(). Recover from an uncertain commit result by rerunning the same comparison-based import after connectivity recovers; never assume that a client error proves rollback. Handle duplicate-key races by rerunning and comparing. Never drop collections.
6. Read back the imported business IDs and verify exactly 10 matching authors and 18 matching books, all parent mappings, and field-for-field equivalence after decimal serialization. The database may contain unrelated records; do not assert total collection sizes or delete extras. Record inserted/skipped/conflicted counts and source checksum.

No Users, tickets, messages, notes, passwords or hashes are invented during this import. Demo login provisioning is a separate explicitly authorized step: choose account emails/admin identity, supply passwords through a secure interactive or secret-input mechanism, hash with bcrypt before persistence, link accounts explicitly, and activate only after successful provisioning. Never log/store plaintext or commit real credentials. Publishing deliberately demo-only test access for final submission requires separate approval; never expose actual user credentials.

## 4. Implemented decisions and remaining scope

- Decimal128 money with decimal-string API serialization; date-only strings for source dates; do not infer missing currency until confirmed.
- Preserve placeholder ISBNs and phone formatting; use the supplied book status vocabulary initially, extending it deliberately later.
- Business-data-only, insert-or-compare seed policy; no automatic refresh of changed existing records.
- Optional login linkage, separate account provisioning, and chosen demo credential delivery method.
- Null category/Medium priority while AI is unavailable, explicit provenance, and bounded text limits.
- Separate private notes and public replies, initial/on-demand unpersisted drafts, and retained referenced records rather than cascading deletion.

These approved choices are implemented. Public deployment, broader live AI-quality evaluation and fresh end-to-end demo verification remain outstanding. Two direct synthetic Gemini smoke requests passed; their limited evidence and editorial issue are recorded in docs/ai-evaluation.md. Upload/storage is not implemented; optional file selection honestly sends no attachments. No additional database setup is required merely to run offline tests.

## Implemented safety clarifications

The implementation has six models, not seven. INR money uses Decimal128 with exact 0.01 increments and inclusive range 0..999999999999.99. Validation parses decimal strings using BigInt, supports equivalent exponent/trailing-zero representations and never rounds. Amounts serialize to strings; source date-only strings remain unchanged. Source JSON numeric validation stays restricted to the supplied nonnegative integer amounts.

Public reference allowlists: Author `_id/author_id/name`; Book `_id/book_id/title/isbn/status`; sender and assignee `_id/role`. All other nested fields are discarded, allowed scalar fields reject objects, and message ticket references become IDs. Attachment public output excludes storage keys. InternalNote cannot be passed as a TicketMessage. These are serialization boundaries, not authorization; API/service ownership and role checks remain mandatory and are implemented separately from serialization.

Index setup for all six collections is explicit: `npm run db:indexes` from backend, with a valid MONGODB_URI, in a separately authorized live setup step. The command creates declared indexes sequentially, never syncs/drops indexes, and stops on conflicts. Automatic indexing is disabled. The source seed still ensures Author/Book indexes before its data transaction. Declared indexes and offline validation are inspectable locally; offline mocks do not establish live index enforcement, rollback or query plans. Previously reported initialization is not a substitute for current authorized demo verification.
