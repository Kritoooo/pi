# Managed Configuration

Managed configuration lets an administrator provide Pi's authoritative runtime configuration and portable resources from an HTTP endpoint. It is an explicit startup mode of the normal `pi` command, not a separate command or distribution.

## Enable Managed Mode

Pass the configuration URL directly:

```bash
pi --managed-config-url https://config.example.com/api/pi/config
```

If the endpoint requires authentication, pass a bootstrap bearer token:

```bash
pi \
  --managed-config-url https://config.example.com/api/pi/config \
  --managed-config-token "$PI_CONFIG_BOOTSTRAP_TOKEN"
```

The equivalent environment variables are:

```bash
export PI_MANAGED_CONFIG_URL=https://config.example.com/api/pi/config
export PI_MANAGED_CONFIG_TOKEN="$PI_CONFIG_BOOTSTRAP_TOKEN"
pi
```

CLI values take precedence over environment variables. A token without a URL is an error. The bootstrap token is sent only to the configuration endpoint; it is never used as a model provider credential.

Without a managed configuration URL, Pi uses its existing local behavior unchanged.

The URL is the mode switch: when it is configured, the remote snapshot becomes the authoritative source for every managed setting and resource. Pi does not load local values to fill omitted remote fields. To run locally while keeping the URL configured, use the explicit opt-out flag or environment variable:

```bash
pi --no-managed-config
PI_MANAGED_CONFIG_DISABLED=1 pi
```

The opt-out wins over the URL and token. In that run the URL is not fetched, and local providers, models, credentials, settings, and resources are used.

## Exclusive Configuration Sources

Local and managed modes are mutually exclusive:

| Source or behavior | Local mode | Managed mode |
| --- | --- | --- |
| Built-in providers and models | Enabled | Ignored |
| `models.json` | Enabled | Ignored |
| `auth.json` | Enabled | Ignored |
| Provider credential environment variables | Enabled | Ignored |
| Provider catalog refresh | Enabled | Disabled |
| Extension provider registration | Enabled | Ignored with a warning |
| Local settings covered by the managed schema | Enabled | Ignored |
| Local context and system prompt files | Enabled | Ignored |
| Local/package/auto-discovered skills and extensions | Enabled | Ignored |
| Local prompt templates and themes | Enabled | Ignored |
| Local keybindings | Enabled | Ignored; built-in defaults are used |
| Managed skill and extension bundles | Not applicable | Enabled |
| Explicit CLI resource paths | Enabled | Enabled and ordered before managed resources |
| Built-in non-provider extensions | Enabled | Enabled |
| Provider and model source | Local composition | Remote snapshot only |
| Provider API key source | Local auth sources | Remote snapshot only |

Managed mode never supplements remote values from local settings or resources. `--api-key`, provider login/logout, and runtime credential changes are unavailable in this mode. Local bootstrap and machine state remain local: the managed URL/token, HTTP proxy, session path, editor/shell integration, Project Trust, changelog state, analytics identifier, sessions, and caches.

## Configuration Contract

