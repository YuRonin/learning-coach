import { markdownInFolder } from './vault-files';
import { t as tr, setLanguage } from './i18n';
import { Plugin, Platform, Notice, TFile, TFolder, normalizePath, requestUrl, type WorkspaceLeaf } from 'obsidian';
import { dataSchema, DEFAULT_SETTINGS, exportSession, MAX_SOURCE_LENGTH, splitNote, type PluginData, type Session, type Settings } from './domain';
import { ModelGateway, validateSettings } from './api';
import { LearningSession } from './session';
import { CoachView, VIEW_TYPE } from './view';
import { CoachSettingsTab } from './settings';
import { NotePicker, PartPicker } from './pickers';
import { addDays, localDate, reviewCards, type ReviewCard } from './review';
import { courseSchema, courseUnits, type Course } from './course';
import { setQuestionValidity } from './evidence';
import { allocationFor, defaultPolicy, type QuestionPolicy } from './question-policy';
import { fingerprint, knowledgeSchema, proposeKnowledge, validatePrerequisites, type Knowledge } from './knowledge';
import { makePlan, reconcilePlans, type LearningTask } from './planner';
import { examSchema, examTypes, type Exam } from './exam';
import { emptyCounts } from './question-policy';
import { TraceStore, traceFolder, parseTraceMarkdown, traceMarkdown } from './trace';
import { TraceModal } from './trace-view';
import { LearningCache } from './cache';

