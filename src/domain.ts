import { t as tr, localizedLabels } from './i18n';
import { z } from 'zod';
import { courseSchema } from './course';
import { questionAllocationSchema, requestedType } from './question-policy';
import { focusSchema } from './knowledge';
import { planSchema } from './planner';
import { examSchema } from './exam';

export const settingsSchema = z.object({
  language: z.enum(['en', 'zh-CN']).default('en'),
  provider: z.enum(['compatible', 'ollama']).default('compatible'),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  timeoutSeconds: z.number().int().min(10).max(300).default(90),
  maxCalls: z.number().int().min(5).max(100).default(30),
  outputFolder: z.string().default('Learning Coach'),
  questionsPerSession: z.number().int().min(1).max(10).default(3),
  learningMode: z.enum(['guided', 'diagnostic']).default('guided'),
  autoExport: z.boolean().default(true),
  sendTemperature: z.boolean().default(true),
  cacheEnabled: z.boolean().default(true),
  traceEnabled: z.boolean().default(true),
  traceFolder: z.string().default('Learning Coach/Traces'),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS = settingsSchema.parse({});
export const MAX_SOURCE_LENGTH = 24_000;

export const assessmentSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect', 'uncertain']),
  feedback: z.string().min(1).max(4000),
});
export const questionDraftSchema = z.object({
  type: z.enum(['single', 'multiple', 'boolean', 'short']).optional(),
  options: z.array(z.object({ id: z.string().regex(/^[A-F]$/), text: z.string().min(1).max(1000) })).max(6).optional(),
  correctOptions: z.array(z.string()).max(6).optional(),
  prompt: z.string().min(1).max(2000),
  referenceQuote: z.string().min(8).max(2000),
  rubric: z.string().min(1).max(3000),
  expectedAnswer: z.string().min(1).max(3000),
});
export const replySchema = z.object({
  message: z.string().min(1).max(7000),
  outline: z.array(z.string().min(1).max(200)).max(6).default([]),
  question: questionDraftSchema.nullable().default(null),
  assessment: assessmentSchema.nullable().default(null),
  helpExposure: z.enum(['none', 'hint', 'answer']).optional(),
});
export type Reply = z.infer<typeof replySchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export const questionSchema = questionDraftSchema.extend({
  id: z.string(),
  originId: z.string().optional(),
  knowledgeId: z.string().optional(),
  quality: z.object({ verdict: z.literal('supported'), reason: z.string() }).optional(),
  reused: z.boolean().optional(),
  invalidated: z.object({ reason: z.string().min(1).max(1000), at: z.string() }).optional(),
  hints: z.number().int().nonnegative().default(0),
  revealed: z.boolean().default(false),
});
export type Question = z.infer<typeof questionSchema>;
export const actionSchema = z.enum(['start', 'answer', 'hint', 'explain', 'next', 'dispute', 'ask']);
export type Action = z.infer<typeof actionSchema>;
export const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['ready', 'paused', 'ended']),
  source: z.object({ path: z.string(), name: z.string(), text: z.string(), mtime: z.number(), selection: z.boolean() }),
  goal: z.string(),
  outline: z.array(z.string()),
  question: questionSchema.nullable(),
  retiredQuestions: z.array(questionSchema).optional(),
  entries: z.array(z.object({ id: z.string(), role: z.enum(['coach', 'user', 'system']), text: z.string(), at: z.string() })),
  attempts: z.array(z.object({
    id: z.string(), question: questionSchema, answer: z.string(), at: z.string(),
    assessment: assessmentSchema.nullable(),
    revisions: z.array(assessmentSchema),
    confidence: z.enum(['certain', 'unsure', 'guessed']).optional(),
    mistakeCause: z.enum(['unknown', 'concept', 'memory', 'reading', 'calculation']).optional(),
  })),
  pending: z.object({ id: z.string(), action: actionSchema, input: z.string(), attemptId: z.string().nullable() }).nullable(),
  calls: z.number().int().nonnegative(),
  error: z.string().nullable(),
  draft: z.string().default(''),
  mode: z.enum(['guided', 'diagnostic']).default('guided'),
  targetQuestions: z.number().int().min(1).max(100).default(3),
  reviewOf: z.string().nullable().default(null),
  courseId: z.string().optional(),
  unitId: z.string().optional(),
  allocation: questionAllocationSchema.optional(),
  focus: focusSchema.optional(),
  taskId: z.string().optional(),
  examId: z.string().optional(),
  examIndex: z.number().int().nonnegative().optional(),
  activeSeconds: z.number().nonnegative().optional(),
  cacheHits: z.number().int().nonnegative().optional(),
  previousQuestions: z.array(questionSchema).max(20).optional(),
  reviewFallback: questionSchema.optional(),
  choiceDraft: z.array(z.string()).optional(),
  confidenceDraft: z.enum(['certain', 'unsure', 'guessed']).optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const dataSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).transform(() => 4 as const),
  settings: settingsSchema,
  session: sessionSchema.nullable(),
  archive: z.array(sessionSchema),
  reviewSnoozes: z.record(z.string(), z.string()).default({}),
  courses: z.array(courseSchema).default([]),
  plans: z.array(planSchema).default([]),
  exams: z.array(examSchema).default([]),
}).transform(data => {
  for (const course of data.courses) for (const unit of course.units) {
    if (unit.id !== unit.path) continue;
    const previous = unit.id;
    unit.id = `unit:${course.id}:${encodeURIComponent(previous)}`;
    for (const session of [...data.archive, ...(data.session ? [data.session] : [])]) {
      if (session.courseId === course.id && session.unitId === previous) session.unitId = unit.id;
    }
  }
  return data;
});
export type PluginData = z.infer<typeof dataSchema>;