The endpoint must return a strict version 1 JSON document:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "company-gateway",
      "name": "Company Gateway",
      "api": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "remote-issued-provider-key",
      "authHeader": true,
      "headers": {
        "x-tenant": "engineering"
      },
      "models": [
        {
          "id": "model-a",
          "name": "Model A",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  ],
  "settings": {},
  "systemPrompt": null,
  "appendSystemPrompt": [],
  "contextFiles": [],
  "skills": [],
  "extensions": []
}
```

All top-level fields in the example are required. Empty managed content must be represented explicitly with `{}`, `[]`, or `null`. A missing field is an invalid snapshot and Pi refuses to start.

Explicit per-run CLI options remain above the snapshot:

```text
explicit CLI option > remote snapshot > built-in product default
```

```json
{
  "version": 1,
  "providers": [
    {
      "id": "company-gateway",
      "api": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "remote-issued-provider-key",
      "models": [{ "id": "model-a" }]
    }
  ],
  "settings": {
    "defaultProvider": "company-gateway",
    "defaultModel": "model-a",
    "defaultThinkingLevel": "high",
    "enableSkillCommands": true,
    "defaultTools": ["read", "bash"],
    "compaction": { "enabled": true, "reserveTokens": 16384 }
  },
  "systemPrompt": "You are the company coding assistant.",
  "appendSystemPrompt": ["Follow the organization coding policy."],
  "contextFiles": [
    { "path": "remote/AGENTS.md", "content": "Organization-wide instructions." }
  ],
  "skills": [
    {
      "name": "company-review",
      "files": [
        {
          "path": "SKILL.md",
          "content": "---\nname: company-review\ndescription: Review changes against company policy\n---\nRead references/policy.md before reviewing."
        },
        {
          "path": "references/policy.md",
          "content": "Company review policy."
        }
      ]
    }
  ],
  "extensions": [
    {
      "name": "company-commands",
      "entry": "index.ts",
      "files": [
        {
          "path": "index.ts",
          "content": "export default function (pi) { pi.registerCommand('company', { description: 'Company command', handler: async () => {} }); }"
        }
      ]
    }
  ]
}
```

`settings` is required and accepts the safe runtime settings represented in [`settings.md`](settings.md), including the default provider/model/thinking level, model thinking-level map, skill-command toggle, tool defaults, compaction/retry/transport, image and terminal behavior, UI preferences, and HTTP timeouts. Individual settings may be omitted to use Pi's built-in default, never a local setting. It does not accept local paths, package sources, credentials, or `defaultProjectTrust`. Default provider/model and model-thinking references must resolve to models in the same snapshot, and every `enabledModels` pattern must match at least one managed model.

`systemPrompt` is required and accepts a string or `null`; `null` selects Pi's built-in system prompt without discovering local `SYSTEM.md`. `appendSystemPrompt`, `contextFiles`, `skills`, and `extensions` are required arrays. `contextFiles` contains literal content supplied by the endpoint; it is not read from a client filesystem. Duplicate context paths and unknown fields are rejected.

`skills` and `extensions` contain text bundles:

- Each skill has a portable lowercase `name` and a `files` array containing exactly one root `SKILL.md`. The skill may include text scripts and reference files. `SKILL.md` must have valid frontmatter, a non-empty description, and a name matching the bundle name when the frontmatter declares one.
- Each extension has a portable lowercase `name`, a `.ts` or `.js` `entry`, and a `files` array containing that entry. Relative imports between files in the same bundle are supported.
- Files use relative POSIX paths. Absolute paths, backslashes, empty segments, `.`/`..`, case-insensitive duplicates, file/directory prefix conflicts, reserved filesystem names, and unknown fields are rejected.
- `executable: true` gives a text file owner-only executable permissions on POSIX. Other files are owner-readable and owner-writable only.
- Pi does not install npm or git dependencies for managed bundles. Extensions may use relative bundled modules and the modules already supported by Pi's extension loader.

Collection fields use complete-snapshot semantics. Empty arrays mean that the managed collection is empty; omission is a schema error. Explicit `--skill` and `--extension` paths remain first. `--no-skills` and `--no-extensions` suppress managed defaults while retaining their existing explicit-path behavior. Local/package/auto-discovered collections are never loaded in managed mode.

Project Trust remains local by design. The remote snapshot cannot grant or revoke trust for a machine. Managed mode does not load project-local settings, packages, or auto-discovered resources, so Project Trust cannot authorize them as a fallback source.

Managed extensions execute code during startup. The configured managed URL is therefore a code trust root, and Project Trust does not approve managed extensions. Use only an authenticated endpoint you control. Use `--no-extensions` for one run, or `--no-managed-config` to skip all remote content and return to local mode.

Each provider requires:

- A unique `id`.
- A Pi-supported `api` protocol.
- An absolute `baseUrl`.
- A non-empty literal `apiKey`.
- A non-empty, complete `models` array.

Provider entries may also set `name`, `headers`, `compat`, and `authHeader`. Model entries reuse the fields supported by [`models.json`](models.md), including `api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`, `samplingParams`, `headers`, and `compat`.

The document is a complete snapshot. Missing required fields, patches, inheritance, deletion markers, unknown fields, duplicate case-insensitive IDs, unresolved model references, and references to local credentials are rejected. An `apiKey` such as `"$SOME_ENV_VAR"` is used literally and is not expanded from the process environment.

Configuration and provider URLs must use HTTPS. Loopback HTTP URLs such as `http://127.0.0.1:8080` are accepted for local development and testing. Embedded URL credentials and invalid header values are rejected.

