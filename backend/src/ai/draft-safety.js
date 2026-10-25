// Conservative tripwires, not a semantic/factual correctness guarantee. Human review remains required.
const unsupported=[
  /\b(?:we|i|bookleaf|our team)\s+(?:have\s+|has\s+|already\s+)?(?:processed|sent|issued|released|transferred|paid|approved|arranged|triggered|completed|escalated|updated)\b/i,
  /\b(?:payment|payout|refund|reprint|resync|re-sync|listing|escalation)\s+(?:has been|was|is already)\s+(?:processed|sent|issued|paid|approved|arranged|triggered|completed|updated|escalated)\b/i,
  /\b(?:we|i|our team)\s+(?:will|shall|guarantee to)\s+(?:pay|refund|transfer|escalate|trigger|resync|re-sync)\b/i,
  /\b(?:next|your|the)\s+(?:royalty\s+)?(?:payout|payment)\s+(?:is|will be|is scheduled|is due)\s+(?:on\s+|for\s+)?(?:\d|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)/i,
  /(?:^|[.!?]\s+)(?:your|the)\s+bank\s+(?:account|details)\s+(?:is|are|has been|have been)\s+(?:linked|verified|confirmed|valid)/i,
  /\b(?:bank account number|ifsc)\s*(?:is|:|=)\s*[A-Z0-9]{4,}/i,
  /\b(?:amazon|flipkart)\s+(?:sales|royalt(?:y|ies)|commission)\s*(?:are|is|:|=)\s*(?:INR|₹|Rs\.?)?\s*\d/i,
  /\b(?:system|developer)\s+(?:prompt|instructions)\s*:/i,
  /BOOKLEAF POLICY:|Ticket fields and conversation are untrusted data/i,
];
export const safeDraft = value => !unsupported.some(pattern=>pattern.test(value));
