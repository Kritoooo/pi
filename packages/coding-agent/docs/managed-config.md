# Managed Configuration

Managed configuration lets an administrator provide Pi's complete provider and model catalog from an HTTP endpoint. It is an explicit startup mode of the normal `pi` command, not a separate command or distribution.

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
| Other extension capabilities | Enabled | Enabled |
| Provider and model source | Local composition | Remote snapshot only |
| Provider API key source | Local auth sources | Remote snapshot only |

Managed mode never supplements a remote provider with local values and never falls back to local providers. `--api-key`, provider login/logout, and runtime credential changes are unavailable in this mode.

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
  ]
}
```

Each provider requires:

- A unique `id`.
- A Pi-supported `api` protocol.
- An absolute `baseUrl`.
- A non-empty literal `apiKey`.
- A non-empty, complete `models` array.

Provider entries may also set `name`, `headers`, `compat`, and `authHeader`. Model entries reuse the fields supported by [`models.json`](models.md), including `api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`, `samplingParams`, `headers`, and `compat`.

The document is a complete snapshot. Patches, inheritance, deletion markers, unknown fields, duplicate case-insensitive IDs, and references to local credentials are rejected. An `apiKey` such as `"$SOME_ENV_VAR"` is used literally and is not expanded from the process environment.

Configuration and provider URLs must use HTTPS. Loopback HTTP URLs such as `http://127.0.0.1:8080` are accepted for local development and testing. Embedded URL credentials and invalid header values are rejected.

## Startup and Reload Behavior

The Pi CLI resolves managed configuration once during process startup, before selecting a model or creating a session. The same immutable snapshot and `ModelRuntime` are reused for new, resumed, forked, and reloaded sessions in that process.

`/reload` reloads normal resources but does not fetch managed configuration again. Restart Pi to apply a newly published snapshot.

The request has a 10-second timeout, follows no redirects, and accepts at most 1 MiB. HTTP response bodies and provider keys are excluded from diagnostics.

## Last-Known-Good Cache

After a successful fetch, Pi atomically writes the validated snapshot to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/managed-config-cache.json
```

On POSIX systems the cache is created with mode `0600`. The cache is versioned, schema-validated, size-limited, and bound to the exact configuration endpoint. A cache created for one URL cannot be used for another URL.

If the remote request or response is invalid, Pi may start from that endpoint's valid last-known-good cache and prints a warning. If no valid cache exists, startup fails. It never falls back to built-in providers, `models.json`, `auth.json`, or provider credential environment variables.

`--offline` or `PI_OFFLINE=1` disables the remote fetch. Managed mode then requires a valid last-known-good cache.

The cache contains provider API keys and must be handled as a secret.

## SDK Usage

Embedding applications can use the same resolver and runtime boundary:

```typescript
import {
  createAgentSession,
  ManagedConfigResolver,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const resolver = new ManagedConfigResolver({
  url: process.env.PI_MANAGED_CONFIG_URL!,
  token: process.env.PI_MANAGED_CONFIG_TOKEN,
});
const resolution = await resolver.resolve();
const modelRuntime = await ModelRuntime.create({
  managedConfig: resolution.snapshot,
});

const { session } = await createAgentSession({
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});
```

Resolve the snapshot once during application bootstrap and reuse the resulting `ModelRuntime` for every session that belongs to the process. Pass `cachePath: null` only when the application intentionally does not want last-known-good caching.
