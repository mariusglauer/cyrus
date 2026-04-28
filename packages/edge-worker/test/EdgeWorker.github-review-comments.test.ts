import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		initializeFastify: vi.fn(),
		getFastifyInstance: vi.fn().mockReturnValue({
			get: vi.fn(),
			post: vi.fn(),
		}),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
	})),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(() => ({
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllSessions: vi.fn().mockReturnValue([]),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		createCyrusAgentSession: vi.fn(),
		getSession: vi.fn(),
		setActivitySink: vi.fn(),
		on: vi.fn(),
		emit: vi.fn(),
	})),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

describe("EdgeWorker - GitHub review comments", () => {
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

	const reviewEvent = {
		eventType: "pull_request_review",
		deliveryId: "delivery-review-1",
		payload: {
			action: "submitted",
			review: {
				id: 99,
				body: "Please address the inline comments.",
				state: "changes_requested",
				html_url: "https://github.com/acme/web/pull/12#pullrequestreview-99",
				user: { login: "reviewer" },
				submitted_at: "2026-04-28T10:00:00Z",
				commit_id: "abc123",
			},
			pull_request: {
				number: 12,
				title: "Fix checkout",
				head: { ref: "fix/checkout" },
				base: { ref: "main" },
			},
			repository: {
				name: "web",
				full_name: "acme/web",
				owner: { login: "acme" },
			},
			sender: { login: "reviewer" },
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};
		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).resolveGitHubToken = vi.fn().mockResolvedValue("token");
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	it("adds inline review comments to change request instructions", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue([
				{
					body: "Use strict null handling here.",
					path: "src/checkout.ts",
					start_line: 10,
					line: 12,
					diff_hunk: "@@ -10,3 +10,3 @@\n-old\n+new",
					html_url: "https://github.com/acme/web/pull/12#discussion_r123",
					user: { login: "reviewer" },
				},
			]),
		});
		vi.stubGlobal("fetch", fetchMock);

		const instructions = await (
			edgeWorker as any
		).buildGitHubChangeRequestInstructions(
			reviewEvent,
			"Please address the inline comments.",
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/acme/web/pulls/12/reviews/99/comments",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer token",
				}),
			}),
		);
		expect(instructions).toContain("## Review Summary");
		expect(instructions).toContain("## Inline Review Comments");
		expect(instructions).toContain("src/checkout.ts:10-12");
		expect(instructions).toContain("Use strict null handling here.");
	});
});
