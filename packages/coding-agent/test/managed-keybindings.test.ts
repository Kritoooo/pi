import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager, setUserKeybindingsEnabled } from "../src/core/keybindings.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	setUserKeybindingsEnabled(true);
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("managed keybindings", () => {
	it("uses built-in defaults without loading the local keybindings file", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-managed-keybindings-"));
		tempDirs.push(agentDir);
		await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+x" }));

		setUserKeybindingsEnabled(false);
		const managed = KeybindingsManager.create(agentDir);
		expect(managed.getUserBindings()).toEqual({});

		setUserKeybindingsEnabled(true);
		const local = KeybindingsManager.create(agentDir);
		expect(local.getUserBindings()).toEqual({ "app.interrupt": "ctrl+x" });
	});
});
