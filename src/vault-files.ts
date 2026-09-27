import { TFile, TFolder, type Vault } from 'obsidian';

/** Walk only the selected folder; listing paths does not read note contents. */
export function markdownInFolder(vault: Vault, path: string): TFile[] {
  const root = path ? vault.getAbstractFileByPath(path) : vault.getRoot();
  if (!(root instanceof TFolder)) return [];
  const files: TFile[] = [];
  const folders = [root];
  while (folders.length) {
    const folder = folders.pop()!;
    for (const child of folder.children) {
      if (child instanceof TFolder) folders.push(child);
      else if (child instanceof TFile && child.extension === 'md') files.push(child);
    }
  }
  return files;
}
