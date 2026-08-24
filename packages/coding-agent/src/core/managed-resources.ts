import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { ManagedConfigError, type ManagedConfigSnapshot, type ManagedResourceFile } from "./managed-config.ts";

const MANAGED_RESOURCES_DIRECTORY = "managed-config-resources";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const EXECUTABLE_FILE_MODE = 0o700;

interface ManagedResourceDescriptor {
	relativePath: string;
	content: string;
	mode: number;
}

export interface MaterializedManagedResources {
	rootPath?: string;
	skillPaths: string[];
	extensionPaths: string[];
}

function resourceError(message: string): ManagedConfigError {
	return new ManagedConfigError("resources", message);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function resolvePortablePath(root: string, portablePath: string): string {
	return join(root, ...portablePath.split("/"));
}

function addBundleFiles(
	descriptors: ManagedResourceDescriptor[],
	resourceType: "skills" | "extensions",
	name: string,
	files: readonly ManagedResourceFile[],
): void {
	for (const file of files) {
		descriptors.push({
			relativePath: `${resourceType}/${name}/${file.path}`,
			content: file.content,
			mode: file.executable === true ? EXECUTABLE_FILE_MODE : FILE_MODE,
		});
	}
}

function describeManagedResources(snapshot: ManagedConfigSnapshot): {
	descriptors: ManagedResourceDescriptor[];
	skillRelativePaths: string[];
	extensionRelativePaths: string[];
} {
	const descriptors: ManagedResourceDescriptor[] = [];
	const skillRelativePaths = snapshot.skills.map((bundle) => {
		addBundleFiles(descriptors, "skills", bundle.name, bundle.files);
		return `skills/${bundle.name}/SKILL.md`;
	});
	const extensionRelativePaths = snapshot.extensions.map((bundle) => {
		addBundleFiles(descriptors, "extensions", bundle.name, bundle.files);
		return `extensions/${bundle.name}/${bundle.entry}`;
	});
	return { descriptors, skillRelativePaths, extensionRelativePaths };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
		const stats = await lstat(path);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw resourceError("Managed resources path is not a private directory");
		}
		if (process.platform !== "win32") await chmod(path, DIRECTORY_MODE);
	} catch (error) {
		if (error instanceof ManagedConfigError) throw error;
		throw resourceError("Managed resources directory could not be prepared");
	}
}

function expectedDirectories(descriptors: readonly ManagedResourceDescriptor[]): Set<string> {
	const directories = new Set<string>([""]);
	for (const descriptor of descriptors) {
		const segments = descriptor.relativePath.split("/");
		segments.pop();
		for (let index = 1; index <= segments.length; index++) {
			directories.add(segments.slice(0, index).join("/"));
		}
	}
	return directories;
}

async function assertPrivateMode(path: string, expectedMode: number, kind: "directory" | "file"): Promise<void> {
	if (process.platform === "win32") return;
	const stats = await lstat(path);
	if ((stats.mode & 0o777) !== expectedMode) {
		throw resourceError(`Managed resource ${kind} permissions are not private`);
	}
}

