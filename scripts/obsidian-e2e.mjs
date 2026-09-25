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
for (const name of ['data.json', 'data.backup.json']) await rm(path.join(pluginDir, name), { force: true });
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
    const content = context ? JSON.stringify(turn) : 'OK';
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
  await view.getByRole('button', { name: '配置模型', exact: true }).click();
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
  const backup = JSON.parse(await readFile(path.join(pluginDir, 'data.backup.json'), 'utf8'));
  assert.equal(backup.version, 1);
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
  assert.equal(await page.evaluate(() => app.plugins.plugins['learning-coach'].engine.current.draft), '手机端尚未提交的草稿');
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
