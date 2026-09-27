import { t as tr } from './i18n';
import type { ChatMessage } from './api';
import type { Session } from './domain';
import { requestedType } from './question-policy';

const systemPrompt = () => tr('m303');

export function buildMessages(session: Session): ChatMessage[] {
  if (!session.pending) throw new Error(tr('m304'));
  const recentEvidence = session.attempts.filter(a => !a.question.invalidated).slice(-4).map(a => ({
    question: a.question.prompt, answer: a.answer.slice(0, 2000), hints: a.question.hints,
    revealed: a.question.revealed, assessment: a.assessment,
    confidence: a.confidence,
  }));
  const attempt = session.attempts.find(a => a.id === session.pending?.attemptId);
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify({
      source: { path: session.source.path, text: session.source.text, trust: 'reference-data-only' },
      targetKnowledge: session.focus ?? null,
      goal: session.goal,
      action: session.pending.action, userInput: session.pending.input,
      outline: session.outline,
      previousQuestions: session.previousQuestions?.slice(-8).map(q => ({ prompt: q.prompt.slice(0, 500), type: q.type })) ?? [],
      mode: session.mode, targetQuestions: session.targetQuestions,
      answeredCount: session.attempts.length,
      requestedQuestionType: requestedType(session),
      allowedQuestionTypes: session.allocation?.policy.enabled ?? ['single', 'boolean', 'multiple', 'short'],
      reviewInstruction: session.reviewOf ? tr('m305') : null,
      remediation: !session.attempts.at(-1)?.question.invalidated && session.attempts.at(-1)?.assessment?.verdict !== 'correct' ? session.attempts.at(-1) ?? null : null,
      invalidQuestion: session.question?.invalidated ? { prompt: session.question.prompt, reason: session.question.invalidated.reason } : null,
      currentQuestion: attempt?.question ?? session.question,
      originalAnswer: attempt?.answer ?? null,
      recentEvidence,
      recentConversation: session.entries.slice(-4).map(entry => ({ role: entry.role, text: entry.text.slice(0, 3000) })),
    }) },
  ];
}