async function verifyMaterializedResources(
	rootPath: string,
	descriptors: readonly ManagedResourceDescriptor[],
): Promise<void> {
	try {
		const rootStats = await lstat(rootPath);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
			throw resourceError("Managed resources snapshot is not a directory");
		}
		await assertPrivateMode(rootPath, DIRECTORY_MODE, "directory");

		const expectedFiles = new Map(descriptors.map((descriptor) => [descriptor.relativePath, descriptor]));
		const expectedDirs = expectedDirectories(descriptors);
		const seenFiles = new Set<string>();
		const seenDirs = new Set<string>([""]);

		const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
			for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
				const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
				const absolutePath = join(absoluteDirectory, entry.name);
				if (entry.isSymbolicLink()) {
					throw resourceError("Managed resources snapshot contains a symbolic link");
				}
				if (entry.isDirectory()) {
					if (!expectedDirs.has(relativePath)) {
						throw resourceError("Managed resources snapshot contains an unexpected directory");
					}
					await assertPrivateMode(absolutePath, DIRECTORY_MODE, "directory");
					seenDirs.add(relativePath);
					await visit(absolutePath, relativePath);
					continue;
				}
				if (!entry.isFile()) {
					throw resourceError("Managed resources snapshot contains an unsupported filesystem entry");
				}
				const descriptor = expectedFiles.get(relativePath);
				if (!descriptor) {
					throw resourceError("Managed resources snapshot contains an unexpected file");
				}
				await assertPrivateMode(absolutePath, descriptor.mode, "file");
				const actualContent = await readFile(absolutePath);
				if (!actualContent.equals(Buffer.from(descriptor.content, "utf8"))) {
					throw resourceError("Managed resources snapshot content does not match the accepted config");
				}
				seenFiles.add(relativePath);
			}
		};

		await visit(rootPath, "");
		if (seenFiles.size !== expectedFiles.size || seenDirs.size !== expectedDirs.size) {
			throw resourceError("Managed resources snapshot is incomplete");
		}
	} catch (error) {
		if (error instanceof ManagedConfigError) throw error;
		throw resourceError("Managed resources snapshot could not be verified");
	}
}

async function managedResourcesSnapshotExists(rootPath: string): Promise<boolean> {
	try {
		const stats = await lstat(rootPath);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw resourceError("Managed resources snapshot is not a directory");
		}
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		if (error instanceof ManagedConfigError) throw error;
		throw resourceError("Managed resources snapshot could not be inspected");
	}
}

async function writeMaterializedResources(
	temporaryPath: string,
	descriptors: readonly ManagedResourceDescriptor[],
): Promise<void> {
	await mkdir(temporaryPath, { mode: DIRECTORY_MODE });
	for (const descriptor of descriptors) {
		const filePath = resolvePortablePath(temporaryPath, descriptor.relativePath);
		await mkdir(dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
		if (process.platform !== "win32") await chmod(dirname(filePath), DIRECTORY_MODE);
		await writeFile(filePath, descriptor.content, { encoding: "utf8", flag: "wx", mode: descriptor.mode });
		if (process.platform !== "win32") await chmod(filePath, descriptor.mode);
	}
}

export async function materializeManagedResources(
	snapshot: ManagedConfigSnapshot,
	agentDir: string,
): Promise<MaterializedManagedResources> {
	const { descriptors, skillRelativePaths, extensionRelativePaths } = describeManagedResources(snapshot);
	if (descriptors.length === 0) {
		return { skillPaths: skillRelativePaths, extensionPaths: extensionRelativePaths };
	}

	const resourcesDigest = createHash("sha256")
		.update(JSON.stringify({ skills: snapshot.skills, extensions: snapshot.extensions }))
		.digest("hex");
	const resourcesDirectory = join(resolvePath(agentDir), MANAGED_RESOURCES_DIRECTORY);
	const rootPath = join(resourcesDirectory, resourcesDigest);
	await ensurePrivateDirectory(resourcesDirectory);

	if (await managedResourcesSnapshotExists(rootPath)) {
		await verifyMaterializedResources(rootPath, descriptors);
	} else {
		const temporaryPath = join(resourcesDirectory, `.${resourcesDigest}-${randomUUID()}.tmp`);
		try {
			await writeMaterializedResources(temporaryPath, descriptors);
			try {
				await rename(temporaryPath, rootPath);
			} catch (renameError) {
				if (!(await managedResourcesSnapshotExists(rootPath))) throw renameError;
			}
		} catch (writeError) {
			if (writeError instanceof ManagedConfigError) throw writeError;
			throw resourceError("Managed resources snapshot could not be materialized");
		} finally {
			await rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
		}
		await verifyMaterializedResources(rootPath, descriptors);
	}

	return {
		rootPath,
		skillPaths: skillRelativePaths.map((path) => resolvePortablePath(rootPath, path)),
		extensionPaths: extensionRelativePaths.map((path) => resolvePortablePath(rootPath, path)),
	};
}
