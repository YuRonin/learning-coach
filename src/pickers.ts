import { t as tr } from './i18n';
import { FuzzySuggestModal, type App, type TFile } from 'obsidian';

export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app); this.setPlaceholder(tr('m275'));
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

type Part = { label: string; text: string };
export class PartPicker extends FuzzySuggestModal<Part> {
  constructor(app: App, private readonly parts: Part[], private readonly choose: (part: Part) => void) {
    super(app); this.setPlaceholder(tr('m276'));
  }
  getItems(): Part[] { return this.parts; }
  getItemText(part: Part): string { return tr('m277', [part.label, part.text.length.toLocaleString()]); }
  onChooseItem(part: Part): void { this.choose(part); }
}
