import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Load the shipped CommonJS bundle with a minimal host. No real vault or API is accessed.
class Component {}
class TFile {}
class TFolder {}
class Plugin {
  commands = [];
  views = new Map();
  saved = null;
  async loadData() { return this.saved; }
  async saveData(data) { await new Promise(resolve => setTimeout(resolve, 1)); this.saved = structuredClone(data); }
  registerView(type, factory) { this.views.set(type, factory); }
  addSettingTab(tab) { this.settingsTab = tab; }
  addRibbonIcon() {}
  addCommand(command) { this.commands.push(command); }
  registerEvent() {}
}
const obsidian = {
  Platform: { isMobile: false }, Plugin, Component, TFile, TFolder, ItemView: class {}, Modal: class {}, FuzzySuggestModal: class {}, PluginSettingTab: class {}, Setting: class {},
  Notice: class {}, MarkdownRenderer: {}, normalizePath: value => value,
  requestUrl: async () => { throw new Error('Real network is prohibited in smoke test'); },
};
const module = { exports: {} };
vm.runInNewContext(await readFile('main.js', 'utf8'), {
  module, exports: module.exports,
  require: name => { assert.equal(name, 'obsidian'); return obsidian; },
  crypto, structuredClone, URL, AbortController, setTimeout, clearTimeout, console,
});
const Coach = module.exports.default;
assert.equal(typeof Coach, 'function');
const coach = new Coach();
coach.app = { workspace: { on: () => ({}), getActiveFile: () => null, onLayoutReady: callback => callback() } };
await coach.onload();
assert.equal(coach.views.has('learning-coach-view'), true);
assert.equal(coach.commands.length, 5);
await Promise.all([
  coach.saveSettings({ baseUrl: 'https://example.test/v1' }),
  coach.saveSettings({ apiKey: 'smoke-only-key' }),
  coach.saveSettings({ model: 'fixture' }),
]);
assert.equal(coach.saved.settings.baseUrl, 'https://example.test/v1');
assert.equal(coach.saved.settings.apiKey, 'smoke-only-key');
assert.equal(coach.saved.settings.model, 'fixture');
coach.gateway.complete = async () => JSON.stringify({ message: '开始学习。', outline: ['理解状态恢复'], question: {
  prompt: '恢复需要保存什么？', referenceQuote: '恢复需要保存真实状态与执行标识。', rubric: '指出状态和执行标识', expectedAnswer: '保存状态和执行标识。',
}, assessment: null });
await coach.engine.start({ path: 'sample.md', name: 'sample', text: '恢复需要保存真实状态与执行标识。', mtime: 1, selection: false }, '理解状态恢复');
assert.equal(coach.saved.session.question.prompt, '恢复需要保存什么？');
assert.equal(coach.saved.settings.apiKey, 'smoke-only-key');
await coach.engine.end();
await coach.engine.start({ path: 'next.md', name: 'next', text: '恢复需要保存真实状态与执行标识。', mtime: 1, selection: false }, '第二次学习');
assert.equal(coach.saved.archive.length, 1);
assert.equal(coach.saved.archive[0].status, 'ended');
coach.onunload();
const restored = new Coach();
restored.saved = coach.saved;
restored.app = coach.app;
await restored.onload();
assert.equal(restored.engine.current.status, 'paused');
assert.equal(restored.engine.current.question.prompt, '恢复需要保存什么？');
assert.equal(restored.data.settings.model, 'fixture');
restored.onunload();
console.log('Bundle smoke passed: plugin registration, concurrent settings, session storage, archive, reload.');

// Mobile must open a normal workspace tab; desktop keeps the right sidebar.
for (const mobile of [false, true]) {
  obsidian.Platform.isMobile = mobile;
  const routes = [];
  const leaf = { setViewState: async state => assert.equal(state.type, 'learning-coach-view') };
  coach.app.workspace.getLeavesOfType = () => [];
  coach.app.workspace.getRightLeaf = () => { routes.push('right'); return leaf; };
  coach.app.workspace.getLeaf = type => { routes.push(type); return leaf; };
  coach.app.workspace.revealLeaf = async actual => assert.equal(actual, leaf);
  await coach.openCoach();
  assert.deepEqual(routes, [mobile ? 'tab' : 'right']);
  coach.app.workspace.getLeavesOfType = () => [leaf];
  await coach.openCoach();
  assert.equal(routes.length, 1);
}
assert.equal(JSON.parse(await readFile('manifest.json', 'utf8')).isDesktopOnly, false);
console.log('Cross-platform smoke passed: mobile tab, desktop sidebar, existing view reuse.');
