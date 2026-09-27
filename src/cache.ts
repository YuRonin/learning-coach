import { t as tr } from './i18n';
import { z } from 'zod';
import type { ChatMessage } from './api';
import type { Settings } from './domain';

const entrySchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), value: z.string().max(60000), expires: z.number(), used: z.number() });
const cacheSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(50) });
type Entry = z.infer<typeof entrySchema>;
export interface CacheStorage { read(): Promise<string>; write(text: string): Promise<void> }
export interface ResponseCache {
  key(settings: Settings, messages: ChatMessage[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A disposable vault-local cache. It never owns learning evidence or stores credentials. */
export class LearningCache implements ResponseCache {
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private issued = new Map<string, number>();
  hits = 0;
  misses = 0;
  savedCharacters = 0;
  storageFailed = false;
  constructor(private storage: CacheStorage, private now = () => Date.now()) {}

  async load(): Promise<void> {
    try {
      const raw = await this.storage.read();
      if (raw.length > 1_000_000) return;
      const parsed = cacheSchema.parse(JSON.parse(raw));
      for (const entry of parsed.entries) if (entry.expires > this.now()) this.entries.set(entry.key, entry);
      this.trim();
    } catch { /* Missing, damaged or older caches are safely ignored. */ }
  }
  async key(settings: Settings, messages: ChatMessage[]): Promise<string | null> {
    if (!settings.cacheEnabled || (typeof crypto === 'undefined' || !crypto.subtle)) return null;
    const epoch = this.epoch;
    // Authentication affects routing on some gateways. Only its digest is included; no key is persisted.
    const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
    const auth = await hash(settings.apiKey);
    const key = await hash(JSON.stringify({ schema: 'learning-cache-1', provider: settings.provider, endpoint: settings.baseUrl, model: settings.model,
      temperature: settings.temperature, sendTemperature: settings.sendTemperature, auth, messages }));
    if (epoch !== this.epoch) return null;
    this.issued.set(key, epoch);
    if (this.issued.size > 256) this.issued.delete(this.issued.keys().next().value!);
    return key;
  }
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= this.now()) { this.entries.delete(key); this.misses++; return null; }
    entry.used = this.now(); this.hits++; this.savedCharacters += entry.value.length; return entry.value;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.issued.get(key) !== this.epoch) return;
    if (value.length > 60000) return;
    this.entries.set(key, { key, value, expires: this.now() + 7 * 86400000, used: this.now() });
    this.trim(); await this.persist();
  }
  async remove(key: string): Promise<void> { this.entries.delete(key); await this.persist(); }
  async clear(): Promise<void> {
    this.epoch++; this.entries.clear(); this.issued.clear(); this.hits = 0; this.misses = 0; this.savedCharacters = 0;
    await this.persist();
    if (this.storageFailed) throw new Error(tr('m013'));
  }
  snapshot(): { entries: number; bytesUpperBound: number; hits: number; misses: number; storageFailed: boolean } {
    this.trim(); return { entries: this.entries.size, bytesUpperBound: this.size() + 100, hits: this.hits, misses: this.misses, storageFailed: this.storageFailed };
  }
  private size(): number { return new TextEncoder().encode(JSON.stringify([...this.entries.values()])).byteLength; }
  private trim(): void {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
    for (const entry of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
      if (this.entries.size <= 50 && this.size() <= 999000) break;
      this.entries.delete(entry.key);
    }
  }
  private async persist(): Promise<void> {
    const epoch = this.epoch;
    const json = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    this.queue = this.queue.catch(() => undefined).then(async () => {
      if (epoch !== this.epoch) return;
      try { await this.storage.write(json); this.storageFailed = false; } catch { this.storageFailed = true; }
    });
    await this.queue;
  }
}
