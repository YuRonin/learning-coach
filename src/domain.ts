import { z } from 'zod';

export const settingsSchema = z.object({
  provider: z.enum(['compatible', 'ollama']).default('compatible'),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  timeoutSeconds: z.number().int().min(10).max(300).default(90),
  maxCalls: z.number().int().min(5).max(100).default(30),
  outputFolder: z.string().default('学习教练'),
  questionsPerSession: z.number().int().min(1).max(10).default(3),
  learningMode: z.enum(['guided', 'diagnostic']).default('guided'),
  autoExport: z.boolean().default(true),
  sendTemperature: z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS = settingsSchema.parse({});
export const MAX_SOURCE_LENGTH = 24_000;

export const assessmentSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect', 'uncertain']),
  feedback: z.string().min(1).max(4000),
});
export const questionDraftSchema = z.object({
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
});
export type Reply = z.infer<typeof replySchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export const questionSchema = questionDraftSchema.extend({
  id: z.string(),
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
  entries: z.array(z.object({ id: z.string(), role: z.enum(['coach', 'user', 'system']), text: z.string(), at: z.string() })),
  attempts: z.array(z.object({
    id: z.string(), question: questionSchema, answer: z.string(), at: z.string(),
    assessment: assessmentSchema.nullable(),
    revisions: z.array(assessmentSchema),
  })),
  pending: z.object({ id: z.string(), action: actionSchema, input: z.string(), attemptId: z.string().nullable() }).nullable(),
  calls: z.number().int().nonnegative(),
  error: z.string().nullable(),
  draft: z.string().default(''),
  mode: z.enum(['guided', 'diagnostic']).default('guided'),
  targetQuestions: z.number().int().min(1).max(100).default(3),
  reviewOf: z.string().nullable().default(null),
});
export type Session = z.infer<typeof sessionSchema>;
export const dataSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema,
  session: sessionSchema.nullable(),
  archive: z.array(sessionSchema),
  reviewSnoozes: z.record(z.string(), z.string()).default({}),
});
export type PluginData = z.infer<typeof dataSchema>;

export function makeSession(source: Session['source'], goal: string): Session {
  if (!source.text.trim()) throw new Error('这篇笔记没有可学习的文字。');
  if (source.text.length > MAX_SOURCE_LENGTH) throw new Error('首版每次最多学习 24,000 个字符。请选中一个章节后，从右键菜单开始学习。');
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), createdAt: now, updatedAt: now, status: 'ready', source,
    goal: goal.trim() || '理解这篇笔记的核心概念，并能够用自己的话解释和应用。',
    outline: [], question: null, entries: [], attempts: [], pending: null, calls: 0, error: null, draft: '',
    mode: 'guided', targetQuestions: 3, reviewOf: null,
  };
}

export const VERDICT_LABELS: Record<Assessment['verdict'], string> = {
  correct: '本题回答符合要点', partial: '部分理解', incorrect: '需要再梳理', uncertain: '待核实',
};

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
  throw new Error('没有找到完整的结构化内容。');
}

export function parseReply(text: string, session: Session): Reply {
  let reply: Reply;
  try { reply = replySchema.parse(extractJson(text)); }
  catch { throw new Error('模型未返回有效的带学结构。学习现场已保存，可重试；也可以换用更擅长结构化输出的模型。'); }
  const action = session.pending?.action;
  if (action === 'start' || action === 'next') {
    if (!reply.question || reply.assessment) throw new Error('模型没有按要求给出新问题，请重试。');
    if (action === 'start' && reply.outline.length === 0) throw new Error('模型没有给出学习目标，请重试。');
    const normalize = (s: string) => s.replace(/\s+/g, '');
    if (!normalize(session.source.text).includes(normalize(reply.question.referenceQuote))) {
      throw new Error('题目的引用未在笔记中找到，已拦截该题。请重试。');
    }
  } else if (action === 'answer' || action === 'dispute') {
    if (!reply.assessment || reply.question) throw new Error('模型没有按要求返回本题评价，请重试。');
  } else if (reply.assessment || reply.question) {
    throw new Error('模型试图在提示环节更换问题或评分，已拦截。请重试。');
  }
  return reply;
}

export function exportSession(session: Session): string {
  const lines = [
    `# 学习记录 · ${session.source.name}`, '',
    `日期：${session.createdAt.slice(0, 10)}`, `来源：[[${session.source.path}]]`,
    `目标：${session.goal}`, '', '> 本记录描述本次学习证据，不代表已永久掌握。', '',
    '## 本次小结', '', ...summarizeSession(session).map(line => `- ${line}`), '', '## 学习路线', '',
    ...session.outline.map((item, index) => `${index + 1}. ${item}`), '', '## 作答证据', '',
  ];
  for (const [index, attempt] of session.attempts.entries()) {
    lines.push(`### ${index + 1}. ${attempt.question.prompt}`, '',
      `学习条件：${attempt.question.revealed ? '已看讲解或答案' : attempt.question.hints > 0 ? '使用过提示' : '未请求提示'}`,
      '', '我的回答：', '', attempt.answer, '',
      `评价：${attempt.assessment ? VERDICT_LABELS[attempt.assessment.verdict] : '待评价'}`, '',
      attempt.assessment?.feedback ?? '尚未完成评价。', '',
      '原文依据：', '', ...attempt.question.referenceQuote.split('\n').map(line => `> ${line}`), '');
    if (attempt.revisions.length) lines.push(`本题经过 ${attempt.revisions.length} 次评价修订。`, '');
  }
  lines.push('## 学习过程', '');
  for (const entry of session.entries) {
    lines.push(`### ${entry.role === 'coach' ? '教练' : entry.role === 'user' ? '我' : '记录'}`, '', entry.text, '');
  }
  return lines.join('\n');
}

export function draftContext(session: Session): string {
  return `${session.id}:${session.question?.id ?? 'feedback'}:${session.attempts.at(-1)?.id ?? ''}`;
}

export function summarizeSession(session: Session): string[] {
  const independent = session.attempts.filter(a => a.assessment?.verdict === 'correct' && !a.question.hints && !a.question.revealed).length;
  const supported = session.attempts.filter(a => a.assessment?.verdict === 'correct' && (a.question.hints > 0 || a.question.revealed)).length;
  const needsWork = session.attempts.filter(a => a.assessment && a.assessment.verdict !== 'correct').length;
  const pending = session.attempts.filter(a => !a.assessment).length;
  return [
    `本次提交 ${session.attempts.length} 次回答；计划 ${session.targetQuestions} 题。`,
    `未请求提示且符合要点 ${independent} 次；使用提示或讲解后符合要点 ${supported} 次。`,
    `需要巩固或核实 ${needsWork} 次；尚未评价 ${pending} 次。`,
    session.attempts.some(a => a.assessment) ? '已评价内容进入复习安排；下次用新的独立回答继续检验。' : '还没有足够的作答证据，后续可从本次材料重新开始。',
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
    chunks.push({ label: `第 ${chunks.length + 1} 部分${heading ? ` · ${heading.slice(0, 60)}` : ''}`, text: part });
    remaining = remaining.slice(end);
  }
  return chunks;
}
