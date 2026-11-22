// Relay integrity: a brief that instructs a relay — request_agent with an
// idempotency key — makes the agent promise that request will exist. Handback
// summaries are prose and can claim anything (observed live: a leg-1 handback
// announced "all 4 agents said hello" while legs 2-4 had never been created).
// A completed handback whose promised relay keys are absent is published with
// validation "rejected" instead of trusted.

// Only the direct relay instruction counts. Nested relay briefs travel inside
// the text as JSON-escaped strings (`key \"…\"`), so the quote-after-space in
// this pattern cannot match them — a leg answers only for its own promise.
export function promisedRelayKeys(brief: string): string[] {
  return [...brief.matchAll(/(?:\bkey|\bidempotencyKey)\s+"([A-Za-z0-9][A-Za-z0-9._-]*)"/g)]
    .map(match => match[1]);
}

export function verifyRelay(brief: string, lookup: (key: string) => { id: string } | undefined): string[] {
  return promisedRelayKeys(brief).filter(key => !lookup(key));
}
