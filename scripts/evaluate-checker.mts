import { setLanguage } from '../src/i18n';
import { mkdir, writeFile } from 'node:fs/promises';
import { ModelGateway } from '../src/api';
import { DEFAULT_SETTINGS, makeSession, extractJson } from '../src/domain';
import { qualityMessages, qualityResultSchema } from '../src/quality';
import { checkerCases } from '../tests/fixtures/checker-cases';

if (!process.env.LC_EVAL_BASE_URL || !process.env.LC_EVAL_MODEL) throw new Error('请设置独立的 LC_EVAL_BASE_URL、LC_EVAL_MODEL 和必要的 LC_EVAL_KEY。不会读取 Obsidian 配置。');
const language = process.env.LC_EVAL_LANGUAGE === 'zh-CN' ? 'zh-CN' : 'en';
setLanguage(language);
const settings = { ...DEFAULT_SETTINGS, baseUrl: process.env.LC_EVAL_BASE_URL, model: process.env.LC_EVAL_MODEL, apiKey: process.env.LC_EVAL_KEY ?? '',
  provider: process.env.LC_EVAL_PROVIDER === 'ollama' ? 'ollama' as const : 'compatible' as const };
const gateway = new ModelGateway(async request => { const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body }); return { status: response.status, text: await response.text() }; });
const directory = `.test-artifacts/model-evaluation/checker-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(directory, { recursive: true });
const results: unknown[] = [];
let falseAccept = 0, falseReject = 0, errors = 0;
for (const sample of checkerCases) {
  const session = makeSession({ path: `${sample.id}.md`, name: sample.id, text: sample.source, mtime: 1, selection: true }, '');
  const start = Date.now();
  try {
    const output = qualityResultSchema.parse(extractJson(await gateway.complete(settings, qualityMessages(sample.question, session))));
    if (sample.expected === 'blocked' && output.verdict === 'supported') falseAccept++;
    if (sample.expected === 'supported' && output.verdict !== 'supported') falseReject++;
    results.push({ ...sample, output, elapsedMs: Date.now() - start });
  } catch (e) { errors++; results.push({ id: sample.id, error: e instanceof Error && e.name !== 'ZodError' ? e.message : '返回格式不符合要求。', elapsedMs: Date.now() - start }); }
  await writeFile(`${directory}/results.json`, JSON.stringify({ language, model: settings.model, falseAccept, falseReject, errors, usage: gateway.usage, humanReviewed: false, results }, null, 2));
  console.log(`已完成 ${results.length}/${checkerCases.length} 个审题样本。`);
}
console.log(`漏检 ${falseAccept}，误拦 ${falseReject}，请求或格式失败 ${errors}。需要人工复核结果；报告保留于 ${directory}。`);
