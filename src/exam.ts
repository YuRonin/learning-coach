import { t as tr } from './i18n';
import { z } from 'zod';
import { focusSchema } from './knowledge';
import { allocationFor, questionPolicySchema, questionTypes, requestedType, type QuestionPolicy, type QuestionType } from './question-policy';

export const examSchema = z.object({
  id: z.string(), courseId: z.string(), unitId: z.string(), title: z.string(), createdAt: z.string(),
  status: z.enum(['active', 'finished']), policy: questionPolicySchema,
  items: z.array(z.object({ focus: focusSchema, source: z.object({ path: z.string(), name: z.string(), text: z.string().min(8).max(24000), mtime: z.number(), selection: z.boolean() }), type: z.enum(questionTypes), sessionId: z.string().optional() })).min(1).max(20),
});
export type Exam = z.infer<typeof examSchema>;
export function examTypes(policy: QuestionPolicy, count: number): QuestionType[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(tr('m163'));
  const allocation = allocationFor(policy, [], 'exam');
  return Array.from({ length: count }, (_, i) => {
    const type = requestedType({ allocation, attempts: [] }) ?? policy.enabled[i % policy.enabled.length]!;
    allocation.displayed[type]++; return type;
  });
}
