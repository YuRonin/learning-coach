import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile, copyFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('.test-artifacts/obsidian');
const vault = path.join(root, 'Learning Coach Test Vault');
const profile = path.join(root, 'profile');
const pluginDir = path.join(vault, '.obsidian/plugins/learning-coach');
await mkdir(pluginDir, { recursive: true });
await mkdir(profile, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(name, path.join(pluginDir, name));
for (const name of ['data.json', 'data.backup.json', 'config.json', 'learning-cache.json']) await rm(path.join(pluginDir, name), { force: true });
for (const name of ['移动后的测试笔记.md', '空白测试.md', '数学测试', '学习教练/运行追踪', 'Learning Coach/Traces']) await rm(path.join(vault, name), { force: true, recursive: true });
const sourceText = '# Harness 学习笔记\n\n超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。\n\n幂等操作允许重复请求，但同一逻辑操作只产生一次效果。\n';
await writeFile(path.join(vault, '测试笔记.md'), sourceText);
await writeFile(path.join(vault, '长笔记.md'), sourceText.repeat(400));
await writeFile(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['learning-coach']));
await writeFile(path.join(vault, '.obsidian/app.json'), JSON.stringify({ legacyEditor: false }));
await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { abcdef1234567891: { path: vault, ts: Date.now(), open: true } } }));

let requests = 0, failNext = false, slowNext = false;
const fixture = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests++;
    if (failNext) { failNext = false; response.writeHead(503); response.end('{}'); return; }
    const delay = slowNext ? 1200 : 40;
    slowNext = false;
    const payload = JSON.parse(body);
    let context;
    try { context = JSON.parse(payload.messages.at(-1).content); } catch { /* connection test */ }
    const question = {
      prompt: '为什么请求超时后，不能直接认定操作失败？',
      referenceQuote: '超时不等于失败，执行结果可能未知。',
      rubric: '指出服务端可能执行成功，只是回执丢失；应查询执行状态。',
      expectedAnswer: '请求可能已成功执行，只是响应丢失，应先查询执行状态。',
    };
    if (context?.goal?.includes('学习课程《')) {
      question.type = context.requestedQuestionType ?? context.allowedQuestionTypes[context.answeredCount % context.allowedQuestionTypes.length];
      question.prompt = `第 ${context.answeredCount + 1} 个情境：${question.type === 'boolean' ? '请求超时就证明服务端执行失败。' : question.type === 'multiple' ? '超时后哪些处理符合笔记？' : '请求超时后应怎样理解执行状态？'}`;
      question.options = question.type === 'boolean' ? [{ id: 'A', text: '正确' }, { id: 'B', text: '错误' }]
        : [{ id: 'A', text: '执行结果可能未知' }, { id: 'B', text: '查询保存的状态与标识' }, { id: 'C', text: '直接认定失败' }];
      question.correctOptions = question.type === 'boolean' ? ['B'] : question.type === 'multiple' ? ['A', 'B'] : ['A'];
      if (question.type === 'short') { question.options = []; question.correctOptions = []; }
      if (context.targetKnowledge) {
        const scenarios = ['客户端等待支付回执超时，怎样区分请求和执行状态？', '保存文件后连接断开，重试前需要确认什么？', '消息投递未收到确认，哪些依据有助于恢复？', '远程服务返回很慢，能否直接判断执行失败？', '作业提交中途断网，应保留什么信息？', '订单写入后回执丢失，应如何查询？'];
        const seen = new Set([...(context.previousQuestions ?? []).map(q => q.prompt), ...(context.recentEvidence ?? []).map(e => e.question)]);
        question.prompt = scenarios.find(prompt => !seen.has(prompt)) ?? scenarios[0];
      }
    }
    if (context?.source?.text?.includes('长方形')) {
      question.type = 'single'; question.prompt = context.previousQuestions?.length ? '用地毯覆盖长六米宽四米的房间，需要多少平方米？' : '一块长六米宽四米的长方形草地面积是多少？';
      question.referenceQuote = '长方形面积等于长乘宽。长六米、宽四米的长方形面积是二十四平方米。';
      question.options = [{ id: 'A', text: '二十四平方米' }, { id: 'B', text: '二十平方米' }, { id: 'C', text: '十平方米' }];
      question.correctOptions = ['A']; question.expectedAnswer = '六乘四等于二十四平方米。'; question.rubric = '使用面积公式并注明平方单位。';
    }
    let turn = { message: '先区分请求、执行和回执。\n\n**超时**只表示没有及时收到响应，不能独自证明服务端状态。', outline: [], question: null, assessment: null };
    if (['start', 'next'].includes(context?.action)) {
      turn.outline = context.action === 'start' ? ['区分超时与执行失败', '解释幂等的用途'] : [];
      turn.question = question;
    } else if (['answer', 'dispute'].includes(context?.action)) {
      turn.message = '让我们回看你的回答。';
      turn.assessment = { verdict: context.action === 'dispute' ? 'partial' : 'correct', feedback: '你指出了回执丢失这一关键可能，还可以明确下一步查询执行结果。' };
    } else if (context?.action === 'hint') turn.message = '想一想：如果服务端已经完成，但回执没有到达，会发生什么？';
    else if (context?.action === 'ask') turn.message = '例如保存成功后网络断开，客户端看见超时，但文件已经存在。';
    else if (context?.action === 'explain') turn.message = question.expectedAnswer;
    if (payload.messages[0]?.content.includes('Write user-facing explanations, questions, assessments, and objectives in English')) {
      turn.message = 'A timeout alone does not establish whether the server completed an operation.';
      if (turn.question) { turn.question = { ...question, type: 'boolean', prompt: 'Does a timeout prove that the operation failed?', options: [{ id: 'A', text: 'True' }, { id: 'B', text: 'False' }], correctOptions: ['B'], rubric: 'Distinguish response timing from execution state.', expectedAnswer: 'False. The operation may have completed before the response was lost.' }; }
      if (context.action === 'start') turn.outline = ['Distinguish timeouts from execution failures'];
      if (turn.assessment) turn.assessment.feedback = 'Your answer identifies that a response can be lost after execution.';
    }
    const content = context?.action === 'suggest-knowledge' ? JSON.stringify({ points: [{ title: '超时与结果', quote: '超时不等于失败，执行结果可能未知。' }, { title: '恢复信息', quote: '恢复需要保存真实状态与执行标识。' }] })
      : context?.action === 'suggest-mapping' ? JSON.stringify({ matches: [{ id: context.points[0].id, reason: '材料要求理解超时的含义。' }] })
      : context?.action === 'quality-check' ? JSON.stringify({ verdict: 'supported', reason: '本地测试题与材料一致。' }) : context ? JSON.stringify(turn) : 'OK';
    setTimeout(() => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content } }] })); }, delay);
  });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const port = fixture.address().port;
