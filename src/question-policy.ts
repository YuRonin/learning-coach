import { t as tr, localizedLabels } from './i18n';
import { z } from 'zod';

export const questionTypes = ['single', 'boolean', 'multiple', 'short'] as const;
export type QuestionType = typeof questionTypes[number];
export const questionLabels: Record<QuestionType, string> = localizedLabels({ single: 'm080', boolean: 'm082', multiple: 'm081', short: 'm083' });
const countsSchema = z.object({ single: z.number().int().nonnegative(), boolean: z.number().int().nonnegative(), multiple: z.number().int().nonnegative(), short: z.number().int().nonnegative() });
export const questionPolicySchema = z.object({
  enabled: z.array(z.enum(questionTypes)).min(1).max(4),
  mode: z.enum(['adaptive', 'fixed']),
  weights: countsSchema,
}).superRefine((p, ctx) => {
  if (new Set(p.enabled).size !== p.enabled.length) ctx.addIssue({ code: 'custom', message: tr('m320') });
  if (p.mode === 'fixed' && (questionTypes.reduce((n, t) => n + p.weights[t], 0) !== 100 || questionTypes.some(t => p.enabled.includes(t) ? p.weights[t] <= 0 : p.weights[t] !== 0))) {
    ctx.addIssue({ code: 'custom', message: tr('m321') });
  }
});
export type QuestionPolicy = z.infer<typeof questionPolicySchema>;
export const emptyCounts = () => ({ single: 0, boolean: 0, multiple: 0, short: 0 });
export const defaultPolicy = (): QuestionPolicy => ({ enabled: [...questionTypes], mode: 'adaptive', weights: emptyCounts() });
export const questionAllocationSchema = z.object({ policy: questionPolicySchema, baseline: countsSchema, displayed: countsSchema });
export type QuestionAllocation = z.infer<typeof questionAllocationSchema>;

export function requestedType(session: { allocation?: QuestionAllocation; attempts: unknown[] }): QuestionType | null {
  const a = session.allocation;
  if (!a) return questionTypes[session.attempts.length % 4]!;
  if (a.policy.mode === 'adaptive') return a.policy.enabled.length === 1 ? a.policy.enabled[0]! : null;
  const counts = questionTypes.map(t => a.baseline[t] + a.displayed[t]);
  const total = counts.reduce((n, c) => n + c, 0);
  // Largest cumulative deficit: short sessions, skipped questions and retries cannot reset the sequence.
  return questionTypes.filter(t => a.policy.enabled.includes(t)).sort((aType, bType) => {
    const deficit = (t: QuestionType) => (total + 1) * a.policy.weights[t] / 100 - counts[questionTypes.indexOf(t)]!;
    return deficit(bType) - deficit(aType);
  })[0]!;
}

export function allocationFor(policy: QuestionPolicy, sessions: { courseId?: string; allocation?: QuestionAllocation }[], courseId: string): QuestionAllocation {
  const parsed = questionPolicySchema.parse(policy);
  const baseline = emptyCounts();
  for (const s of sessions) {
    if (s.courseId !== courseId || !s.allocation) continue;
    // Keep actual displayed counts across sessions, including temporary configurations.
    for (const t of questionTypes) if (parsed.enabled.includes(t)) baseline[t] += s.allocation.displayed[t];
  }
  return { policy: structuredClone(parsed), baseline, displayed: emptyCounts() };
}
