import { FuzzySuggestModal, type App, type TFile } from 'obsidian';

export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app); this.setPlaceholder('搜索一篇想学习的 Markdown 笔记');
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

type Part = { label: string; text: string };
export class PartPicker extends FuzzySuggestModal<Part> {
  constructor(app: App, private readonly parts: Part[], private readonly choose: (part: Part) => void) {
    super(app); this.setPlaceholder('笔记较长，选择本次要学习的部分（原笔记不会被截断）');
  }
  getItems(): Part[] { return this.parts; }
  getItemText(part: Part): string { return `${part.label} · ${part.text.length.toLocaleString()} 字符`; }
  onChooseItem(part: Part): void { this.choose(part); }
}