export function makeSession(source: Session['source'], goal: string): Session {
  if (!source.text.trim()) throw new Error(tr('m064'));
  if (source.text.length > MAX_SOURCE_LENGTH) throw new Error(tr('m065'));
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), createdAt: now, updatedAt: now, status: 'ready', source,
    goal: goal.trim() || tr('m066'),
    outline: [], question: null, entries: [], attempts: [], pending: null, calls: 0, error: null, draft: '',
    mode: 'guided', targetQuestions: 3, reviewOf: null,
  };
}

export const VERDICT_LABELS: Record<Assessment['verdict'], string> = localizedLabels({
  correct: 'm067', partial: 'm068', incorrect: 'm069', uncertain: 'm070',
});

export function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* Some compatible models add a short preamble. */ }
  const start = cleaned.indexOf('{');
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index >= 0 && index < cleaned.length; index++) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
  }
  throw new Error(tr('m071'));
}

export function parseReply(text: string, session: Session): Reply {
  let reply: Reply;
  try { reply = replySchema.parse(extractJson(text)); }
  catch { throw new Error(tr('m072')); }
  const action = session.pending?.action;
  if (action === 'start' || action === 'next') {
    if (!reply.question || reply.assessment) throw new Error(tr('m073'));
    if (action === 'start' && reply.outline.length === 0) throw new Error(tr('m074'));
    const normalize = (s: string) => s.replace(/\s+/g, '');
    if (!normalize(session.source.text).includes(normalize(reply.question.referenceQuote))) {
      throw new Error(tr('m075'));
    }
    validateQuestion(reply.question);
    const requested = requestedType(session);
    if ((session.allocation && (!reply.question.type || !session.allocation.policy.enabled.includes(reply.question.type))) ||
      ((session.courseId || session.allocation) && requested && reply.question.type !== requested)) {
      throw new Error(tr('m076'));
    }
    if (action === 'next' && session.courseId && session.attempts.some(a => normalize(a.question.prompt) === normalize(reply.question!.prompt))) {
      throw new Error(tr('m077'));
    }
  } else if (action === 'answer' || action === 'dispute') {
    if (!reply.assessment || reply.question) throw new Error(tr('m078'));
  } else if (reply.assessment || reply.question) {
    throw new Error(tr('m079'));
  }
  return reply;
}

export const QUESTION_LABELS = localizedLabels({ single: 'm080', multiple: 'm081', boolean: 'm082', short: 'm083' });

export function validateQuestion(q: z.infer<typeof questionDraftSchema>): void {
  if (!q.type || q.type === 'short') {
    if (q.options?.length || q.correctOptions?.length) throw new Error(tr('m084'));
    return;
  }
  const options = q.options ?? [];
  const ids = options.map(o => o.id);
  const answers = q.correctOptions ?? [];
  if (options.length < 2 || new Set(ids).size !== ids.length || new Set(options.map(o => o.text.trim())).size !== ids.length
    || !answers.length || new Set(answers).size !== answers.length || answers.some(id => !ids.includes(id))
    || (q.type !== 'multiple' && answers.length !== 1) || (q.type === 'multiple' && answers.length < 2)
    || (q.type === 'boolean' && (options.length !== 2 || !(['True', '正确'].includes(options[0]?.text ?? '') && ['False', '错误'].includes(options[1]?.text ?? ''))))) {
    throw new Error(tr('m087'));
  }
}

export function gradeChoice(q: Question, answer: string): Assessment | null {
  if (!q.type || q.type === 'short') return null;
  validateQuestion(q);
  const selected = answer.split(',');
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !q.options!.some(o => o.id === id))
    || (q.type !== 'multiple' && selected.length !== 1)) throw new Error(tr('m088'));
  const correct = selected.length === q.correctOptions!.length && selected.every(id => q.correctOptions!.includes(id));
  const labels = q.options!.filter(o => q.correctOptions!.includes(o.id)).map(o => `${o.id}：${o.text}`).join('；');
  return { verdict: correct ? 'correct' : 'incorrect', feedback: tr('m089', [correct ? tr('m090') : tr('m091'), labels, q.expectedAnswer, q.rubric]) };
}

