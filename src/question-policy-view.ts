import { t as tr } from './i18n';
import { defaultPolicy, questionLabels, questionPolicySchema, questionTypes, type QuestionPolicy } from './question-policy';

/** Shared course and temporary-session editor; values stay local until its owner saves. */
export function policyEditor(parent: HTMLElement, initial = defaultPolicy()): () => QuestionPolicy {
  const draft = structuredClone(initial);
  const group = parent.createEl('fieldset', { cls: 'lc-disclosure' });
  group.createEl('legend', { text: tr('m309') });
  group.createEl('p', { text: tr('m310'), cls: 'lc-caption' });
  const modeLabel = group.createEl('label', { cls: 'lc-label', text: tr('m311') });
  const mode = modeLabel.createEl('select', { attr: { 'aria-label': tr('m311') } });
  mode.createEl('option', { text: tr('m312'), value: 'adaptive' });
  mode.createEl('option', { text: tr('m313'), value: 'fixed' });
  mode.value = draft.mode;
  const inputs = new Map<string, HTMLInputElement>();
  const refresh = () => { for (const t of questionTypes) { const input = inputs.get(t)!; input.disabled = draft.mode !== 'fixed' || !draft.enabled.includes(t); input.value = String(draft.weights[t]); } };
  for (const t of questionTypes) {
    const row = group.createDiv({ cls: 'lc-course-unit' });
    const label = row.createEl('label', { cls: 'lc-option lc-policy-option' });
    const check = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': questionLabels[t] } });
    check.checked = draft.enabled.includes(t);
    label.appendText(questionLabels[t]);
    const weightLabel = row.createEl('label', { cls: 'lc-label', text: tr('m314', [questionLabels[t]]) });
    const weight = weightLabel.createEl('input', { attr: { type: 'number', min: '0', max: '100', step: '1', 'aria-label': tr('m315', [questionLabels[t]]) } });
    inputs.set(t, weight);
    weight.addEventListener('input', () => { draft.weights[t] = Number(weight.value); });
    check.addEventListener('change', () => {
      draft.enabled = questionTypes.filter(type => type === t ? check.checked : draft.enabled.includes(type));
      if (!check.checked) draft.weights[t] = 0;
      refresh();
    });
  }
  mode.addEventListener('change', () => { draft.mode = mode.value as QuestionPolicy['mode']; refresh(); });
  const equal = group.createEl('button', { text: tr('m316'), attr: { type: 'button' } });
  equal.addEventListener('click', () => {
    const n = draft.enabled.length;
    for (const t of questionTypes) draft.weights[t] = 0;
    draft.enabled.forEach((t, i) => { draft.weights[t] = Math.floor(100 / n) + (i < 100 % n ? 1 : 0); });
    refresh();
  });
  group.createEl('p', { text: tr('m317'), cls: 'lc-caption' });
  refresh();
  return () => {
    const result = questionPolicySchema.safeParse(draft);
    if (!result.success) throw new Error(draft.enabled.length ? tr('m318') : tr('m319'));
    return result.data;
  };
}
