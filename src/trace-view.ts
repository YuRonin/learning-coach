import { t as tr, getLanguage } from './i18n';
import { Modal, Setting, type App } from 'obsidian';
import { traceLabels } from './trace';
import type LearningCoachPlugin from './main';

export class TraceModal extends Modal {
  constructor(app: App, private coach: LearningCoachPlugin) { super(app); }
  onOpen(): void {
    this.contentEl.lang = getLanguage();
    this.contentEl.addClass('lc-root', 'lc-settings-modal');
    this.setTitle(tr('m411'));
    this.titleEl.setAttribute('role', 'heading');
    this.titleEl.setAttribute('aria-level', '2');
    this.contentEl.createEl('p', { text: tr('m456'), cls: 'lc-caption' });
    void this.coach.safely(async () => {
      const records = await this.coach.recentTraces();
      if (!this.contentEl.isConnected) return;
      if (!records.length) this.contentEl.createEl('p', { text: tr('m457') });
      for (const { file, record } of records.slice(0, 100)) {
        new Setting(this.contentEl).setName(`${traceLabels[record.action]} · ${new Date(record.startedAt).toLocaleString(getLanguage())}`)
          .setDesc(tr('m458', [{ running: tr('m459'), success: tr('m460'), failure: tr('m461'), cancelled: tr('m462') }[record.outcome], record.events.length]))
          .addButton(button => button.setButtonText(tr('m463')).onClick(() => this.coach.safely(async () => { await this.app.workspace.getLeaf(false).openFile(file); this.close(); })));
      }
    });
  }
  onClose(): void { this.contentEl.empty(); }
}
