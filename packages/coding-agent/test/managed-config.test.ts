import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { ManagedConfigError, ManagedConfigResolver, parseManagedConfig } from "../src/core/managed-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const REMOTE_KEY = "$REMOTE_LITERAL_KEY";
const MANAGED_URL = "https://config.example.test/pi";
const tempDirs: string[] = [];

function managedConfig(apiKey = REMOTE_KEY) {
	return {
		version: 1 as const,
		settings: {},
		systemPrompt: null,
		appendSystemPrompt: [],
		contextFiles: [],
		skills: [],
		extensions: [],
		providers: [
			{
				id: "managed-provider",
				name: "Managed Provider",
				api: "openai-responses",
				baseUrl: "https://managed.example.test/v1",
				apiKey,
				authHeader: true,
				headers: { "x-managed": "remote" },
				models: [
					{
						id: "managed-model",
						name: "Managed Model",
						reasoning: true,
						input: ["text", "image"] as Array<"text" | "image">,
						cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
						contextWindow: 128_000,
						maxTokens: 16_384,
						headers: { "x-model": "managed-model" },
					},
				],
			},
		],
	};
}

async function makeTempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function responseFetch(body: string, status = 200): typeof globalThis.fetch {
	return async () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function captureResolutionError(resolver: ManagedConfigResolver): Promise<ManagedConfigError> {
	try {
		await resolver.resolve();
		throw new Error("Expected managed config resolution to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(ManagedConfigError);
		return error as ManagedConfigError;
	}
}

function doneStream(model: Model<Api>): ReturnType<typeof createAssistantMessageEventStream> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "managed ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

afterEach(async () => {
	resetApiProviders();
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("managed config validation", () => {
	it("requires a complete authoritative snapshot", () => {
		for (const field of [
			"settings",
			"systemPrompt",
			"appendSystemPrompt",
			"contextFiles",
			"skills",
			"extensions",
		] as const) {
			const config: Record<string, unknown> = { ...managedConfig() };
			delete config[field];
			expect(() => parseManagedConfig(config)).toThrow(`Invalid managed config at ${field}`);
		}
	});

	it("accepts a supported, immutable version 1 snapshot without expanding key placeholders", () => {
		const snapshot = parseManagedConfig(managedConfig());

		expect(snapshot.providers[0]?.apiKey).toBe(REMOTE_KEY);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.providers[0]?.models[0])).toBe(true);
		expect(() => parseManagedConfig({ ...managedConfig(), unexpected: true })).toThrow(
			"Invalid managed config at root",
		);
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				providers: [{ ...managedConfig().providers[0], unexpected: true }],
			}),
		).toThrow("Invalid managed config at providers.0");
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				providers: [
					{
						...managedConfig().providers[0],
						models: [{ ...managedConfig().providers[0]!.models[0], unexpected: true }],
					},
				],
			}),
		).toThrow("Invalid managed config at providers.0.models.0");
	});

	it("accepts managed runtime settings, prompts, and context files", () => {
		const snapshot = parseManagedConfig({
			...managedConfig(),
			settings: {
				defaultProvider: "managed-provider",
				defaultModel: "managed-model",
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "managed-provider/managed-model": "xhigh" },
				defaultTools: ["read", "bash"],
				enabledModels: [],
				compaction: { enabled: false, reserveTokens: 4096 },
			},
			systemPrompt: "Remote system prompt",
			appendSystemPrompt: ["Remote append"],
			contextFiles: [{ path: "remote/AGENTS.md", content: "Remote instructions" }],
		});

		expect(snapshot.settings.defaultModel).toBe("managed-model");
		expect(snapshot.settings.modelThinkingLevels).toEqual({ "managed-provider/managed-model": "xhigh" });
		expect(snapshot.settings.enabledModels).toEqual([]);
		expect(snapshot.systemPrompt).toBe("Remote system prompt");
		expect(snapshot.appendSystemPrompt).toEqual(["Remote append"]);
		expect(snapshot.contextFiles).toEqual([{ path: "remote/AGENTS.md", content: "Remote instructions" }]);
		expect(Object.isFrozen(snapshot.settings)).toBe(true);
		expect(Object.isFrozen(snapshot.contextFiles?.[0])).toBe(true);
	});

	it("rejects settings that reference missing managed providers or models", () => {
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { defaultProvider: "managed-provider" },
			}),
		).toThrow("settings.defaultModel");
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { defaultProvider: "missing", defaultModel: "managed-model" },
			}),
		).toThrow('unknown managed provider "missing"');
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { defaultProvider: "managed-provider", defaultModel: "missing" },
			}),
		).toThrow('unknown managed model "managed-provider/missing"');
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { modelThinkingLevels: { "managed-provider/missing": "high" } },
			}),
		).toThrow('unknown managed model "managed-provider/missing"');
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { enabledModels: ["missing-model"] },
			}),
		).toThrow('No models match pattern "missing-model"');
	});

	it("keeps Project Trust out of the remotely controlled settings", () => {
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				settings: { defaultProjectTrust: "always" },
			}),
		).toThrow("Invalid managed config at settings");
	});

	it("rejects duplicate or unsafe managed context file paths", () => {
		const base = managedConfig();
		expect(() =>
			parseManagedConfig({
				...base,
				contextFiles: [
					{ path: "AGENTS.md", content: "one" },
					{ path: "AGENTS.md", content: "two" },
				],
			}),
		).toThrow("duplicate context file path");
		expect(() =>
			parseManagedConfig({
				...base,
				contextFiles: [{ path: "bad\npath", content: "unsafe" }],
			}),
		).toThrow("must not be blank or contain control characters");
	});

	it("injects literal remote prompt and context content without reading remote paths locally", async () => {
		const directory = await makeTempDir("pi-managed-resources-");
		await writeFile(join(directory, "AGENTS.md"), "local instructions");
		await writeFile(join(directory, "SYSTEM.md"), "local system prompt");
		await writeFile(join(directory, "APPEND_SYSTEM.md"), "local append prompt");
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory(),
			managedMode: true,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: () => "remote system prompt",
			appendSystemPromptOverride: () => ["remote append"],
			agentsFilesOverride: () => ({
				agentsFiles: [{ path: "remote/AGENTS.md", content: "remote instructions" }],
			}),
		});

		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("remote system prompt");
		expect(loader.getAppendSystemPrompt()).toEqual(["remote append"]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{ path: "remote/AGENTS.md", content: "remote instructions" },
		]);
	});

	it("uses remote settings without loading local managed fields", async () => {
		vi.stubEnv("PI_CLEAR_ON_SHRINK", "1");
		vi.stubEnv("PI_HARDWARE_CURSOR", "1");
		const root = await makeTempDir("pi-managed-settings-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "local-provider",
				defaultModel: "local-model",
				theme: "local-theme",
				quietStartup: true,
				extensions: ["local-extension.ts"],
				externalEditor: "local-editor",
				sessionDir: "local-sessions",
				defaultProjectTrust: "never",
			}),
		);
		await writeFile(
			join(cwd, ".pi/settings.json"),
			JSON.stringify({ defaultProvider: "project-provider", theme: "project-theme" }),
		);

		const settings = SettingsManager.createManaged(
			cwd,
			agentDir,
			{
				defaultProvider: "managed-provider",
				defaultModel: "managed-model",
				theme: "managed-theme",
			},
			{ projectTrusted: true },
		);

		expect(settings.isManagedMode()).toBe(true);
		expect(settings.getDefaultProvider()).toBe("managed-provider");
		expect(settings.getDefaultModel()).toBe("managed-model");
		expect(settings.getTheme()).toBe("managed-theme");
		expect(settings.getQuietStartup()).toBe(false);
		expect(settings.getExtensionPaths()).toEqual([]);
		expect(settings.getExternalEditorCommand()).toBe("local-editor");
		expect(settings.getSessionDir()).toBe("local-sessions");
		expect(settings.getDefaultProjectTrust()).toBe("never");
		expect(settings.getProjectSettings()).toEqual({});
		expect(settings.getClearOnShrink()).toBe(false);
		expect(settings.getShowHardwareCursor()).toBe(false);
		settings.setTheme("local-edit");
		settings.setProjectThemePaths(["project-edit.json"]);
		await settings.flush();
		expect(settings.getTheme()).toBe("managed-theme");
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).theme).toBe("local-theme");
		expect(JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8")).themes).toBeUndefined();

		await settings.reload();
		expect(settings.getDefaultProvider()).toBe("managed-provider");
		expect(settings.getTheme()).toBe("managed-theme");
		expect(settings.getExtensionPaths()).toEqual([]);
	});

	it("rejects ambiguous identifiers and unsafe provider settings", () => {
		const provider = managedConfig().providers[0]!;
		expect(() =>
			parseManagedConfig({ ...managedConfig(), providers: [provider, { ...provider, id: "MANAGED-PROVIDER" }] }),
		).toThrow("duplicate provider id");
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				providers: [{ ...provider, models: [provider.models[0], { ...provider.models[0], id: "MANAGED-MODEL" }] }],
			}),
		).toThrow("duplicate model id");
		expect(() =>
			parseManagedConfig({ ...managedConfig(), providers: [{ ...provider, api: "unsupported" }] }),
		).toThrow("unsupported API protocol");
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				providers: [{ ...provider, baseUrl: "http://models.example.test/v1" }],
			}),
		).toThrow("HTTPS is required");
		expect(() => parseManagedConfig({ ...managedConfig(), providers: [{ ...provider, apiKey: " \n" }] })).toThrow(
			"must not be blank",
		);
		expect(() =>
			parseManagedConfig({
				...managedConfig(),
				providers: [{ ...provider, headers: { authorization: "bad\rvalue" } }],
			}),
		).toThrow("control characters");

		expect(
			parseManagedConfig({ ...managedConfig(), providers: [{ ...provider, baseUrl: "http://127.0.0.1:8080/v1" }] }),
		).toBeDefined();
	});
});