const child = spawn(process.env.OBSIDIAN_EXECUTABLE ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const results = [];
const check = name => { results.push(name); console.log(`PASS ${name}`); };
try {
  const ws = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No Obsidian debugging endpoint')), 20000);
    child.stderr.on('data', data => {
      const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Obsidian exited: ${code}`)); });
  });
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 30000 });
  const trust = page.getByRole('button', { name: /信任仓库作者并启用插件|Trust author and enable plugins/ });
  if (await trust.isVisible()) await trust.click();
  await page.waitForFunction(() => !!window.app?.plugins?.plugins['learning-coach']);
  await page.evaluate(() => { if (app.isMobile) app.emulateMobile(false); });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const file = app.vault.getAbstractFileByPath('测试笔记.md');
    await app.workspace.getLeaf().openFile(file);
    await app.plugins.plugins['learning-coach'].openCoach();
    app.workspace.rightSplit.setSize(480);
  });
  const view = page.locator('.lc-root');
  await view.getByRole('button', { name: 'Configure model', exact: true }).click();
  await page.locator('.lc-settings-modal').getByText('Base URL', { exact: true }).waitFor();
  await page.locator('.lc-settings-modal .setting-item').filter({ hasText: 'Language / 语言' }).locator('select:not([aria-hidden="true"])').selectOption('zh-CN');
  await page.locator('.lc-settings-modal').getByText('服务地址', { exact: true }).waitFor();
  check('localization: English default, language selector switches settings and live study navigation to Chinese');
  const modal = page.locator('.lc-settings-modal');
  const setting = name => modal.locator('.setting-item').filter({ has: page.locator('.setting-item-name', { hasText: name }) });
  await setting('服务地址').locator('input').fill(`http://127.0.0.1:${port}/v1`);
  await setting('访问密钥').locator('input').fill('fixture-key-not-a-real-secret');
  await setting('模型名称').locator('input').fill('fixture-model');
  await setting('每轮计划题数').locator('select:not([aria-hidden="true"])').selectOption('1');
  await modal.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接成功，模型已返回文本。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'settings.png') });
  await page.keyboard.press('Escape');
  check('real settings UI persists base URL/key/model and connection test reaches local HTTP server');
  await page.waitForTimeout(400);
  const settingsWindow = page.context().waitForEvent('page');
  await page.evaluate(async () => {
    const tab = app.plugins.plugins['learning-coach'].coachSettingsTab;
    tab.update();
    const names = tab.settingItems.flatMap(item => 'items' in item ? item.items.map(row => row.name) : [item.name]);
    for (const name of ['Language / 语言', '服务地址', '访问密钥']) {
      if (!names.includes(name)) throw new Error(`Setting missing from search definitions: ${name}`);
    }
    await app.setting.open();
    app.setting.openTabById('learning-coach');
  });
  const settingsPage = await settingsWindow;
  await settingsPage.locator('.vertical-tab-content').getByText('服务地址', { exact: true }).waitFor();
  await settingsPage.locator('.vertical-tab-content .setting-item').filter({ hasText: 'Language / 语言' }).locator('select:not([aria-hidden="true"])').selectOption('en');
  await settingsPage.locator('.vertical-tab-content').getByText('Base URL', { exact: true }).waitFor();
  await settingsPage.locator('.vertical-tab-content .setting-item').filter({ hasText: 'Language / 语言' }).locator('select:not([aria-hidden="true"])').selectOption('zh-CN');
  await settingsPage.locator('.vertical-tab-content').getByText('服务地址', { exact: true }).waitFor();
  await settingsPage.screenshot({ path: path.join(root, 'native-settings.png') });
  await page.evaluate(() => app.setting.close());
  check('native declarative settings: searchable definitions, native rendering, and live language refresh');


  await view.getByRole('button', { name: '学习台', exact: true }).click();
  await view.getByRole('textbox', { name: '本次学习目标', exact: true }).fill('理解超时，并能设计可靠的学习记录');
  await view.getByRole('button', { name: '开始学习当前笔记', exact: true }).click();
  const idle = () => page.waitForFunction(() => !app.plugins.plugins['learning-coach'].engine.busy);
  await view.locator('.lc-question').waitFor(); await idle();
  await page.screenshot({ path: path.join(root, 'lesson.png') });
  check('current-note guided session renders sourced question and learning route');

  const answer = () => view.locator('textarea.lc-answer').first();
  await answer().fill('请给我一个实际保存文件的例子');
  await view.getByRole('button', { name: '发送追问', exact: true }).click();
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.question?.revealed);
  await idle();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.attempts.length), 0);
  await answer().fill('服务端可能已经执行成功，只是响应丢失，应先查询结果。');
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  await view.getByText('我不同意这个评价', { exact: true }).click();
  await answer().fill('我已经指出了查询结果，请核实评分。');
  await view.getByRole('button', { name: '请求复核', exact: true }).click();
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.attempts[0]?.revisions.length === 1);
  await idle();
  check('follow-up does not invent an answer; submission and regrading preserve one evidence record');
  await view.getByRole('button', { name: '完成本轮', exact: true }).click();
  await view.locator('.lc-complete').waitFor();
  await page.waitForFunction(() => app.vault.getMarkdownFiles().some(file => file.path.endsWith('本轮总结.md')));
  check('finishing creates a summary note and review schedule');

  await view.getByRole('button', { name: '查看复习安排', exact: true }).click();
  const beforeReview = requests;
  await view.getByRole('button', { name: '提前复习', exact: true }).first().click();
  await view.locator('.lc-question').waitFor(); await idle();
  assert.equal(requests, beforeReview);
  slowNext = true;
  await view.getByRole('button', { name: '给点提示', exact: true }).click();
  await view.getByRole('button', { name: '暂停请求', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).waitFor();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  await view.getByRole('button', { name: '重试这一轮', exact: true }).click();
  await view.locator('.lc-question').waitFor(); await idle();
  await page.waitForTimeout(1300); // Intentionally wait for the cancelled fixture response.
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.question.hints), 1);
  check('review starts without a generation call; pause/retry discards a late response');

  failNext = true;
  await answer().fill('先查询真实执行结果，不盲目重试。');
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-error').waitFor();
  await view.getByRole('button', { name: '重试这一轮', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.attempts.length), 1);
  check('real HTTP 503 retry keeps exactly one submitted answer');

  await view.getByRole('button', { name: '完成本轮', exact: true }).click();
  await view.locator('.lc-complete').waitFor();
  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['learning-coach'];
    await plugin.startFile(app.vault.getAbstractFileByPath('测试笔记.md'), '继续测试恢复');
  });
  await view.locator('.lc-question').waitFor(); await idle();
  await answer().fill('这是一段还没提交的草稿');
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.draft === '这是一段还没提交的草稿');
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('learning-coach');
    await app.plugins.enablePlugin('learning-coach');
    await app.plugins.plugins['learning-coach'].openCoach();
  });
  await view.getByRole('button', { name: '回到学习现场', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  await view.locator('.lc-question').waitFor();
  assert.equal(await answer().inputValue(), '这是一段还没提交的草稿');
  check('plugin unload/reload restores the question and unsent draft');

  await page.evaluate(async () => {
    const file = app.vault.getAbstractFileByPath('测试笔记.md');
    await app.vault.modify(file, await app.vault.read(file) + '\n材料已更新。\n');
    await app.plugins.plugins['learning-coach'].openCoach();
  });
  await view.getByRole('button', { name: '记录', exact: true }).click();
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  await view.getByText('源笔记已修改。', { exact: false }).waitFor();
  check('changed source is explicitly shown while the old evidence snapshot is retained');

  await page.evaluate(async () => {
    await app.plugins.plugins['learning-coach'].startFile(app.vault.getAbstractFileByPath('长笔记.md'), '学习长笔记');
  });
  await page.locator('.prompt-input').waitFor();
  await page.keyboard.press('Enter');
  await idle();
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.source.name === '长笔记');
  await view.locator('.lc-question').waitFor();
  check('long notes offer a part picker and retain an unfinished previous session');
  await view.getByRole('button', { name: '记录', exact: true }).click();
  const oldSessionCard = view.locator('.lc-card').filter({ has: page.getByRole('heading', { name: '测试笔记', exact: true }) }).filter({ has: page.getByRole('button', { name: '继续这次学习', exact: true }) });
  await oldSessionCard.first().getByRole('button', { name: '继续这次学习', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  await view.locator('.lc-question').waitFor();
  assert.equal(await answer().inputValue(), '这是一段还没提交的草稿');
  check('history restores an unfinished session without losing its draft');
  await page.screenshot({ path: path.join(root, 'restored-session.png') });
  await view.getByRole('button', { name: '今日', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'today.png') });
  const data = JSON.parse(await readFile(path.join(pluginDir, 'data.json'), 'utf8'));
  assert.ok(data.archive.length >= 3);
  assert.equal('apiKey' in data.settings, false);
  assert.equal('baseUrl' in data.settings, false);
  const connection = JSON.parse(await readFile(path.join(pluginDir, 'config.json'), 'utf8'));
  assert.equal(connection.apiKey, 'fixture-key-not-a-real-secret');
  assert.equal(connection.baseUrl, `http://127.0.0.1:${port}/v1`);
  const backup = JSON.parse(await readFile(path.join(pluginDir, 'data.backup.json'), 'utf8'));
  assert.equal(backup.version, 5);
  assert.equal('apiKey' in backup.settings, false);
  assert.equal('baseUrl' in backup.settings, false);
  // Official Obsidian mobile emulation, not an iOS/Android device test.
  await page.evaluate(async () => {
    app.workspace.getLeavesOfType('learning-coach-view').forEach(leaf => leaf.detach());
    app.emulateMobile(true);
  });
  await page.waitForTimeout(1000); // Host rebuilds its workspace when switching emulation.
  await page.evaluate(async () => { await app.plugins.plugins['learning-coach'].openCoach(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await view.getByRole('button', { name: '回到学习现场', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  await view.locator('.lc-question').waitFor();
  await answer().fill('手机端尚未提交的草稿');
  await view.getByRole('button', { name: '记录', exact: true }).click();
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.draft === '手机端尚未提交的草稿');
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await view.evaluate(el => ({ width: el.clientWidth, overflow: el.scrollWidth - el.clientWidth, buttonHeight: el.querySelector('button').getBoundingClientRect().height }));
    assert.ok(geometry.width > 200, JSON.stringify(geometry));
    assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
    assert.ok(geometry.buttonHeight >= 44, JSON.stringify(geometry));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'mobile-lesson.png') });
  await view.getByRole('button', { name: '设置', exact: true }).click();
  await modal.waitFor();
  assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await setting('服务地址').locator('input').fill(`http://127.0.0.1:${port}/v1`);
  await modal.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接成功，模型已返回文本。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'mobile-settings.png') });
  await page.keyboard.press('Escape');
  await answer().fill('查询已保存的真实状态与执行标识。');
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  check('mobile emulation: 320/390/768px layout, touch targets, settings, draft and answer submission');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['theme-light', 'theme-dark']) {
    await page.evaluate(theme => { document.body.classList.remove('theme-light', 'theme-dark'); document.body.classList.add(theme); }, theme);
    for (const dimensions of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(dimensions);
      assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.querySelector('.lc-body').scrollTop = 0; });
    await page.screenshot({ path: path.join(root, `mobile-${theme}.png`) });
    const ratios = await view.evaluate(el => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return ['.lc-feedback .lc-prose', '.lc-feedback .mod-cta'].map(selector => {
        const node = el.querySelector(selector);
        const style = getComputedStyle(node);
        let parent = node;
        while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
        const a = luminance(style.color), b = luminance(getComputedStyle(parent).backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
    });
    assert.ok(ratios.every(ratio => ratio >= 4.5), `${theme}: ${ratios}`);
  }
  assert.equal(await view.locator('.lc-nav [aria-current="page"]').innerText(), '学习台');
  assert.ok(!(await view.innerText()).includes('LEARNING COACH'));
  await view.evaluate(el => { el.style.fontSize = '24px'; });
  assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await view.evaluate(el => { el.style.fontSize = ''; });
  check('design system: Chinese navigation, light/dark contrast, landscape, large text and reduced motion');

  // Exercise the new course workflow through the actual mobile UI.
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByRole('button', { name: '添加课程', exact: true }).click();
  await modal.getByRole('textbox', { name: '课程名称', exact: true }).fill('可靠系统入门');
  await modal.getByRole('spinbutton', { name: '每天学习分钟数', exact: true }).fill('25');
  await modal.getByRole('combobox', { name: '题型安排', exact: true }).selectOption('fixed');
  await modal.getByRole('button', { name: '保存课程', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: '合计为 100%' }).waitFor();
  await modal.getByRole('button', { name: '平均分配比例', exact: true }).click();
  assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await modal.getByRole('button', { name: '保存课程', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await view.getByRole('button', { name: '学习建议单元', exact: true }).click();
  await view.locator('.lc-options input[type="radio"]').first().waitFor(); await idle();
  await view.locator('.lc-options input[value="C"]').check();
  await view.getByRole('combobox', { name: '作答把握' }).selectOption('guessed');
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  assert.ok(await view.locator('.lc-options input[value="C"]').isChecked());
  assert.equal(await view.getByRole('combobox', { name: '作答把握' }).inputValue(), 'guessed');
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('learning-coach');
    await app.plugins.enablePlugin('learning-coach');
    await app.plugins.plugins['learning-coach'].openCoach();
  });
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  assert.ok(await view.locator('.lc-options input[value="C"]').isChecked());
  assert.equal(await view.getByRole('combobox', { name: '作答把握' }).inputValue(), 'guessed');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await view.locator('.lc-option').first().evaluate(el => el.getBoundingClientRect().height >= 48));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'mobile-course-question.png') });
  const beforeGrade = requests;
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  assert.equal(requests, beforeGrade);
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.attempts[0].assessment.verdict), 'incorrect');
  await view.getByText('我不同意这个评价', { exact: true }).click();
  await view.getByRole('button', { name: '报告并作废此题', exact: true }).click();
  await modal.getByRole('textbox', { name: '作废原因', exact: true }).fill('测试：题目存在歧义，需要排除。');
  await modal.getByRole('button', { name: '保存原因并作废', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await view.getByText('本题已作废，原始作答已保留', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => {
    const plugin = app.plugins.plugins['learning-coach'];
    return plugin.getReviews().filter(card => card.courseId === plugin.engine.current.courseId).length;
  }), 0);
  assert.equal(await view.locator('progress').getAttribute('value'), '0');
  await page.screenshot({ path: path.join(root, 'mobile-void-question.png') });
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('learning-coach');
    await app.plugins.enablePlugin('learning-coach');
    await app.plugins.plugins['learning-coach'].openCoach();
  });
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  await view.getByRole('button', { name: '继续学习', exact: true }).click();
  await view.getByText('本题已作废，原始作答已保留', { exact: true }).waitFor();
  await view.getByRole('button', { name: '恢复此题', exact: true }).click();
  await view.getByRole('button', { name: '讲清缺口，再换题练习', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => {
    const plugin = app.plugins.plugins['learning-coach'];
    return plugin.getReviews().filter(card => card.courseId === plugin.engine.current.courseId).length;
  }), 1);
  assert.equal(requests, beforeGrade);
  check('question report: voided evidence and progress removed, reload preserves reason, undo restores review without model requests');
  await view.getByRole('button', { name: '讲清缺口，再换题练习', exact: true }).click();
  await view.locator('.lc-options input[value="B"]').waitFor(); await idle();
  await view.locator('.lc-options input[value="B"]').check();
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  await view.getByRole('button', { name: '再练一题', exact: true }).click();
  await view.locator('.lc-options input[type="checkbox"]').first().waitFor(); await idle();
  await view.locator('.lc-options input[value="A"]').check();
  await view.locator('.lc-options input[value="B"]').check();
  await view.getByRole('button', { name: '提交回答', exact: true }).click();
  await view.locator('.lc-feedback').waitFor(); await idle();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.attempts[2].assessment.verdict), 'correct');
  await view.getByRole('button', { name: '再练一题', exact: true }).click();
  await view.locator('.lc-question textarea').waitFor(); await idle();
  assert.equal(await view.locator('.lc-options').count(), 0);
  await view.getByRole('button', { name: '今天到这里', exact: true }).click();
  await idle();
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'mobile-courses.png') });
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.courses.length), 1);
  check('course loop: mobile creation, saved choices, single/boolean/multiple/short questions, local grades and varied remediation');
  await view.getByRole('button', { name: '编辑课程与更新目录', exact: true }).click();
  for (const type of ['判断题', '多选题', '简答题']) await modal.getByRole('checkbox', { name: type, exact: true }).uncheck();
  await modal.getByRole('spinbutton', { name: '单选题比例', exact: true }).fill('100');
  await modal.getByRole('button', { name: '保存课程', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await view.getByText('查看单元与学习证据', { exact: true }).click();
  await view.locator('.lc-course-unit').filter({ hasText: '测试笔记.md' }).getByRole('button', { name: '学习这一节', exact: true }).click();
  await view.locator('.lc-options input[type="radio"]').first().waitFor(); await idle();
  assert.deepEqual(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.allocation.policy.enabled), ['single']);
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByRole('button', { name: '编辑课程与更新目录', exact: true }).click();
  await modal.getByRole('combobox', { name: '题型安排', exact: true }).selectOption('adaptive');
  await modal.getByRole('checkbox', { name: '单选题', exact: true }).uncheck();
  await modal.getByRole('checkbox', { name: '简答题', exact: true }).check();
  await modal.getByRole('button', { name: '保存课程', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.allocation.policy.enabled), ['single']);
  await view.getByRole('button', { name: '学习台', exact: true }).click();
  await view.getByRole('button', { name: '跳过这题', exact: true }).click();
  await idle();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.question.type), 'single');
  check('course question policy: single-only generation and active snapshot unaffected by course edits');
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByText('查看单元与学习证据', { exact: true }).click();
  await view.getByRole('button', { name: '调整本轮题型', exact: true }).first().click();
  await modal.getByRole('checkbox', { name: '简答题', exact: true }).uncheck();
  await modal.getByRole('checkbox', { name: '判断题', exact: true }).check();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'mobile-question-policy.png') });
  await modal.getByRole('button', { name: '按本轮题型开始', exact: true }).click();
  await modal.waitFor({ state: 'hidden' }); await idle();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.question.type), 'boolean');
  assert.deepEqual(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.courses[0].questionPolicy.enabled), ['short']);
  check('temporary policy: mobile layout and one-session override preserves course settings');
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['learning-coach'];
    const previous = plugin.engine.current.id;
    let file = app.vault.getAbstractFileByPath('空白测试.md');
    if (!file) file = await app.vault.create('空白测试.md', '   ');
    else await app.vault.modify(file, '   ');
    let rejected = false;
    try { await plugin.startFile(file, ''); } catch (error) { rejected = error.message.includes('没有可学习'); }
    if (!rejected || plugin.engine.current.id !== previous) throw new Error('Empty source changed the learning session');
    const current = app.vault.getAbstractFileByPath('测试笔记.md');
    const destination = app.vault.getAbstractFileByPath('移动后的测试笔记.md');
    if (destination) await app.vault.trash(destination, false);
    await app.vault.rename(current, '移动后的测试笔记.md');
  });
  await view.getByRole('button', { name: '今日', exact: true }).click();
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByText('查看单元与学习证据', { exact: true }).click();
  await view.getByText(/移动后的测试笔记.md ·/).first().waitFor();
  assert.equal(await page.evaluate(() => {
    const p = app.plugins.plugins['learning-coach'];
    return p.data.courses[0].units.find(u => u.path === '移动后的测试笔记.md').id === p.engine.current.unitId;
  }), true);
  check('empty notes preserve the active session; renamed sources retain stable unit identity');
  const knowledgeUnit = view.locator('.lc-course-unit').filter({ hasText: '移动后的测试笔记.md' }).first();
  await knowledgeUnit.getByRole('button', { name: '从笔记整理知识点', exact: true }).click(); await idle();
  await knowledgeUnit.getByRole('button', { name: '编辑与确认知识点', exact: true }).click();
  for (const check of await modal.getByRole('checkbox', { name: /^确认知识点/ }).all()) await check.check();
  await modal.getByRole('button', { name: '保存知识点', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await knowledgeUnit.locator('details').filter({ has: page.locator('summary', { hasText: /^知识点（/ }) }).evaluate(el => { el.open = true; });
  await knowledgeUnit.getByRole('button', { name: '学习这个知识点', exact: true }).first().click(); await idle();
  assert.equal(await page.evaluate(() => {
    const s = app.plugins.plugins['learning-coach'].engine.current;
    return !!s.focus && s.question.knowledgeId === s.focus.id;
  }), true);
  check('knowledge import: local candidates, explicit confirmation, source-linked questions');
  await view.getByRole('button', { name: '今日', exact: true }).click();
  await view.getByRole('button', { name: '今天只有十分钟', exact: true }).click(); await idle();
  await view.getByRole('button', { name: '开始这个任务', exact: true }).first().click(); await idle();
  assert.ok(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.taskId));
  await view.getByRole('button', { name: '今日', exact: true }).click();
  await view.getByRole('button', { name: '继续这个任务', exact: true }).first().waitFor();
  check('daily plan: ten-minute budget, durable task-session link and resume entry');
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.locator('details').filter({ has: page.locator('summary', { hasText: /^查看单元与学习证据$/ }) }).evaluate(el => { el.open = true; });
  await knowledgeUnit.getByRole('button', { name: '章节检验', exact: true }).click();
  await modal.getByRole('spinbutton', { name: '检验题数', exact: true }).fill('2');
  await modal.getByRole('checkbox', { name: '简答题', exact: true }).uncheck();
  await modal.getByRole('checkbox', { name: '单选题', exact: true }).check();
  await modal.getByRole('button', { name: '预览检验安排', exact: true }).click();
  await modal.getByText(/单选题 2 题/).waitFor();
  await modal.getByRole('button', { name: '开始章节检验', exact: true }).click();
  await modal.waitFor({ state: 'hidden' }); await idle();
  assert.equal(await view.getByRole('button', { name: '给点提示', exact: true }).count(), 0);
  await view.locator('.lc-options input[value="C"]').check();
  await view.getByRole('button', { name: '提交回答', exact: true }).click(); await idle();
  assert.equal(await view.locator('.lc-feedback').count(), 0);
  assert.equal(await view.getByText(/本轮互动 ·/).count(), 0);
  await view.getByRole('button', { name: '进入下一道检验题', exact: true }).click(); await idle();
  await view.locator('.lc-options input[value="A"]').check();
  await view.getByRole('button', { name: '提交回答', exact: true }).click(); await idle();
  await view.getByRole('button', { name: '交卷并查看报告', exact: true }).click(); await idle();
  await view.getByText('2 道有效评价，其中 1 道符合要点。未设置可靠考试分值，不生成总分。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.exams.at(-1).status), 'finished');
  check('chapter assessment: preview, exact types, hidden feedback, two independent answers and combined report');
  await view.getByText(/Harness 学习笔记 · 待巩固/).first().click();
  await view.getByRole('button', { name: '复核本题评价', exact: true }).first().click();
  await modal.getByRole('textbox', { name: '章节检验复核理由', exact: true }).fill('请根据冻结的原文与评分标准再次核对。');
  await modal.getByRole('button', { name: '请求复核本题', exact: true }).click();
  await modal.waitFor({ state: 'hidden' }); await idle();
  assert.equal(await page.evaluate(() => {
    const s = app.plugins.plugins['learning-coach'].engine.current;
    return s.status === 'ended' && s.attempts.length === 1 && s.attempts[0].revisions.length === 1 && s.attempts[0].assessment.verdict === 'partial';
  }), true);
  check('submitted exam review: report entry revises one saved assessment without reopening the exam');
  const beforeCache = requests;
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach']; await p.cache.clear();
    await p.engine.pause();
    await p.engine.start({ path: '缓存测试.md', name: '缓存测试', text: '超时不等于失败，执行结果可能未知。', mtime: 1, selection: false }, '缓存验收');
  });
  assert.equal(requests, beforeCache + 1);
  await page.evaluate(async () => {
    await app.plugins.disablePlugin('learning-coach'); await app.plugins.enablePlugin('learning-coach');
    const p = app.plugins.plugins['learning-coach']; await p.engine.pause();
    await p.engine.start({ path: '缓存测试.md', name: '缓存测试', text: '超时不等于失败，执行结果可能未知。', mtime: 1, selection: false }, '缓存验收');
    if (p.engine.current.cacheHits !== 1 || p.engine.current.calls !== 0 || p.engine.current.attempts.length) throw new Error('Cache did not restore safely');
  });
  assert.equal(requests, beforeCache + 1);
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach']; await p.cache.clear(); await p.engine.pause();
    await p.engine.start({ path: '缓存测试.md', name: '缓存测试', text: '超时不等于失败，执行结果可能未知。', mtime: 1, selection: false }, '缓存验收');
  });
  assert.equal(requests, beforeCache + 2);
  check('persistent cache: cold request, plugin reload, warm hit with zero model calls, explicit clear');
  await page.evaluate(async () => { await app.plugins.plugins['learning-coach'].openCoach(); });
  await view.getByRole('button', { name: '课程', exact: true }).click();
  await view.getByRole('button', { name: '记录考纲与学习要求', exact: true }).click();
  await modal.getByLabel('材料名称与来源', { exact: true }).fill('匿名验收目标');
  await modal.getByLabel('材料内容（最多 24,000 字符）', { exact: true }).fill('理解超时与失败的区别，并能解释保存执行状态的用途。');
  await modal.getByRole('button', { name: '让模型建议对应知识点', exact: true }).click();
  await modal.getByText('以下均为模型建议，请核对勾选项后确认保存。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.courses[0].requirements?.length ?? 0), 0);
  await modal.getByRole('button', { name: '确认对应关系并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.courses[0].requirements.length), 1);
  await view.locator('details').filter({ has: page.locator('summary', { hasText: /^查看单元与学习证据$/ }) }).evaluate(el => { el.open = true; });
  await knowledgeUnit.getByRole('button', { name: '编辑与确认知识点', exact: true }).click();
  await modal.getByRole('checkbox', { name: /^选择知识点/ }).first().check();
  await modal.getByRole('button', { name: '让模型建议拆分选中知识点', exact: true }).click();
  await modal.getByText(/收到 2 个候选，尚未保存/).waitFor();
  assert.equal(await modal.getByRole('checkbox', { name: /^确认知识点/ }).first().isChecked(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].data.courses[0].units.find(u => u.path === '移动后的测试笔记.md').knowledge.filter(p => p.active).length), 1);
  check('material suggestions: explicit source upload, mapping confirmation, split preview discarded on close');
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach'];
    await app.vault.createFolder('数学测试');
    await app.vault.create('数学测试/面积.md', '# 面积\n\n长方形面积等于长乘宽。长六米、宽四米的长方形面积是二十四平方米。');
    await p.saveCourse({ name: '匿名数学课程', folder: '数学测试', minutes: 10, examDate: '', questionPolicy: { enabled: ['single'], mode: 'fixed', weights: { single: 100, multiple: 0, boolean: 0, short: 0 } } });
    let course = p.data.courses.find(c => c.name === '匿名数学课程'); let unit = course.units[0];
    await p.prepareKnowledge(course.id, unit.id);
    course = p.data.courses.find(c => c.id === course.id); unit = course.units[0];
    await p.saveKnowledge(course.id, unit.id, unit.knowledge.map(point => ({ ...point, confirmed: true })));
    course = p.data.courses.find(c => c.id === course.id); unit = course.units[0];
    await p.learnKnowledge(course, unit, unit.knowledge.find(k => k.active));
  }); await idle();
  await view.getByText('一块长六米宽四米的长方形草地面积是多少？', { exact: true }).waitFor();
  await view.locator('.lc-options input[value="A"]').check(); await view.getByRole('button', { name: '提交回答', exact: true }).click(); await idle();
  await view.getByRole('button', { name: '完成本轮', exact: true }).click(); await idle();
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach']; const c = p.data.courses.find(c => c.name === '匿名数学课程'), u = c.units[0];
    await p.createExam(c, u, [u.knowledge.find(k => k.active).id], c.questionPolicy, 1);
  }); await idle();
  await view.locator('.lc-options input[value="A"]').check(); await view.getByRole('button', { name: '提交回答', exact: true }).click(); await idle();
  await view.getByRole('button', { name: '交卷并查看报告', exact: true }).click(); await idle();
  await view.getByText('1 道有效评价，其中 1 道符合要点。未设置可靠考试分值，不生成总分。', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach']; const c = p.data.courses.find(c => c.name === '匿名数学课程');
    const otherRecords = p.allSessions().filter(s => s.courseId !== c.id).length;
    await p.archiveCourse(c.id, true); await p.clearCourseRecords(c.id);
    if (!app.vault.getAbstractFileByPath('数学测试/面积.md') || p.allSessions().some(s => s.courseId === c.id) || p.allSessions().length !== otherRecords) throw new Error('Course clearing crossed its boundary');
  });
  check('second subject: mathematics learning and exam preserve course policy; archived clearing keeps source and other records');
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach'];
    const records = await p.recentTraces();
    if (!records.length || p.trace.storageFailed) throw new Error('Trace vault persistence failed');
    for (const kind of ['cache', 'request', 'schema', 'persist', 'local-grade']) {
      if (!records.some(r => r.record.events.some(e => e.kind === kind))) throw new Error(`Missing trace step ${kind}`);
    }
    if (!records.some(r => r.record.events.some(e => e.kind === 'cache' && e.status === 'hit'))) throw new Error('Cache hit not traced');
    if (!records.some(r => r.record.outcome === 'failure')) throw new Error('Failure not traced');
    const texts = await Promise.all(records.map(r => app.vault.read(r.file)));
    for (const secret of [p.data.settings.apiKey, p.data.settings.baseUrl, '超时不等于失败，执行结果可能未知。']) {
      if (secret && texts.some(t => t.includes(secret))) throw new Error('Private content leaked into trace');
    }
    await p.exportTraces();
    const exports = app.vault.getMarkdownFiles().filter(f => f.path.includes('/追踪汇总-'));
    if (!exports.length) throw new Error('Trace export missing');
    p.openTraces();
  });
  await page.getByRole('heading', { name: '运行追踪', exact: true }).waitFor();
  await page.locator('.modal-container').last().getByRole('button', { name: '查看', exact: true }).first().click();
  check('agent trace: vault persistence, request/cache/local grade/failure steps, privacy whitelist, seven-day export and Chinese viewer');
  await page.evaluate(async () => { await app.plugins.plugins['learning-coach'].openCoach(); });
  await view.getByRole('button', { name: '设置', exact: true }).click();
  const languageSetting = page.locator('.lc-settings-modal .setting-item').filter({ hasText: 'Language / 语言' });
  await languageSetting.locator('select:not([aria-hidden="true"])').selectOption('en');
  await page.locator('.lc-settings-modal').getByText('Base URL', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach'];
    if (p.engine.current?.status === 'ready') await p.engine.pause();
    await p.startFile(app.vault.getAbstractFileByPath('移动后的测试笔记.md'), 'Check understanding in English');
  }); await idle();
  await view.getByText('Does a timeout prove that the operation failed?', { exact: true }).waitFor();
  await view.getByText('Have a question? Ask your coach', { exact: true }).click();
  await view.locator('textarea.lc-answer').first().fill('用户草稿 {0} stays unchanged');
  await page.waitForFunction(() => app.plugins.plugins['learning-coach'].engine.current.draft === '用户草稿 {0} stays unchanged');
  await view.getByRole('button', { name: 'Settings', exact: true }).click();
  await languageSetting.locator('select:not([aria-hidden="true"])').selectOption('zh-CN');
  await page.locator('.lc-settings-modal').getByText('服务地址', { exact: true }).waitFor();
  await languageSetting.locator('select:not([aria-hidden="true"])').selectOption('en');
  await page.locator('.lc-settings-modal').getByText('Base URL', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const before = app.plugins.plugins['learning-coach'].data.session;
    if (before.draft !== '用户草稿 {0} stays unchanged') throw new Error('Language change damaged draft');
    await app.plugins.disablePlugin('learning-coach'); await app.plugins.enablePlugin('learning-coach');
    const p = app.plugins.plugins['learning-coach'];
    if (p.data.settings.language !== 'en' || p.engine.current.draft !== before.draft) throw new Error('Language or draft did not persist');
    const commands = Object.values(app.commands.commands).filter(c => c.id.startsWith('learning-coach:'));
    if (commands.length !== 5 || commands.some(c => /[\u3400-\u9fff]/.test(c.name))) throw new Error('Command localization failed');
    await p.openCoach(); await p.engine.resume();
    app.workspace.getLeavesOfType('learning-coach-view')[0].view.showTab('learn');
  }); await idle();
  await view.locator('.lc-options input[value="B"]').check();
  const beforeLocalGrade = requests;
  await view.getByRole('button', { name: 'Submit answer', exact: true }).click(); await idle();
  await view.getByText('Answer meets the criteria', { exact: true }).waitFor();
  assert.equal(requests, beforeLocalGrade);
  await page.evaluate(() => {
    app.workspace.getLeavesOfType('learning-coach-view').forEach(leaf => leaf.detach());
    app.emulateMobile(true);
  });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await app.plugins.plugins['learning-coach'].openCoach();
    await app.plugins.plugins['learning-coach'].engine.resume();
    app.workspace.getLeavesOfType('learning-coach-view')[0].view.showTab('learn');
  });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await view.getByText('Answer meets the criteria', { exact: true }).waitFor();
    const overflow = await view.evaluate(el => el.scrollWidth > el.clientWidth + 2);
    assert.equal(overflow, false, `English study view overflows at ${width}px`);
  }
  await page.screenshot({ path: path.join(root, 'english-study-mobile.png') });
  await view.getByRole('button', { name: 'Finish session', exact: true }).click(); await idle();
  await page.evaluate(async () => {
    const p = app.plugins.plugins['learning-coach'];
    const records = await p.recentTraces();
    const text = await app.vault.read(records[0].file);
    if (!text.includes('# Agent trace')) throw new Error('English trace heading missing');
    await p.exportTraces();
  });
  check('English study: generated true/false question, language round-trip preserves draft, restart persists English, commands, local grading, mobile layout and trace export');
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(root, 'results.json'), JSON.stringify({ testedAt: new Date().toISOString(), obsidian: await page.title(), results, requestCount: requests, pageErrors }, null, 2));
  console.log(`Real Obsidian E2E passed: ${results.length} scenarios, ${requests} fixture HTTP requests.`);
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(-4000));
    }
  }
  throw error;
} finally {
  await browser?.close(); child.kill('SIGTERM');
  await new Promise(resolve => fixture.close(resolve));
}