export function exportSession(session: Session): string {
  const lines = [
    tr('m092', [session.source.name]), '',
    tr('m093', [session.createdAt.slice(0, 10)]), tr('m094', [session.source.path]),
    tr('m095', [session.goal]), '', tr('m096'), '',
    tr('m097'), '', ...summarizeSession(session).map(line => `- ${line}`), '', tr('m098'), '',
    ...session.outline.map((item, index) => `${index + 1}. ${item}`), '', tr('m099'), '',
  ];
  for (const [index, attempt] of session.attempts.entries()) {
    lines.push(`### ${index + 1}. ${attempt.question.prompt}`, '',
      ...(attempt.question.invalidated ? [tr('m100', [attempt.question.invalidated.reason]), ''] : []),
      ...(attempt.question.options ?? []).map(o => `${o.id}. ${o.text}`), '',
      tr('m101', [attempt.confidence === 'certain' ? tr('m102') : attempt.confidence === 'unsure' ? tr('m103') : attempt.confidence === 'guessed' ? tr('m104') : tr('m105')]),
      tr('m106', [attempt.question.reused ? tr('m107') : attempt.question.revealed ? tr('m108') : attempt.question.hints > 0 ? tr('m109') : tr('m110')]),
      '', tr('m111'), '', attempt.answer, '',
      tr('m112', [attempt.assessment ? VERDICT_LABELS[attempt.assessment.verdict] : tr('m113')]), '',
      attempt.assessment?.feedback ?? tr('m114'), '',
      tr('m115'), '', ...attempt.question.referenceQuote.split('\n').map(line => `> ${line}`), '');
    if (attempt.revisions.length) lines.push(tr('m116', [attempt.revisions.length]), '');
  }
  const unsubmitted = [...(session.retiredQuestions ?? []), ...(session.question && !session.attempts.some(a => a.question.id === session.question!.id) ? [session.question] : [])];
  if (unsubmitted.length) {
    lines.push(tr('m117'), '');
    for (const question of unsubmitted) lines.push(`### ${question.prompt}`, '', question.invalidated ? tr('m118', [question.invalidated.reason]) : tr('m119'), '');
  }
  lines.push(tr('m120'), '');
  for (const entry of session.entries) {
    lines.push(`### ${entry.role === 'coach' ? tr('m121') : entry.role === 'user' ? tr('m122') : tr('m123')}`, '', entry.text, '');
  }
  return lines.join('\n');
}

export function draftContext(session: Session): string {
  return `${session.id}:${session.question?.id ?? 'feedback'}:${session.attempts.at(-1)?.id ?? ''}`;
}

export function summarizeSession(session: Session): string[] {
  const valid = session.attempts.filter(a => !a.question.invalidated);
  const independent = valid.filter(a => a.assessment?.verdict === 'correct' && !a.question.hints && !a.question.revealed && !a.question.reused && a.confidence !== 'unsure' && a.confidence !== 'guessed').length;
  const supported = valid.filter(a => a.assessment?.verdict === 'correct' && (a.question.hints > 0 || a.question.revealed || a.question.reused || a.confidence === 'unsure' || a.confidence === 'guessed')).length;
  const needsWork = valid.filter(a => a.assessment && a.assessment.verdict !== 'correct').length;
  const pending = valid.filter(a => !a.assessment).length;
  return [
    tr('m124', [session.attempts.length, session.targetQuestions]),
    tr('m125', [session.attempts.length - valid.length]),
    tr('m126', [independent, supported]),
    tr('m127', [needsWork, pending]),
    valid.some(a => a.assessment) ? tr('m128') : tr('m129'),
  ];
}

export function splitNote(text: string): { label: string; text: string }[] {
  const chunks: { label: string; text: string }[] = [];
  let remaining = text;
  while (remaining.length) {
    let end = Math.min(MAX_SOURCE_LENGTH, remaining.length);
    if (end < remaining.length) {
      const boundary = remaining.lastIndexOf('\n', end - 1);
      if (boundary > MAX_SOURCE_LENGTH / 2) end = boundary + 1;
    }
    const part = remaining.slice(0, end);
    const heading = part.match(/^#{1,6}\s+(.+)$/m)?.[1];
    chunks.push({ label: tr('m130', [chunks.length + 1, heading ? ` · ${heading.slice(0, 60)}` : '']), text: part });
    remaining = remaining.slice(end);
  }
  return chunks;
}
