# Learning Coach

Learning Coach is an Obsidian plugin for guided learning from Markdown notes. Select a note or a passage and work through explanations, questions, hints, feedback, and review scheduling. The current version is 0.4.3. The plugin interface is available in Simplified Chinese.

## Installation

Extract `dist/learning-coach-0.4.3.zip` and copy the included `learning-coach` folder into your vault's `.obsidian/plugins/` directory:

```text
Your vault/
  .obsidian/
    plugins/
      learning-coach/
        main.js
        manifest.json
        styles.css
```

Restart Obsidian or reload community plugins, then enable **Learning Coach** in Settings. Open the plugin settings, enter a service URL, API key, and model name, and select **Test connection**. When upgrading, replace the three files above and keep your existing `data.json`.

Do not copy the source project or `node_modules` into your vault.

## Desktop and mobile

The same package works on desktop, iOS, and Android. Desktop uses a right-side learning pane; mobile opens a full learning tab. On mobile, run **Open Learning Coach** or **Choose a note to start learning** from the command palette, or add either command to the mobile toolbar.

On a phone, `localhost` and `127.0.0.1` refer to the phone itself. They cannot reach a model service running on your computer. A mobile service URL must be reachable from the phone; a local computer service needs to be configured for access over your local network. HTTPS is recommended.

Both platforms use the same learning data format, but the same learning session should not be edited simultaneously on two devices. Finish saving and syncing before switching devices.

## Model service configuration

### OpenAI-compatible API

| Field | What to enter |
| --- | --- |
| Provider | OpenAI-compatible API |
| Service URL | The chat endpoint supplied by your model provider |
| API key | The key for that service; leave blank for a local service without authentication |
| Model name | The exact model name supplied by the service |

You can enter a service root URL, a version URL, or a complete chat endpoint:

```text
https://example.com
→ https://example.com/v1/chat/completions

https://example.com/v1
→ https://example.com/v1/chat/completions

https://example.com/proxy/v1
→ https://example.com/proxy/v1/chat/completions

https://example.com/v1/chat/completions
→ used as entered
```

### Native Ollama API

- Provider: Ollama native API.
- Service URL: `http://127.0.0.1:11434`.
- API key: usually blank.
- Model name: a model already installed locally.

The plugin uses `/api/chat`; it does not download or start a model. A connection test sends one short test message and does not send note content. A successful test only means that the service returned text; it does not guarantee that the model will reliably complete a structured learning session.

## How to learn

1. Open a Markdown note.
2. Select the graduation-cap icon in the left ribbon, or run **Learning Coach: Open Learning Coach**.
3. Enter a goal for this session, or use the default goal.
4. Select **Start learning this note**.
5. Read the learning route and explanation, then answer in your own words.
6. Use **Give me a hint**, **Explain directly**, **Ask a follow-up**, or **Skip this question** when needed.
7. If you disagree with an assessment, expand **I disagree with this assessment**, explain why, and request a review.
8. Pause, resume, or select **That's enough for today** at any time. You can also save a Markdown learning record.

Long notes open a section picker, with a limit of 24,000 characters per section. You can also select a chapter and start learning from the context menu. A single answer can contain up to 6,000 characters. The default route is **Explain first, then practice**; you can switch to **Test first, then learn** and choose the number of questions per session.

At the end of a session, a summary is saved by default. Use **Today** to view review items, review early, or postpone a review by one day. Reviews reuse the saved questions. An independently correct answer advances the interval through 1, 3, 7, 14, and 30 days; a hint, revealed explanation, or incorrect answer returns the interval to one day. This is a simple review schedule, not a precise long-term mastery model.

## Data and privacy

- Settings, note snapshots, the current session, and history are stored in the plugin's `data.json` inside the current vault.
- Before each write, the previous version is kept as `data.backup.json` so the plugin can attempt recovery if the main file is damaged.
- The API key is stored unencrypted in local plugin data. Do not share these files publicly, and check whether your vault sync service will sync them.
- The plugin enumerates Markdown files in the current vault so you can choose a source note. It does not automatically upload the whole vault.
- The remote model receives the note passage you select, your learning goal, and related answers. The plugin sends these only to the service configured by you.
- Exported Markdown records are written to a folder in your vault, `学习教练` by default. If a file has the same name, the plugin creates a new file instead of overwriting the existing record.
- If the source note changes, the plugin shows a notice. The current session continues to use the snapshot saved when learning started; start a new session to learn the updated content.
- Pausing stops the plugin from accepting late model results, although a service may continue processing a request that was already sent.

## Current scope

Implemented: model configuration, connection testing, current notes and selected passages, learning goals and routes, question-by-question guidance, hints and explanations, assessments and reviews, session save and restore, history, review scheduling, Markdown export, call limits, and timeouts.

Not implemented: cross-file course planning, PDF/OCR import, web search, voice features, concurrent multi-device sync, or precise long-term mastery estimation.

Citations in a question do not guarantee that the content is correct. A model may still misjudge an answer, reveal an answer too early, or ask an ambiguous question. Check the source note and use the review flow when needed. This version has not been shown to improve learning outcomes.

## Development

Node.js 22 or newer is recommended. Dependency versions are pinned in `package-lock.json`.

```bash
npm ci
npm test
npm run build
npm run smoke
npm run release:check
```

`npm run dev` watches the source files. `npm run package` creates an installable `dist/learning-coach/` directory and a versioned ZIP without user data.

The interface guidelines are in [design-system/MASTER.md](design-system/MASTER.md). New pages and components should follow its terminology, visual tokens, touch targets, and accessibility rules.

```text
src/
  main.ts       plugin entry point, serialized saves, and record export
  settings.ts   model configuration and connection testing
  view.ts       learning interface and history
  api.ts        URL normalization, protocol adapters, timeouts, and pause handling
  domain.ts     state, output validation, and learning records
  session.ts    learning loop, answers, retries, and recovery
  prompts.ts    model context for each learning action
  review.ts     review plans derived from real answers
  pickers.ts    note and long-note section selection
tests/          model service, review, and session behavior tests
```
