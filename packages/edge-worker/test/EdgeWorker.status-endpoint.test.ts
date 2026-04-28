import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

// Mock dependencies
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
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			getAllSessions: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn(),
			getActiveSessions: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			setActivitySink: vi.fn(),
			on: vi.fn(), // EventEmitter method
			emit: vi.fn(), // EventEmitter method
		};
	}),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn().mockReturnValue(false),
		isAgentSessionPromptedWebhook: vi.fn().mockReturnValue(false),
		isIssueAssignedWebhook: vi.fn().mockReturnValue(false),
		isIssueCommentMentionWebhook: vi.fn().mockReturnValue(false),
		isIssueNewCommentWebhook: vi.fn().mockReturnValue(false),
		isIssueUnassignedWebhook: vi.fn().mockReturnValue(false),
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

describe("EdgeWorker - Status Endpoint", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let _registeredGetHandler:
		| ((request: any, reply: any) => Promise<any>)
		| null = null;

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
		vi.clearAllMocks();
		_registeredGetHandler = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};
	});

	afterEach(async () => {
		vi.useRealTimers();
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe("computeStatus", () => {
		it("should return idle when no webhooks are being processed and no runners are active", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Access the private method via type assertion for testing
			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("idle");
		});

		it("should return busy when activeWebhookCount > 0", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Simulate webhook processing
			(edgeWorker as any).activeWebhookCount = 1;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
		});

		it("should return busy when a runner is running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create a mock runner that is running
			const mockRunner = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			// Create a mock session manager that returns the mock runner
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManager = mockSessionManager;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
			expect(mockRunner.isRunning).toHaveBeenCalled();
		});

		it("should return idle when runner exists but is not running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create a mock runner that is not running
			const mockRunner = {
				isRunning: vi.fn().mockReturnValue(false),
			};

			// Create a mock session manager that returns the mock runner
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManager = mockSessionManager;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("idle");
		});

		it("should return busy when multiple runners exist and at least one is running", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create mock runners - one running, one not
			const mockRunner1 = {
				isRunning: vi.fn().mockReturnValue(false),
			};
			const mockRunner2 = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			// Create a mock session manager that returns both runners
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner1, mockRunner2]),
			};

			// Set the mock session manager
			(edgeWorker as any).agentSessionManager = mockSessionManager;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
		});

		it("should check all runners from the single session manager", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Create mock runners - one idle, one busy
			const mockRunner1 = {
				isRunning: vi.fn().mockReturnValue(false),
			};
			const mockRunner2 = {
				isRunning: vi.fn().mockReturnValue(true),
			};

			// Single session manager returns all runners across repos
			const mockSessionManager = {
				getAllAgentRunners: vi.fn().mockReturnValue([mockRunner1, mockRunner2]),
			};

			// Set the single session manager
			(edgeWorker as any).agentSessionManager = mockSessionManager;

			const status = (edgeWorker as any).computeStatus();

			expect(status).toBe("busy");
			expect(mockSessionManager.getAllAgentRunners).toHaveBeenCalled();
		});
	});

	describe("activeWebhookCount tracking", () => {
		it("should increment and decrement activeWebhookCount during webhook handling", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Verify initial state
			expect((edgeWorker as any).activeWebhookCount).toBe(0);

			// Call handleWebhook with a mock webhook that doesn't match any handler
			const mockWebhook = { action: "unknown" };
			await (edgeWorker as any).handleWebhook(mockWebhook, [mockRepository]);

			// After completion, count should be back to 0
			expect((edgeWorker as any).activeWebhookCount).toBe(0);
		});

		it("should decrement activeWebhookCount even when handler throws an error", async () => {
			edgeWorker = new EdgeWorker(mockConfig);

			// Mock isIssueUnassignedWebhook to return true and make the handler throw
			const { isIssueUnassignedWebhook } = await import("cyrus-core");
			vi.mocked(isIssueUnassignedWebhook).mockReturnValue(true);

			// Mock the handler to throw
			(edgeWorker as any).handleIssueUnassignedWebhook = vi
				.fn()
				.mockRejectedValue(new Error("Test error"));

			// Call handleWebhook
			const mockWebhook = { action: "issueUnassigned", notification: {} };
			await (edgeWorker as any).handleWebhook(mockWebhook, [mockRepository]);

			// Count should still be 0 after error (finally block executed)
			expect((edgeWorker as any).activeWebhookCount).toBe(0);
		});
	});

	describe("durable queue recovery", () => {
		it("requeues restored active Linear sessions that no longer have a runner", async () => {
			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).saveLinearSessionQueue = vi
				.fn()
				.mockResolvedValue(undefined);
			(edgeWorker as any).sendOperationalAlert = vi
				.fn()
				.mockResolvedValue(undefined);

			(edgeWorker as any).agentSessionManager.getActiveSessions = vi
				.fn()
				.mockReturnValue([
					{
						id: "linear-session-1",
						externalSessionId: "linear-session-1",
						status: "active",
						updatedAt: Date.now(),
						issueContext: {
							trackerId: "linear",
							issueId: "issue-1",
							issueIdentifier: "FC-4410",
						},
						issue: {
							id: "issue-1",
							identifier: "FC-4410",
							title: "PageBuilder: Tags not readable",
						},
						repositories: [{ repositoryId: "test-repo" }],
					},
				]);

			await (
				edgeWorker as any
			).recoverInterruptedActiveLinearSessionsFromState();

			expect((edgeWorker as any).linearSessionQueue).toHaveLength(1);
			expect((edgeWorker as any).linearSessionQueue[0]).toEqual(
				expect.objectContaining({
					origin: "linear",
					sessionId: "linear-session-1",
					workItemIdentifier: "FC-4410",
					retryCount: 1,
					lastError: "Recovered active session after Cyrus restart.",
				}),
			);
			expect(
				(edgeWorker as any).linearSessionQueue[0].webhook.organizationId,
			).toBe("test-workspace");
		});

		it("does not duplicate sessions already tracked by the durable queue", async () => {
			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).saveLinearSessionQueue = vi
				.fn()
				.mockResolvedValue(undefined);
			(edgeWorker as any).linearSessionQueue = [
				{
					origin: "linear",
					sessionId: "linear-session-1",
					workItemIdentifier: "FC-4410",
					queuedAt: Date.now(),
					availableAt: Date.now(),
					retryCount: 0,
					repoIds: ["test-repo"],
					webhook: {
						organizationId: "test-workspace",
						agentSession: {
							id: "linear-session-1",
							issue: { id: "issue-1", identifier: "FC-4410" },
						},
					},
				},
			];
			(edgeWorker as any).agentSessionManager.getActiveSessions = vi
				.fn()
				.mockReturnValue([
					{
						id: "linear-session-1",
						externalSessionId: "linear-session-1",
						status: "active",
						issueContext: {
							trackerId: "linear",
							issueId: "issue-1",
							issueIdentifier: "FC-4410",
						},
						issue: { id: "issue-1", identifier: "FC-4410" },
						repositories: [{ repositoryId: "test-repo" }],
					},
				]);

			await (
				edgeWorker as any
			).recoverInterruptedActiveLinearSessionsFromState();

			expect((edgeWorker as any).linearSessionQueue).toHaveLength(1);
		});

		it("ignores stale active sessions outside the recovery lookback", async () => {
			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).saveLinearSessionQueue = vi
				.fn()
				.mockResolvedValue(undefined);

			(edgeWorker as any).agentSessionManager.getActiveSessions = vi
				.fn()
				.mockReturnValue([
					{
						id: "linear-session-1",
						externalSessionId: "linear-session-1",
						status: "active",
						updatedAt: Date.now() - 24 * 60 * 60 * 1_000,
						issueContext: {
							trackerId: "linear",
							issueId: "issue-1",
							issueIdentifier: "FC-4132",
						},
						issue: { id: "issue-1", identifier: "FC-4132" },
						repositories: [{ repositoryId: "test-repo" }],
					},
				]);

			await (
				edgeWorker as any
			).recoverInterruptedActiveLinearSessionsFromState();

			expect((edgeWorker as any).linearSessionQueue).toHaveLength(0);
			expect((edgeWorker as any).saveLinearSessionQueue).not.toHaveBeenCalled();
		});

		it("keeps a queued Linear item active until the agent session completes", async () => {
			vi.useFakeTimers();
			edgeWorker = new EdgeWorker(mockConfig);
			let status = "active";
			(edgeWorker as any).agentSessionManager.getSession = vi
				.fn()
				.mockImplementation(() => ({ status }));

			let resolved = false;
			const promise = (edgeWorker as any)
				.waitForQueuedLinearSessionCompletion(
					{ sessionId: "linear-session-1" },
					new AbortController().signal,
				)
				.then(() => {
					resolved = true;
				});

			await vi.advanceTimersByTimeAsync(1_000);
			expect(resolved).toBe(false);

			status = "complete";
			await vi.advanceTimersByTimeAsync(1_000);
			await promise;
			expect(resolved).toBe(true);
			vi.useRealTimers();
		});
	});

	describe("garbage collection", () => {
		it("only treats Cyrus-prefixed branches as GC candidates", () => {
			edgeWorker = new EdgeWorker(mockConfig);

			expect(
				(edgeWorker as any).isCyrusGarbageCollectionBranch(
					"cyrus2/fc-4410-pagebuilder-tags-not-readable",
				),
			).toBe(true);
			expect(
				(edgeWorker as any).isCyrusGarbageCollectionBranch(
					"FC-4410-followup-funnel-mails",
				),
			).toBe(false);
		});

		it("only considers terminal PRs eligible after the GC grace window", () => {
			edgeWorker = new EdgeWorker(mockConfig);
			const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
			const recentDate = new Date(Date.now()).toISOString();

			expect(
				(edgeWorker as any).isTerminalPullRequestEligibleForGarbageCollection({
					state: "OPEN",
				}),
			).toBe(false);
			expect(
				(edgeWorker as any).isTerminalPullRequestEligibleForGarbageCollection({
					state: "MERGED",
					mergedAt: oldDate,
				}),
			).toBe(true);
			expect(
				(edgeWorker as any).isTerminalPullRequestEligibleForGarbageCollection({
					state: "CLOSED",
					closedAt: recentDate,
				}),
			).toBe(false);
		});
	});

	describe("registerStatusEndpoint", () => {
		it("should register GET /status endpoint with Fastify", async () => {
			const mockGet = vi.fn();
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

			// Create EdgeWorker with mock that captures the registered handler
			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(function () {
				return {
					initializeFastify: vi.fn(),
					getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
				};
			} as any);

			edgeWorker = new EdgeWorker(mockConfig);

			// Call registerStatusEndpoint
			(edgeWorker as any).registerStatusEndpoint();

			// Verify GET /status was registered
			expect(mockGet).toHaveBeenCalledWith("/status", expect.any(Function));
		});

		it("should return idle status via the endpoint handler", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/status") {
					capturedHandler = handler;
				}
			});
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(function () {
				return {
					initializeFastify: vi.fn(),
					getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
				};
			} as any);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerStatusEndpoint();

			// Mock reply object
			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			// Call the captured handler
			expect(capturedHandler).not.toBeNull();
			await capturedHandler({}, mockReply);

			expect(mockReply.status).toHaveBeenCalledWith(200);
			expect(mockReply.send).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "idle",
					activeWebhookCount: 0,
					activeRunnerCount: 0,
					linearQueue: expect.objectContaining({
						pending: 0,
						active: 0,
					}),
				}),
			);
		});

		it("should return busy status via the endpoint handler when webhook is processing", async () => {
			let capturedHandler: any = null;
			const mockGet = vi.fn((path: string, handler: any) => {
				if (path === "/status") {
					capturedHandler = handler;
				}
			});
			const mockFastify = {
				get: mockGet,
				post: vi.fn(),
			};

			const { SharedApplicationServer } = await import(
				"../src/SharedApplicationServer.js"
			);
			vi.mocked(SharedApplicationServer).mockImplementation(function () {
				return {
					initializeFastify: vi.fn(),
					getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
				};
			} as any);

			edgeWorker = new EdgeWorker(mockConfig);
			(edgeWorker as any).registerStatusEndpoint();

			// Simulate active webhook
			(edgeWorker as any).activeWebhookCount = 1;

			// Mock reply object
			const mockReply = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			// Call the captured handler
			expect(capturedHandler).not.toBeNull();
			await capturedHandler({}, mockReply);

			expect(mockReply.status).toHaveBeenCalledWith(200);
			expect(mockReply.send).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "busy",
					activeWebhookCount: 1,
					linearQueue: expect.objectContaining({
						pending: 0,
						active: 0,
					}),
				}),
			);
		});
	});
});
