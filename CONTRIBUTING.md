# Contributing

Use an isolated test vault and synthetic credentials. Do not read, copy, or commit personal Obsidian configuration. Preserve existing work. Reuse the existing components, spacing, colors, and bilingual terminology when changing the interface.

## Local development

```bash
npm ci
npm run dev
```

Before submitting a change, run `npm test`, `npm run build`, and `npm run smoke`. For interface or interaction changes, also run `npm run test:e2e` in the isolated Obsidian test environment. Report real-device testing separately from mobile emulation. Run `npm run release:check` and `npm run check:public` before preparing release assets.

## Localization

English is the default. Application-owned text belongs in `src/locales/en.ts` and `src/locales/zh-CN.ts`. Use the typed translator from `src/i18n.ts`; do not translate user notes, titles, source quotes, saved model output, or answers. Existing message IDs are stable: add a new ID instead of renumbering the catalog.

Keep numbered placeholders identical across translations. Pass values as translator arguments, never by translating already interpolated user text. Module-level labels must resolve lazily through `localizedLabels` so changing language updates them. Avoid translating storage paths or protocol identifiers.

New model instructions must select the response language without weakening source grounding, assessment rules, or prompt-injection boundaries. A UI language change does not rewrite historical content. Add tests for both languages when changing prompts or question validation.

## Bug reports

Provide the plugin, Obsidian, and OS versions, the selected language, expected behavior, and minimal reproduction steps. Use anonymous notes. Do not attach keys, private gateway addresses, complete data files, or unredacted traces.
