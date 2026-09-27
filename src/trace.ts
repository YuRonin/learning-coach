import { t as tr, localizedLabels } from './i18n';
import { z } from 'zod';

export const traceActions = ['start', 'next', 'answer', 'hint', 'explain', 'ask', 'dispute', 'connection', 'suggest-knowledge', 'suggest-mapping', 'pause', 'resume', 'end', 'restore', 'fallback'] as const;
export type TraceAction = typeof traceActions[number];
const count = z.number().finite().nonnegative();
const ref = z.string().regex(/^(?:[a-f0-9-]{36}|ref-[a-f0-9]{8})$/);
const eventSchema = z.object({
  sequence: z.number().int().positive(), at: z.string().datetime(),
  kind: z.enum(['action', 'request', 'cache', 'schema', 'quality', 'persist', 'local-grade']),
  status: z.enum(['started', 'success', 'failure', 'cancelled', 'hit', 'miss', 'bypass', 'passed', 'rejected', 'uncertain']),
  requestId: ref.optional(), durationMs: count.optional(), inputChars: count.optional(), outputChars: count.optional(),
  inputTokens: count.optional(), outputTokens: count.optional(), cachedInputTokens: count.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  code: z.enum(['configuration', 'network', 'http', 'timeout', 'cancelled', 'invalid-json', 'empty-response', 'structure', 'duplicate-or-leak', 'unsupported', 'budget', 'storage', 'unknown']).optional(),
  scope: z.enum(['generation', 'audit', 'other']).optional(),
  provider: z.enum(['compatible', 'ollama']).optional(), modelRef: ref.optional(),
});
export type TraceEventInput = Omit<z.infer<typeof eventSchema>, 'sequence' | 'at'>;
export const traceSchema = z.object({
  schemaVersion: z.literal(1), traceId: ref, runId: ref, pluginVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  action: z.enum(traceActions), startedAt: z.string().datetime(), endedAt: z.string().datetime().optional(),
  outcome: z.enum(['running', 'success', 'failure', 'cancelled']),
  sessionRef: ref.optional(), operationRef: ref.optional(), taskRef: ref.optional(), courseRef: ref.optional(), knowledgeRef: ref.optional(), examRef: ref.optional(),
  events: z.array(eventSchema).max(128),
});
export type TraceRecord = z.infer<typeof traceSchema>;
export interface TraceContext { sessionId?: string; operationId?: string; taskId?: string; courseId?: string; knowledgeId?: string; examId?: string }
export interface TraceStorage { write(path: string, text: string): Promise<void> }
export function traceRef(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `ref-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
export function traceFolder(value: string): string {
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.length > 180 || /[\x00-\x1f:*?"<>|#\[\]]/.test(path) || path.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.'))) throw new Error(tr('m464'));
  return path;
}
export const traceLabels: Record<TraceAction, string> = localizedLabels({ start: 'm465', next: 'm466', answer: 'm467', hint: 'm468', explain: 'm469', ask: 'm470', dispute: 'm471', connection: 'm405', 'suggest-knowledge': 'm472', 'suggest-mapping': 'm473', pause: 'm474', resume: 'm475', end: 'm476', restore: 'm477', fallback: 'm478' });
export function traceMarkdown(record: TraceRecord): string {
  const r = traceSchema.parse(record);
  const outcomes = { running: tr('m479'), success: tr('m460'), failure: tr('m461'), cancelled: tr('m462') };
  const rows = r.events.map(e => `| ${e.sequence} | ${e.at} | ${{ action: tr('m480'), request: tr('m481'), cache: tr('m482'), schema: tr('m483'), quality: tr('m484'), persist: tr('m485'), 'local-grade': tr('m486') }[e.kind]} | ${{ started: tr('m487'), success: tr('m460'), failure: tr('m461'), cancelled: tr('m488'), hit: tr('m489'), miss: tr('m490'), bypass: tr('m491'), passed: tr('m492'), rejected: tr('m493'), uncertain: tr('m070') }[e.status]} | ${e.durationMs === undefined ? '—' : Math.round(e.durationMs)} | ${e.inputTokens ?? tr('m494')} / ${e.outputTokens ?? tr('m494')} |`);
  return tr('m495', [traceLabels[r.action], outcomes[r.outcome], r.traceId, r.startedAt, r.pluginVersion, rows.join('\n'), JSON.stringify(r, null, 2)]);
}
export function parseTraceMarkdown(text: string): TraceRecord {
  if (text.length > 150000 || !text.startsWith('---\nlearning-coach-trace: 1\n')) throw new Error(tr('m496'));
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  return traceSchema.parse(JSON.parse(match?.[1] ?? ''));
}
export class TraceStore {
  readonly runId = crypto.randomUUID();
  private queue: Promise<void> = Promise.resolve();
  storageFailed = false;
  lastPath: string | null = null;
  constructor(private storage: TraceStorage, private options: () => { enabled: boolean; folder: string; version: string }) {}
  async begin(action: TraceAction, context: TraceContext = {}): Promise<TraceRun | undefined> {
    try {
      if (!this.options().enabled) return;
      const { folder, version } = this.options();
      const startedAt = new Date().toISOString(); const traceId = crypto.randomUUID();
      const record: TraceRecord = { schemaVersion: 1, traceId, runId: this.runId, pluginVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0', action, startedAt, outcome: 'running', events: [],
        sessionRef: context.sessionId ? traceRef(context.sessionId) : undefined, operationRef: context.operationId ? traceRef(context.operationId) : undefined,
        taskRef: context.taskId ? traceRef(context.taskId) : undefined, courseRef: context.courseId ? traceRef(context.courseId) : undefined,
        knowledgeRef: context.knowledgeId ? traceRef(context.knowledgeId) : undefined, examRef: context.examId ? traceRef(context.examId) : undefined };
      const run = new TraceRun(record, `${traceFolder(folder)}/${startedAt.slice(0, 10)}/${traceId}.md`, this);
      await run.event({ kind: 'action', status: 'started' }); return run;
    } catch { this.storageFailed = true; return; }
  }
  async persist(path: string, record: TraceRecord): Promise<void> {
    if (!this.options().enabled) return;
    try {
      const text = traceMarkdown(record);
      this.queue = this.queue.catch(() => undefined).then(async () => {
        if (!this.options().enabled) return;
        try { await this.storage.write(path, text); this.lastPath = path; this.storageFailed = false; }
        catch { this.storageFailed = true; }
      });
      await this.queue;
    } catch { this.storageFailed = true; }
  }
  async flush(): Promise<void> { await this.queue; }
}
export class TraceRun {
  private ended = false;
  constructor(readonly record: TraceRecord, readonly path: string, private store: TraceStore) {}
  async event(event: TraceEventInput): Promise<void> {
    if (this.ended) return;
    try {
      if (this.record.events.length < 127) this.record.events.push(eventSchema.parse({ ...event, sequence: this.record.events.length + 1, at: new Date().toISOString() }));
      await this.store.persist(this.path, this.record);
    } catch { this.store.storageFailed = true; }
  }
  async finish(outcome: 'success' | 'failure' | 'cancelled'): Promise<void> {
    if (this.ended) return;
    this.record.outcome = outcome; this.record.endedAt = new Date().toISOString();
    this.ended = true;
    this.record.events.push(eventSchema.parse({ kind: 'action', status: outcome, durationMs: Math.max(0, Date.now() - Date.parse(this.record.startedAt)), sequence: this.record.events.length + 1, at: this.record.endedAt }));
    await this.store.persist(this.path, this.record);
  }
}
