import { getLanguage } from './i18n';
import { z } from 'zod';
import type { Session } from './domain';
import { normalizeEvidence } from './evidence';
import { questionPolicySchema } from './question-policy';
import { knowledgeSchema } from './knowledge';

export const courseSchema = z.object({
  id: z.string(), name: z.string().min(1).max(100), folder: z.string(),
  examDate: z.string(), minutes: z.number().int().min(5).max(240),
  questionPolicy: questionPolicySchema.optional(),
  archived: z.boolean().optional(),
  priority: z.number().int().min(0).max(2).optional(),
  policyHistory: z.array(z.object({ at: z.string(), policy: questionPolicySchema })).optional(),
  requirements: z.array(z.object({ id: z.string(), label: z.string().min(1).max(200), kind: z.enum(['syllabus', 'goal', 'question']), text: z.string().min(8).max(24000), knowledgeIds: z.array(z.string()).min(1), confirmedAt: z.string() })).optional(),
  units: z.array(z.object({ id: z.string(), title: z.string(), path: z.string(), topics: z.array(z.string()).optional(), excluded: z.boolean().optional(), materialMtime: z.number().optional(), knowledge: z.array(knowledgeSchema).optional() })),
});
export type Course = z.infer<typeof courseSchema>;

/** Course units follow actual Markdown files, so their identity survives content edits. */
export function courseUnits(files: { path: string; basename: string }[], folder: string, previous: Course['units'] = []): Course['units'] {
  const prefix = folder.replace(/^\/+|\/+$/g, '');
  return files.filter(f => !prefix || f.path.startsWith(`${prefix}/`))
    .sort((a, b) => a.path.localeCompare(b.path, getLanguage(), { numeric: true }))
    .map(f => ({ ...previous.find(u => u.path === f.path), id: previous.find(u => u.path === f.path)?.id ?? crypto.randomUUID(), path: f.path, title: f.basename }));
}

export { unitEvidence } from './unit-evidence';