## Startup and Reload Behavior

The Pi CLI resolves managed configuration once during process startup, before selecting a model or creating a session. The same immutable snapshot and `ModelRuntime` are reused for new, resumed, forked, and reloaded sessions in that process.

Managed skill and extension bundles are materialized atomically under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-config-resources/<resource-sha256>/
```

The directory is private to the current user on POSIX. Before reuse, Pi verifies the exact file set, contents, file types, and permissions against the accepted snapshot. A mismatch fails closed instead of executing locally modified code.

`/reload` reloads the same materialized resources but does not fetch managed configuration again. Restart Pi to apply a newly published snapshot.

The request has a 10-second timeout, follows no redirects, and accepts at most 1 MiB. HTTP response bodies and provider keys are excluded from diagnostics.

## Last-Known-Good Cache

After a successful fetch, Pi atomically writes the validated snapshot to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-config-cache.json
```

On POSIX systems the cache is created with mode `0600`. The cache is versioned, schema-validated, size-limited, and bound to the exact configuration endpoint. A cache created for one URL cannot be used for another URL.

Pi uses a valid last-known-good cache only for availability failures: explicit offline mode, connection failures, timeouts, HTTP 408/425/429, and HTTP 5xx responses. If the endpoint returns an authentication/routing error, invalid JSON, an oversized body, an incomplete snapshot, an invalid schema, or inconsistent references, startup fails immediately instead of hiding the published error behind an older cache. It never falls back to local configuration.

`--offline` or `PI_OFFLINE=1` disables the remote fetch. Managed mode then requires a valid last-known-good cache.

The cache contains provider API keys and must be handled as a secret.

## SDK Usage

Embedding applications can use the same resolver and runtime boundary:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ManagedConfigResolver,
  materializeManagedResources,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const resolver = new ManagedConfigResolver({
  url: process.env.PI_MANAGED_CONFIG_URL!,
  token: process.env.PI_MANAGED_CONFIG_TOKEN,
});
const resolution = await resolver.resolve();
const agentDir = getAgentDir();
const managedResources = await materializeManagedResources(
  resolution.snapshot,
  agentDir,
);
const modelRuntime = await ModelRuntime.create({
  managedConfig: resolution.snapshot,
});
const settingsManager = SettingsManager.createManaged(
  process.cwd(),
  agentDir,
  resolution.snapshot.settings,
);
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  managedSkillPaths: managedResources.skillPaths,
  managedExtensionPaths: managedResources.extensionPaths,
  managedMode: true,
  systemPromptOverride: () => resolution.snapshot.systemPrompt ?? undefined,
  appendSystemPromptOverride: () => [...resolution.snapshot.appendSystemPrompt],
  agentsFilesOverride: () => ({
    agentsFiles: resolution.snapshot.contextFiles.map((file) => ({ ...file })),
  }),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  modelRuntime,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(),
});
```

Resolve and materialize the snapshot once during application bootstrap, then reuse the resulting `ModelRuntime`, managed settings manager, resource policy, and materialized paths for every session that belongs to the process. Pass `cachePath: null` only when the application intentionally does not want last-known-good caching.
