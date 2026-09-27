import { t as tr, getLanguage } from './i18n';
import { PluginSettingTab, Setting, type App, type SettingDefinitionRender } from 'obsidian';
import type LearningCoachPlugin from './main';
import { traceFolder } from './trace';
import { endpoint } from './api';
import type { Settings } from './domain';

type CoachRow = Omit<SettingDefinitionRender, 'render'> & { render: (setting: Setting) => void };
type CoachGroup = { type: 'group'; heading: string; items: CoachRow[] };

export class CoachSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly coach: LearningCoachPlugin) { super(app, coach); }

  getSettingDefinitions(): (CoachRow | CoachGroup)[] {
    const definitions: CoachRow[] = [];
    const row = (name: string, desc = '') => {
      const definition: CoachRow = { name, desc, render: () => {} };
      definitions.push(definition);
      return (configure: (setting: Setting) => void) => { definition.render = setting => {
        this.containerEl.lang = getLanguage();
        this.containerEl.addClass('lc-settings');
        configure(setting);
      }; };
    };
    row('Language / 语言')(setting => { setting.setName('Language / 语言')
      .addDropdown(dropdown => dropdown.addOption('en', 'English').addOption('zh-CN', '简体中文')
        .setValue(this.coach.data.settings.language).setDisabled(this.coach.engine.busy)
        .onChange(value => this.coach.safely(async () => {
          await this.coach.saveSettings({ language: value === 'zh-CN' ? 'zh-CN' : 'en' });
          this.refresh();
        }))); });
    row(tr('m386'), tr('m387'))(() => {});
    row(tr('m388'))(setting => { setting.setName(tr('m388')).setHeading(); });
    let connection: HTMLElement | undefined;
    const save = (patch: Partial<Settings>) => {
      if ('baseUrl' in patch || 'apiKey' in patch || 'model' in patch || 'provider' in patch) { if (connection) { connection.dataset.state = 'idle'; connection.setText(tr('m390')); } }
      return this.coach.safely(() => this.coach.saveSettings(patch));
    };
    row(tr('m391'), tr('m392'))(setting => { setting.setName(tr('m391')).setDesc(tr('m392'))
      .addDropdown(dropdown => dropdown.addOption('compatible', tr('m393')).addOption('ollama', tr('m394'))
        .setValue(this.coach.data.settings.provider).onChange(async value => {
          const oldUrl = this.coach.data.settings.baseUrl;
          const isDefault = ['http://127.0.0.1:11434', 'https://api.openai.com/v1'].includes(oldUrl);
          await save({ provider: value === 'ollama' ? 'ollama' : 'compatible', baseUrl: isDefault ? (value === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1') : oldUrl });
          this.refresh();
        })); });
    row(tr('m395'), tr('m396'))(setting => {
      setting.setName(tr('m395')).setDesc(tr('m396'))
      .addText(text => text.setPlaceholder('https://example.com/v1').setValue(this.coach.data.settings.baseUrl).onChange(async value => {
        await save({ baseUrl: value.trim() });
        refreshEndpoint();
      }));
      endpointEl = setting.descEl.createDiv({ cls: 'lc-endpoint' });
      refreshEndpoint();
    });
    let endpointEl: HTMLElement | undefined;
    const refreshEndpoint = () => {
      if (!endpointEl) return;
      try { endpointEl.setText(tr('m397', [endpoint(this.coach.data.settings.baseUrl, this.coach.data.settings.provider)])); }
      catch (error) { endpointEl.setText(error instanceof Error ? error.message : tr('m398')); }
    };
    row(tr('m399'), tr('m400'))(setting => { setting.setName(tr('m399')).setDesc(tr('m400'))
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setPlaceholder(tr('m401')).setValue(this.coach.data.settings.apiKey).onChange(value => save({ apiKey: value.trim() }));
      }); });
    row(tr('m402'), tr('m403'))(setting => { setting.setName(tr('m402')).setDesc(tr('m403'))
      .addText(text => text.setPlaceholder(tr('m404')).setValue(this.coach.data.settings.model).onChange(value => save({ model: value.trim() }))); });
    row(tr('m405'), tr('m406'))(setting => { setting.setName(tr('m405')).setDesc(tr('m406'))
      .addButton(button => button.setButtonText(tr('m405')).onClick(async () => {
        button.setDisabled(true).setButtonText(tr('m407'));
        connection!.dataset.state = 'loading'; connection!.setText(tr('m408'));
        try { await this.coach.flushSettings(); await this.coach.gateway.test({ ...this.coach.data.settings }); connection!.dataset.state = 'success'; connection!.setText(tr('m409')); }
        catch (error) { connection!.dataset.state = 'error'; connection!.setText(error instanceof Error ? error.message : tr('m410')); }
        finally { button.setDisabled(false).setButtonText(tr('m405')); }
      }));
      connection = setting.descEl.createDiv({ cls: 'lc-connection-status', attr: { role: 'status', 'aria-live': 'polite' } });
      connection.setText(tr('m389'));
    });
    row(tr('m411'))(setting => { setting.setName(tr('m411')).setHeading(); });
    row(tr('m412'), tr('m413'))(setting => { setting.setName(tr('m412')).setDesc(tr('m413'))
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.traceEnabled).onChange(value => save({ traceEnabled: value }))); });
    let folder = this.coach.data.settings.traceFolder;
    row(tr('m414'), tr('m415'))(setting => { setting.setName(tr('m414')).setDesc(tr('m415'))
      .addText(text => text.setValue(folder).onChange(value => { folder = value; }))
      .addButton(button => button.setButtonText(tr('m416')).onClick(() => this.coach.safely(async () => { await this.coach.saveSettings({ traceFolder: traceFolder(folder) }); this.refresh(); }))); });
    row(tr('m417'))(setting => { setting.setName(tr('m417')).setDesc(this.coach.trace.storageFailed ? tr('m418') : tr('m419'))
      .addButton(button => button.setButtonText(tr('m420')).onClick(() => this.coach.openTraces()))
      .addButton(button => button.setButtonText(tr('m421')).onClick(() => this.coach.safely(() => this.coach.exportTraces()))); });
    row(tr('m422'))(setting => { setting.setName(tr('m422')).setHeading(); });
    row(tr('m423'), tr('m424'))(setting => { setting.setName(tr('m423')).setDesc(tr('m424'))
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.cacheEnabled).onChange(value => save({ cacheEnabled: value }))); });
    const cache = this.coach.cache.snapshot();
    row(tr('m425'))(setting => { setting.setName(tr('m425')).setDesc(tr('m426', [cache.entries, Math.ceil(cache.bytesUpperBound / 1024), cache.hits, cache.misses, cache.storageFailed ? tr('m427') : '']))
      .addButton(button => button.setButtonText(tr('m428')).setDisabled(this.coach.engine.busy).onClick(async () => { await this.coach.safely(() => this.coach.cache.clear()); this.refresh(); })); });
    const usage = this.coach.gateway.usage;
    row(tr('m429'))(setting => { setting.setName(tr('m429')).setDesc(usage.reportedResponses
      ? tr('m430', [usage.reportedResponses, usage.inputTokens, usage.outputTokens, usage.cacheReportedResponses ? tr('m431', [usage.cachedInputTokens]) : tr('m432')])
      : tr('m433')); });
    row(tr('m434'), tr('m435'))(setting => { setting.setName(tr('m434')).setDesc(tr('m435'))
      .addDropdown(dropdown => dropdown.addOption('guided', tr('m436')).addOption('diagnostic', tr('m437'))
        .setValue(this.coach.data.settings.learningMode).onChange(value => save({ learningMode: value === 'diagnostic' ? 'diagnostic' : 'guided' }))); });
    row(tr('m438'), tr('m439'))(setting => { setting.setName(tr('m438')).setDesc(tr('m439'))
      .addDropdown(dropdown => {
        for (const count of [1, 3, 5, 8, 10]) dropdown.addOption(String(count), tr('m440', [count]));
        dropdown.setValue(String(this.coach.data.settings.questionsPerSession)).onChange(value => save({ questionsPerSession: Number(value) }));
      }); });
    row(tr('m441'), tr('m442'))(setting => { setting.setName(tr('m441')).setDesc(tr('m442'))
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.autoExport).onChange(value => save({ autoExport: value }))); });
    row(tr('m443'), tr('m444'))(setting => { setting.setName(tr('m443')).setDesc(tr('m444'))
      .addText(text => text.setValue(this.coach.data.settings.outputFolder).onChange(value => save({ outputFolder: value }))); });
    const advancedStart = definitions.length;
    row(tr('m446'), tr('m447'))(setting => { setting.setName(tr('m446')).setDesc(tr('m447'))
      .addDropdown(dropdown => {
        for (const seconds of [30, 60, 90, 120, 180, 300]) dropdown.addOption(String(seconds), tr('m448', [seconds]));
        dropdown.setValue(String(this.coach.data.settings.timeoutSeconds)).onChange(value => save({ timeoutSeconds: Number(value) }));
      }); });
    row(tr('m449'), tr('m450'))(setting => { setting.setName(tr('m449')).setDesc(tr('m450'))
      .addDropdown(dropdown => {
        for (const calls of [10, 20, 30, 50, 100]) dropdown.addOption(String(calls), tr('m451', [calls]));
        dropdown.setValue(String(this.coach.data.settings.maxCalls)).onChange(value => save({ maxCalls: Number(value) }));
      }); });
    row(tr('m452'), tr('m453'))(setting => { setting.setName(tr('m452')).setDesc(tr('m453'))
      .addSlider(slider => slider.setLimits(0, 1, 0.1).setValue(this.coach.data.settings.temperature)
        .onChange(value => save({ temperature: value }))); });
    row(tr('m454'), tr('m455'))(setting => { setting.setName(tr('m454')).setDesc(tr('m455'))
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.sendTemperature).onChange(value => save({ sendTemperature: value }))); });
    return [...definitions.slice(0, advancedStart), { type: 'group', heading: tr('m445'), items: definitions.slice(advancedStart) }];
  }

  private standalone = false;
  private refresh(): void {
    if (this.standalone) this.renderInto(this.containerEl);
    else this.update();
  }

  /** The in-view modal shares exactly the same searchable row definitions. */
  renderInto(container: HTMLElement): void {
    this.standalone = true;
    this.containerEl = container;
    container.empty();
    container.lang = getLanguage();
    container.addClass('lc-settings');
    for (const item of this.getSettingDefinitions()) {
      if ('type' in item) {
        if (item.type !== 'group') continue;
        const details = container.createEl('details', { cls: 'lc-settings-advanced lc-disclosure' });
        details.createEl('summary', { text: item.heading });
        for (const child of item.items ?? []) {
          if ('render' in child && child.render) child.render(new Setting(details).setName(child.name).setDesc(child.desc ?? ''));
        }
      } else if ('render' in item && item.render) {
        item.render(new Setting(container).setName(item.name).setDesc(item.desc ?? ''));
      }
    }
  }
}
