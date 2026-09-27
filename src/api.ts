import { t as tr } from './i18n';
import { traceRef, type TraceRun, type TraceAction, type TraceStore } from './trace';
import type { Settings } from './domain';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface HttpRequest { url: string; method: string; headers: Record<string, string>; body: string }
export interface HttpResponse { status: number; text: string }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export function endpoint(base: string, provider: Settings['provider']): string {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new Error(tr('m000')); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(tr('m001'));
  if (url.username || url.password || url.search || url.hash) throw new Error(tr('m002'));
  let path = url.pathname.replace(/\/+$/, '');
  if (provider === 'ollama') {
    if (!path.endsWith('/api/chat')) path += path.endsWith('/api') ? '/chat' : '/api/chat';
  } else if (!path.endsWith('/chat/completions')) {
    path += path === '' ? '/v1/chat/completions' : '/chat/completions';
  }
  url.pathname = path;
  return url.toString();
}

export function validateSettings(settings: Settings): void {
  endpoint(settings.baseUrl, settings.provider);
  if (!settings.model.trim()) throw new Error(tr('m003'));
}

function responseError(status: number): Error {
  if (status === 401 || status === 403) return new Error(tr('m004', [status]));
  if (status === 404) return new Error(tr('m005'));
  if (status === 429) return new Error(tr('m006'));
  return new Error(tr('m007', [status]));
}

export class ModelGateway {
  traceStore?: TraceStore;
  usage = { reportedResponses: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReportedResponses: 0 };
  constructor(private readonly transport: Transport) {}

  async complete(settings: Settings, messages: ChatMessage[], signal?: AbortSignal, trace?: TraceRun, action: TraceAction = 'connection'): Promise<string> {
    const ownTrace = !trace;
    if (!trace && this.traceStore) trace = await this.traceStore.begin(action);
    const requestId = crypto.randomUUID(); const start = Date.now();
    let code: 'configuration' | 'network' | 'http' | 'timeout' | 'cancelled' | 'invalid-json' | 'empty-response' = 'configuration';
    let httpStatus: number | undefined;
    try {
    validateSettings(settings);
    if (signal?.aborted) throw new Error(tr('m008'));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    const body = settings.provider === 'ollama'
      ? { model: settings.model.trim(), stream: false, messages, options: { temperature: settings.temperature, num_predict: 4096 } }
      : { model: settings.model.trim(), stream: false, messages, ...(settings.sendTemperature ? { temperature: settings.temperature } : {}) };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      code = 'network';
      if (trace) await trace.event({ kind: 'request', status: 'started', requestId, provider: settings.provider, modelRef: traceRef(settings.model), inputChars: messages.reduce((n, m) => n + m.content.length, 0) });
      if (signal?.aborted) { code = 'cancelled'; throw new Error(tr('m008')); }
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { code = 'timeout'; reject(new Error(tr('m009'))); }, settings.timeoutSeconds * 1000);
        cancel = () => { code = 'cancelled'; reject(new Error(tr('m008'))); };
        signal?.addEventListener('abort', cancel, { once: true });
      });
      const request = this.transport({ url: endpoint(settings.baseUrl, settings.provider), method: 'POST', headers, body: JSON.stringify(body) })
        .catch(() => { throw new Error(tr('m010')); });
      const response = await Promise.race([request, interrupted]);
      if (signal?.aborted) throw new Error(tr('m008'));
      httpStatus = response.status; code = 'http';
      if (response.status < 200 || response.status >= 300) throw responseError(response.status);
      code = 'invalid-json';
      let data: unknown;
      try { data = JSON.parse(response.text); } catch { throw new Error(tr('m011')); }
      const obj = data as { message?: { content?: unknown }; choices?: { message?: { content?: unknown } }[] };
      const content = settings.provider === 'ollama' ? obj?.message?.content : obj?.choices?.[0]?.message?.content;
      code = 'empty-response';
      if (typeof content !== 'string' || !content.trim()) throw new Error(tr('m012'));
      const report = data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_cache_hit_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } }; prompt_eval_count?: unknown; eval_count?: unknown };
      const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      const input = settings.provider === 'ollama' ? report.prompt_eval_count : report.usage?.prompt_tokens;
      const output = settings.provider === 'ollama' ? report.eval_count : report.usage?.completion_tokens;
      const cached = report.usage?.prompt_cache_hit_tokens ?? report.usage?.prompt_tokens_details?.cached_tokens;
      if (validCount(input) && validCount(output)) {
        this.usage.reportedResponses++; this.usage.inputTokens += input; this.usage.outputTokens += output;
        if (validCount(cached) && cached <= input) { this.usage.cachedInputTokens += cached; this.usage.cacheReportedResponses++; }
      }
      await trace?.event({ kind: 'request', status: 'success', requestId, httpStatus, durationMs: Date.now() - start, outputChars: content.length, inputTokens: validCount(input) ? input : undefined, outputTokens: validCount(output) ? output : undefined, cachedInputTokens: validCount(cached) && validCount(input) && cached <= input ? cached : undefined });
      if (ownTrace) await trace?.finish('success');
      return content;
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
    } catch (error) {
      await trace?.event({ kind: 'request', status: signal?.aborted ? 'cancelled' : 'failure', requestId, httpStatus, durationMs: Date.now() - start, code: signal?.aborted ? 'cancelled' : code });
      if (ownTrace) await trace?.finish(signal?.aborted ? 'cancelled' : 'failure');
      throw error;
    }
  }

  async test(settings: Settings): Promise<void> {
    await this.complete(settings, [{ role: 'user', content: 'Reply with OK only.' }]);
  }
}
