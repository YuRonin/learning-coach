# Learning Coach

Turn your Obsidian course notes into a study routine: confirm knowledge points, plan your available time, practice, correct mistakes, and revisit the material with different questions.

**Version 0.9.3 is a pre-release for acceptance testing, not the final 1.0 release.** The interface defaults to English and supports Simplified Chinese. Choose your language in **Settings → Learning Coach → Language / 语言**. New coaching responses follow that language; your notes, answers, and previous records are not translated or rewritten.

[User guide](docs/course-guide.md) · [Chinese user guide](docs/course-guide.zh-CN.md) · [Release notes](docs/releases/0.9.3.md)

## What you can do

- Organize a notes folder as a course, exclude unrelated material, and confirm source-linked knowledge points.
- Set question types for each course: single choice, multiple choice, true/false, and short answer. Use fixed proportions or let the coach adapt within your choices.
- Plan a short study session around your available time, due reviews, and learning gaps.
- Answer questions, ask for hints or explanations, and return later for independent review.
- Run a unit assessment with feedback held until submission. Request a reassessment or invalidate a flawed question without losing the original answer.
- Inspect local agent traces and export the last seven days for troubleshooting.

Generated questions are practice based on your material, not official exam questions. Source matching and model review reduce some errors but do not guarantee a correct answer. The plugin does not predict exam scores or pass rates.

## Install the pre-release

Requires **Obsidian 1.13.7 or later**. Older versions have not been verified.

1. Build the plugin or obtain the `learning-coach-0.9.3.zip` package from the maintainer.
2. Put its `learning-coach` folder under `<vault>/.obsidian/plugins/`.
3. Reload community plugins and enable **Learning Coach**.
4. Open its settings, choose your language, and enter your model connection details.
5. Select **Test connection**. This sends a short test message, not your notes, and may incur a small provider charge.

This project has not yet been published in the Obsidian community directory. Updating the plugin requires replacing only `main.js`, `manifest.json`, and `styles.css`; keep your existing data files.

## Start studying

Open **Courses → Add course**, choose a notes folder, preview the included notes, and set your daily budget and question types. Each note becomes a unit.

Expand a unit and select **Extract knowledge points from notes**. Initial candidates are generated locally. Check the source quotes, then confirm the points you want to study. Optional model-assisted splitting and syllabus mapping send only the material described in their dialogs and require you to save the preview.

On **Today**, plan tasks for your available time. You can also study a confirmed point directly, or start from the current note or selected text without creating a course. Long notes use a section picker; each session accepts up to 24,000 source characters and each answer up to 6,000 characters.

## Connect a model

Use an **OpenAI-compatible** chat endpoint or the **native Ollama** API. Enter the provider's base URL, API key, and exact model identifier. Compatible endpoints accept a root URL, a `/v1` URL, or a complete `/chat/completions` URL; the settings page shows the resolved endpoint. Custom gateways may require a version prefix.

Ollama requires an already running, reachable service and an installed model. The plugin does not download or start models. On a phone, `127.0.0.1` refers to the phone, not your computer.

Real-provider quality evaluation remains pending. A successful connection test only confirms that the service returns text; it does not establish question quality.

## How learning evidence works

Objective questions are graded locally against the answer saved when the question was generated. Short answers and reassessments use your model. Hints, explanations, reused questions, and self-reported confidence remain part of the evidence.

A knowledge point can become provisionally stable only after independent correct answers to different questions at least a day apart. Later gaps return it to practice. The progress bar counts assessed questions, not mastery.

Question settings are frozen for an active session. Changing a course affects future sessions. Fixed proportions balance cumulative displayed questions, including skips; short sessions may not match the proportions exactly. Invalidated questions remain in history but are excluded from progress and review calculations.

## Caching and usage

The local response cache is enabled by default. It stores validated question-generation and question-review responses for seven days, with a limit of 50 entries and about 1 MB. Hits survive restarts and issue no model request. Grading, reassessment, hints, and follow-ups are not reused from this cache.

Cache keys depend on request content and connection settings. English and Chinese prompts produce different keys. Changing connection settings or temperature clears the cache. You can disable or clear it in settings. Cache corruption or write failure does not delete study records.

Provider-side context caching is separate. The plugin displays token counts only when reported by the service; it does not estimate costs or infer saved tokens from character counts.

## Agent traces

Traces are enabled by default and written to a normal vault folder:

```text
Learning Coach/Traces/YYYY-MM-DD/<trace-id>.md
```

Existing configured folders are preserved, including folders named in Chinese. Changing the interface language does not rename or move files.

Each action has a separate file with request timing, reported usage, cache hits, validation results, local grading, and save results. Retries get new trace IDs linked to the same operation digest. An unfinished trace may mean an action is still running or the app closed before its result was recorded.

In settings, **View agent traces** shows the latest 100 records. **Export last seven days** reads up to the 1,000 most recently modified trace files and skips damaged files. Exports include validated fields, not text manually added to a trace. Old traces do not expire automatically; you can delete their date folders yourself.

Traces do not contain API keys, service URLs, note bodies, complete prompts, model responses, or your answers. Timing, usage, behavior, and identifier digests are still personal information. Check exports before sharing. These are execution records, not a model's internal reasoning.

## Desktop, mobile, and sync

The same bundle targets desktop, iOS, and Android. Desktop uses a sidebar; mobile uses a full tab. Desktop flows and mobile-sized layouts have been tested. **iOS and Android device testing is still pending.**

Trace files and exported summaries can sync as ordinary notes if your sync service includes their folders. Course progress, answers, settings, and active sessions live in the plugin's `data.json`; syncing them depends on whether your service includes plugin data. That file also contains your unencrypted API key and base URL.

There is **no automatic conflict merge for simultaneous study on multiple devices**. Finish or pause on one device, wait for saving and sync, then switch. If plugin data is excluded from sync, traces can sync while learning progress does not. Automatic cross-device conflict merging is not supported.

## Data and privacy

Connection settings, source snapshots, answers, courses, plans, and assessments are stored in the current vault's plugin `data.json`. The previous complete save is retained in `data.backup.json`. Keys are stored unencrypted. The separate `learning-cache.json` may contain source quotes and generated questions, but not connection keys or complete requests.

Starting a study action sends selected material and relevant answers to your configured model service. Optional model suggestions also send the material described in the dialog. The plugin does not automatically upload the whole vault. Your provider and sync service have their own data policies.

Older data-format upgrades retain `data.pre-0.9.0.json`; the current data format is 4. Back up privately before downgrading. An older snapshot does not include later work. Clearing course records does not delete source notes, exported notes, caches, or existing backups.

The release package includes only three runtime files, never personal configuration, caches, traces, or test vaults. See [Security and privacy](SECURITY.md).

## Development and validation

Use Node.js 22 or later and the committed lockfile.

```bash
npm ci
npm test
npm run build
npm run smoke
npm run test:e2e
npm run release:check
npm run check:public
```

End-to-end tests require a local Obsidian installation. They use an isolated vault and a local fixture service, never your personal API configuration. Mobile emulation is not a real-device result.

`npm run package` creates the installable folder and ZIP. `npm run benchmark` uses synthetic data. `npm run evaluate:model` and `npm run evaluate:checker` use explicit environment variables for anonymous provider evaluations; they do not read personal plugin settings.

See the [contribution guide](CONTRIBUTING.md). PDF/OCR import, web question search, voice, timed full-length mock exams, and multi-device conflict merging are not implemented.

For bug reports, include the version and reproduction steps. Do not upload API keys, complete configuration files, or private course notes.
