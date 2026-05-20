import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	withContext: function () {
		return this;
	},
} as any;

function createSession(
	manager: AgentSessionManager,
	workspacePath: string,
): void {
	manager.createCyrusAgentSession(
		"session-1",
		"issue-1",
		{
			id: "issue-1",
			identifier: "TEST-1",
			title: "Frontend fix",
			branchName: "test-1",
		},
		{ path: workspacePath, isGitWorktree: true },
		"linear",
		[],
	);
}

describe("AgentSessionManager screenshot candidates", () => {
	it("ignores app image assets and keeps explicit cyrus screenshots", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "cyrus-screenshots-"));
		const assetPath = join(
			workspacePath,
			"apps/app/public/assets/product-logo.png",
		);
		const screenshotPath = join(
			workspacePath,
			"cyrus-screenshots/frontend-after.png",
		);
		mkdirSync(join(workspacePath, "apps/app/public/assets"), {
			recursive: true,
		});
		mkdirSync(join(workspacePath, "cyrus-screenshots"), { recursive: true });
		writeFileSync(assetPath, "not a screenshot");
		writeFileSync(screenshotPath, "screenshot bytes");

		const manager = new AgentSessionManager(undefined, undefined, noopLogger);
		createSession(manager, workspacePath);
		(manager as any).rememberScreenshotPath("session-1", assetPath);
		(manager as any).rememberScreenshotPath("session-1", screenshotPath);

		const candidates = await (manager as any).collectScreenshotCandidates(
			manager.getSession("session-1"),
		);

		expect(candidates.map((candidate: any) => candidate.path)).toEqual([
			screenshotPath,
		]);
	});

	it("accepts explicit screenshot tool paths outside the workspace", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "cyrus-workspace-"));
		const toolDir = mkdtempSync(join(tmpdir(), "cyrus-tool-output-"));
		const screenshotPath = join(toolDir, "chrome_screenshot.png");
		writeFileSync(screenshotPath, "screenshot bytes");

		const manager = new AgentSessionManager(undefined, undefined, noopLogger);
		createSession(manager, workspacePath);
		(manager as any).rememberScreenshotPath("session-1", screenshotPath);

		const candidates = await (manager as any).collectScreenshotCandidates(
			manager.getSession("session-1"),
		);

		expect(candidates.map((candidate: any) => candidate.path)).toEqual([
			screenshotPath,
		]);
		expect(candidates[0]?.source).toBe("tool");
	});

	it("does not treat broad visual or browser asset paths as screenshots", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "cyrus-visual-assets-"));
		const visualAssetPath = join(
			workspacePath,
			"apps/app/imports/ui/visual-assets/browser-card.webp",
		);
		mkdirSync(join(workspacePath, "apps/app/imports/ui/visual-assets"), {
			recursive: true,
		});
		writeFileSync(visualAssetPath, "asset bytes");

		const manager = new AgentSessionManager(undefined, undefined, noopLogger);
		createSession(manager, workspacePath);
		(manager as any).rememberScreenshotPath("session-1", visualAssetPath);

		const candidates = await (manager as any).collectScreenshotCandidates(
			manager.getSession("session-1"),
		);

		expect(candidates).toEqual([]);
	});
});
