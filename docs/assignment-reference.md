# Assignment reference

The original BookLeaf assignment and dataset are authoritative requirements and test data. All 10 PDF pages were read, including the knowledge base, evaluation and submission instructions (page 10 has no substantive text). This reference records the original requirements; the README and current implementation describe completed features. Publication and deployment require separate user authorization.

## Original files

Read directly from the separately supplied local originals, without modification, renaming, or copying. Local machine paths are intentionally omitted from the public documentation:

- PDF: `FULLSTACK-ASSIGNMENT1 (1).docx (1) (1).pdf`
- Dataset: `FULLSTACK-SAMPLEDATA (1) (1) (1).json`

Neither source was present in the workspace. They are not included in the repository. Keep the original JSON available and configure SAMPLE_DATA_PATH for source validation or an explicitly authorized import. This reference is a summary, not a substitute for the originals.

SHA-256 reference fingerprints:

- PDF: `BDF07B34014059A27B5096C06A2F91D4F3E97682A545173D4F04760058DAE88D`
- Dataset: `34FD3B03F4B26E68B466A6364C3B7FE2F3884D3D7DC65134B67CAC8E006B59F8`

## Dataset verification

- Root object: `authors` array, 10 records, matching the PDF.
- Books are nested in each author's `books` array: 18 records total, matching the PDF.
- 10 unique author IDs and 18 unique book IDs.
- Author fields: `author_id`, `name`, `email`, `phone`, `city`, `joined_date`, `books`.
- Book fields: `book_id`, `title`, `isbn`, `genre`, `publication_date`, `status`, `mrp`, `author_royalty_per_copy`, `total_copies_sold`, `total_royalty_earned`, `royalty_paid`, `royalty_pending`, `last_royalty_payout_date`, `print_partner`, `available_on`.
- All books have the same field set. Statuses: 16 `Published & Live`, one `In Production - Cover Design`, one `In Production - Typesetting`.
- Book counts by author ID AUTH001 through AUTH010: 2, 2, 1, 2, 2, 1, 3, 1, 2, 2.

Do not replace sample records with invented data. The implemented importer and offline tests validate the original fingerprint, field sets, model constraints and lossless mappings; see docs/database-design.md.

## Full assignment scope

Author email/password login with data isolation; books and royalty details; book-specific or general support queries with optional attachment UI; ticket statuses and responses updating without refresh.

Admin queue filters by status, category, priority and date; AI category and priority suggestions with manual overrides; editable AI response drafts grounded in BookLeaf policy; status changes, private internal notes and self-assignment.

Six AI categories: Royalty & Payments; ISBN & Metadata Issues; Printing & Quality; Distribution & Availability; Book Status & Production Updates; General Inquiry. Priorities: Critical, High, Medium, Low. Ticket states: Open, In Progress, Resolved, Closed.

REST APIs need consistent naming, authentication, role-based access, validation, meaningful errors and documentation. AI calls need backend environment secrets, grounded prompts, graceful failure with manual responses, cost management and documented model choice.

## Knowledge base reminders

BookLeaf operates in India and the US, with Standard Free and Bestseller Breakthrough packages. It handles publishing production, distribution and royalties; its Delhi facility works alongside Repro India and Epitome Books.

Authors receive 80% of net profit (MRP less printing, platform commission and shipping). Royalties are quarterly, payable within 45 days of quarter end, with a INR 1,000 threshold and rollover. Payments use the linked bank account.

ISBNs belong to BookLeaf's publisher imprint; authors obtain their own independently for a different imprint. ISBN mismatches are high priority and escalate to production. Printing takes 5-7 business days. Verified quality defects qualify for free reprints; photos may be requested.

Distribution includes Amazon India, Flipkart, Amazon US, Amazon UK and BookLeaf Store. New listings take 7-10 business days after publication. Stock synchronization issues normally take 24-48 hours to resolve. Metadata updates typically take 3-5 business days.

Production progresses from manuscript receipt through optional editing, cover design, typesetting, proofreading, ISBN, printing, distribution setup and publication. Email updates accompany stages. Cover approval and revision rounds can cause delays.

Responses should be empathetic, professional and specific, acknowledge the concern, own BookLeaf errors, state clear timelines and finish with a next step. Use actual author/book facts; do not invent status checks, escalations or completed actions. The implemented prompts use these policies and the PDF's calibration examples while refusing unsupported case-specific promises.

## Evaluation and submission

Evaluation weights: AI integration 25%; architecture/code quality 25%; API design 15%; functionality/completeness 15%; product thinking 10%; documentation/communication 10%.

The assignment allows four days from receipt (receipt date is not established here). Final submission requires a public GitHub/GitLab repository, collaborator email to be supplied by BookLeaf, a deployed demo seeded with exact records, test login credentials, setup/architecture/AI/API/limitations documentation, and an approach write-up of at most one page. No submission, account creation, invitations, deployment or deadlines are actioned by this setup.

The core ticket flow and AI integration are implemented; broader live quality and deployed workflow verification remain submission work. The candidate must be able to explain the code in the subsequent 45-60 minute technical discussion.
