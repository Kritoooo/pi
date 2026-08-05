import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	lazyStream,
	type Model,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { ModelDefinitionSchema, ProviderCompatSchema } from "./model-config.ts";
import { mergeCompat } from "./provider-composer.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_VERSION = 1;

function strictSchema<T extends TSchema>(schema: T): T {
	const clone = structuredClone(schema) as T;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		if (record.type === "object") record.additionalProperties = false;
		for (const child of Object.values(record)) visit(child);
	};
	visit(clone);
	return clone;
}

const ManagedModelSchema = strictSchema(ModelDefinitionSchema);
const ManagedProviderCompatSchema = strictSchema(ProviderCompatSchema);
const ManagedProviderSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String({ minLength: 1 })),
		api: Type.String({ minLength: 1 }),
		baseUrl: Type.String({ minLength: 1 }),
		apiKey: Type.String({ minLength: 1 }),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(ManagedProviderCompatSchema),
		authHeader: Type.Optional(Type.Boolean()),
		models: Type.Array(ManagedModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
const ManagedConfigSchema = Type.Object(
	{
		version: Type.Literal(1),
		providers: Type.Array(ManagedProviderSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
const ManagedConfigCacheSchema = Type.Object(
	{
		cacheVersion: Type.Literal(CACHE_VERSION),
		sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		config: ManagedConfigSchema,
	},
	{ additionalProperties: false },
);

const validateManagedConfig = Compile(ManagedConfigSchema);
const validateManagedConfigCache = Compile(ManagedConfigCacheSchema);

export type ManagedConfigSnapshot = Static<typeof ManagedConfigSchema>;
export type ManagedConfigProvider = Static<typeof ManagedProviderSchema>;

export type ManagedConfigErrorCode =
	| "aborted"
	| "cache"
	| "http"
	| "json"
	| "request"
	| "response_too_large"
	| "schema"
	| "timeout"
	| "unavailable";

export class ManagedConfigError extends Error {
	readonly code: ManagedConfigErrorCode;

	constructor(code: ManagedConfigErrorCode, message: string) {
		super(message);
		this.name = "ManagedConfigError";
		this.code = code;
	}
}

export interface ManagedConfigResolution {
	snapshot: ManagedConfigSnapshot;
	source: "remote" | "cache";
	warning?: string;
}

export interface ManagedConfigResolverOptions {
	url: string;
	token?: string;
	cachePath?: string | null;
	timeoutMs?: number;
	maxResponseBytes?: number;
	fetch?: typeof globalThis.fetch;
}

export interface ResolveManagedConfigOptions {
	allowNetwork?: boolean;
	signal?: AbortSignal;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//u, "").replaceAll("/", ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//u, "").replaceAll("/", ".");
	return path || "root";
}

function validationError(path: string, message: string): ManagedConfigError {
	return new ManagedConfigError("schema", `Invalid managed config at ${path}: ${message}`);
}

function asSentence(message: string): string {
	return /[.!?]$/u.test(message) ? message : `${message}.`;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "[::1]" ||
		normalized === "::1" ||
		/^127(?:\.\d{1,3}){3}$/u.test(normalized)
	);
}

function parseSecureHttpUrl(value: string, path: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw validationError(path, "expected an absolute HTTP(S) URL");
	}
	if (url.username || url.password) {
		throw validationError(path, "embedded URL credentials are not allowed");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
		throw validationError(path, "HTTPS is required except for loopback endpoints");
	}
	return url;
}

function displayUrl(url: URL): string {
	const redacted = new URL(url);
	redacted.username = "";
	redacted.password = "";
	redacted.search = "";
	redacted.hash = "";
	return redacted.toString();
}

function assertIdentifier(value: string, path: string, allowSlash: boolean): void {
	if (value !== value.trim() || /[\u0000-\u001f\u007f\s]/u.test(value)) {
		throw validationError(path, "must not contain whitespace or control characters");
	}
	if (!allowSlash && value.includes("/")) {
		throw validationError(path, "must not contain '/'");
	}
}

function assertPositiveNumber(value: number | undefined, path: string): void {
	if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
		throw validationError(path, "must be greater than zero");
	}
}

function assertHeaders(headers: Record<string, string> | undefined, path: string): void {
	if (!headers) return;
	for (const [name, value] of Object.entries(headers)) {
		if (/[\u0000-\u001f\u007f]/u.test(value)) {
			throw validationError(`${path}.${name}`, "must not contain control characters");
		}
		try {
			new Headers([[name, value]]);
		} catch {
			throw validationError(`${path}.${name}`, "is not a valid HTTP header");
		}
	}
}

function assertSupportedApi(value: string, path: string): void {
	if (!getApiProvider(value as Api)) {
		throw validationError(path, `unsupported API protocol "${value}"`);
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function parseManagedConfig(input: unknown): ManagedConfigSnapshot {
	if (!validateManagedConfig.Check(input)) {
		const first = validateManagedConfig.Errors(input)[0];
		throw first
			? validationError(formatValidationPath(first), first.message)
			: new ManagedConfigError("schema", "Invalid managed config schema");
	}

	const config = input as ManagedConfigSnapshot;
	const providerIds = new Set<string>();
	for (const [providerIndex, provider] of config.providers.entries()) {
		const providerPath = `providers.${providerIndex}`;
		assertIdentifier(provider.id, `${providerPath}.id`, false);
		const normalizedProviderId = provider.id.toLowerCase();
		if (providerIds.has(normalizedProviderId)) {
			throw validationError(`${providerPath}.id`, `duplicate provider id "${provider.id}"`);
		}
		providerIds.add(normalizedProviderId);
		if (provider.name !== undefined && provider.name.trim().length === 0) {
			throw validationError(`${providerPath}.name`, "must not be blank");
		}
		assertSupportedApi(provider.api, `${providerPath}.api`);
		parseSecureHttpUrl(provider.baseUrl, `${providerPath}.baseUrl`);
		if (provider.apiKey.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(provider.apiKey)) {
			throw validationError(`${providerPath}.apiKey`, "must not be blank or contain control characters");
		}
		assertHeaders(provider.headers, `${providerPath}.headers`);

		const modelIds = new Set<string>();
		for (const [modelIndex, model] of provider.models.entries()) {
			const modelPath = `${providerPath}.models.${modelIndex}`;
			assertIdentifier(model.id, `${modelPath}.id`, true);
			const normalizedModelId = model.id.toLowerCase();
			if (modelIds.has(normalizedModelId)) {
				throw validationError(`${modelPath}.id`, `duplicate model id "${model.id}"`);
			}
			modelIds.add(normalizedModelId);
			if (model.name !== undefined && model.name.trim().length === 0) {
				throw validationError(`${modelPath}.name`, "must not be blank");
			}
			if (model.api !== undefined) assertSupportedApi(model.api, `${modelPath}.api`);
			if (model.baseUrl !== undefined) parseSecureHttpUrl(model.baseUrl, `${modelPath}.baseUrl`);
			if (model.input !== undefined && model.input.length === 0) {
				throw validationError(`${modelPath}.input`, "must contain at least one input type");
			}
			assertHeaders(model.headers, `${modelPath}.headers`);
			assertPositiveNumber(model.contextWindow, `${modelPath}.contextWindow`);
			assertPositiveNumber(model.maxTokens, `${modelPath}.maxTokens`);
		}
	}

	return deepFreeze(structuredClone(config));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

export class ManagedConfigResolver {
	private readonly url: URL;
	private readonly token: string | undefined;
	private readonly cachePath: string | undefined;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly sourceHash: string;

	constructor(options: ManagedConfigResolverOptions) {
		this.url = parseSecureHttpUrl(options.url, "managedConfigUrl");
		this.token = options.token;
		this.cachePath =
			options.cachePath === null
				? undefined
				: normalizePath(options.cachePath ?? join(getAgentDir(), "managed-config-cache.json"));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		this.fetchFn = options.fetch ?? globalThis.fetch;
		this.sourceHash = createHash("sha256").update(this.url.toString()).digest("hex");
		if (this.token !== undefined && (this.token.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(this.token))) {
			throw new ManagedConfigError("schema", "Managed config token must not be blank or contain control characters");
		}
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new ManagedConfigError("schema", "Managed config timeout must be a positive integer");
		}
		if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
			throw new ManagedConfigError("schema", "Managed config response limit must be a positive integer");
		}
	}

	async resolve(options: ResolveManagedConfigOptions = {}): Promise<ManagedConfigResolution> {
		let remoteError: ManagedConfigError;
		if (options.allowNetwork === false) {
			remoteError = new ManagedConfigError("request", "Managed config network access is disabled");
		} else {
			try {
				const snapshot = await this.fetchSnapshot(options.signal);
				let warning: string | undefined;
				try {
					await this.writeCache(snapshot);
				} catch {
					warning = "Managed config loaded, but the last-known-good cache could not be updated.";
				}
				return { snapshot, source: "remote", warning };
			} catch (error) {
				if (options.signal?.aborted) {
					throw new ManagedConfigError("aborted", "Managed config resolution was cancelled");
				}
				remoteError =
					error instanceof ManagedConfigError
						? error
						: new ManagedConfigError("request", `Managed config request failed for ${displayUrl(this.url)}`);
			}
		}

		try {
			const snapshot = await this.readCache();
			return {
				snapshot,
				source: "cache",
				warning: `${asSentence(remoteError.message)} Using the last-known-good managed config cache.`,
			};
		} catch (cacheError) {
			const cacheMessage =
				cacheError instanceof ManagedConfigError
					? cacheError.message
					: "No valid managed config cache is available.";
			throw new ManagedConfigError("unavailable", `${asSentence(remoteError.message)} ${cacheMessage}`);
		}
	}

	private async fetchSnapshot(callerSignal?: AbortSignal): Promise<ManagedConfigSnapshot> {
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		const headers: Record<string, string> = { accept: "application/json", "cache-control": "no-cache" };
		if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;

		let response: Response;
		try {
			response = await this.fetchFn(this.url, {
				method: "GET",
				headers,
				redirect: "error",
				signal,
			});
		} catch {
			if (callerSignal?.aborted) {
				throw new ManagedConfigError("aborted", "Managed config request was cancelled");
			}
			if (timeoutSignal.aborted) {
				throw new ManagedConfigError(
					"timeout",
					`Managed config request timed out after ${this.timeoutMs}ms for ${displayUrl(this.url)}`,
				);
			}
			throw new ManagedConfigError("request", `Managed config request failed for ${displayUrl(this.url)}`);
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new ManagedConfigError(
				"http",
				`Managed config request returned HTTP ${response.status} for ${displayUrl(this.url)}`,
			);
		}

		let body: string;
		try {
			body = await this.readResponseBody(response);
		} catch (error) {
			if (error instanceof ManagedConfigError) throw error;
			if (callerSignal?.aborted) {
				throw new ManagedConfigError("aborted", "Managed config request was cancelled");
			}
			if (timeoutSignal.aborted) {
				throw new ManagedConfigError(
					"timeout",
					`Managed config request timed out after ${this.timeoutMs}ms for ${displayUrl(this.url)}`,
				);
			}
			throw new ManagedConfigError("request", `Managed config response failed for ${displayUrl(this.url)}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new ManagedConfigError("json", `Managed config response is not valid JSON for ${displayUrl(this.url)}`);
		}
		return parseManagedConfig(parsed);
	}

	private async readResponseBody(response: Response): Promise<string> {
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null) {
			const declaredBytes = Number(contentLength);
			if (Number.isFinite(declaredBytes) && declaredBytes > this.maxResponseBytes) {
				await response.body?.cancel().catch(() => {});
				throw new ManagedConfigError(
					"response_too_large",
					`Managed config response exceeds the ${this.maxResponseBytes}-byte limit`,
				);
			}
		}
		if (!response.body) return "";

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > this.maxResponseBytes) {
					await reader.cancel();
					throw new ManagedConfigError(
						"response_too_large",
						`Managed config response exceeds the ${this.maxResponseBytes}-byte limit`,
					);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks, totalBytes).toString("utf8");
	}

	private async readCache(): Promise<ManagedConfigSnapshot> {
		if (!this.cachePath) {
			throw new ManagedConfigError("cache", "Managed config caching is disabled.");
		}

		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(this.cachePath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				throw new ManagedConfigError("cache", "No managed config cache is available.");
			}
			throw new ManagedConfigError("cache", "The managed config cache could not be read.");
		}
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new ManagedConfigError("cache", "The managed config cache is not a regular file.");
		}
		if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
			throw new ManagedConfigError("cache", "The managed config cache permissions are not private.");
		}
		if (stats.size > this.maxResponseBytes + 4096) {
			throw new ManagedConfigError("cache", "The managed config cache exceeds the allowed size.");
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
		} catch {
			throw new ManagedConfigError("cache", "The managed config cache is not valid JSON.");
		}
		if (!validateManagedConfigCache.Check(parsed)) {
			throw new ManagedConfigError("cache", "The managed config cache schema is invalid.");
		}
		const cache = parsed as Static<typeof ManagedConfigCacheSchema>;
		if (cache.sourceHash !== this.sourceHash) {
			throw new ManagedConfigError("cache", "The managed config cache belongs to a different endpoint.");
		}
		return parseManagedConfig(cache.config);
	}

	private async writeCache(snapshot: ManagedConfigSnapshot): Promise<void> {
		if (!this.cachePath) return;
		const directory = dirname(this.cachePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const tempPath = join(directory, `.${randomUUID()}.managed-config.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(tempPath, "wx", 0o600);
			await handle.writeFile(
				`${JSON.stringify({ cacheVersion: CACHE_VERSION, sourceHash: this.sourceHash, config: snapshot })}\n`,
				"utf8",
			);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(tempPath, this.cachePath);
			await chmod(this.cachePath, 0o600);
		} finally {
			await handle?.close().catch(() => {});
			await unlink(tempPath).catch(() => {});
		}
	}
}

type ApiImplementation = NonNullable<ReturnType<typeof getApiProvider>>;

function managedModels(provider: ManagedConfigProvider): readonly Model<Api>[] {
	return provider.models.map((definition) =>
		deepFreeze({
			id: definition.id,
			name: definition.name ?? definition.id,
			api: (definition.api ?? provider.api) as Api,
			provider: provider.id,
			baseUrl: definition.baseUrl ?? provider.baseUrl,
			reasoning: definition.reasoning ?? false,
			thinkingLevelMap: definition.thinkingLevelMap,
			input: [...(definition.input ?? ["text"])],
			cost: structuredClone(definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			contextWindow: definition.contextWindow ?? 128000,
			maxTokens: definition.maxTokens ?? 16384,
			samplingParams: definition.samplingParams ? structuredClone(definition.samplingParams) : undefined,
			headers: definition.headers ? { ...definition.headers } : undefined,
			compat: mergeCompat(provider.compat, definition.compat),
		}),
	);
}

function managedAuthHeaders(provider: ManagedConfigProvider): ProviderHeaders | undefined {
	if (!provider.headers && !provider.authHeader) return undefined;
	const headers: ProviderHeaders = { ...provider.headers };
	if (provider.authHeader) headers.Authorization = `Bearer ${provider.apiKey}`;
	return deepFreeze(headers);
}

function createManagedProvider(provider: ManagedConfigProvider): Provider {
	const models = deepFreeze([...managedModels(provider)]);
	const implementations = new Map<Api, ApiImplementation>();
	for (const model of models) {
		const implementation = getApiProvider(model.api);
		if (!implementation) {
			throw new ManagedConfigError("schema", `Unsupported managed config API protocol "${model.api}"`);
		}
		implementations.set(model.api, implementation);
	}
	const headers = managedAuthHeaders(provider);
	const streamWith = (
		model: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			const implementation = implementations.get(model.api);
			if (!implementation) throw new Error(`No managed API implementation for protocol: ${model.api}`);
			return simple
				? implementation.streamSimple(model, context, options as SimpleStreamOptions)
				: implementation.stream(model, context, options);
		});

	return deepFreeze({
		id: provider.id,
		name: provider.name ?? provider.id,
		baseUrl: provider.baseUrl,
		headers: provider.headers ? { ...provider.headers } : undefined,
		auth: {
			apiKey: {
				name: "Managed API key",
				check: async ({ signal }) => {
					signal.throwIfAborted();
					return { type: "api_key" as const, source: "managed config" };
				},
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return {
						auth: { apiKey: provider.apiKey, headers },
						source: "managed config",
					};
				},
			},
		},
		getModels: () => models,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	} satisfies Provider);
}

export function createManagedProviders(snapshot: ManagedConfigSnapshot): readonly Provider[] {
	const config = parseManagedConfig(snapshot);
	return deepFreeze(config.providers.map((provider) => createManagedProvider(provider)));
}
