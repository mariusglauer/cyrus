import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi.fn().mockReturnValue({
				get: vi.fn(),
				post: vi.fn(),
			}),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
		};
	}),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(function () {
		return {
			cleanup: vi.fn().mockReturnValue(0),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			getAllSessions: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn(),
			getActiveSessions: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			setActivitySink: vi.fn(),
			on: vi.fn(),
			emit: vi.fn(),
		};
	}),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

describe("EdgeWorker - garbage collection", () => {
	let root: string;
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cyrus-gc-"));
		mockConfig = {
			platform: "linear",
			cyrusHome: root,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": {
					linearToken: "test-token",
					linearWorkspaceSlug: "funnelcockpit",
				},
			},
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (edgeWorker) {
			await edgeWorker.stop().catch(() => undefined);
		}
		rmSync(root, { recursive: true, force: true });
	});

	function createWorker() {
		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).garbageCollectionWorktreeTtlMs = 1_000;
		(edgeWorker as any).garbageCollectionWorktreeCacheTtlMs = 1_000;
		return edgeWorker;
	}

	function createOldWorktree(issueIdentifier: string) {
		const worktreesDir = join(root, "worktrees");
		const workspacePath = join(worktreesDir, issueIdentifier);
		mkdirSync(workspacePath, { recursive: true });
		const old = new Date(Date.now() - 10_000);
		utimesSync(workspacePath, old, old);
		return workspacePath;
	}

	function createSummary() {
		return {
			reason: "test",
			startedAt: new Date().toISOString(),
			scannedWorktrees: 0,
			removedWorktrees: 0,
			scannedBranches: 0,
			removedLocalBranches: 0,
			removedRemoteBranches: 0,
			scannedTempDirs: 0,
			removedTempDirs: 0,
			scannedSystemTempDirs: 0,
			removedSystemTempDirs: 0,
			removedSessions: 0,
			removedRegistrySessions: 0,
			removedInactiveWorktrees: 0,
			removedWorktreeCacheDirs: 0,
			skippedProtected: 0,
			skippedOpenPullRequests: 0,
			skippedUnknownPullRequests: 0,
			skippedFreshWorktrees: 0,
			skippedDirtyWorktrees: 0,
			errors: [],
		};
	}

	it("removes old inactive clean worktrees even when the PR is still open", async () => {
		const worker = createWorker();
		const workspacePath = createOldWorktree("FC-1572");
		const summary = createSummary();
		const deleteWorktree = vi.fn().mockImplementation(async () => {
			rmSync(workspacePath, { recursive: true, force: true });
		});

		(worker as any).listWorktreeBranchRefs = vi.fn().mockReturnValue([
			{
				path: workspacePath,
				branch: "cyrus/fc-1572-fix-copy",
				repoPath: "/test/repo",
			},
		]);
		(worker as any).getPullRequestGarbageCollectionState = vi
			.fn()
			.mockReturnValue({ state: "OPEN" });
		(worker as any).isGitWorktreeClean = vi.fn().mockReturnValue(true);
		(worker as any).deleteGarbageCollectedBranch = vi.fn();
		(worker as any).gitService = { deleteWorktree };

		await (worker as any).collectGarbageFromWorktrees(
			{
				issueIdentifiers: new Set(),
				branchNames: new Set(),
				tempDirNames: new Set(),
			},
			summary,
		);

		expect(deleteWorktree).toHaveBeenCalledWith("FC-1572");
		expect((worker as any).deleteGarbageCollectedBranch).not.toHaveBeenCalled();
		expect(summary.removedWorktrees).toBe(1);
		expect(summary.removedInactiveWorktrees).toBe(1);
		expect(existsSync(workspacePath)).toBe(false);
	});

	it("keeps dirty inactive worktrees so unpushed changes are not lost", async () => {
		const worker = createWorker();
		const workspacePath = createOldWorktree("FC-1573");
		const summary = createSummary();
		const deleteWorktree = vi.fn();

		(worker as any).listWorktreeBranchRefs = vi.fn().mockReturnValue([
			{
				path: workspacePath,
				branch: "cyrus/fc-1573-fix-copy",
				repoPath: "/test/repo",
			},
		]);
		(worker as any).getPullRequestGarbageCollectionState = vi
			.fn()
			.mockReturnValue({ state: "OPEN" });
		(worker as any).isGitWorktreeClean = vi.fn().mockReturnValue(false);
		(worker as any).gitService = { deleteWorktree };

		await (worker as any).collectGarbageFromWorktrees(
			{
				issueIdentifiers: new Set(),
				branchNames: new Set(),
				tempDirNames: new Set(),
			},
			summary,
		);

		expect(deleteWorktree).not.toHaveBeenCalled();
		expect(summary.removedWorktrees).toBe(0);
		expect(summary.skippedDirtyWorktrees).toBe(1);
		expect(existsSync(workspacePath)).toBe(true);
	});

	it("removes generated cache directories from stale dirty worktrees", async () => {
		const worker = createWorker();
		const workspacePath = createOldWorktree("FC-1574");
		const nodeModulesPath = join(workspacePath, "node_modules");
		mkdirSync(nodeModulesPath, { recursive: true });
		const old = new Date(Date.now() - 10_000);
		utimesSync(workspacePath, old, old);
		const summary = createSummary();
		const deleteWorktree = vi.fn();

		(worker as any).listWorktreeBranchRefs = vi.fn().mockReturnValue([
			{
				path: workspacePath,
				branch: "cyrus/fc-1574-fix-copy",
				repoPath: "/test/repo",
			},
		]);
		(worker as any).getPullRequestGarbageCollectionState = vi
			.fn()
			.mockReturnValue({ state: "OPEN" });
		(worker as any).isGitWorktreeClean = vi.fn().mockReturnValue(false);
		(worker as any).gitService = { deleteWorktree };

		await (worker as any).collectGarbageFromWorktrees(
			{
				issueIdentifiers: new Set(),
				branchNames: new Set(),
				tempDirNames: new Set(),
			},
			summary,
		);

		expect(deleteWorktree).not.toHaveBeenCalled();
		expect(existsSync(workspacePath)).toBe(true);
		expect(existsSync(nodeModulesPath)).toBe(false);
		expect(summary.removedWorktreeCacheDirs).toBe(1);
		expect(summary.skippedDirtyWorktrees).toBe(1);
	});

	it("serializes queue saves and uses unique temporary files", async () => {
		const worker = createWorker();
		(worker as any).linearSessionQueue = [
			{
				origin: "linear",
				sessionId: "linear-session-1",
				workItemIdentifier: "FC-1572",
				queuedAt: Date.now(),
				availableAt: Date.now(),
				retryCount: 0,
				repoIds: ["test-repo"],
				webhook: {
					organizationId: "test-workspace",
					agentSession: {
						id: "linear-session-1",
						issue: { id: "issue-1", identifier: "FC-1572" },
					},
				},
			},
		];

		await Promise.all(
			Array.from({ length: 5 }, () => (worker as any).saveLinearSessionQueue()),
		);

		const queue = JSON.parse(
			readFileSync(join(root, "linear-session-queue.json"), "utf8"),
		);
		expect(queue.items).toHaveLength(1);
		expect(queue.items[0].sessionId).toBe("linear-session-1");
		expect(
			readdirSync(root).filter((name) => name.includes(".tmp")),
		).toHaveLength(0);
	});

	it("removes stale Cyrus-owned system temp entries by pattern", async () => {
		const tempRoot = join(root, "system-tmp");
		mkdirSync(tempRoot, { recursive: true });
		const staleCache = join(tempRoot, "bun-cache-pr1812");
		const unrelated = join(tempRoot, "unrelated-cache");
		mkdirSync(staleCache, { recursive: true });
		mkdirSync(unrelated, { recursive: true });
		const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
		utimesSync(staleCache, old, old);
		utimesSync(unrelated, old, old);
		vi.stubEnv("CYRUS_GC_SYSTEM_TMP_DIR", tempRoot);
		const worker = createWorker();
		const summary = createSummary();

		await (worker as any).collectGarbageFromSystemTempEntries(summary);

		expect(existsSync(staleCache)).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
		expect(summary.scannedSystemTempDirs).toBe(1);
		expect(summary.removedSystemTempDirs).toBe(1);
	});

	it("keeps the manual GC endpoint local or token-authenticated", () => {
		const worker = createWorker();

		expect(
			(worker as any).isLocalAdminRequest({
				ip: "127.0.0.1",
				headers: { host: "cyrus.funnelcockpit.com" },
			}),
		).toBe(false);
		expect(
			(worker as any).isLocalAdminRequest({
				ip: "127.0.0.1",
				headers: { host: "127.0.0.1:3456" },
			}),
		).toBe(true);

		vi.stubEnv("CYRUS_ADMIN_TOKEN", "secret-token");
		expect(
			(worker as any).isLocalAdminRequest({
				ip: "203.0.113.10",
				headers: { authorization: "Bearer secret-token" },
			}),
		).toBe(true);
	});
});
