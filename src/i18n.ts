import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

export type Language = 'en' | 'zh-CN';
export type MessageKey = keyof typeof en;
let language: Language = 'en';
export const getLanguage = (): Language => language;
export function setLanguage(value: Language): void { language = value; }
export function t(key: MessageKey, values: readonly unknown[] = [], locale: Language = language): string {
  const template = locale === 'zh-CN' ? zhCN[key] : en[key];
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

/** Resolve labels on access so language changes do not leave module-level labels stale. */
export function localizedLabels<T extends Record<string, MessageKey>>(keys: T): { [K in keyof T]: string } {
  const labels = {} as { [K in keyof T]: string };
  for (const key of Object.keys(keys)) Object.defineProperty(labels, key, { enumerable: true, get: () => t(keys[key]!) });
  return labels;
}
