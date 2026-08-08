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
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn(),
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

describe("EdgeWorker - GitHub review comments", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let originalGitHubPrAuthorLogins: string | undefined;
	let originalGitHubPrBranchPrefixes: string | undefined;
	let originalGitHubBotUsername: string | undefined;
	let originalGitHubConflictRebase: string | undefined;
	let originalGitHubConflictRebaseExternalAuthors: string | undefined;

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
				state: "open",
				merged: false,
				merged_at: null,
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
		originalGitHubPrAuthorLogins = process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS;
		originalGitHubPrBranchPrefixes =
			process.env.CYRUS_GITHUB_PR_BRANCH_PREFIXES;
		originalGitHubBotUsername = process.env.GITHUB_BOT_USERNAME;
		originalGitHubConflictRebase = process.env.CYRUS_GITHUB_CONFLICT_REBASE;
		originalGitHubConflictRebaseExternalAuthors =
			process.env.CYRUS_GITHUB_CONFLICT_REBASE_INCLUDE_EXTERNAL_AUTHORS;
		delete process.env.CYRUS_GITHUB_CONFLICT_REBASE;
		delete process.env.CYRUS_GITHUB_CONFLICT_REBASE_INCLUDE_EXTERNAL_AUTHORS;

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
		restoreEnvValue(
			"CYRUS_GITHUB_PR_AUTHOR_LOGINS",
			originalGitHubPrAuthorLogins,
		);
		restoreEnvValue(
			"CYRUS_GITHUB_PR_BRANCH_PREFIXES",
			originalGitHubPrBranchPrefixes,
		);
		restoreEnvValue("GITHUB_BOT_USERNAME", originalGitHubBotUsername);
		restoreEnvValue(
			"CYRUS_GITHUB_CONFLICT_REBASE",
			originalGitHubConflictRebase,
		);
		restoreEnvValue(
			"CYRUS_GITHUB_CONFLICT_REBASE_INCLUDE_EXTERNAL_AUTHORS",
			originalGitHubConflictRebaseExternalAuthors,
		);
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	const restoreEnvValue = (name: string, value: string | undefined) => {
		if (value === undefined) {
			delete process.env[name];
			return;
		}
		process.env[name] = value;
	};

	const withPullRequest = (overrides: Record<string, unknown>) => ({
		...reviewEvent,
		payload: {
			...reviewEvent.payload,
			pull_request: {
				...reviewEvent.payload.pull_request,
				body: null,
				user: { login: "funnelcockpit-bot" },
				...overrides,
			},
		},
	});

	const repositoryRef = {
		id: 1,
		name: "web",
		full_name: "acme/web",
		html_url: "https://github.com/acme/web",
		clone_url: "https://github.com/acme/web.git",
		ssh_url: "git@github.com:acme/web.git",
		default_branch: "main",
		owner: {
			login: "acme",
			id: 10,
			avatar_url: "",
			html_url: "https://github.com/acme",
			type: "Organization",
		},
	};

	const conflictedPullRequest = (overrides: Record<string, unknown> = {}) => ({
		id: 12,
		number: 12,
		title: "FC-4172: Fix checkout",
		body: "Linear issue: FC-4172",
		state: "open",
		html_url: "https://github.com/acme/web/pull/12",
		url: "https://api.github.com/repos/acme/web/pulls/12",
		head: {
			label: "acme:feature/fc-4172-checkout",
			ref: "feature/fc-4172-checkout",
			sha: "abcdef1234567890",
			repo: repositoryRef,
		},
		base: {
			label: "acme:main",
			ref: "main",
			sha: "base123",
			repo: repositoryRef,
		},
		user: {
			login: "human-dev",
			id: 20,
			avatar_url: "",
			html_url: "https://github.com/human-dev",
			type: "User",
		},
		mergeable: false,
		mergeable_state: "dirty",
		merged: false,
		merged_at: null,
		...overrides,
	});

	const pullRequestEvent = (pullRequest: any) => ({
		eventType: "pull_request",
		deliveryId: "delivery-pr-conflict-1",
		payload: {
			action: "synchronize",
			number: pullRequest.number,
			pull_request: pullRequest,
			repository: repositoryRef,
			sender: pullRequest.user,
		},
	});

	function stubConflictRebaseSideEffects(pullRequest: any) {
		(edgeWorker as any).fetchGitHubPullRequestDetails = vi
			.fn()
			.mockResolvedValue(pullRequest);
		(edgeWorker as any).postGitHubPullRequestIssueComment = vi
			.fn()
			.mockResolvedValue(undefined);
		(edgeWorker as any).postGitHubLinkedLinearThoughtForPullRequestEvent = vi
			.fn()
			.mockResolvedValue(undefined);
		(edgeWorker as any).saveLinearSessionQueue = vi
			.fn()
			.mockResolvedValue(undefined);
		(edgeWorker as any).drainLinearSessionQueue = vi.fn();
	}

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

	it("ignores pull_request conflict checks when auto-rebase is disabled", async () => {
		const enqueueSpy = vi.spyOn(
			edgeWorker as any,
			"enqueueGitHubConflictRebaseIfNeeded",
		);

		await (edgeWorker as any).handleGitHubPullRequestWebhook(
			pullRequestEvent(conflictedPullRequest()),
		);

		expect(enqueueSpy).not.toHaveBeenCalled();
	});

	it("queues same-repository conflicted PRs from external authors when enabled", async () => {
		(edgeWorker as any).config.githubConflictRebaseTrigger = true;
		(edgeWorker as any).config.githubConflictRebaseIncludeExternalAuthors =
			true;
		const pullRequest = conflictedPullRequest();
		stubConflictRebaseSideEffects(pullRequest);

		await (edgeWorker as any).enqueueGitHubConflictRebaseIfNeeded(
			pullRequestEvent(pullRequest),
			mockRepository,
			"pull_request",
		);

		expect(
			(edgeWorker as any).postGitHubPullRequestIssueComment,
		).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("Cyrus detected merge conflicts"),
		);
		expect((edgeWorker as any).linearSessionQueue).toHaveLength(1);
		expect((edgeWorker as any).linearSessionQueue[0]).toEqual(
			expect.objectContaining({
				origin: "github",
				task: "github-conflict-rebase",
				workItemIdentifier: "acme/web#12",
				sessionId: "github-conflict-rebase-acme-web-12-abcdef123456",
			}),
		);
		expect((edgeWorker as any).drainLinearSessionQueue).toHaveBeenCalled();
	});

	it("does not queue external-author conflicted PRs unless explicitly enabled", async () => {
		(edgeWorker as any).config.githubConflictRebaseTrigger = true;
		const pullRequest = conflictedPullRequest({
			title: "Fix checkout",
			body: null,
			head: {
				label: "acme:feature/checkout",
				ref: "feature/checkout",
				sha: "abcdef1234567890",
				repo: repositoryRef,
			},
		});
		stubConflictRebaseSideEffects(pullRequest);

		await (edgeWorker as any).enqueueGitHubConflictRebaseIfNeeded(
			pullRequestEvent(pullRequest),
			mockRepository,
			"pull_request",
		);

		expect(
			(edgeWorker as any).postGitHubPullRequestIssueComment,
		).not.toHaveBeenCalled();
		expect((edgeWorker as any).linearSessionQueue).toHaveLength(0);
	});

	it("does not queue forked conflicted PRs because the configured checkout cannot push them", async () => {
		(edgeWorker as any).config.githubConflictRebaseTrigger = true;
		(edgeWorker as any).config.githubConflictRebaseIncludeExternalAuthors =
			true;
		const forkRepo = {
			...repositoryRef,
			full_name: "external/web",
			owner: { ...repositoryRef.owner, login: "external" },
		};
		const pullRequest = conflictedPullRequest({
			head: {
				label: "external:feature/fc-4172-checkout",
				ref: "feature/fc-4172-checkout",
				sha: "abcdef1234567890",
				repo: forkRepo,
			},
		});
		stubConflictRebaseSideEffects(pullRequest);

		await (edgeWorker as any).enqueueGitHubConflictRebaseIfNeeded(
			pullRequestEvent(pullRequest),
			mockRepository,
			"pull_request",
		);

		expect(
			(edgeWorker as any).postGitHubPullRequestIssueComment,
		).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining(
				"head branch is not in the configured repository",
			),
		);
		expect((edgeWorker as any).linearSessionQueue).toHaveLength(0);
	});

	it("marks a GitHub PR as draft before follow-up work", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					node_id: "PR_kwDOExample",
					draft: false,
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						convertPullRequestToDraft: {
							pullRequest: { isDraft: true },
						},
					},
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		const changed = await (edgeWorker as any).setGitHubPullRequestDraftState(
			reviewEvent,
			true,
		);

		expect(changed).toBe(true);
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://api.github.com/repos/acme/web/pulls/12",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer token",
				}),
			}),
		);
		const graphBody = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(graphBody.query).toContain("convertPullRequestToDraft");
		expect(graphBody.variables).toEqual({ id: "PR_kwDOExample" });
	});

	it("marks a GitHub PR ready after follow-up work", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					node_id: "PR_kwDOExample",
					draft: true,
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					data: {
						markPullRequestReadyForReview: {
							pullRequest: { isDraft: false },
						},
					},
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		const changed = await (edgeWorker as any).setGitHubPullRequestDraftState(
			reviewEvent,
			false,
		);

		expect(changed).toBe(true);
		const graphBody = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(graphBody.query).toContain("markPullRequestReadyForReview");
		expect(graphBody.variables).toEqual({ id: "PR_kwDOExample" });
	});

	it("allows change requests for configured Cyrus PR authors", () => {
		process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS = "funnelcockpit-bot";

		const event = withPullRequest({
			user: { login: "funnelcockpit-bot" },
			head: { ref: "fix/checkout" },
		});

		expect((edgeWorker as any).isQueueableGitHubEvent(event)).toBe(true);
	});

	it("ignores change requests on PRs not opened by Cyrus", () => {
		process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS = "funnelcockpit-bot";

		const event = withPullRequest({
			title: "FC-4172: Fix checkout",
			body: "Linear issue: FC-4172",
			head: { ref: "cyrus2/fc-4172-checkout" },
			user: { login: "human-dev" },
		});

		expect((edgeWorker as any).isQueueableGitHubEvent(event)).toBe(false);
	});

	it("ignores change requests on already merged Cyrus PRs", () => {
		process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS = "funnelcockpit-bot";

		const event = withPullRequest({
			title: "FC-4442: Translate members area streaming design",
			body: "Linear issue: FC-4442",
			head: { ref: "cyrus/fc-4442-membersarea-streaming-design-not-fully" },
			user: { login: "funnelcockpit-bot" },
			state: "closed",
			merged: true,
			merged_at: "2026-04-29T12:00:00Z",
		});

		expect((edgeWorker as any).isQueueableGitHubEvent(event)).toBe(false);
	});

	it("ignores bot mentions on closed PR issues", () => {
		process.env.GITHUB_BOT_USERNAME = "funnelcockpit-bot";

		const event = {
			eventType: "issue_comment",
			deliveryId: "delivery-comment-closed-pr",
			payload: {
				action: "created",
				issue: {
					number: 99,
					title: "FC-4442: Translate members area streaming design",
					body: "Linear issue: FC-4442",
					state: "closed",
					pull_request: {
						url: "https://api.github.com/repos/acme/web/pulls/99",
						html_url: "https://github.com/acme/web/pull/99",
						diff_url: "https://github.com/acme/web/pull/99.diff",
						patch_url: "https://github.com/acme/web/pull/99.patch",
					},
				},
				comment: {
					id: 123,
					body: "@funnelcockpit-bot please handle this",
					user: { login: "reviewer" },
				},
				repository: {
					name: "web",
					full_name: "acme/web",
					owner: { login: "acme" },
				},
				sender: { login: "reviewer" },
			},
		};

		expect((edgeWorker as any).isQueueableGitHubEvent(event)).toBe(false);
	});

	it("recognizes Cyrus PR signatures when no PR author allowlist is configured", () => {
		delete process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS;
		delete process.env.GITHUB_BOT_USERNAME;

		const event = withPullRequest({
			title: "FC-4172: Fix checkout",
			body: "Linear issue: FC-4172",
			head: { ref: "cyrus2/fc-4172-checkout" },
			user: { login: "automation-user" },
		});

		expect((edgeWorker as any).isQueueableGitHubEvent(event)).toBe(true);
	});

	it("resolves the original Linear agent session for a GitHub follow-up", () => {
		(edgeWorker as any).agentSessionManager.getAllSessions = vi
			.fn()
			.mockReturnValue([
				{
					id: "linear-session-1",
					externalSessionId: "linear-session-1",
					updatedAt: 10,
					issueContext: {
						trackerId: "linear",
						issueIdentifier: "FC-4172",
					},
					issue: {
						identifier: "FC-4172",
					},
					repositories: [{ repositoryId: "test-repo" }],
				},
			]);

		const event = {
			...reviewEvent,
			payload: {
				...reviewEvent.payload,
				pull_request: {
					...reviewEvent.payload.pull_request,
					title: "FC-4172: Fix checkout",
					body: "Linear issue: FC-4172",
				},
			},
		};

		const link = (edgeWorker as any).resolveLinearSessionLinkForGitHubEvent(
			event,
			mockRepository,
			"fix/fc-4172-checkout",
		);

		expect(link).toEqual({
			sessionId: "linear-session-1",
			workspaceId: "test-workspace",
			issueIdentifier: "FC-4172",
		});
	});
});
