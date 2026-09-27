import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/locales/en';
import { zhCN } from '../src/locales/zh-CN';
import { setLanguage, t, type MessageKey } from '../src/i18n';
import { DEFAULT_SETTINGS, settingsSchema, makeSession, validateQuestion, gradeChoice, QUESTION_LABELS, exportSession } from '../src/domain';
import { buildMessages } from '../src/prompts';
import { splitMessages, mappingMessages } from '../src/material-analysis';
import { qualityMessages, validateQuality } from '../src/quality';
import { LearningCache } from '../src/cache';

const source = { path: '中文笔记.md', name: '中文笔记', text: '源材料中的中文不会因切换界面语言而被重写。', mtime: 1, selection: false };

test('English is the settings default; catalogs have complete keys and matching placeholders', () => {
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(settingsSchema.parse({ outputFolder: '旧目录', traceFolder: '旧追踪' }).outputFolder, '旧目录');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  for (const key of Object.keys(en) as MessageKey[]) {
    assert.ok(en[key].trim()); assert.ok(zhCN[key].trim());
    assert.deepEqual([...en[key].matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort(), [...zhCN[key].matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort(), key);
    assert.ok(!/[\u3400-\u9fff]/.test(en[key]), `English message contains Chinese: ${key}`);
  }
});

test('runtime switching updates labels and prompts without altering user data; interpolation is single-pass', () => {
  const session = makeSession(source, '我的目标'); session.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  const snapshot = structuredClone(session);
  setLanguage('en'); assert.equal(QUESTION_LABELS.boolean, 'True or false');
  assert.match(buildMessages(session)[0]!.content, /Write user-facing.*in English/);
  assert.ok(exportSession(session).startsWith('# Study record')); assert.ok(exportSession(session).includes(source.name));
  assert.equal(t('m149', ['{1} 中文 <script>']), 'Your answer: {1} 中文 <script>');
  assert.match(splitMessages(source.text)[0]!.content, /in English/);
  assert.match(mappingMessages(source.text, [{ id: 'k', title: '用户文字', quote: source.text }])[0]!.content, /in English/);
  setLanguage('zh-CN'); assert.equal(QUESTION_LABELS.boolean, '判断题'); assert.match(buildMessages(session)[0]!.content, /统一使用简体中文/);
  assert.deepEqual(session, snapshot);
});

test('saved true/false questions work after switching language; new English prompts use English options', () => {
  for (const texts of [['True', 'False'], ['正确', '错误']]) {
    const question = { id: 'q', type: 'boolean' as const, prompt: 'Is this true?', options: [{ id: 'A', text: texts[0]! }, { id: 'B', text: texts[1]! }], correctOptions: ['A'], referenceQuote: source.text, rubric: 'criteria', expectedAnswer: 'explanation', hints: 0, revealed: false };
    for (const locale of ['en', 'zh-CN'] as const) { setLanguage(locale); validateQuestion(question); assert.equal(gradeChoice(question, 'A')?.verdict, 'correct'); }
  }
  setLanguage('en'); const session = makeSession(source, 'goal'); session.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  assert.match(buildMessages(session)[0]!.content, /A labeled exactly "True"/);
  assert.match(qualityMessages({ prompt: 'Why?', referenceQuote: source.text, rubric: 'criteria', expectedAnswer: 'answer' }, session)[0]!.content, /English reason/);
});

test('language-specific prompts isolate cached generations and English answer leaks are blocked', async () => {
  const cache = new LearningCache({ read: async () => '', write: async () => {} });
  const session = makeSession(source, 'goal'); session.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  setLanguage('en'); const english = await cache.key(DEFAULT_SETTINGS, buildMessages(session));
  setLanguage('zh-CN'); const chinese = await cache.key(DEFAULT_SETTINGS, buildMessages(session));
  assert.notEqual(english, chinese);
  assert.throws(() => validateQuality({ prompt: 'The correct answer is A.', referenceQuote: source.text, rubric: 'criteria', expectedAnswer: 'answer' }, []));
  assert.doesNotThrow(() => validateQuality({ prompt: 'Choose a suitable strategy.', referenceQuote: source.text, rubric: 'criteria', expectedAnswer: 'answer' }, []));
});
