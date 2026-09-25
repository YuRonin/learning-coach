import type { Settings } from './domain';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface HttpRequest { url: string; method: string; headers: Record<string, string>; body: string }
export interface HttpResponse { status: number; text: string }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export function endpoint(base: string, provider: Settings['provider']): string {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new Error('请输入完整的 服务地址，例如 https://example.com/v1。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址必须使用 http 或 https。');
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含用户名、密码、查询参数或 #。请将密钥填入 访问密钥。');
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
  if (!settings.model.trim()) throw new Error('请先在插件设置中填写模型名称。');
}

function responseError(status: number): Error {
  if (status === 401 || status === 403) return new Error(`认证失败（${status}）。请检查 访问密钥 和模型访问权限。`);
  if (status === 404) return new Error('接口或模型未找到（404）。请检查 服务地址 和模型名称。');
  if (status === 429) return new Error('请求受限（429）。请检查额度或稍后重试。');
  return new Error(`模型服务返回 HTTP ${status}。请检查接口配置或稍后重试。`);
}

export class ModelGateway {
  constructor(private readonly transport: Transport) {}

  async complete(settings: Settings, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    validateSettings(settings);
    if (signal?.aborted) throw new Error('已暂停。');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    const body = settings.provider === 'ollama'
      ? { model: settings.model.trim(), stream: false, messages, options: { temperature: settings.temperature, num_predict: 4096 } }
      : { model: settings.model.trim(), stream: false, messages, ...(settings.sendTemperature ? { temperature: settings.temperature } : {}) };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('请求超时，学习现场已保存。可以重试或调整超时时间。')), settings.timeoutSeconds * 1000);
        cancel = () => reject(new Error('已暂停。'));
        signal?.addEventListener('abort', cancel, { once: true });
      });
      const request = this.transport({ url: endpoint(settings.baseUrl, settings.provider), method: 'POST', headers, body: JSON.stringify(body) })
        .catch(() => { throw new Error('无法连接模型服务。请检查 服务地址、网络或本地服务是否启动。'); });
      const response = await Promise.race([request, interrupted]);
      if (signal?.aborted) throw new Error('已暂停。');
      if (response.status < 200 || response.status >= 300) throw responseError(response.status);
      let data: unknown;
      try { data = JSON.parse(response.text); } catch { throw new Error('模型服务返回的数据格式不正确。请检查是否填入了网页地址。'); }
      const obj = data as { message?: { content?: unknown }; choices?: { message?: { content?: unknown } }[] };
      const content = settings.provider === 'ollama' ? obj?.message?.content : obj?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回文本内容。请确认该模型支持聊天接口。');
      return content;
    } finally {
      globalThis.clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  async test(settings: Settings): Promise<void> {
    await this.complete(settings, [{ role: 'user', content: 'Reply with OK only.' }]);
  }
}