export default class LearningCoachPlugin extends Plugin {
  private coachSettingsTab?: CoachSettingsTab;
  data: PluginData = { version: 4, settings: { ...DEFAULT_SETTINGS }, session: null, archive: [], reviewSnoozes: {}, courses: [], plans: [], exams: [] };
  engine!: LearningSession;
  cache!: LearningCache;
  trace!: TraceStore;
  gateway = new ModelGateway(async request => {
    const result = await requestUrl({ ...request, throw: false });
    return { status: result.status, text: result.text };
  });
  private ribbon?: HTMLElement;
  lastNote: TFile | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  async onload(): Promise<void> {
    let saved: unknown;
    try { saved = await this.loadData(); } catch { saved = { corrupt: true }; }
    if (saved != null) {
      if (typeof saved === 'object' && 'version' in saved && typeof saved.version === 'number' && saved.version > 4) {
        throw new Error(tr('m201'));
      }
      let result = dataSchema.safeParse(saved);
      let migrationSource: unknown = saved;
      if (!result.success) {
        try {
          const backup: unknown = JSON.parse(await this.app.vault.adapter.read(this.backupPath()));
          result = dataSchema.safeParse(backup);
          if (result.success) migrationSource = backup;
        } catch { /* Keep original data if neither copy can be read. */ }
        if (result.success) new Notice(tr('m202'), 8000);
      }
      if (!result.success) {
        new Notice(tr('m203'), 10000);
        throw new Error('Unsupported Learning Coach data; original file was not overwritten.');
      }
      if (this.manifest?.dir && typeof migrationSource === 'object' && migrationSource && 'version' in migrationSource && Number(migrationSource.version) < 4) {
        const path = normalizePath(`${this.manifest.dir}/data.pre-0.9.0.json`);
        if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, JSON.stringify(migrationSource));
      }
      this.data = result.data;
      if (this.data.session && this.data.session.status !== 'ended') {
        this.data.session.status = 'paused';
      }
    }
    setLanguage(this.data.settings.language);
    this.cache = new LearningCache({
      read: () => this.manifest?.dir ? this.app.vault.adapter.read(normalizePath(`${this.manifest.dir}/learning-cache.json`)) : Promise.resolve('{}'),
      write: text => this.manifest?.dir ? this.app.vault.adapter.write(normalizePath(`${this.manifest.dir}/learning-cache.json`), text) : Promise.resolve(),
    });
    await this.cache.load();
    this.trace = new TraceStore({ write: (path, text) => this.writeTraceFile(path, text) }, () => ({ enabled: this.data.settings.traceEnabled, folder: this.data.settings.traceFolder, version: this.manifest?.version ?? '0.9.1' }));
    this.gateway.traceStore = this.trace;
    this.engine = new LearningSession(this.data.session, {
      save: session => this.persistSession(session),
      ask: (messages, signal, settings, trace) => this.gateway.complete(settings ?? { ...this.data.settings }, messages, signal, trace),
      trace: this.trace,
      cache: this.cache,
      examFinished: id => this.data.exams.find(e => e.id === id)?.status === 'finished',
      settings: () => this.data.settings,
      changed: () => this.emit(),
    });
    this.registerView(VIEW_TYPE, leaf => new CoachView(leaf, this));
    this.coachSettingsTab = new CoachSettingsTab(this.app, this);
    this.addSettingTab(this.coachSettingsTab);
    this.ribbon = this.addRibbonIcon('graduation-cap', tr('m062'), () => { void this.openCoach(); });
    this.registerLocalizedCommands();
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.extension === 'md') this.lastNote = file;
      this.emit();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void this.safely(async () => {
        await this.update(data => {
          const renamed = (path: string) => path === oldPath ? file.path : path.startsWith(`${oldPath}/`) ? file.path + path.slice(oldPath.length) : path;
          for (const course of data.courses) {
            course.folder = renamed(course.folder);
            for (const unit of course.units) { unit.path = renamed(unit.path); unit.title = unit.path.split('/').at(-1)!.replace(/\.md$/, ''); }
          }
        });
        this.emit();
      });
    }));
    this.registerEvent(this.app.vault.on('modify', () => this.emit()));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const selection = editor.getSelection();
      if (!selection.trim() || !info.file) return;
      const file = info.file;
      menu.addItem(item => item.setTitle(tr('m211')).setIcon('graduation-cap').onClick(() => {
        void this.safely(async () => { await this.openCoach(); await this.startFile(file, '', selection); });
      }));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle(tr('m212')).setIcon('graduation-cap')
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
      reconcilePlans(data.plans, session);
      if (session.examId) {
        const item = data.exams.find(e => e.id === session.examId)?.items[session.examIndex ?? 0];
        if (item) item.sessionId = session.id;
      }
    });
  }

  private registerLocalizedCommands(): void {
    this.addCommand({ id: 'open', name: tr('m204'), callback: () => { void this.openCoach(); } });
    this.addCommand({ id: 'learn-current-note', name: tr('m205'), callback: () => {
      void this.safely(async () => { const file = this.currentNote(); await this.openCoach(); await this.startFile(file, ''); });
    } });
    this.addCommand({ id: 'learn-selection', name: tr('m206'), editorCallback: (editor, view) => {
      void this.safely(async () => {
        if (!view.file) throw new Error(tr('m207'));
        const selected = editor.getSelection();
        if (!selected.trim()) throw new Error(tr('m208'));
        await this.openCoach();
        await this.startFile(view.file, '', selected);
      });
    } });
    this.addCommand({ id: 'today-review', name: tr('m209'), callback: () => {
      void this.safely(async () => { const leaf = await this.openCoach(); if (leaf.view instanceof CoachView) leaf.view.showTab('today'); });
    } });
    this.addCommand({ id: 'choose-learning-note', name: tr('m210'), callback: () => this.chooseNote('') });
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    await this.update(data => { data.settings = { ...data.settings, ...patch }; });
    if (patch.language) {
      setLanguage(patch.language);
      this.coachSettingsTab?.update();
      for (const id of ['open', 'learn-current-note', 'learn-selection', 'today-review', 'choose-learning-note']) this.removeCommand(id);
      this.registerLocalizedCommands();
      this.ribbon?.setAttribute('aria-label', tr('m062'));
      this.emit();
    }
    if (this.cache && ['apiKey', 'baseUrl', 'model', 'provider', 'temperature', 'sendTemperature', 'cacheEnabled'].some(key => key in patch)) await this.cache.clear();
  }

  async flushSettings(): Promise<void> { await this.writeQueue; }

  private backupPath(): string { return normalizePath(`${this.manifest.dir}/data.backup.json`); }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { new Notice(tr('m213')); }
    }
  }

  async safely(work: () => Promise<unknown>): Promise<void> {
    try { await work(); } catch (error) { new Notice(error instanceof Error ? error.message : tr('m214'), 7000); }
  }

  currentNote(): TFile {
    const active = this.app.workspace.getActiveFile();
    const file = active?.extension === 'md' ? active : this.lastNote;
    if (!file || file.extension !== 'md') throw new Error(tr('m207'));
    return file;
  }

  async startFile(file: TFile, goal: string, selection?: string, course?: Course): Promise<void> {
    await this.flushSettings();
    validateSettings(this.data.settings);
    const text = selection ?? await this.app.vault.read(file);
    if (!text.trim()) throw new Error(tr('m215'));
    if (text.length > MAX_SOURCE_LENGTH) {
      new PartPicker(this.app, splitNote(text), part => {
        void this.safely(() => this.startFile(file, goal, part.text, course));
      }).open();
      return;
    }
    if (this.engine.busy) throw new Error(tr('m216'));
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
    await this.engine.start({ path: file.path, name: file.basename, text, mtime: file.stat.mtime, selection: selection !== undefined }, goal,
      course ? { courseId: course.id, unitId: course.units.find(u => u.path === file.path)?.id ?? file.path, allocation: allocationFor(course.questionPolicy ?? defaultPolicy(), this.allSessions(), course.id) } : undefined);
  }

  allSessions(): Session[] { return [...this.data.archive, ...(this.engine.current ? [this.engine.current] : [])]; }
  evidenceSessions(): Session[] { return this.allSessions().filter(s => !s.examId || this.data.exams.find(e => e.id === s.examId)?.status === 'finished'); }
  private seenQuestions(focus: NonNullable<Session['focus']>): NonNullable<Session['question']>[] {
    const questions = this.allSessions().filter(s => s.focus?.id === focus.id && s.focus.revision === focus.revision && s.focus.fingerprint === focus.fingerprint)
      .flatMap(s => [...s.attempts.map(a => a.question), ...(s.retiredQuestions ?? []), ...(s.question ? [s.question] : [])]);
    return questions.filter((q, i) => questions.findIndex(other => other.id === q.id) === i).slice(-20);
  }

  async changeQuestionValidity(sessionId: string, questionId: string, reason: string | null): Promise<void> {
    const clean = reason === null ? null : reason.trim();
    if (clean !== null && (!clean || clean.length > 1000)) throw new Error(tr('m217'));
    await this.engine.editRecords(async () => {
      await this.update(data => {
        const sessions = [...data.archive, ...(data.session ? [data.session] : [])];
        const target = sessions.find(s => s.id === sessionId);
        const question = target?.question?.id === questionId ? target.question
          : target?.attempts.find(a => a.question.id === questionId)?.question ?? target?.retiredQuestions?.find(q => q.id === questionId);
        if (!target || !question) throw new Error(tr('m218'));
        setQuestionValidity(sessions, target.source, question, clean, new Date().toISOString());
        for (const session of sessions) reconcilePlans(data.plans, session);
      });
      return this.data.session;
    });
  }

  async saveCourse(input: { id?: string; name: string; folder: string; examDate: string; minutes: number; priority?: number; questionPolicy?: QuestionPolicy; excludedPaths?: string[] }): Promise<void> {
    const folder = input.folder.trim().replace(/^\/+|\/+$/g, '');
    const file = this.app.vault.getAbstractFileByPath(folder);
    if (folder && !(file instanceof TFolder)) throw new Error(tr('m219'));
    if (input.examDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.examDate)) throw new Error(tr('m220'));
    const previous = this.data.courses.find(c => c.id === input.id);
    const course = courseSchema.parse({ ...previous, ...input, questionPolicy: input.questionPolicy ?? previous?.questionPolicy,
      name: input.name.trim(), folder, id: input.id ?? crypto.randomUUID(),
      units: courseUnits(markdownInFolder(this.app.vault, folder).filter(f => f.stat.size > 0 && !f.path.startsWith(`${this.data.settings.outputFolder}/`) && !f.path.startsWith(`${this.data.settings.traceFolder}/`)), folder, previous?.units) });
    if (input.questionPolicy && JSON.stringify(input.questionPolicy) !== JSON.stringify(previous?.questionPolicy)) course.policyHistory = [...(previous?.policyHistory ?? []), { at: new Date().toISOString(), policy: structuredClone(input.questionPolicy) }];
    for (const unit of course.units) {
      const note = this.app.vault.getAbstractFileByPath(unit.path);
      if (input.excludedPaths) unit.excluded = input.excludedPaths.includes(unit.path);
      if (note instanceof TFile) unit.topics = [...new Set(this.app.metadataCache.getFileCache(note)?.headings?.map(h => h.heading) ?? [])].slice(0, 30);
    }
    if (!course.units.some(u => !u.excluded)) throw new Error(tr('m221'));
    // Missing sources stay addressable so users can repair them without losing stable IDs.
    course.units.push(...(previous?.units.filter(u => !course.units.some(n => n.id === u.id)) ?? []));
    await this.update(data => { data.courses = [...data.courses.filter(c => c.id !== course.id), course]; });
    this.emit();
  }

  async learnUnit(course: Course, unit: Course['units'][number]): Promise<void> {
    if (course.archived || unit.excluded) throw new Error(tr('m222'));
    const file = this.app.vault.getAbstractFileByPath(unit.path);
    if (!(file instanceof TFile)) throw new Error(tr('m223'));
    await this.startFile(file, tr('m224', [course.name, unit.title, course.examDate ? tr('m225', [course.examDate]) : '', course.minutes]), undefined, course);
  }

  chooseNote(goal: string): void {
    new NotePicker(this.app, file => { void this.safely(() => this.startFile(file, goal)); }).open();
  }

  getReviews(): ReviewCard[] {
    return reviewCards(this.evidenceSessions(), this.data.reviewSnoozes).filter(card => {
      const course = this.data.courses.find(c => c.id === card.courseId);
      const unit = course?.units.find(u => u.id === card.unitId);
      const file = unit && this.app.vault.getAbstractFileByPath(unit.path);
      return !course?.archived && !unit?.excluded && (!card.focus || (file instanceof TFile && file.stat.mtime === card.source.mtime && unit?.knowledge?.some(p => p.id === card.focus!.id && p.active && p.confirmed && p.revision === card.focus!.revision)));
    });
  }

  async prepareKnowledge(courseId: string, unitId: string): Promise<void> {
    const unit = this.data.courses.find(c => c.id === courseId)?.units.find(u => u.id === unitId);
    const file = unit && this.app.vault.getAbstractFileByPath(unit.path);
    if (!(file instanceof TFile)) throw new Error(tr('m226'));
    const text = await this.app.vault.read(file);
    const candidates = proposeKnowledge(text, file.basename);
    if (!candidates.length) throw new Error(tr('m227'));
    await this.update(data => {
      const target = data.courses.find(c => c.id === courseId)!.units.find(u => u.id === unitId)!;
      target.knowledge = [...(target.knowledge ?? []).map(p => ({ ...p, active: false })), ...candidates];
      target.materialMtime = file.stat.mtime;
    }); this.emit();
  }

  async saveKnowledge(courseId: string, unitId: string, points: Knowledge[]): Promise<void> {
    const unit = this.data.courses.find(c => c.id === courseId)?.units.find(u => u.id === unitId);
    const file = unit && this.app.vault.getAbstractFileByPath(unit.path);
    if (!(file instanceof TFile)) throw new Error(tr('m228'));
    const text = await this.app.vault.read(file);
    const parsed = points.map(p => knowledgeSchema.parse(p));
    validatePrerequisites(parsed);
    if (parsed.some(p => p.active && (!text.includes(p.quote) || p.fingerprint !== fingerprint(text)))) throw new Error(tr('m229'));
    if (new Set(parsed.map(p => p.id)).size !== parsed.length) throw new Error(tr('m230'));
    await this.update(data => { data.courses.find(c => c.id === courseId)!.units.find(u => u.id === unitId)!.knowledge = parsed; }); this.emit();
  }

  async archiveCourse(id: string, archived: boolean): Promise<void> {
    await this.update(data => { const course = data.courses.find(c => c.id === id); if (course) course.archived = archived; }); this.emit();
  }

  async saveRequirement(courseId: string, requirement: NonNullable<Course['requirements']>[number]): Promise<void> {
    await this.update(data => {
      const course = data.courses.find(c => c.id === courseId);
      if (!course) throw new Error(tr('m231'));
      const valid = new Set(course.units.flatMap(u => u.knowledge?.filter(p => p.active && p.confirmed).map(p => p.id) ?? []));
      if (requirement.knowledgeIds.some(id => !valid.has(id))) throw new Error(tr('m232'));
      course.requirements = courseSchema.parse({ ...course, requirements: [...(course.requirements ?? []), requirement] }).requirements;
    }); this.emit();
  }

  async clearCourseRecords(id: string): Promise<void> {
    await this.engine.editRecords(async () => {
      await this.update(data => {
        if (!data.courses.some(c => c.id === id && c.archived)) throw new Error(tr('m233'));
        data.archive = data.archive.filter(s => s.courseId !== id);
        if (data.session?.courseId === id) data.session = null;
        data.exams = data.exams.filter(e => e.courseId !== id);
        for (const plan of data.plans) plan.tasks = plan.tasks.filter(t => t.courseId !== id);
      }); return this.data.session;
    });
  }

  async openKnowledgeSource(path: string, quote: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(tr('m234'));
    const text = await this.app.vault.read(file); const offset = text.indexOf(quote);
    if (offset < 0) throw new Error(tr('m235'));
    await this.app.workspace.getLeaf(true).openFile(file, { eState: { line: text.slice(0, offset).split('\n').length - 1 } });
  }

  relinkUnit(courseId: string, unitId: string): void {
    new NotePicker(this.app, file => { void this.safely(async () => {
      await this.update(data => {
        const unit = data.courses.find(c => c.id === courseId)?.units.find(u => u.id === unitId);
        if (!unit) throw new Error(tr('m236'));
        unit.path = file.path; unit.title = file.basename;
      }); this.emit();
    }); }).open();
  }

  async learnKnowledge(course: Course, unit: Course['units'][number], point: Knowledge, taskId?: string): Promise<void> {
    await this.flushSettings(); validateSettings(this.data.settings);
    if (course.archived || unit.excluded || !point.active || !point.confirmed) throw new Error(tr('m237'));
    const file = this.app.vault.getAbstractFileByPath(unit.path);
    if (!(file instanceof TFile)) throw new Error(tr('m238'));
    const text = await this.app.vault.read(file);
    if (point.fingerprint !== fingerprint(text) || !text.includes(point.quote)) throw new Error(tr('m239'));
    if (this.engine.busy) throw new Error(tr('m240'));
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const leaf = await this.openCoach(); if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
    await this.engine.start({ path: file.path, name: file.basename, text: point.quote, mtime: file.stat.mtime, selection: true }, tr('m241', [course.name, point.title]), {
      courseId: course.id, unitId: unit.id, taskId, focus: { id: point.id, title: point.title, revision: point.revision, fingerprint: point.fingerprint },
      previousQuestions: this.seenQuestions(point),
      allocation: allocationFor(course.questionPolicy ?? defaultPolicy(), this.allSessions(), course.id),
    });
  }

  async planToday(budget: number): Promise<void> {
    const courses = this.data.courses.map(course => ({ ...course, units: course.units.filter(unit => {
      const file = this.app.vault.getAbstractFileByPath(unit.path);
      return file instanceof TFile && (unit.materialMtime === undefined || unit.materialMtime === file.stat.mtime);
    }) }));
    const plan = makePlan(courses, this.evidenceSessions(), budget, this.data.plans, localDate(), Intl.DateTimeFormat().resolvedOptions().timeZone, this.data.reviewSnoozes);
    await this.update(data => {
      for (const previous of data.plans.filter(p => p.date === plan.date)) for (const task of previous.tasks) if (task.status === 'todo') task.status = 'skipped';
      data.plans.push(plan);
    }); this.emit();
  }

  async changeTask(id: string, status: 'deferred' | 'skipped'): Promise<void> {
    await this.update(data => { for (const plan of data.plans) { const task = plan.tasks.find(t => t.id === id); if (task && task.status !== 'done') task.status = status; } }); this.emit();
  }

  async startTask(task: LearningTask): Promise<void> {
    const previous = this.allSessions().find(s => s.taskId === task.id || s.id === task.sessionId);
    if (previous && previous.status !== 'ended') { await this.restoreSession(previous); return; }
    if (previous && previous.attempts.filter(a => a.assessment && !a.question.invalidated).length < previous.targetQuestions) {
      if (this.engine.busy) throw new Error(tr('m242'));
      if (this.engine.current?.status === 'ready') await this.engine.pause();
      await this.engine.restore({ ...structuredClone(previous), status: 'paused' });
      const leaf = await this.openCoach(); if (leaf.view instanceof CoachView) leaf.view.showTab('learn'); return;
    }
    const course = this.data.courses.find(c => c.id === task.courseId);
    const unit = course?.units.find(u => u.id === task.unitId);
    const point = unit?.knowledge?.find(p => p.id === task.knowledgeId);
    if (!course || !unit || !point) throw new Error(tr('m243'));
    await this.learnKnowledge(course, unit, point, task.id);
  }

  async createExam(course: Course, unit: Course['units'][number], ids: string[], policy: QuestionPolicy, count: number): Promise<void> {
    await this.flushSettings(); validateSettings(this.data.settings);
    if (course.archived || unit.excluded) throw new Error(tr('m244'));
    const points = unit.knowledge?.filter(p => ids.includes(p.id) && p.active && p.confirmed) ?? [];
    if (!points.length || count < points.length) throw new Error(tr('m245'));
    const file = this.app.vault.getAbstractFileByPath(unit.path);
    if (!(file instanceof TFile)) throw new Error(tr('m228'));
    const text = await this.app.vault.read(file);
    if (points.some(p => p.fingerprint !== fingerprint(text) || !text.includes(p.quote))) throw new Error(tr('m246'));
    const types = examTypes(policy, count);
    const exam = examSchema.parse({ id: crypto.randomUUID(), courseId: course.id, unitId: unit.id, title: `${course.name} · ${unit.title}`, createdAt: new Date().toISOString(), status: 'active', policy,
      items: types.map((type, i) => { const point = points[i % points.length]!; return { type, focus: point,
        source: { path: file.path, name: file.basename, text: point.quote, mtime: file.stat.mtime, selection: true } }; }) });
    if (exam.items.reduce((n, item) => n + item.source.text.length, 0) > 240000) throw new Error(tr('m247'));
    await this.update(data => { data.exams.push(exam); });
    await this.continueExam(exam.id);
  }

  async continueExam(id: string): Promise<void> {
    const exam = this.data.exams.find(e => e.id === id);
    if (!exam || exam.status === 'finished') throw new Error(tr('m248'));
    const course = this.data.courses.find(c => c.id === exam.courseId);
    if (!course || course.archived) throw new Error(tr('m249'));
    const index = exam.items.findIndex(item => !this.allSessions().find(s => s.id === item.sessionId)?.attempts.some(a => a.assessment));
    if (index < 0) { await this.finishExam(id); return; }
    const item = exam.items[index]!;
    const existing = this.allSessions().find(s => s.id === item.sessionId);
    if (existing && existing.status !== 'ended') { await this.restoreSession(existing); return; }
    validateSettings(this.data.settings);
    if (this.engine.busy) throw new Error(tr('m250'));
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const leaf = await this.openCoach(); if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
    await this.engine.start(item.source, tr('m251', [course.name, item.focus.title]), {
      courseId: exam.courseId, unitId: exam.unitId, focus: item.focus, examId: id, examIndex: index,
      previousQuestions: this.seenQuestions(item.focus),
      allocation: allocationFor({ enabled: [item.type], mode: 'fixed', weights: { ...emptyCounts(), [item.type]: 100 } }, [], exam.courseId),
    });
  }

  async finishExam(id: string): Promise<void> {
    if (this.engine.busy) throw new Error(tr('m252'));
    if (this.engine.current?.examId === id) await this.engine.end();
    await this.update(data => { const exam = data.exams.find(e => e.id === id); if (exam) exam.status = 'finished'; }); this.emit();
  }

  async reviewExamAnswer(examId: string, sessionId: string, reason: string): Promise<void> {
    if (this.engine.busy) throw new Error(tr('m242'));
    const exam = this.data.exams.find(e => e.id === examId);
    const session = this.allSessions().find(s => s.id === sessionId && s.examId === examId);
    if (exam?.status !== 'finished' || !exam.items.some(i => i.sessionId === sessionId) || !session?.attempts.at(-1)?.assessment) throw new Error(tr('m253'));
    if (!reason.trim() || reason.length > 6000) throw new Error(tr('m254'));
    await this.flushSettings(); validateSettings(this.data.settings);
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    await this.engine.restore({ ...session, status: 'ended' });
    if (session.pending?.action === 'dispute') await this.engine.retry();
    else await this.engine.perform('dispute', reason);
    if (this.engine.current?.pending) throw new Error(this.engine.current.error ?? tr('m255'));
    this.emit();
  }

  async review(card: ReviewCard): Promise<void> {
    await this.flushSettings();
    validateSettings(this.data.settings);
    const fresh = this.getReviews().find(item => item.id === card.id);
    if (!fresh) throw new Error(tr('m256'));
    if (this.engine.busy) throw new Error(tr('m257'));
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const course = this.data.courses.find(c => c.id === fresh.courseId);
    await this.engine.startReview(fresh, course ? allocationFor(course.questionPolicy ?? defaultPolicy(), this.allSessions(), course.id) : undefined, fresh.focus ? this.seenQuestions(fresh.focus) : undefined);
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
  }

  async snoozeReview(id: string): Promise<void> {
    await this.update(data => { data.reviewSnoozes[id] = addDays(localDate(), 1); });
    this.emit();
  }

  async restoreSession(session: Session): Promise<void> {
    if (this.engine.busy) throw new Error(tr('m257'));
    if (this.engine.current?.status === 'ready') await this.engine.pause();
    const fresh = this.allSessions().find(item => item.id === session.id);
    if (!fresh) throw new Error(tr('m258'));
    await this.engine.restore(fresh.examId && this.data.exams.find(e => e.id === fresh.examId)?.status === 'finished' ? { ...fresh, status: 'ended' } : fresh);
    const leaf = await this.openCoach();
    if (leaf.view instanceof CoachView) leaf.view.showTab('learn');
  }

  async finishSession(): Promise<void> {
    if (this.engine.current?.examId && this.data.exams.find(e => e.id === this.engine.current!.examId)?.status === 'active') {
      await this.finishExam(this.engine.current.examId); return;
    }
    await this.engine.end();
    if (this.data.settings.autoExport) {
      try { await this.exportRecord(this.engine.current, true); }
      catch (error) { new Notice(tr('m259', [error instanceof Error ? error.message : tr('m260')]), 8000); }
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
    if (!session) throw new Error(tr('m261'));
    const folder = this.data.settings.outputFolder.trim();
    if (!folder || /(^[/\\]|(^|[/\\])\.\.?([/\\]|$)|[:*?"<>|])/.test(folder) || folder.split(/[/\\]/).some(part => part.startsWith('.'))) {
      throw new Error(tr('m262'));
    }
    const normalized = normalizePath(folder);
    const segments = normalized.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join('/');
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFolder)) throw new Error(tr('m263'));
      if (!existing) await this.app.vault.createFolder(path);
    }
    const safeName = session.source.name.replace(/[\\/:*?"<>|#\x5b\x5d]/g, '-').slice(0, 60);
    const base = normalizePath(`${normalized}/${session.createdAt.slice(0, 10)} ${safeName} ${session.id.slice(0, 8)}${automatic ? tr('m264') : ''}`);
    let path = `${base}.md`;
    if (automatic && this.app.vault.getAbstractFileByPath(path)) return;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} (${suffix++}).md`;
    const file = await this.app.vault.create(path, exportSession(session));
    new Notice(tr('m265'));
    if (!automatic) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async writeTraceFile(path: string, text: string): Promise<void> {
    const parts = path.split('/'); parts.pop();
    let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        try { await this.app.vault.createFolder(folder); }
        catch (error) { if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error; }
      }
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.modify(file, text);
    else await this.app.vault.create(path, text);
  }

  openTraces(): void { new TraceModal(this.app, this).open(); }

  async recentTraces() {
    await this.trace.flush();
    const folder = traceFolder(this.data.settings.traceFolder);
    const files = markdownInFolder(this.app.vault, folder).filter(f => f.path.startsWith(`${folder}/`) && /^[a-f0-9-]{36}\.md$/.test(f.name)).sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 1000);
    const records = [];
    for (const file of files) {
      if (file.stat.size > 150000) continue;
      try { records.push({ file, record: parseTraceMarkdown(await this.app.vault.read(file)) }); } catch { /* Skip unrelated or damaged files. */ }
    }
    return records.sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
  }

  async exportTraces(): Promise<void> {
    const records = (await this.recentTraces()).filter(r => Date.parse(r.record.startedAt) >= Date.now() - 7 * 86400000);
    if (!records.length) throw new Error(tr('m266'));
    const path = tr('m267', [traceFolder(this.data.settings.traceFolder), crypto.randomUUID()]);
    await this.writeTraceFile(path, tr('m268', [records.length]) + records.map(r => traceMarkdown(r.record)).join('\n\n---\n\n'));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  onunload(): void { this.engine?.dispose(); this.listeners.clear(); }
}
