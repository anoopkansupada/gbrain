/**
 * Canonical set of page `type` values accepted by gbrain.
 *
 * Boundary validator: any inbound write whose `type` field is not in this set,
 * or contains a stray quote character (a signal of the matter.stringify
 * quote-accretion bug pre-v0.35.9), is rejected at the put_page / import-file
 * / sync entry points so corrupt values never reach the DB. The repair command
 * (`gbrain repair-type-field`) imports this set to drive its cleanup.
 */
export const TYPE_ENUM: ReadonlySet<string> = new Set([
  'person', 'company', 'deal', 'meeting', 'signal', 'reflection', 'pattern',
  'learning', 'compiled', 'compiled-beliefs', 'task', 'brief', 'source',
  'concept', 'note', 'essay', 'email', 'template', 'system', 'decision',
  'plan', 'goal', 'idea', 'playbook', 'recipe', 'report', 'calendar-index',
  'correspondence', 'reusable-component', 'scrape', 'crypto-project', 'event',
  'original', 'personal', 'routine', 'auto-extract-output', 'writing',
  'pattern-index', 'media', 'email-draft', 'email_draft', 'deliverable',
  'action', 'project', 'organisation', 'company-supplement', 'reference',
  'skill',
]);

/**
 * Reject any `type` value that contains a quote character (corruption signal)
 * or that isn't in `TYPE_ENUM`. Throws on bad input; returns void on clean.
 *
 * Error message includes the paste-ready repair command (Garry B14: print the
 * fix, don't make the user grep for it).
 */
export function assertValidPageType(type: unknown, context: string): void {
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(
      `Invalid type ${JSON.stringify(type)} at ${context}. Run: gbrain repair-type-field --apply`,
    );
  }
  if (/['"]/.test(type)) {
    throw new Error(
      `Invalid type "${type}" at ${context} (contains quote characters — corruption from old serializer). Run: gbrain repair-type-field --apply`,
    );
  }
  if (!TYPE_ENUM.has(type)) {
    throw new Error(
      `Invalid type "${type}" at ${context}. Run: gbrain repair-type-field --apply`,
    );
  }
}