describe("ManagedConfigResolver", () => {
	it("fetches once with bootstrap authentication and writes a private endpoint-bound cache", async () => {
		const directory = await makeTempDir("pi-managed-resolver-");
		const cachePath = join(directory, "cache.json");
		let calls = 0;
		const fetchFn: typeof globalThis.fetch = async (input, init) => {
			calls++;
			expect(String(input)).toBe(MANAGED_URL);
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer bootstrap-token");
			expect(headers.get("cache-control")).toBe("no-cache");
			return new Response(JSON.stringify(managedConfig()));
		};
		const resolver = new ManagedConfigResolver({
			url: MANAGED_URL,
			token: "bootstrap-token",
			cachePath,
			fetch: fetchFn,
		});

		const result = await resolver.resolve();

		expect(calls).toBe(1);
		expect(result.source).toBe("remote");
		expect(result.snapshot.providers[0]?.apiKey).toBe(REMOTE_KEY);
		const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
		expect(cache.cacheVersion).toBe(1);
		expect(cache.sourceHash).toMatch(/^[0-9a-f]{64}$/u);
		if (process.platform !== "win32") expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
	});

	it("falls back only to a valid last-known-good cache for the same endpoint", async () => {
		const directory = await makeTempDir("pi-managed-cache-");
		const cachePath = join(directory, "cache.json");
		await new ManagedConfigResolver({
			url: MANAGED_URL,
			cachePath,
			fetch: responseFetch(JSON.stringify(managedConfig())),
		}).resolve();

		const cached = await new ManagedConfigResolver({
			url: MANAGED_URL,
			cachePath,
			fetch: async () => {
				throw new Error("remote down with secret-value");
			},
		}).resolve();
		expect(cached.source).toBe("cache");
		expect(cached.warning).toContain("last-known-good");
		expect(cached.warning).not.toContain("secret-value");

		const offline = await new ManagedConfigResolver({ url: MANAGED_URL, cachePath }).resolve({ allowNetwork: false });
		expect(offline.source).toBe("cache");

		const wrongEndpoint = new ManagedConfigResolver({
			url: "https://other.example.test/pi",
			cachePath,
		});
		await expect(wrongEndpoint.resolve({ allowNetwork: false })).rejects.toThrow("different endpoint");

		if (process.platform !== "win32") {
			await chmod(cachePath, 0o644);
			await expect(offlineResolver(cachePath).resolve({ allowNetwork: false })).rejects.toThrow(
				"permissions are not private",
			);
		}
	});

	it("does not hide an invalid remote response behind the last-known-good cache", async () => {
		const directory = await makeTempDir("pi-managed-invalid-remote-");
		const cachePath = join(directory, "cache.json");
		await new ManagedConfigResolver({
			url: MANAGED_URL,
			cachePath,
			fetch: responseFetch(JSON.stringify(managedConfig())),
		}).resolve();

		const incomplete = { ...managedConfig() } as Record<string, unknown>;
		delete incomplete.skills;
		await expect(
			new ManagedConfigResolver({
				url: MANAGED_URL,
				cachePath,
				fetch: responseFetch(JSON.stringify(incomplete)),
			}).resolve(),
		).rejects.toThrow("Invalid managed config at skills");
		await expect(
			new ManagedConfigResolver({
				url: MANAGED_URL,
				cachePath,
				fetch: responseFetch("{invalid"),
			}).resolve(),
		).rejects.toThrow("not valid JSON");
		await expect(
			new ManagedConfigResolver({
				url: MANAGED_URL,
				cachePath,
				fetch: responseFetch("unauthorized", 401),
			}).resolve(),
		).rejects.toThrow("HTTP 401");
	});

	it("bounds responses, times out requests, and never includes response secrets in diagnostics", async () => {
		const secret = "response-secret-value";
		const failures = [
			new ManagedConfigResolver({ url: MANAGED_URL, cachePath: null, fetch: responseFetch(secret, 503) }),
			new ManagedConfigResolver({ url: MANAGED_URL, cachePath: null, fetch: responseFetch(`{${secret}`) }),
			new ManagedConfigResolver({
				url: MANAGED_URL,
				cachePath: null,
				maxResponseBytes: 8,
				fetch: responseFetch("0123456789"),
			}),
			new ManagedConfigResolver({
				url: MANAGED_URL,
				cachePath: null,
				timeoutMs: 5,
				fetch: async (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			}),
		];

		const errors = await Promise.all(failures.map(captureResolutionError));
		expect(errors.map((error) => error.message).join("\n")).not.toContain(secret);
		expect(errors[0]?.message).toContain("HTTP 503");
		expect(errors[1]?.message).toContain("not valid JSON");
		expect(errors[2]?.message).toContain("8-byte limit");
		expect(errors[3]?.message).toContain("timed out");
	});
});

function offlineResolver(cachePath: string): ManagedConfigResolver {
	return new ManagedConfigResolver({ url: MANAGED_URL, cachePath });
}

describe("managed ModelRuntime", () => {
	it("uses only the remote provider, literal credentials, and captured protocol implementation", async () => {
		const directory = await makeTempDir("pi-managed-runtime-");
		const localModelsPath = join(directory, "models.json");
		await writeFile(
			localModelsPath,
			JSON.stringify({
				providers: {
					"local-only": {
						api: "openai-responses",
						baseUrl: "https://local.example.test/v1",
						apiKey: "local-key",
						models: [{ id: "local-model" }],
					},
				},
			}),
		);
		const localCredentials = new InMemoryCredentialStore();
		await localCredentials.modify("managed-provider", async () => ({ type: "api_key", key: "stored-local-key" }));

		let captured:
			| {
					apiKey: string | undefined;
					baseUrl: string;
					env: Record<string, string> | undefined;
					headers: ProviderHeaders | undefined;
					modelHeaders: ProviderHeaders | undefined;
			  }
			| undefined;
		const capture = (model: Model<Api>, options: StreamOptions | SimpleStreamOptions | undefined) => {
			captured = {
				apiKey: options?.apiKey,
				baseUrl: model.baseUrl,
				env: options?.env,
				headers: options?.headers,
				modelHeaders: model.headers,
			};
			return doneStream(model);
		};
		registerApiProvider({
			api: "openai-responses",
			stream: (model, _context, options) => capture(model, options),
			streamSimple: (model, _context, options) => capture(model, options),
		});

		const runtime = await ModelRuntime.create({
			managedConfig: parseManagedConfig(managedConfig()),
			credentials: localCredentials,
			modelsPath: localModelsPath,
			allowModelNetwork: true,
		});
		resetApiProviders();

		expect(runtime.isManaged()).toBe(true);
		expect(runtime.getProviders().map((provider) => provider.id)).toEqual(["managed-provider"]);
		expect(runtime.getModels().map((model) => `${model.provider}/${model.id}`)).toEqual([
			"managed-provider/managed-model",
		]);
		expect(runtime.getModel("local-only", "local-model")).toBeUndefined();
		expect(await runtime.listCredentials()).toEqual([]);
		expect(runtime.getProviderAuthStatus("managed-provider")).toEqual({ configured: true, source: "managed" });
		expect(
			(
				await runtime.getAuth("managed-provider", {
					apiKey: "request-local-key",
					env: { REMOTE_LITERAL_KEY: "expanded-local-key" },
				})
			)?.auth.apiKey,
		).toBe(REMOTE_KEY);

		const model = runtime.getModel("managed-provider", "managed-model");
		expect(model).toBeDefined();
		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				apiKey: "request-local-key",
				env: { REMOTE_LITERAL_KEY: "expanded-local-key" },
				headers: { Authorization: "Bearer request-local-key", "x-explicit": "kept" },
				transformHeaders: (headers) => ({
					...headers,
					Authorization: "Bearer transformed-local-key",
					"x-managed": "transformed-local-value",
				}),
			},
		);

		expect(captured).toEqual({
			apiKey: REMOTE_KEY,
			baseUrl: "https://managed.example.test/v1",
			env: undefined,
			headers: {
				Authorization: `Bearer ${REMOTE_KEY}`,
				"x-managed": "remote",
				"x-model": "managed-model",
				"x-explicit": "kept",
			},
			modelHeaders: { "x-model": "managed-model" },
		});

		await runtime.refresh({ allowNetwork: true });
		expect(runtime.getProviders().map((provider) => provider.id)).toEqual(["managed-provider"]);
		await expect(runtime.setRuntimeApiKey("managed-provider", "new-key")).rejects.toThrow("managed mode");
		await expect(runtime.removeRuntimeApiKey("managed-provider")).rejects.toThrow("managed mode");
		await expect(
			runtime.login("managed-provider", "api_key", { prompt: async () => "new-key", notify: () => {} }),
		).rejects.toThrow("managed mode");
		await expect(runtime.logout("managed-provider")).rejects.toThrow("managed mode");
		expect(() => runtime.registerProvider("injected", { baseUrl: "https://injected.example.test/v1" })).toThrow(
			"managed mode",
		);
		expect(() => runtime.registerNativeProvider(runtime.getProvider("managed-provider")!)).toThrow("managed mode");
		expect(() => runtime.unregisterProvider("managed-provider")).toThrow("managed mode");
	});

	it("keeps non-provider extensions while ignoring queued provider registrations", async () => {
		const directory = await makeTempDir("pi-managed-extensions-");
		const runtime = await ModelRuntime.create({ managedConfig: parseManagedConfig(managedConfig()) });
		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			resourceLoaderOptions: {
				managedMode: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.registerProvider("injected-provider", {
							api: "openai-responses",
							baseUrl: "https://injected.example.test/v1",
							apiKey: "injected-key",
							models: [
								{
									id: "injected-model",
									name: "Injected Model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 4096,
									maxTokens: 1024,
								},
							],
						});
						pi.registerCommand("managed-command", { description: "Still loaded", handler: async () => {} });
					},
				],
			},
		});

		expect(runtime.getProvider("injected-provider")).toBeUndefined();
		expect(runtime.getProviders().map((provider) => provider.id)).toEqual(["managed-provider"]);
		expect(services.diagnostics).toEqual([
			expect.objectContaining({ type: "warning", message: expect.stringContaining("ignored in managed mode") }),
		]);
		expect(
			services.resourceLoader
				.getExtensions()
				.extensions.some((extension) => extension.commands.has("managed-command")),
		).toBe(true);
	});
});
