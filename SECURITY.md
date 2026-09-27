# Security and privacy

Do not put API keys in public issues, screenshots, logs, or source code.

Learning Coach stores study data in the current vault's plugin data and connection settings separately in `config.json`. API keys remain unencrypted. Study requests send selected note excerpts, learning goals, and relevant answers to the model service you configure. Optional material suggestions send the inputs described in their dialogs. The plugin does not automatically upload the entire vault.

## Files that must remain private

- `config.json` contains the unencrypted API key and base URL. Keep it local and exclude it from sync.
- `data.json`, `data.backup.json`, and `data.pre-*.json` contain learning data and non-connection settings. New versions remove credentials from these files.
- `learning-cache.json` can contain note quotes and generated questions. Its keys are digests; raw connection keys, URLs, and complete requests are not stored in the cache.
- Exported study notes contain your answers and source material.
- Agent traces omit keys, URLs, note bodies, prompts, and answers, but still reveal timing, usage, behavior, and linked identifier digests. They are not anonymous.

The repository ignores private data files, and the package script includes only `main.js`, `manifest.json`, and `styles.css`. These safeguards do not protect secrets deliberately pasted into source code, screenshots, or Git history. If a real key has been committed or shared, revoke it with the provider; deleting the latest copy is not sufficient.

## Retention and synchronization

The local response cache retains at most 50 entries, about 1 MB, for seven days. Clear or disable it in settings. Clearing the cache does not delete learning records. Clearing course records does not remove exports, caches, or backups. Remove those copies separately if you need to erase private material, including copies held by a sync service.

Traces default to `Learning Coach/Traces` for new configurations. Existing folder settings are preserved. Turning tracing off retains existing files; old traces are not automatically deleted.

If you synchronize plugin data between devices, exclude the local `config.json` and finish syncing before switching devices. Learning Coach does not merge conflicting learning state from concurrent devices.

## Reporting a vulnerability

Use the repository's private GitHub vulnerability reporting channel if available, or contact the maintainer privately before sharing sensitive reproduction material. Do not attach live keys or complete personal configuration files. If no private channel is available, open an issue containing only a request for a private contact method.
