import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { parseManagedConfig } from "../src/core/managed-config.ts";
import { materializeManagedResources } from "../src/core/managed-resources.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function managedConfig(resources: Record<string, unknown> = {}) {
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
				api: "openai-responses",
				baseUrl: "https://managed.example.test/v1",
				apiKey: "managed-key",
				models: [
					{
						id: "managed-model",
						name: "Managed Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 1024,
					},
				],
			},
		],
		...resources,
	};
}

function skillContent(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\nManaged skill instructions.`;
}

async function makeTempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

async function writeSkill(path: string, name: string, description: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, skillContent(name, description));
}

async function writeCommandExtension(path: string, commandName: string, description: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`export default function (pi) {
	pi.registerCommand("${commandName}", { description: "${description}", handler: async () => {} });
}
`,
	);
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("managed resource validation", () => {
	it("accepts immutable skill and extension bundles in a version 1 snapshot", () => {
		const snapshot = parseManagedConfig(
			managedConfig({
				settings: { enableSkillCommands: false },
				skills: [
					{
						name: "managed-skill",
						files: [
							{ path: "SKILL.md", content: skillContent("managed-skill", "Managed skill") },
							{ path: "scripts/run.sh", content: "#!/bin/sh\necho managed\n", executable: true },
						],
					},
				],
				extensions: [
					{
						name: "managed-extension",
						entry: "src/index.ts",
						files: [
							{ path: "src/index.ts", content: "export default function () {}" },
							{ path: "src/helper.ts", content: 'export const value = "managed";' },
						],
					},
				],
			}),
		);

		expect(snapshot.settings.enableSkillCommands).toBe(false);
		expect(snapshot.skills[0]?.files[1]?.executable).toBe(true);
		expect(snapshot.extensions[0]?.entry).toBe("src/index.ts");
		expect(Object.isFrozen(snapshot.skills[0]?.files)).toBe(true);
		expect(Object.isFrozen(snapshot.extensions[0])).toBe(true);
	});

	it("rejects unsafe, ambiguous, or incomplete bundles", () => {
		const validSkill = {
			name: "managed-skill",
			files: [{ path: "SKILL.md", content: skillContent("managed-skill", "Managed skill") }],
		};
		const validExtension = {
			name: "managed-extension",
			entry: "index.ts",
			files: [{ path: "index.ts", content: "export default function () {}" }],
		};

		expect(() =>
			parseManagedConfig(
				managedConfig({ skills: [{ ...validSkill, files: [{ path: "../SKILL.md", content: "unsafe" }] }] }),
			),
		).toThrow("must not contain empty, '.' or '..' segments");
		expect(() =>
			parseManagedConfig(
				managedConfig({
					extensions: [
						{
							...validExtension,
							files: [
								{ path: "index.ts", content: "one" },
								{ path: "INDEX.ts", content: "two" },
							],
						},
					],
				}),
			),
		).toThrow("duplicates managed resource path");
		expect(() =>
			parseManagedConfig(
				managedConfig({
					extensions: [
						{
							...validExtension,
							entry: "src/index.ts",
							files: [
								{ path: "src", content: "file" },
								{ path: "src/index.ts", content: "nested" },
							],
						},
					],
				}),
			),
		).toThrow("conflicts with managed resource path");
		expect(() =>
			parseManagedConfig(
				managedConfig({ skills: [{ ...validSkill, files: [{ path: "README.md", content: "none" }] }] }),
			),
		).toThrow('must contain a root "SKILL.md" file');
		expect(() =>
			parseManagedConfig(
				managedConfig({
					skills: [
						{
							...validSkill,
							files: [{ path: "SKILL.md", content: skillContent("other-skill", "Wrong name") }],
						},
					],
				}),
			),
		).toThrow("name must match the bundle name");
		expect(() =>
			parseManagedConfig(managedConfig({ extensions: [{ ...validExtension, entry: "missing.ts" }] })),
		).toThrow("must identify a file in the extension bundle");
		expect(() =>
			parseManagedConfig(
				managedConfig({
					extensions: [{ ...validExtension, entry: "index.json", files: [{ path: "index.json", content: "{}" }] }],
				}),
			),
		).toThrow('must end with ".ts" or ".js"');
	});
});

describe("managed resource materialization", () => {
	it("writes and reuses a private content-addressed snapshot", async () => {
		const agentDir = await makeTempDir("pi-managed-materialized-");
		const snapshot = parseManagedConfig(
			managedConfig({
				skills: [
					{
						name: "managed-skill",
						files: [
							{ path: "SKILL.md", content: skillContent("managed-skill", "Managed skill") },
							{ path: "scripts/run.sh", content: "#!/bin/sh\necho managed\n", executable: true },
						],
					},
				],
				extensions: [
					{
						name: "managed-extension",
						entry: "index.ts",
						files: [{ path: "index.ts", content: "export default function () {}" }],
					},
				],
			}),
		);

		const first = await materializeManagedResources(snapshot, agentDir);
		const second = await materializeManagedResources(snapshot, agentDir);

		expect(second).toEqual(first);
		expect(first.rootPath).toContain(join(agentDir, "managed-config-resources"));
		expect(await readFile(first.skillPaths[0]!, "utf8")).toContain("Managed skill instructions");
		expect(await readFile(first.extensionPaths[0]!, "utf8")).toContain("export default");
		if (process.platform !== "win32") {
			expect((await stat(first.rootPath!)).mode & 0o777).toBe(0o700);
			expect((await stat(first.skillPaths[0]!)).mode & 0o777).toBe(0o600);
			expect((await stat(join(dirname(first.skillPaths[0]!), "scripts/run.sh"))).mode & 0o777).toBe(0o700);
		}
	});

	it("fails closed when a materialized snapshot is modified", async () => {
		const agentDir = await makeTempDir("pi-managed-tamper-");
		const snapshot = parseManagedConfig(
			managedConfig({
				skills: [
					{
						name: "managed-skill",
						files: [{ path: "SKILL.md", content: skillContent("managed-skill", "Managed skill") }],
					},
				],
			}),
		);
		const materialized = await materializeManagedResources(snapshot, agentDir);
		await chmod(materialized.skillPaths[0]!, 0o600);
		await writeFile(materialized.skillPaths[0]!, "tampered");

		await expect(materializeManagedResources(snapshot, agentDir)).rejects.toThrow(
			"content does not match the accepted config",
		);
	});
});

describe("managed resource loading", () => {
	it("replaces local skills and extensions while keeping explicit CLI paths first", async () => {
		const root = await makeTempDir("pi-managed-loader-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await writeSkill(join(agentDir, "skills/local-skill/SKILL.md"), "local-skill", "Local skill");
		await writeCommandExtension(join(agentDir, "extensions/local.ts"), "local-command", "Local command");

		const explicitSkillPath = join(root, "explicit-skill/SKILL.md");
		const explicitExtensionPath = join(root, "explicit-extension.ts");
		await writeSkill(explicitSkillPath, "explicit-skill", "Explicit skill");
		await writeCommandExtension(explicitExtensionPath, "explicit-command", "Explicit command");

		const snapshot = parseManagedConfig(
			managedConfig({
				skills: [
					{
						name: "managed-skill",
						files: [{ path: "SKILL.md", content: skillContent("managed-skill", "Managed skill") }],
					},
				],
				extensions: [
					{
						name: "managed-extension",
						entry: "index.ts",
						files: [
							{
								path: "index.ts",
								content:
									'import { description } from "./helper.ts";\nexport default function (pi) { pi.registerCommand("managed-command", { description, handler: async () => {} }); }',
							},
							{ path: "helper.ts", content: 'export const description = "Managed command";' },
						],
					},
				],
			}),
		);
		const managed = await materializeManagedResources(snapshot, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			additionalSkillPaths: [explicitSkillPath],
			additionalExtensionPaths: [explicitExtensionPath],
			managedSkillPaths: managed.skillPaths,
			managedExtensionPaths: managed.extensionPaths,
			managedMode: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		const preTrust = await loader.loadProjectTrustExtensions();
		expect(preTrust.extensions.map((extension) => extension.path)).toEqual([
			explicitExtensionPath,
			managed.extensionPaths[0],
		]);
		await loader.reload();
		await loader.reload();

		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["explicit-skill", "managed-skill"]);
		expect(loader.getSkills().skills.some((skill) => skill.name === "local-skill")).toBe(false);
		expect(loader.getSkills().skills.find((skill) => skill.name === "managed-skill")?.sourceInfo).toMatchObject({
			source: "managed",
			scope: "temporary",
			origin: "top-level",
		});
		const extensions = loader.getExtensions().extensions;
		expect(extensions.map((extension) => extension.path)).toEqual([explicitExtensionPath, managed.extensionPaths[0]]);
		expect(extensions.some((extension) => extension.commands.has("local-command"))).toBe(false);
		expect(extensions.find((extension) => extension.commands.has("managed-command"))?.sourceInfo).toMatchObject({
			source: "managed",
			scope: "temporary",
			origin: "top-level",
		});
	});

	it("treats empty managed collections as authoritative and keeps explicit no-resource behavior", async () => {
		const root = await makeTempDir("pi-managed-empty-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await writeSkill(join(agentDir, "skills/local-skill/SKILL.md"), "local-skill", "Local skill");
		await writeCommandExtension(join(agentDir, "extensions/local.ts"), "local-command", "Local command");

		const empty = await materializeManagedResources(parseManagedConfig(managedConfig()), agentDir);
		const emptyLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			managedSkillPaths: empty.skillPaths,
			managedExtensionPaths: empty.extensionPaths,
			managedMode: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				(pi) => pi.registerCommand("inline-command", { description: "Inline", handler: async () => {} }),
			],
		});
		await emptyLoader.reload();
		expect(emptyLoader.getSkills().skills).toEqual([]);
		expect(emptyLoader.getExtensions().extensions).toHaveLength(1);
		expect(emptyLoader.getExtensions().extensions[0]?.commands.has("inline-command")).toBe(true);

		const explicitSkillPath = join(root, "explicit-skill/SKILL.md");
		const explicitExtensionPath = join(root, "explicit-extension.ts");
		await writeSkill(explicitSkillPath, "explicit-skill", "Explicit skill");
		await writeCommandExtension(explicitExtensionPath, "explicit-command", "Explicit command");
		const disabledLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [explicitSkillPath],
			additionalExtensionPaths: [explicitExtensionPath],
			managedSkillPaths: [join(root, "unused-skill/SKILL.md")],
			managedExtensionPaths: [join(root, "unused-extension.ts")],
			managedMode: true,
			noSkills: true,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await disabledLoader.reload();
		expect(disabledLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["explicit-skill"]);
		expect(disabledLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
			explicitExtensionPath,
		]);
	});

	it("does not auto-discover local prompt templates or themes", async () => {
		const root = await makeTempDir("pi-managed-local-resources-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "prompts"), { recursive: true });
		await mkdir(join(agentDir, "themes"), { recursive: true });
		await writeFile(join(agentDir, "prompts/local.md"), "Local prompt");
		const theme = JSON.parse(
			await readFile(join(process.cwd(), "src/modes/interactive/theme/dark.json"), "utf8"),
		) as { name: string };
		theme.name = "local-theme";
		await writeFile(join(agentDir, "themes/local.json"), JSON.stringify(theme));

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			managedMode: true,
			noExtensions: true,
			noSkills: true,
		});
		await loader.reload();

		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
	});

	it("loads managed extension behavior but ignores its provider registrations", async () => {
		const root = await makeTempDir("pi-managed-extension-provider-");
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		const snapshot = parseManagedConfig(
			managedConfig({
				extensions: [
					{
						name: "managed-extension",
						entry: "index.ts",
						files: [
							{
								path: "index.ts",
								content: `export default function (pi) {
	pi.registerProvider("injected-provider", {
		api: "openai-responses",
		baseUrl: "https://injected.example.test/v1",
		apiKey: "injected-key",
		models: [{ id: "injected-model", name: "Injected", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
	});
	pi.registerCommand("managed-command", { description: "Managed", handler: async () => {} });
}
`,
							},
						],
					},
				],
			}),
		);
		const managed = await materializeManagedResources(snapshot, agentDir);
		const runtime = await ModelRuntime.create({ managedConfig: snapshot });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoaderOptions: {
				managedExtensionPaths: managed.extensionPaths,
				managedMode: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(runtime.getProvider("injected-provider")).toBeUndefined();
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
