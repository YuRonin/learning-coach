import { setLanguage } from '../src/i18n';
import { mkdir, writeFile } from 'node:fs/promises';
import { ModelGateway } from '../src/api';
import { DEFAULT_SETTINGS, makeSession, parseReply } from '../src/domain';
import { allocationFor, emptyCounts, questionTypes } from '../src/question-policy';
import { buildMessages } from '../src/prompts';
import { evaluationCases } from '../tests/fixtures/evaluation-cases';

if (!process.env.LC_EVAL_BASE_URL || !process.env.LC_EVAL_MODEL) throw new Error('请为独立评估设置 LC_EVAL_BASE_URL、LC_EVAL_MODEL；如需鉴权，设置 LC_EVAL_KEY。不会读取 Obsidian 配置。');
const language = process.env.LC_EVAL_LANGUAGE === 'zh-CN' ? 'zh-CN' : 'en';
setLanguage(language);
const settings = { ...DEFAULT_SETTINGS, provider: process.env.LC_EVAL_PROVIDER === 'ollama' ? 'ollama' as const : 'compatible' as const,
  baseUrl: process.env.LC_EVAL_BASE_URL, model: process.env.LC_EVAL_MODEL, apiKey: process.env.LC_EVAL_KEY ?? '', temperature: 0.2 };
const gateway = new ModelGateway(async request => { const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body }); return { status: response.status, text: await response.text() }; });
const results: unknown[] = [];
const directory = `.test-artifacts/model-evaluation/generation-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(directory, { recursive: true });
for (const [index, sample] of evaluationCases.entries()) for (let variant = 0; variant < 2; variant++) {
  const type = questionTypes[(index * 2 + variant) % 4]!;
  const session = makeSession({ path: `${sample.id}.md`, name: sample.title, text: sample.text, mtime: 1, selection: false }, '依据材料出一道练习。材料缺失或矛盾时，考查识别不足，不推断未知事实。');
  session.courseId = 'evaluation'; session.allocation = allocationFor({ enabled: [type], mode: 'fixed', weights: { ...emptyCounts(), [type]: 100 } }, [], 'evaluation');
  session.pending = { id: crypto.randomUUID(), action: 'start', input: '', attemptId: null };
  const start = Date.now(); const messages = buildMessages(session);
  try {
    const raw = await gateway.complete(settings, messages); const reply = parseReply(raw, session);
    results.push({ sample: sample.id, source: sample.text, type, elapsedMs: Date.now() - start, inputChars: JSON.stringify(messages).length, outputChars: raw.length, question: reply.question, manualVerdict: null, manualNotes: '' });
  } catch (e) { results.push({ sample: sample.id, type, elapsedMs: Date.now() - start, error: e instanceof Error && e.name !== 'ZodError' ? e.message : '返回格式不符合要求。', manualVerdict: null }); }
  await writeFile(`${directory}/results.json`, JSON.stringify({ language, model: settings.model, syntheticMaterials: true, calls: results.length, usage: gateway.usage, humanReviewed: false, results }, null, 2));
  console.log(`已完成 ${results.length}/60 次评估请求。`);
}
console.log(`本次报告保留于 ${directory}；每次运行单独保存，不覆盖失败样本。`);
