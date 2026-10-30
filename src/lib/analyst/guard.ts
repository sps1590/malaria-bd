/**
 * The analyst is strictly read-only. This is the first line of defence (a friendly refusal); the real
 * guarantee is that every query runs inside a Postgres READ ONLY transaction (see store.ts), so even a
 * mistake here cannot change data.
 */

const POLITE = "(?:please|pls|kindly|can you|could you|would you|will you|may i|can i|just|now|then|and|also|go ahead and|i want to|i need to|i would like to|i'd like to|let's|lets|you should|you must|you can|help me|how (?:do i|to|can i)|is it possible to|are you able to|able to|allowed to|try to|trying to|want you to|need you to)";
const VERBS =
  "(?:delete|remove|erase|wipe|drop|truncate|purge|destroy|clear|insert|overwrite|alter|modify|edit|rename|reset|replace|correct|fix|falsify|fabricate|tamper with|manipulate|update(?! (?:me|us|on)\\b)|upload|import|change (?:the |all |every )?(?:data|cases?|deaths?|values?|numbers?|figures?|records?|rows?|counts?)|set (?:the |all )?(?:data|cases?|deaths?|values?|numbers?|figures?|records?|counts?))";

const WRITE_PHRASE = new RegExp(`(?:^|\\b${POLITE}\\s+)${VERBS}\\b`);
// verbs that do not end on a word character, or take a number: "get rid of …", "add 50 cases …", "increase the deaths by 5"
const WRITE_PHRASE_2 = new RegExp(
  `(?:^|\\b${POLITE}\\s+)(?:get rid of|throw away|zero out|blank out|empty the|add\\s+(?:\\d|new\\s+(?:rows?|records?|cases?|data|entr\\w+))|create\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?(?:records?|rows?|entr\\w+|database|schema|users?|roles?|accounts?)|(?:increase|decrease|reduce|raise|bump|boost|lower|cut)\\s+(?:the\\s+)?(?:cases|deaths|tests|numbers|figures|counts?|values?)\\s+(?:by|to)\\s+\\d|make\\s+(?:the\\s+)?(?:cases|deaths|tests|numbers|figures|counts?|values?)\\s+(?:equal|zero|0|\\d))`,
);
const SQL_WRITE = /\b(?:delete\s+from|drop\s+(?:table|database|schema|index|view|column)|truncate(?:\s+table)?\s+\w+|insert\s+into|update\s+\w+\s+set|alter\s+(?:table|database|role|user)|create\s+(?:table|index|database|user|role|schema|view)|grant\s+\w+\s+on|revoke\s+\w+\s+on|copy\s+\w+\s+(?:from|to)|vacuum|reindex)\b/;
const CHAINED = /;\s*(?:delete|drop|update|insert|alter|truncate|create)\b/;
const DB_VERBS_ON_DATA = /\b(?:delete|remove|erase|wipe|drop|purge|destroy|truncate)\b.{0,40}\b(?:data|records?|rows?|table|database|reports?|entries|cases|deaths|district|upazila|division|everything|all)\b/;
const EDIT_DATA = /\b(?:update|modify|edit|overwrite|alter|change|correct|fix|replace|set|adjust)\b.{0,40}\b(?:data|records?|rows?|table|database|values?|numbers?|figures?|counts?)\b.{0,40}\b(?:to|into|as|with|=)\b/;

export interface GuardResult {
  blocked: boolean;
  reason?: "write" | "sql";
}

/** True when the message asks to change or destroy data (or to run a write statement). */
export function detectWrite(normalized: string, original: string): GuardResult {
  if (SQL_WRITE.test(normalized) || CHAINED.test(normalized)) return { blocked: true, reason: "write" };
  if (WRITE_PHRASE.test(normalized) || WRITE_PHRASE_2.test(normalized) || DB_VERBS_ON_DATA.test(normalized) || EDIT_DATA.test(normalized)) return { blocked: true, reason: "write" };
  if (
    /\b(?:mis_monthly|weather_district_monthly|forecast_\w+|upazila_population|population_quantification|mis_sync_log|information_schema|pg_catalog)\b/i.test(original) ||
    /^\s*select\s+(?:\*|count\s*\(|sum\s*\(|distinct\b)/i.test(original)
  ) {
    return { blocked: true, reason: "sql" };
  }
  return { blocked: false };
}

export const READ_ONLY_REPLY = `I can’t do that — **this assistant is strictly read-only.**

I can read, summarise, compare, rank and forecast the surveillance data, but I can never delete, insert, update or modify anything. That isn’t just a rule I follow: every query I run is executed in a database transaction that is opened as **READ ONLY**, so PostgreSQL itself would reject any change.

If a figure looks wrong, corrections must be made at the source (the NMEP MIS) — the dashboard re-syncs it every day. I’m happy to help you *find* the suspect figures, for example:`;

export const RAW_SQL_REPLY = `I don’t run SQL typed into the chat — but you don’t need it. **Describe what you want in plain words** and I’ll write and run the query for you (always read-only), then show you the exact SQL under **“How I got this”**.

For example:`;
