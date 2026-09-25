import { Plugin, Platform, Notice, TFile, TFolder, normalizePath, requestUrl, type WorkspaceLeaf } from 'obsidian';
import { dataSchema, DEFAULT_SETTINGS, exportSession, MAX_SOURCE_LENGTH, splitNote, type PluginData, type Session, type Settings } from './domain';
import { ModelGateway, validateSettings } from './api';
import { LearningSession } from './session';
import { CoachView, VIEW_TYPE } from './view';
import { CoachSettingsTab } from './settings';
import { NotePicker, PartPicker } from './pickers';
import { addDays, localDate, reviewCards, type ReviewCard } from './review';

export default class LearningCoachPlugin extends Plugin {
  data: PluginData = { version: 1, settings: { ...DEFAULT_SETTINGS }, session: null, archive: [], reviewSnoozes: {} };
  engine!: LearningSession;
  gateway = new ModelGateway(async request => {
    const result = await requestUrl({ ...request, throw: false });
    return { status: result.status, text: result.text };
  });
  lastNote: TFile | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  async onload(): Promise<void> {
    let saved: unknown;
    try { saved = await this.loadData(); } catch { saved = { corrupt: true }; }
    if (saved != null) {
      let result = dataSchema.safeParse(saved);
      if (!result.success) {
        try { result = dataSchema.safeParse(JSON.parse(await this.app.vault.adapter.read(this.backupPath()))); } catch { /* Keep original data if neither copy can be read. */ }
        if (result.success) new Notice('已从上一次完整备份恢复学习数据。', 8000);
      }
      if (!result.success) {
        new Notice('学习教练的数据格式无法读取。已保留原文件，请备份插件 data.json 后再处理。', 10000);
        throw new Error('Unsupported Learning Coach data; original file was not overwritten.');
      }
      this.data = result.data;
      if (this.data.session && this.data.session.status !== 'ended') {
        this.data.session.status = 'paused';
      }
    }
    this.engine = new LearningSession(this.data.session, {
      save: session => this.persistSession(session),
      ask: (messages, signal) => this.gateway.complete({ ...this.data.settings }, messages, signal),
      settings: () => this.data.settings,
      changed: () => this.emit(),
    });
    this.registerView(VIEW_TYPE, leaf => new CoachView(leaf, this));
    this.addSettingTab(new CoachSettingsTab(this.app, this));
    this.addRibbonIcon('graduation-cap', '学习教练', () => { void this.openCoach(); });
    this.addCommand({ id: 'open', name: '打开学习教练', callback: () => { void this.openCoach(); } });
    this.addCommand({ id: 'learn-current-note', name: '从当前笔记开始学习', callback: () => {
      void this.safely(async () => { const file = this.currentNote(); await this.openCoach(); await this.startFile(file, ''); });
    } });
    this.addCommand({ id: 'learn-selection', name: '学习选中的内容', editorCallback: (editor, view) => {
      void this.safely(async () => {
        if (!view.file) throw new Error('请先打开一篇 Markdown 笔记。');
        const selected = editor.getSelection();
        if (!selected.trim()) throw new Error('请先选中想学习的内容。');
        await this.openCoach();
        await this.startFile(view.file, '', selected);
      });
    } });
    this.addCommand({ id: 'today-review', name: '查看今日复习', callback: () => {
      void this.safely(async () => { const leaf = await this.openCoach(); if (leaf.view instanceof CoachView) leaf.view.showTab('today'); });
    } });
    this.addCommand({ id: 'choose-learning-note', name: '选择笔记开始学习', callback: () => this.chooseNote('') });
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.extension === 'md') this.lastNote = file;
      this.emit();
    }));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const selection = editor.getSelection();
      if (!selection.trim() || !info.file) return;
      const file = info.file;
      menu.addItem(item => item.setTitle('用学习教练学习选中内容').setIcon('graduation-cap').onClick(() => {
        void this.safely(async () => { await this.openCoach(); await this.startFile(file, '', selection); });
      }));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('用学习教练学习这篇笔记').setIcon('graduation-cap')
        .onClick(() => { void this.safely(async () => { await this.openCoach(); await this.startFile(file, ''); }); }));
    }));
    this.app.workspace.onLayoutReady(() => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === 'md') this.lastNote = file;
      this.emit();
    });
  }

  private update(mutator: (data: PluginData) => void): Promise<void> {
    const next = this.writeQueue.catch(() => undefined).then(async () => {
      const snapshot = structuredClone(this.data);
      mutator(snapshot);
      if (this.manifest?.dir) await this.app.vault.adapter.write(this.backupPath(), JSON.stringify(this.data));
      await this.saveData(snapshot);
      this.data = snapshot;
    });
    this.writeQueue = next;
    return next;
  }

  private persistSession(session: Session): Promise<void> {
    return this.update(data => {
      if (data.session && data.session.id !== session.id) {
        data.archive = data.archive.filter(item => item.id !== data.session!.id);
        data.archive.push(data.session);
      }
      data.archive = data.archive.filter(item => item.id !== session.id);
      data.session = session;
    });
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    await this.update(data => { data.settings = { ...data.settings, ...patch }; });
  }

  async flushSettings(): Promise<void> { await this.writeQueue; }

  private backupPath(): string { return normalizePath(`${this.manifest.dir}/data.backup.json`); }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { new Notice('学习界面未能刷新，请关闭侧边栏后重新打开。'); }
    }
  }

  async safely(work: () => Promise<unknown>): Promise<void> {
    try { await work(); } catch (error) { new Notice(error instanceof Error ? error.message : '操作未完成，请重试。', 7000); }
  }

  currentNote(): TFile {
    const active = this.app.workspace.getActiveFile();
    const file = active?.extension === 'md' ? active : this.lastNote;
    if (!file || file.extension !== 'md') throw new Error('请先打开一篇 Markdown 笔记。');
    return file;
  }

  async startFile(file: TFile, goal: string, selection?: string): Promise<void> {
    await this.flushSettings();
    validateSettings(this.data.settings);
    const text = selection ?? await this.app.vault.read(file);
    if (text.length > MAX_SOURCE_LENGTH) {
      new PartPicker(this.app, splitNote(text), part => {
        void this.safely(() => this.startFile(file, goal, part.text));
      }).open();
      return;
    }
    if (this.engine.busy) throw new Error('请先暂停正在进行的模型请求。');
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
    await this.engine.start({ path: file.path, name: file.basename, text, mtime: file.stat.mtime, selection: selection !== undefined }, goal);
  }

  chooseNote(goal: string): void {
    new NotePicker(this.app, file => { void this.safely(() => this.startFile(file, goal)); }).open();
  }

  getReviews(): ReviewCard[] {
    return reviewCards([...this.data.archive, ...(this.engine.current ? [this.engine.current] : [])], this.data.reviewSnoozes);
  }

  async review(card: ReviewCard): Promise<void> {
    await this.flushSettings();
    validateSettings(this.data.settings);
    if (this.engine.busy) throw new Error('请先暂停正在进行的请求。');
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    await this.engine.startReview(card);
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
  }

  async snoozeReview(id: string): Promise<void> {
    await this.update(data => { data.reviewSnoozes[id] = addDays(localDate(), 1); });
    this.emit();
  }

  async restoreSession(session: Session): Promise<void> {
    if (this.engine.busy) throw new Error('请先暂停正在进行的请求。');
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    await this.engine.restore(session);
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
  }

  async finishSession(): Promise<void> {
    await this.engine.end();
    if (this.data.settings.autoExport) {
      try { await this.exportRecord(this.engine.current, true); }
      catch (error) { new Notice(`学习现场已保存，但自动生成笔记失败：${error instanceof Error ? error.message : '请稍后手动保存。'}`, 8000); }
    }
  }

  async openCoach(): Promise<WorkspaceLeaf> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = Platform.isMobile
        ? this.app.workspace.getLeaf('tab')
        : this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async exportRecord(session = this.engine.current, automatic = false): Promise<void> {
    if (!session) throw new Error('还没有学习记录。');
    const folder = this.data.settings.outputFolder.trim();
    if (!folder || /(^[/\\]|(^|[/\\])\.\.?([/\\]|$)|[:*?"<>|])/.test(folder) || folder.split(/[/\\]/).some(part => part.startsWith('.'))) {
      throw new Error('学习记录目录必须是库内的普通相对路径，例如 学习教练/记录。');
    }
    const normalized = normalizePath(folder);
    const segments = normalized.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join('/');
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFolder)) throw new Error('学习记录目录与现有文件重名。');
      if (!existing) await this.app.vault.createFolder(path);
    }
    const safeName = session.source.name.replace(/[\\/:*?"<>|#\x5b\x5d]/g, '-').slice(0, 60);
    const base = normalizePath(`${normalized}/${session.createdAt.slice(0, 10)} ${safeName} ${session.id.slice(0, 8)}${automatic ? ' 本轮总结' : ''}`);
    let path = `${base}.md`;
    if (automatic && this.app.vault.getAbstractFileByPath(path)) return;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} (${suffix++}).md`;
    const file = await this.app.vault.create(path, exportSession(session));
    new Notice('学习记录已保存。');
    if (!automatic) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  onunload(): void { this.engine?.dispose(); this.listeners.clear(); }
}
