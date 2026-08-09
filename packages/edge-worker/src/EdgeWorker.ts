import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	statfs,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import type {
	McpServerConfig,
	SDKMessage,
	SessionStore,
	WarmQuery,
} from "cyrus-claude-runner";
import {
	buildBaseSessionEnv,
	ClaudeRunner,
	HttpSessionStore,
	normalizeMcpHttpTransport,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { CodexRunner } from "cyrus-codex-runner";
import { ConfigUpdater } from "cyrus-config-updater";
import type {
	AgentActivityCreateInput,
	AgentEvent,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	BaseBranchResolution,
	ContentUpdateMessage,
	CyrusAgentSession,
	EdgeWorkerConfig,
	GuidanceRule,
	IAgentRunner,
	IIssueTrackerService,
	ILogger,
	InternalMessage,
	Issue,
	IssueMinimal,
	IssueStateChangeMessage,
	IssueUnassignedWebhook,
	IssueUpdateWebhook,
	RepositoryConfig,
	RunnerType,
	SerializableEdgeWorkerState,
	SessionStartMessage,
	StopSignalMessage,
	UnassignMessage,
	UserPromptMessage,
	Webhook,
	WebhookAgentSession,
	WebhookIssue,
} from "cyrus-core";
import {
	CLIIssueTrackerService,
	CLIRPCServer,
	createLogger,
	DEFAULT_PROXY_URL,
	getDefaultWorktreesDir,
	getSessionTempDir,
	getSessionTempRoot,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	isContentUpdateMessage,
	isIssueAssignedWebhook,
	isIssueCommentMentionWebhook,
	isIssueDeletedWebhook,
	isIssueNewCommentWebhook,
	isIssueStateChangeMessage,
	isIssueStateChangeWebhook,
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedWebhook,
	isSessionStartMessage,
	isSessionTempDirName,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
	PersistenceManager,
	requireLinearWorkspaceId,
	resolvePath,
	WebhookIpValidator,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import { GeminiRunner } from "cyrus-gemini-runner";
import {
	extractCommentAuthor,
	extractCommentBody,
	extractCommentId,
	extractCommentUrl,
	extractPRBaseBranchRef,
	extractPRBranchRef,
	extractPRNumber,
	extractPRTitle,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
	extractSessionKey,
	GitHubAppTokenProvider,
	GitHubCommentService,
	type GitHubCommentWebhookEvent,
	GitHubEventTransport,
	type GitHubPullRequest,
	type GitHubPullRequestPayload,
	type GitHubPullRequestWebhookEvent,
	type GitHubPushPayload,
	type GitHubWebhookEvent,
	isCommentOnPullRequest,
	isIssueCommentPayload,
	isPullRequestReviewCommentPayload,
	isPullRequestReviewPayload,
	stripMention,
} from "cyrus-github-event-transport";
import type { GitLabWebhookEvent } from "cyrus-gitlab-event-transport";
import {
	extractDiscussionId,
	extractSessionKey as extractGitLabSessionKey,
	extractMRBaseBranchRef,
	extractMRBranchRef,
	extractMRIid,
	extractMRTitle,
	extractNoteAuthor,
	extractNoteBody,
	extractNoteId,
	extractNoteUrl,
	extractProjectId,
	extractProjectPath,
	GitLabCommentService,
	GitLabEventTransport,
	isNoteOnMergeRequest,
	stripMention as stripGitLabMention,
} from "cyrus-gitlab-event-transport";
import {
	LinearEventTransport,
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
	createFetchFailureModesClient,
	type FailureModesHttpClient,
	type ResolvedSession,
} from "cyrus-mcp-tools";
import {
	SlackEventTransport,
	type SlackWebhookEvent,
} from "cyrus-slack-event-transport";
import { Sessions, streamableHttp } from "fastify-mcp";
import { ActivityPoster } from "./ActivityPoster.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { AskUserQuestionHandler } from "./AskUserQuestionHandler.js";
import { AttachmentService } from "./AttachmentService.js";
import { LiveChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import { ChatSessionHandler } from "./ChatSessionHandler.js";
import { ConfigManager, type RepositoryChanges } from "./ConfigManager.js";
import { DefaultSkillsDeployer } from "./DefaultSkillsDeployer.js";
import { EgressProxy } from "./EgressProxy.js";
import { GitService } from "./GitService.js";
import { GlobalSessionRegistry } from "./GlobalSessionRegistry.js";
import { McpConfigService } from "./McpConfigService.js";
import { PromptBuilder } from "./PromptBuilder.js";
import type {
	IssueContextResult,
	PromptAssembly,
	PromptAssemblyInput,
	PromptComponent,
	PromptType,
} from "./prompt-assembly/types.js";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "./RepositoryRouter.js";
import {
	RunnerConfigBuilder,
	resolveIssueMcpConfigPath,
} from "./RunnerConfigBuilder.js";
import { RunnerSelectionService } from "./RunnerSelectionService.js";
import { SharedApplicationServer } from "./SharedApplicationServer.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "./SkillsPluginResolver.js";
import { SlackChatAdapter } from "./SlackChatAdapter.js";
import type { IActivitySink } from "./sinks/IActivitySink.js";
import { LinearActivitySink } from "./sinks/LinearActivitySink.js";
import { ToolPermissionResolver } from "./ToolPermissionResolver.js";
import type { AgentSessionData, EdgeWorkerEvents } from "./types.js";
import { UserAccessControl } from "./UserAccessControl.js";

export declare interface EdgeWorker {
	on<K extends keyof EdgeWorkerEvents>(
		event: K,
		listener: EdgeWorkerEvents[K],
	): this;
	emit<K extends keyof EdgeWorkerEvents>(
		event: K,
		...args: Parameters<EdgeWorkerEvents[K]>
	): boolean;
}

type CyrusToolsMcpContext = {
	contextId?: string;
};

type RateLimitHeaders =
	| Record<string, string | number | undefined>
	| { get(name: string): string | null };

type AgentSessionQueueOrigin = "linear" | "github";
type AgentSessionQueueTask = "agent-session" | "github-conflict-rebase";

type AgentSessionQueueItem = {
	origin: AgentSessionQueueOrigin;
	task?: AgentSessionQueueTask;
	workItemIdentifier: string;
	sessionId: string;
	queuedAt: number;
	availableAt: number;
	retryCount: number;
	lastError?: string;
	startedAt?: number;
	prioritizedAt?: number;
	recoveredAt?: number;
	webhook?: AgentSessionCreatedWebhook;
	repoIds?: string[];
	githubEvent?: GitHubCommentWebhookEvent;
	githubPullRequestEvent?: GitHubPullRequestWebhookEvent;
	githubRepositoryId?: string;
};

type SerializedAgentSessionQueueItem = AgentSessionQueueItem & {
	state?: "queued" | "running";
	/** @deprecated Older queue files used issueIdentifier for Linear-only items. */
	issueIdentifier?: string;
	/** @deprecated Older queue files stored Linear payloads without origin. */
	webhook?: AgentSessionCreatedWebhook;
	/** @deprecated Older queue files stored repo IDs as a top-level field. */
	repoIds?: string[];
};

type OperationalAlertSeverity = "info" | "warning" | "error";

type OperationalAlert = {
	key: string;
	severity: OperationalAlertSeverity;
	title: string;
	message: string;
	createdAt: number;
	lastSentAt?: number;
	sendCount: number;
};

type GarbageCollectionSummary = {
	reason: string;
	startedAt: string;
	finishedAt?: string;
	scannedWorktrees: number;
	removedWorktrees: number;
	scannedBranches: number;
	removedLocalBranches: number;
	removedRemoteBranches: number;
	scannedTempDirs: number;
	removedTempDirs: number;
	removedSessions: number;
	removedRegistrySessions: number;
	removedInactiveWorktrees: number;
	skippedProtected: number;
	skippedOpenPullRequests: number;
	skippedUnknownPullRequests: number;
	skippedFreshWorktrees: number;
	skippedDirtyWorktrees: number;
	skippedBecauseBusy?: boolean;
	errors: string[];
};

type GarbageCollectionProtection = {
	issueIdentifiers: Set<string>;
	branchNames: Set<string>;
	tempDirNames: Set<string>;
};

type WorktreeBranchRef = {
	path: string;
	branch: string;
	repoPath: string;
};

type PullRequestGarbageCollectionState = {
	state?: string;
	mergedAt?: string | null;
	closedAt?: string | null;
	url?: string;
	headRefName?: string;
};

type InactiveWorktreeRemovalBlocker = "fresh" | "dirty" | "stat";

type LinearSessionLink = {
	sessionId: string;
	workspaceId: string;
	issueIdentifier: string;
};

const DEFAULT_GC_INTERVAL_MS = 3_600_000;
const DEFAULT_GC_MAX_REMOVALS_PER_RUN = 50;

/**
 * Unified edge worker that **orchestrates**
 *   capturing Linear webhooks,
 *   managing Claude Code processes, and
 *   processes results through to Linear Agent Activity Sessions
 */
export class EdgeWorker extends EventEmitter {
	private config: EdgeWorkerConfig;
	private repositories: Map<string, RepositoryConfig> = new Map(); // repository 'id' (internal, stored in config.json) mapped to the full repo config
	private agentSessionManager: AgentSessionManager; // Single instance managing all agent sessions across repositories
	private activitySinks: Map<string, IActivitySink> = new Map(); // Maps Linear workspace ID to activity sink (one per workspace, mirrors issueTrackers)
	private sessionRepositories: Map<string, string> = new Map(); // Maps session ID to repository ID
	private lastStopTimeBySession: Map<string, number> = new Map(); // Maps session ID to timestamp of last stop signal (for double-stop detection)
	private warmInstances: Map<string, WarmQuery> = new Map(); // Pre-warmed Claude sessions keyed by agentSessionId
	private issueTrackers: Map<string, IIssueTrackerService> = new Map(); // one issue tracker per Linear workspace (keyed by linearWorkspaceId)
	private linearEventTransport: LinearEventTransport | null = null; // Single event transport for webhook delivery
	private gitHubEventTransport: GitHubEventTransport | null = null; // GitHub event transport for forwarded GitHub webhooks
	private gitHubAppTokenProvider: GitHubAppTokenProvider | null = null; // Self-hosted GitHub App token minting
	private gitLabEventTransport: GitLabEventTransport | null = null; // GitLab event transport for forwarded GitLab webhooks
	private slackEventTransport: SlackEventTransport | null = null;
	private chatSessionHandler: ChatSessionHandler<SlackWebhookEvent> | null =
		null;
	private gitHubCommentService: GitHubCommentService; // Service for posting comments back to GitHub PRs
	private gitLabCommentService: GitLabCommentService; // Service for posting comments back to GitLab MRs
	private cliRPCServer: CLIRPCServer | null = null; // CLI RPC server for CLI platform mode
	private configUpdater: ConfigUpdater | null = null; // Single config updater for configuration updates
	private persistenceManager: PersistenceManager;
	private sharedApplicationServer: SharedApplicationServer;
	private cyrusHome: string;
	private globalSessionRegistry: GlobalSessionRegistry; // Centralized session storage across all repositories
	private configPath?: string; // Path to config.json file
	/** @internal - Exposed for testing only */
	public repositoryRouter: RepositoryRouter; // Repository routing and selection
	private gitService: GitService;
	private activeWebhookCount = 0; // Track number of webhooks currently being processed
	private linearSessionQueue: AgentSessionQueueItem[] = [];
	private linearSessionActiveItems: Map<string, AgentSessionQueueItem> =
		new Map();
	private linearSessionQueueFile: string;
	private linearSessionQueueSavePromise: Promise<void> = Promise.resolve();
	private linearSessionQueueDrainTimer: NodeJS.Timeout | null = null;
	private operationalMonitorTimer: NodeJS.Timeout | null = null;
	private garbageCollectionTimer: NodeJS.Timeout | null = null;
	private garbageCollectionRunning = false;
	private lastGarbageCollectionSummary: GarbageCollectionSummary | null = null;
	private operationalAlerts: OperationalAlert[] = [];
	private operationalAlertLastSentByKey = new Map<string, number>();
	private linearSessionCooldownUntil = 0;
	private readonly linearSessionQueueConcurrency = Math.max(
		1,
		Number.parseInt(process.env.CYRUS_LINEAR_CONCURRENCY || "2", 10) || 2,
	);
	private readonly linearSessionMaxRetries = Math.max(
		0,
		Number.parseInt(process.env.CYRUS_LINEAR_MAX_RETRIES || "2", 10) || 2,
	);
	private readonly linearSessionRetryDelayMs = Math.max(
		1_000,
		Number.parseInt(process.env.CYRUS_LINEAR_RETRY_DELAY_MS || "300000", 10) ||
			300_000,
	);
	private readonly linearSessionTimeoutMs = Math.max(
		60_000,
		Number.parseInt(
			process.env.CYRUS_LINEAR_SESSION_TIMEOUT_MS || "5400000",
			10,
		) || 5_400_000,
	);
	private readonly linearRateLimitFallbackMs = Math.max(
		60_000,
		Number.parseInt(
			process.env.CYRUS_LINEAR_RATE_LIMIT_COOLDOWN_MS || "3900000",
			10,
		) || 3_900_000,
	);
	private readonly interruptedSessionRecoveryLookbackMs = Math.max(
		60_000,
		Number.parseInt(
			process.env.CYRUS_RECOVER_ACTIVE_SESSION_LOOKBACK_MS || "7200000",
			10,
		) || 7_200_000,
	);
	private readonly garbageCollectionEnabled =
		process.env.CYRUS_GC_ENABLED?.toLowerCase().trim() !== "false";
	private readonly garbageCollectionIntervalMs = Math.max(
		300_000,
		Number.parseInt(
			process.env.CYRUS_GC_INTERVAL_MS || String(DEFAULT_GC_INTERVAL_MS),
			10,
		) || DEFAULT_GC_INTERVAL_MS,
	);
	private readonly garbageCollectionSessionTtlMs = Math.max(
		3_600_000,
		Number.parseInt(process.env.CYRUS_GC_SESSION_TTL_MS || "604800000", 10) ||
			604_800_000,
	);
	private readonly garbageCollectionTerminalPrGraceMs = Math.max(
		0,
		Number.parseInt(
			process.env.CYRUS_GC_TERMINAL_PR_GRACE_MS || "3600000",
			10,
		) || 3_600_000,
	);
	private readonly garbageCollectionWorktreeTtlMs = Math.max(
		600_000,
		Number.parseInt(process.env.CYRUS_GC_WORKTREE_TTL_MS || "3600000", 10) ||
			3_600_000,
	);
	private readonly garbageCollectionDeleteRemoteBranches =
		process.env.CYRUS_GC_DELETE_REMOTE_BRANCHES?.toLowerCase().trim() ===
		"true";
	private readonly garbageCollectionRunWhenBusy =
		process.env.CYRUS_GC_RUN_WHEN_BUSY?.toLowerCase().trim() !== "false";
	private readonly garbageCollectionMaxRemovalsPerRun = Math.max(
		1,
		Number.parseInt(
			process.env.CYRUS_GC_MAX_REMOVALS_PER_RUN ||
				String(DEFAULT_GC_MAX_REMOVALS_PER_RUN),
			10,
		) || DEFAULT_GC_MAX_REMOVALS_PER_RUN,
	);
	private readonly garbageCollectionTempTtlMs = Math.max(
		60_000,
		Number.parseInt(process.env.CYRUS_GC_TEMP_TTL_MS || "3600000", 10) ||
			3_600_000,
	);
	private readonly diskGuardEnabled =
		process.env.CYRUS_DISK_GUARD_ENABLED?.toLowerCase().trim() !== "false";
	private readonly diskGuardMinFreeBytes = Math.max(
		0,
		Number.parseInt(
			process.env.CYRUS_DISK_GUARD_MIN_FREE_BYTES || "10737418240",
			10,
		) || 10_737_418_240,
	);
	private readonly diskGuardMinFreePercent = Math.max(
		0,
		Number.parseFloat(process.env.CYRUS_DISK_GUARD_MIN_FREE_PERCENT || "5") ||
			5,
	);
	private readonly operationalMonitorIntervalMs = Math.max(
		30_000,
		Number.parseInt(
			process.env.CYRUS_ALERT_MONITOR_INTERVAL_MS || "60000",
			10,
		) || 60_000,
	);
	private readonly queueWaitAlertMs = Math.max(
		60_000,
		Number.parseInt(process.env.CYRUS_ALERT_QUEUE_WAIT_MS || "900000", 10) ||
			900_000,
	);
	private readonly activeTaskAlertMs = Math.max(
		60_000,
		Number.parseInt(
			process.env.CYRUS_ALERT_ACTIVE_TASK_MS ||
				String(Math.min(this.linearSessionTimeoutMs, 5_400_000)),
			10,
		) || Math.min(this.linearSessionTimeoutMs, 5_400_000),
	);
	private readonly operationalAlertDedupeMs = Math.max(
		60_000,
		Number.parseInt(process.env.CYRUS_ALERT_DEDUPE_MS || "1800000", 10) ||
			1_800_000,
	);
	/** Handler for AskUserQuestion tool invocations via Linear select signal */
	private askUserQuestionHandler: AskUserQuestionHandler;
	/** User access control for whitelisting/blacklisting Linear users */
	private userAccessControl: UserAccessControl;
	private logger: ILogger;
	// Extracted service modules
	private attachmentService: AttachmentService;
	private runnerSelectionService: RunnerSelectionService;
	private toolPermissionResolver: ToolPermissionResolver;
	private mcpConfigService: McpConfigService;
	private runnerConfigBuilder: RunnerConfigBuilder;
	private activityPoster: ActivityPoster;
	private configManager: ConfigManager;
	private promptBuilder: PromptBuilder;
	private defaultSkillsDeployer: DefaultSkillsDeployer;
	private skillsPluginResolver: SkillsPluginResolver;
	private readonly cyrusToolsMcpEndpoint = "/mcp/cyrus-tools";
	private cyrusToolsMcpRegistered = false;
	private cyrusToolsMcpRequestContext =
		new AsyncLocalStorage<CyrusToolsMcpContext>();
	private cyrusToolsMcpSessions = new Sessions<any>();
	/** Validates webhook source IPs against known provider allowlists */
	private webhookIpValidator: WebhookIpValidator;
	/** Egress proxy for sandbox network traffic filtering and header injection */
	private egressProxy: EgressProxy | null = null;
	/** Base SDK sandbox settings to pass to ClaudeRunner sessions (set when proxy starts) */
	private sdkSandboxSettings:
		| import("cyrus-claude-runner").SandboxSettings
		| null = null;
	/** CA cert path for MITM TLS termination (passed per-session env, not process.env) */
	private egressCaCertPath: string | null = null;
	/**
	 * Remote SessionStore that mirrors Claude SDK transcripts to the Cyrus
	 * hosted control plane. Enabled when all three of `CYRUS_APP_URL`,
	 * `CYRUS_API_KEY`, and `CYRUS_TEAM_ID` are set — used by any Claude
	 * runner spawned from this worker so transcripts survive ephemeral
	 * worktrees and are resumable from any host.
	 */
	private claudeSessionStore: SessionStore | null = null;
	/**
	 * Tracks recently processed issue-update webhook keys to prevent
	 * duplicate deliveries from Linear's at-least-once delivery.
	 * Key format: `${createdAt}:${issueId}`
	 */
	private processedIssueUpdateKeys = new Set<string>();

	/**
	 * Sessions parked due to blocked-by dependencies.
	 * Key: Linear issue ID (the blocked issue)
	 * Value: All data needed to replay initializeAgentRunner when unblocked
	 */
	private parkedSessions = new Map<
		string,
		{
			agentSession: AgentSessionCreatedWebhook["agentSession"];
			repositories: RepositoryConfig[];
			linearWorkspaceId: string;
			guidance?: AgentSessionCreatedWebhook["guidance"];
			commentBody?: string | null;
			baseBranchOverrides?: Map<string, string>;
			routingMethod?: string;
			blockingIssueIds: string[];
		}
	>();

	/**
	 * Resolve `~/` prefixes in path-bearing config fields that are otherwise
	 * passed verbatim to `fs.readFileSync` (which does not expand tildes).
	 * Repository-scoped paths are normalized separately in addNew /
	 * updateModified; this covers the platform-level MCP config lists that
	 * cyrus-hosted writes with literal `~/.cyrus/...` prefixes when
	 * generating self-host config.
	 */
	private static normalizeConfigPaths(
		config: EdgeWorkerConfig,
	): EdgeWorkerConfig {
		const resolveList = (paths: string[] | undefined): string[] | undefined =>
			paths ? paths.map(resolvePath) : undefined;
		return {
			...config,
			slackMcpConfigs: resolveList(config.slackMcpConfigs),
			linearMcpConfigs: resolveList(config.linearMcpConfigs),
			githubMcpConfigs: resolveList(config.githubMcpConfigs),
		};
	}

	constructor(config: EdgeWorkerConfig) {
		super();
		this.config = EdgeWorker.normalizeConfigPaths(config);
		this.cyrusHome = config.cyrusHome;
		this.linearSessionQueueFile = join(
			this.cyrusHome,
			"linear-session-queue.json",
		);
		this.logger = createLogger({ component: "EdgeWorker" });
		this.persistenceManager = new PersistenceManager(
			join(this.cyrusHome, "state"),
		);

		// Mirror Claude SDK session transcripts to the hosted control plane
		// when CYRUS_API_KEY (proof of team ownership) and CYRUS_TEAM_ID
		// (which team the transcripts belong to) are configured. The
		// destination URL defaults to DEFAULT_CYRUS_APP_URL but can be
		// overridden via CYRUS_APP_URL for preview environments. If either
		// of the required vars is missing the store stays null and the SDK
		// falls back to local JSONL only. Operators can also opt out
		// explicitly by setting CYRUS_DISABLE_REMOTE_SESSION_STORE=1, which
		// keeps transcripts local even when the vars above are present.
		const sessionStoreBaseUrl = getCyrusAppUrl();
		const sessionStoreApiKey = process.env.CYRUS_API_KEY;
		const sessionStoreTeamId = process.env.CYRUS_TEAM_ID;
		const sessionStoreDisabled = this.isRemoteSessionStoreDisabled();
		if (!sessionStoreDisabled && sessionStoreApiKey && sessionStoreTeamId) {
			this.claudeSessionStore = new HttpSessionStore({
				baseUrl: sessionStoreBaseUrl,
				apiKey: sessionStoreApiKey,
				teamId: sessionStoreTeamId,
				logger: this.logger,
			});
			this.logger.info(
				`[SessionStore] Mirroring Claude sessions to ${sessionStoreBaseUrl} for team ${sessionStoreTeamId}`,
			);
		} else if (
			sessionStoreDisabled &&
			sessionStoreApiKey &&
			sessionStoreTeamId
		) {
			this.logger.info(
				"[SessionStore] Remote session store disabled via CYRUS_DISABLE_REMOTE_SESSION_STORE; transcripts will stay local.",
			);
		}

		// Initialize GitHub comment service for posting replies to GitHub PRs
		this.gitHubCommentService = new GitHubCommentService();

		// Initialize GitLab comment service for posting replies to GitLab MRs.
		// For Self-Managed GitLab the API base URL must be derived from the
		// configured repos' gitlabUrl host; otherwise the service falls back to
		// gitlab.com and 404s on every reply. Picks the first configured
		// GitLab repo's host (single GitLab host per Cyrus instance).
		const firstGitlabRepo = config.repositories.find((r) => r.gitlabUrl);
		let gitlabApiBaseUrl: string | undefined;
		if (firstGitlabRepo?.gitlabUrl) {
			try {
				gitlabApiBaseUrl = new URL(firstGitlabRepo.gitlabUrl).origin;
			} catch {
				// malformed gitlabUrl — leave undefined and fall through to default
			}
		}
		this.gitLabCommentService = new GitLabCommentService(
			gitlabApiBaseUrl ? { apiBaseUrl: gitlabApiBaseUrl } : undefined,
		);

		// Initialize global session registry (centralized session storage)
		this.globalSessionRegistry = new GlobalSessionRegistry();

		// Initialize repository router with dependencies
		const repositoryRouterDeps: RepositoryRouterDeps = {
			fetchIssueLabels: async (issueId: string, linearWorkspaceId: string) => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return [];

				// Use platform-agnostic getIssueLabels method
				return await issueTracker.getIssueLabels(issueId);
			},
			fetchIssueDescription: async (
				issueId: string,
				linearWorkspaceId: string,
			): Promise<string | undefined> => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return undefined;

				// Fetch issue and get description
				try {
					const issue = await issueTracker.fetchIssue(issueId);
					return issue?.description ?? undefined;
				} catch (error) {
					this.logger.error(
						`Failed to fetch issue description for routing:`,
						error,
					);
					return undefined;
				}
			},
			hasActiveSession: (issueId: string, _repositoryId: string) => {
				const activeSessions =
					this.agentSessionManager.getActiveSessionsByIssueId(issueId);
				return activeSessions.length > 0;
			},
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId);
			},
		};
		this.repositoryRouter = new RepositoryRouter(repositoryRouterDeps);
		this.gitService = new GitService({ cyrusHome: this.cyrusHome });

		// Initialize AskUserQuestion handler for elicitation via Linear select signal
		this.askUserQuestionHandler = new AskUserQuestionHandler({
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId) ?? null;
			},
		});

		// Initialize webhook IP validator
		// Enabled by default in self-hosted mode (CYRUS_HOST_EXTERNAL=true),
		// can be overridden with WEBHOOK_IP_VALIDATION=false to disable
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const ipValidationEnv =
			process.env.WEBHOOK_IP_VALIDATION?.toLowerCase().trim();
		const ipValidationEnabled =
			ipValidationEnv === "true" ||
			(ipValidationEnv !== "false" && isExternalHost);
		this.webhookIpValidator = new WebhookIpValidator({
			enabled: ipValidationEnabled,
		});
		if (ipValidationEnabled) {
			this.logger.info("Webhook IP validation enabled");
		}

		// Initialize shared application server
		const serverPort = config.serverPort || config.webhookPort || 3456;
		const serverHost = config.serverHost || "localhost";
		const skipTunnel = config.platform === "cli"; // Skip Cloudflare tunnel in CLI mode
		this.sharedApplicationServer = new SharedApplicationServer(
			serverPort,
			serverHost,
			skipTunnel,
		);

		// Create single AgentSessionManager instance shared across all repositories
		this.agentSessionManager = new AgentSessionManager(
			(childSessionId: string) => {
				this.logger.debug(
					`Looking up parent session for child ${childSessionId}`,
				);
				const parentId =
					this.globalSessionRegistry.getParentSessionId(childSessionId);
				this.logger.debug(
					`Child ${childSessionId} -> Parent ${parentId || "not found"}`,
				);
				return parentId;
			},
			async (parentSessionId, prompt, childSessionId) => {
				const repoId = this.sessionRepositories.get(childSessionId);
				const repo = repoId ? this.repositories.get(repoId) : undefined;
				if (!repo) {
					this.logger.error(
						`No repository found for child session ${childSessionId}`,
					);
					return;
				}
				await this.handleResumeParentSession(
					parentSessionId,
					prompt,
					childSessionId,
				);
			},
			undefined,
			(alert) => this.sendOperationalAlert(alert),
		);

		// Initialize repositories with path resolution
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				this.repositories.set(repo.id, resolvedRepo);
			}
		}

		// Initialize issue trackers per workspace (one per workspace, not per repo)
		if (config.linearWorkspaces) {
			for (const [linearWorkspaceId, wsConfig] of Object.entries(
				config.linearWorkspaces,
			)) {
				const issueTracker =
					this.config.platform === "cli"
						? (() => {
								const service = new CLIIssueTrackerService();
								service.seedDefaultData();
								return service;
							})()
						: new LinearIssueTrackerService(
								new LinearClient({
									accessToken: wsConfig.linearToken,
								}),
								this.buildOAuthConfig(linearWorkspaceId),
							);
				this.issueTrackers.set(linearWorkspaceId, issueTracker);
			}
		}

		// Create activity sinks per workspace (one per workspace, mirrors issueTrackers)
		for (const [workspaceId, issueTracker] of this.issueTrackers) {
			this.activitySinks.set(
				workspaceId,
				new LinearActivitySink(issueTracker, workspaceId),
			);
		}

		// Initialize user access control with global and per-repository configs
		const repoAccessConfigs = new Map<
			string,
			import("cyrus-core").UserAccessControlConfig | undefined
		>();
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				repoAccessConfigs.set(repo.id, repo.userAccessControl);
			}
		}
		this.userAccessControl = new UserAccessControl(
			config.userAccessControl,
			repoAccessConfigs,
		);

		// Initialize extracted service modules
		this.attachmentService = new AttachmentService(
			this.logger,
			this.cyrusHome,
			this.config.linearWorkspaces || {},
		);
		this.runnerSelectionService = new RunnerSelectionService(this.config);
		this.toolPermissionResolver = new ToolPermissionResolver(
			this.config,
			this.logger,
		);
		this.mcpConfigService = new McpConfigService({
			getLinearTokenForWorkspace: (workspaceId) =>
				this.getLinearTokenForWorkspace(workspaceId),
			getIssueTracker: (workspaceId) =>
				this.issueTrackers.get(workspaceId) as
					| (IIssueTrackerService & {
							getClient?: () => import("@linear/sdk").LinearClient;
					  })
					| undefined,
			getCyrusToolsMcpUrl: () => this.getCyrusToolsMcpUrl(),
			createCyrusToolsOptions: (parentSessionId) =>
				this.createCyrusToolsOptions(parentSessionId),
		});
		this.runnerConfigBuilder = new RunnerConfigBuilder(
			this.toolPermissionResolver,
			this.mcpConfigService,
			this.runnerSelectionService,
		);
		this.activityPoster = new ActivityPoster(
			this.issueTrackers,
			this.repositories,
			this.logger,
		);
		this.configManager = new ConfigManager(
			this.config,
			this.logger,
			this.configPath,
			this.repositories,
		);
		this.promptBuilder = new PromptBuilder({
			logger: this.logger,
			repositories: this.repositories,
			issueTrackers: this.issueTrackers,
			gitService: this.gitService,
		});
		this.defaultSkillsDeployer = new DefaultSkillsDeployer(
			this.cyrusHome,
			this.logger,
		);
		this.skillsPluginResolver = new SkillsPluginResolver(
			this.cyrusHome,
			this.logger,
		);

		// Components will be initialized and registered in start() method before server starts
	}

	/**
	 * Start the edge worker
	 */
	async start(): Promise<void> {
		// Deploy default skills to cyrusHome if not already present (one-time setup)
		await this.defaultSkillsDeployer.ensureDeployed();

		// Scaffold user skills plugin manifest if needed (one-time setup)
		await this.skillsPluginResolver.ensureUserPluginScaffolded();

		// Load persisted state for each repository
		await this.loadPersistedState();

		// Pre-warm the 30 most recent Claude sessions in the background
		// so their first query after restart has near-zero cold-start latency.
		// Disabled by default; opt in with CYRUS_ENABLE_WARM_SESSIONS=1.
		if (this.isWarmSessionsEnabled()) {
			this.warmupRecentSessions(30).catch((err) => {
				this.logger.warn("Session warmup failed (non-fatal):", err);
			});
		}

		// Start config file watcher via ConfigManager
		this.configManager.on(
			"configChanged",
			async (changes: RepositoryChanges) => {
				this.updateLinearWorkspaceTokens(changes.newConfig);
				await this.removeDeletedRepositories(changes.removed);
				await this.updateModifiedRepositories(changes.modified);
				await this.addNewRepositories(changes.added);
				// Live-update sandbox / egress proxy settings
				await this.applySandboxConfigChanges(changes.newConfig);
				this.config = EdgeWorker.normalizeConfigPaths(changes.newConfig);
				this.configManager.setConfig(changes.newConfig);
				this.runnerSelectionService.setConfig(changes.newConfig);
				this.toolPermissionResolver.setConfig(changes.newConfig);
			},
		);
		this.configManager.startConfigWatcher();

		// Start egress proxy if sandbox is enabled.
		// The proxy intercepts Bash-spawned subprocess traffic only (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		if (this.config.sandbox?.enabled) {
			this.logger.info("🛡️  Sandbox egress proxy: starting...");
			this.egressProxy = new EgressProxy(
				this.config.sandbox,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			// Store base SDK sandbox settings — merged per-session with worktree path
			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};

			const systemWideCert = this.config.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			// When systemWideCert is true, the OS cert store handles trust
			// for all tools — skip per-session cert env vars.
			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else {
			this.logger.info(
				"🛡️  Sandbox egress proxy: disabled (set sandbox.enabled=true in config.json to enable)",
			);
		}

		// Initialize and register components BEFORE starting server (routes must be registered before listen())
		await this.initializeComponents();

		// Refresh GitHub webhook allowlist from /meta API (non-blocking)
		if (this.webhookIpValidator.isEnabled()) {
			this.webhookIpValidator.refreshGitHubAllowlist().catch((error) => {
				this.logger.warn(
					"Failed to refresh GitHub webhook allowlist",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		}

		// Start shared application server (this also starts Cloudflare tunnel if CLOUDFLARE_TOKEN is set)
		await this.sharedApplicationServer.start();

		await this.loadLinearSessionQueue();
		await this.recoverInterruptedActiveLinearSessionsFromState();
		this.drainLinearSessionQueue();
		this.startOperationalMonitor();
		this.startGarbageCollector();
		void this.sendOperationalAlert({
			key: "process-start",
			severity: "info",
			title: "Cyrus restarted",
			message: "Cyrus started and loaded its durable queue.",
		});
	}

	/**
	 * Initialize and register components (routes) before server starts
	 */
	private async initializeComponents(): Promise<void> {
		// 1. Platform-specific initialization
		if (this.config.platform === "cli") {
			// CLI mode: ensure a CLIIssueTrackerService exists for each repo workspace.
			// Repos from config.repositories don't go through linearWorkspaces init,
			// so we create trackers here if missing.
			for (const [repoId, repo] of this.repositories) {
				const wsId = repo.linearWorkspaceId;
				if (wsId && !this.issueTrackers.has(wsId)) {
					const service = new CLIIssueTrackerService();
					service.seedDefaultData();
					this.issueTrackers.set(wsId, service);
					const activitySink = new LinearActivitySink(service, wsId);
					this.activitySinks.set(repoId, activitySink);
				}
			}

			const firstCliTracker = Array.from(this.issueTrackers.values()).find(
				(tracker): tracker is CLIIssueTrackerService =>
					tracker instanceof CLIIssueTrackerService,
			);

			if (firstCliTracker) {
				this.cliRPCServer = new CLIRPCServer({
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
					issueTracker: firstCliTracker,
					version: "1.0.0",
				});

				// Register the /cli/rpc endpoint
				this.cliRPCServer.register();

				this.logger.info("✅ CLI RPC server registered");
				this.logger.info("   RPC endpoint: /cli/rpc");

				// Create CLI event transport and register listener
				const cliEventTransport = firstCliTracker.createEventTransport({
					platform: "cli",
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				});

				// Listen for webhook events
				cliEventTransport.on("event", (event: AgentEvent) => {
					const repos = Array.from(this.repositories.values());
					this.handleWebhook(event as unknown as Webhook, repos);
				});

				// Listen for unified internal messages (used by F1 to emit
				// IssueStateChangeMessage when an issue is terminated).
				cliEventTransport.on("message", (message: InternalMessage) => {
					this.handleMessage(message);
				});

				// Listen for errors
				cliEventTransport.on("error", (error: Error) => {
					this.handleError(error);
				});

				// Register the CLI event transport endpoints
				cliEventTransport.register();

				this.logger.info("✅ CLI event transport registered");
				this.logger.info(
					"   Event listener: listening for AgentSessionCreated events",
				);
			}
		} else {
			// Linear mode: Create and register LinearEventTransport
			const useDirectWebhooks =
				process.env.LINEAR_DIRECT_WEBHOOKS?.toLowerCase() === "true";
			const verificationMode = useDirectWebhooks ? "direct" : "proxy";

			// Get appropriate secret based on mode
			const secret = useDirectWebhooks
				? process.env.LINEAR_WEBHOOK_SECRET || ""
				: process.env.CYRUS_API_KEY || "";

			this.linearEventTransport = new LinearEventTransport({
				fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				verificationMode,
				secret,
				ipAllowlist:
					verificationMode === "direct" && this.webhookIpValidator.isEnabled()
						? this.webhookIpValidator.getAllowlist("linear")
						: undefined,
			});

			// Listen for legacy webhook events (deprecated, kept for backward compatibility)
			this.linearEventTransport.on("event", (event: AgentEvent) => {
				const repos = Array.from(this.repositories.values());
				this.handleWebhook(event as unknown as Webhook, repos);
			});

			// Listen for unified internal messages (new message bus)
			this.linearEventTransport.on("message", (message: InternalMessage) => {
				this.handleMessage(message);
			});

			// Listen for errors
			this.linearEventTransport.on("error", (error: Error) => {
				this.handleError(error);
			});

			// Register the /linear-webhook endpoint (with /webhook retained as a deprecated alias)
			this.linearEventTransport.register();

			this.logger.info(
				`✅ Linear event transport registered (${verificationMode} mode)`,
			);
			this.logger.info(
				`   Webhook endpoint: ${this.sharedApplicationServer.getWebhookUrl()}`,
			);
		}

		// 2. Register GitHub and Slack event transports unconditionally
		// These don't require repositories and must be available during onboarding
		// for webhook URL verification to succeed.
		this.registerGitHubEventTransport();
		this.registerGitLabEventTransport();
		this.registerSlackEventTransport();

		// 3. Create and register ConfigUpdater (both platforms)
		this.configUpdater = new ConfigUpdater(
			this.sharedApplicationServer.getFastifyInstance(),
			this.cyrusHome,
			() => process.env.CYRUS_API_KEY || "",
		);

		// Register config update routes
		this.configUpdater.register();

		this.logger.info("✅ Config updater registered");
		this.logger.info(
			"   Routes: /api/update/cyrus-config, /api/update/cyrus-env,",
		);
		this.logger.info(
			"           /api/update/repository, /api/update/test-mcp, /api/update/configure-mcp",
		);

		// 3. Register MCP endpoint for cyrus-tools on the same Fastify server/port
		await this.registerCyrusToolsMcpEndpoint();
		// 4. Register dashboard and status endpoints for process activity monitoring
		this.registerDashboardEndpoint();
		this.registerStatusEndpoint();

		// 5. Register /version endpoint for CLI version info
		this.registerVersionEndpoint();
	}

	/**
	 * Register the root dashboard for quick operational visibility.
	 */
	private registerDashboardEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/", async (_request, reply) => {
			return reply
				.status(200)
				.header("content-type", "text/html; charset=utf-8")
				.send(this.renderDashboardHtml());
		});

		this.logger.info("✅ Dashboard endpoint registered");
		this.logger.info("   Route: GET /");
	}

	/**
	 * Register the /status endpoint for checking if the process is busy or idle
	 * This endpoint is used to determine if the process can be safely restarted
	 */
	private registerStatusEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/status", async (_request, reply) => {
			return reply.status(200).send(this.buildStatusPayload());
		});

		fastify.get("/linear-queue", async (_request, reply) => {
			return reply.status(200).send(this.buildLinearQueueStatus());
		});

		fastify.get("/agent-queue", async (_request, reply) => {
			return reply.status(200).send(this.buildLinearQueueStatus());
		});

		fastify.post("/agent-queue/gc", async (request, reply) => {
			if (!this.isLoopbackRequestAddress(request.ip)) {
				return reply.status(403).send({
					ok: false,
					error:
						"Garbage collection can only be triggered locally on the Cyrus host.",
				});
			}

			const body = request.body as
				| { reason?: string; ignoreBusy?: boolean }
				| undefined;
			const reason = body?.reason?.trim() || "manual";
			await this.runGarbageCollection(reason, {
				ignoreBusy: body?.ignoreBusy ?? true,
			});
			const disk = await this.getDiskAvailability(this.cyrusHome).catch(
				() => null,
			);
			return reply.status(200).send({
				ok: true,
				garbageCollection: this.lastGarbageCollectionSummary,
				disk,
			});
		});

		fastify.post(
			"/agent-queue/github-conflict-rebase/scan",
			async (request, reply) => {
				if (!this.isLoopbackRequestAddress(request.ip)) {
					return reply.status(403).send({
						ok: false,
						error:
							"Conflict rebase scans can only be triggered locally on the Cyrus host.",
					});
				}

				const body = request.body as
					| { repositoryId?: string; baseBranch?: string }
					| undefined;
				const result = await this.scanConfiguredGitHubPullRequestsForConflicts({
					repositoryId: body?.repositoryId,
					baseBranch: body?.baseBranch,
				});
				return reply.status(result.statusCode).send(result.body);
			},
		);

		fastify.post(
			"/agent-queue/:sessionId/prioritize",
			async (request, reply) => {
				const params = request.params as { sessionId?: string };
				const sessionId = params.sessionId?.trim();
				if (!sessionId) {
					return reply.status(400).send({
						ok: false,
						error: "Missing queue session id.",
					});
				}

				const result = await this.prioritizeAgentQueueItem(sessionId);
				return reply.status(result.statusCode).send(result.body);
			},
		);

		fastify.post(
			"/linear-queue/:sessionId/prioritize",
			async (request, reply) => {
				const params = request.params as { sessionId?: string };
				const sessionId = params.sessionId?.trim();
				if (!sessionId) {
					return reply.status(400).send({
						ok: false,
						error: "Missing queue session id.",
					});
				}

				const result = await this.prioritizeAgentQueueItem(sessionId);
				return reply.status(result.statusCode).send(result.body);
			},
		);

		this.logger.info("✅ Status endpoint registered");
		this.logger.info("   Route: GET /status");
		this.logger.info("   Route: GET /linear-queue");
		this.logger.info("   Route: GET /agent-queue");
		this.logger.info("   Route: POST /agent-queue/gc");
		this.logger.info("   Route: POST /agent-queue/github-conflict-rebase/scan");
		this.logger.info("   Route: POST /agent-queue/:sessionId/prioritize");
	}

	private isLoopbackRequestAddress(address: string | undefined): boolean {
		const normalized = address?.trim().toLowerCase();
		return (
			normalized === "127.0.0.1" ||
			normalized === "::1" ||
			normalized === "::ffff:127.0.0.1"
		);
	}

	private renderDashboardHtml(): string {
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Cyrus Dashboard</title>
	<style>
		:root {
			color-scheme: light dark;
			--bg: #f7f8fa;
			--panel: #ffffff;
			--panel-soft: #f1f4f7;
			--text: #171a1f;
			--muted: #667085;
			--line: #d8dee8;
			--accent: #126a5a;
			--danger: #b42318;
			--warning: #b54708;
			--shadow: 0 1px 2px rgb(16 24 40 / 8%);
		}

		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #101214;
				--panel: #181b1f;
				--panel-soft: #20242a;
				--text: #eef1f5;
				--muted: #aab3c1;
				--line: #313842;
				--accent: #4bc7ac;
				--danger: #ff8a80;
				--warning: #ffbc6e;
				--shadow: none;
			}
		}

		* { box-sizing: border-box; }

		body {
			margin: 0;
			background: var(--bg);
			color: var(--text);
			font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		main {
			width: min(1200px, calc(100vw - 32px));
			margin: 0 auto;
			padding: 28px 0 40px;
		}

		header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 20px;
			margin-bottom: 22px;
		}

		h1 {
			margin: 0;
			font-size: 28px;
			line-height: 1.15;
			letter-spacing: 0;
		}

		h2 {
			margin: 0 0 12px;
			font-size: 16px;
			line-height: 1.25;
			letter-spacing: 0;
		}

		.muted { color: var(--muted); }

		.status-pill {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			min-height: 32px;
			padding: 4px 10px;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: var(--panel);
			box-shadow: var(--shadow);
			font-weight: 600;
		}

		.dot {
			width: 9px;
			height: 9px;
			border-radius: 999px;
			background: var(--accent);
		}

		.status-pill.busy .dot { background: var(--warning); }
		.status-pill.error .dot { background: var(--danger); }

		.metrics {
			display: grid;
			grid-template-columns: repeat(5, minmax(0, 1fr));
			gap: 12px;
			margin-bottom: 18px;
		}

		.metric,
		.section {
			border: 1px solid var(--line);
			border-radius: 8px;
			background: var(--panel);
			box-shadow: var(--shadow);
		}

		.metric { padding: 14px; }

		.metric-label {
			margin-bottom: 6px;
			color: var(--muted);
			font-size: 12px;
			text-transform: uppercase;
		}

		.metric-value {
			font-size: 24px;
			line-height: 1.2;
			font-weight: 700;
			letter-spacing: 0;
		}

		.section {
			margin-top: 14px;
			padding: 16px;
			overflow: hidden;
		}

		.table-wrap { overflow-x: auto; }

		table {
			width: 100%;
			border-collapse: collapse;
			min-width: 920px;
		}

		th,
		td {
			padding: 10px 8px;
			border-bottom: 1px solid var(--line);
			text-align: left;
			vertical-align: top;
		}

		th {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
			text-transform: uppercase;
		}

		tbody tr:last-child td { border-bottom: 0; }

		code {
			padding: 2px 5px;
			border-radius: 4px;
			background: var(--panel-soft);
			font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			font-size: 12px;
		}

		a {
			color: var(--accent);
			text-decoration: none;
			font-weight: 600;
		}

		a:hover { text-decoration: underline; }
		a code { color: inherit; }

		button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 30px;
			padding: 4px 9px;
			border: 1px solid var(--line);
			border-radius: 6px;
			background: var(--panel-soft);
			color: var(--text);
			font: inherit;
			font-weight: 600;
			cursor: pointer;
		}

		button:hover:not(:disabled) {
			border-color: var(--accent);
			color: var(--accent);
		}

		button:disabled {
			cursor: wait;
			opacity: 0.65;
		}

		.empty {
			padding: 18px 0;
			color: var(--muted);
		}

		.config {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 8px;
		}

		.config span {
			display: inline-flex;
			align-items: center;
			min-height: 28px;
			padding: 3px 8px;
			border: 1px solid var(--line);
			border-radius: 6px;
			background: var(--panel-soft);
			color: var(--muted);
		}

		.error-text { color: var(--danger); }

		.queue-message {
			margin: -2px 0 10px;
			color: var(--muted);
			min-height: 20px;
		}

		.queue-message.error-text { color: var(--danger); }

		@media (max-width: 900px) {
			.metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
			header { flex-direction: column; }
		}

		@media (max-width: 520px) {
			main {
				width: min(100vw - 20px, 1200px);
				padding-top: 18px;
			}
			.metrics { grid-template-columns: 1fr; }
			h1 { font-size: 24px; }
		}
	</style>
</head>
<body>
	<main>
		<header>
			<div>
				<h1>Cyrus Dashboard</h1>
				<div class="muted" id="updated">Loading...</div>
			</div>
			<div class="status-pill" id="statusPill"><span class="dot"></span><span id="statusText">Loading</span></div>
		</header>

		<section class="metrics" aria-label="Metrics">
			<div class="metric"><div class="metric-label">Queue pending</div><div class="metric-value" id="pending">0</div></div>
			<div class="metric"><div class="metric-label">Queue active</div><div class="metric-value" id="active">0</div></div>
			<div class="metric"><div class="metric-label">Runners</div><div class="metric-value" id="runners">0</div></div>
			<div class="metric"><div class="metric-label">Webhooks</div><div class="metric-value" id="webhooks">0</div></div>
			<div class="metric"><div class="metric-label">Cooldown</div><div class="metric-value" id="cooldown">0s</div></div>
		</section>

		<section class="section">
			<h2>Active Tasks</h2>
			<div id="activeTasks"></div>
		</section>

		<section class="section">
			<h2>Waiting Queue</h2>
			<div class="queue-message" id="queueMessage"></div>
			<div id="pendingTasks"></div>
		</section>

		<section class="section">
			<h2>Recent Alerts</h2>
			<div id="recentAlerts"></div>
		</section>

		<section class="section">
			<h2>Queue Settings</h2>
			<div class="config" id="config"></div>
		</section>
	</main>

	<script>
		const els = {
			statusPill: document.getElementById("statusPill"),
			statusText: document.getElementById("statusText"),
			updated: document.getElementById("updated"),
			pending: document.getElementById("pending"),
			active: document.getElementById("active"),
			runners: document.getElementById("runners"),
			webhooks: document.getElementById("webhooks"),
			cooldown: document.getElementById("cooldown"),
			activeTasks: document.getElementById("activeTasks"),
			pendingTasks: document.getElementById("pendingTasks"),
			queueMessage: document.getElementById("queueMessage"),
			recentAlerts: document.getElementById("recentAlerts"),
			config: document.getElementById("config"),
		};

		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0s";
			const totalSeconds = Math.round(ms / 1000);
			const hours = Math.floor(totalSeconds / 3600);
			const minutes = Math.floor((totalSeconds % 3600) / 60);
			const seconds = totalSeconds % 60;
			if (hours) return hours + "h " + minutes + "m";
			if (minutes) return minutes + "m " + seconds + "s";
			return seconds + "s";
		}

		function text(value) {
			return value === undefined || value === null || value === "" ? "-" : String(value);
		}

		function createTable(columns, rows) {
			if (!rows.length) {
				const empty = document.createElement("div");
				empty.className = "empty";
				empty.textContent = "No items";
				return empty;
			}

			const wrap = document.createElement("div");
			wrap.className = "table-wrap";
			const table = document.createElement("table");
			const thead = document.createElement("thead");
			const headRow = document.createElement("tr");
			for (const column of columns) {
				const th = document.createElement("th");
				th.textContent = column.label;
				headRow.appendChild(th);
			}
			thead.appendChild(headRow);
			table.appendChild(thead);

			const tbody = document.createElement("tbody");
			for (const row of rows) {
				const tr = document.createElement("tr");
				for (const column of columns) {
					const td = document.createElement("td");
					if (column.render) {
						column.render(row, td);
						tr.appendChild(td);
						continue;
					}
					const value = column.value(row);
					const href = column.href ? column.href(row) : "";
					let target = td;
					if (href) {
						const link = document.createElement("a");
						link.href = href;
						link.target = "_blank";
						link.rel = "noreferrer";
						target = link;
					}
					if (column.code) {
						const code = document.createElement("code");
						code.textContent = text(value);
						target.appendChild(code);
					} else {
						target.textContent = text(value);
					}
					if (target !== td) {
						td.appendChild(target);
					}
					tr.appendChild(td);
				}
				tbody.appendChild(tr);
			}
			table.appendChild(tbody);
			wrap.appendChild(table);
			return wrap;
		}

		async function prioritizeTask(sessionId, button) {
			if (!sessionId || !button) return;
			const originalText = button.textContent;
			button.disabled = true;
			button.textContent = "Moving";
			els.queueMessage.className = "queue-message";
			els.queueMessage.textContent = "";

			try {
				const response = await fetch("/agent-queue/" + encodeURIComponent(sessionId) + "/prioritize", {
					method: "POST",
					headers: { "accept": "application/json" },
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload.ok === false) {
					throw new Error(payload.error || "HTTP " + response.status);
				}
				els.queueMessage.textContent = payload.message || "Task moved to the front of the queue.";
				await load();
			} catch (error) {
				els.queueMessage.className = "queue-message error-text";
				els.queueMessage.textContent = "Failed to prioritize task: " + error.message;
				button.disabled = false;
				button.textContent = originalText;
			}
		}

		function setChildren(node, child) {
			node.replaceChildren(child);
		}

		function render(data) {
			const queue = data.linearQueue || {};
			const status = data.status || "unknown";

			els.statusPill.className = "status-pill " + (status === "busy" ? "busy" : status === "idle" ? "" : "error");
			els.statusText.textContent = status.toUpperCase();
			els.updated.textContent = "Last updated " + new Date().toLocaleString();
			els.pending.textContent = text(queue.pending || 0);
			els.active.textContent = text(queue.active || 0);
			els.runners.textContent = text(data.activeRunnerCount || 0);
			els.webhooks.textContent = text(data.activeWebhookCount || 0);
			els.cooldown.textContent = formatDuration(queue.cooldownRemainingMs || 0);

			setChildren(
				els.activeTasks,
				createTable(
					[
						{ label: "Origin", value: (row) => row.origin },
						{ label: "Task", value: (row) => row.task },
						{ label: "Task / PR", value: (row) => row.issueIdentifier, href: (row) => row.workItemUrl, code: true },
						{ label: "Linear", value: (row) => row.linearIssueIdentifier, href: (row) => row.linearIssueUrl, code: true },
						{ label: "Session", value: (row) => row.sessionId, code: true },
						{ label: "Retry", value: (row) => row.retryCount },
						{ label: "Queued", value: (row) => formatDuration(row.queuedForMs) },
						{ label: "Running", value: (row) => formatDuration(row.runningForMs) },
						{ label: "Recovered", value: (row) => row.recoveredAt || "-" },
						{ label: "Last error", value: (row) => row.lastError },
					],
					queue.activeItems || [],
				),
			);

			setChildren(
				els.pendingTasks,
				createTable(
					[
						{ label: "#", value: (row) => row.position },
						{ label: "Origin", value: (row) => row.origin },
						{ label: "Task", value: (row) => row.task },
						{ label: "Task / PR", value: (row) => row.issueIdentifier, href: (row) => row.workItemUrl, code: true },
						{ label: "Linear", value: (row) => row.linearIssueIdentifier, href: (row) => row.linearIssueUrl, code: true },
						{ label: "Session", value: (row) => row.sessionId, code: true },
						{ label: "Retry", value: (row) => row.retryCount },
						{ label: "Queued", value: (row) => formatDuration(row.queuedForMs) },
						{ label: "Available in", value: (row) => formatDuration(row.availableInMs) },
						{
							label: "Action",
							render: (row, td) => {
								const button = document.createElement("button");
								button.type = "button";
								button.textContent = row.position === 1 ? "Top" : "Prioritize";
								button.disabled = !row.canPrioritize || row.position === 1;
								button.addEventListener("click", () => prioritizeTask(row.sessionId, button));
								td.appendChild(button);
							},
						},
						{ label: "Recovered", value: (row) => row.recoveredAt || "-" },
						{ label: "Last error", value: (row) => row.lastError },
					],
					queue.pendingItems || [],
				),
			);

			setChildren(
				els.recentAlerts,
				createTable(
					[
						{ label: "Severity", value: (row) => row.severity },
						{ label: "Title", value: (row) => row.title },
						{ label: "Message", value: (row) => row.message },
						{ label: "Created", value: (row) => row.createdAt },
						{ label: "Sent", value: (row) => row.lastSentAt || "-" },
						{ label: "Count", value: (row) => row.sendCount },
					],
					data.recentAlerts || [],
				),
			);

			els.config.replaceChildren();
			const configItems = [
				["Durable queue", queue.durable ? "enabled" : "disabled"],
				["Concurrency", queue.concurrency],
				["Max retries", queue.maxRetries],
				["Retry delay", formatDuration(queue.retryDelayMs || 0)],
				["Timeout", formatDuration(queue.sessionTimeoutMs || 0)],
				["Cooldown until", queue.cooldownUntil || "-"],
				["Next available", queue.nextAvailableAt || "-"],
			];
			for (const item of configItems) {
				const span = document.createElement("span");
				span.textContent = item[0] + ": " + text(item[1]);
				els.config.appendChild(span);
			}
		}

		async function load() {
			try {
				const response = await fetch("/status", { cache: "no-store" });
				if (!response.ok) throw new Error("HTTP " + response.status);
				render(await response.json());
			} catch (error) {
				els.statusPill.className = "status-pill error";
				els.statusText.textContent = "ERROR";
				els.updated.innerHTML = "";
				const span = document.createElement("span");
				span.className = "error-text";
				span.textContent = "Failed to load status: " + error.message;
				els.updated.appendChild(span);
			}
		}

		load();
		setInterval(load, 5000);
	</script>
</body>
</html>`;
	}

	/**
	 * Register the /version endpoint for CLI version information
	 * This endpoint is used by dashboards to display the installed CLI version
	 */
	private registerVersionEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/version", async (_request, reply) => {
			return reply.status(200).send({
				cyrus_cli_version: this.config.version ?? null,
			});
		});

		this.logger.info("✅ Version endpoint registered");
		this.logger.info("   Route: GET /version");
	}

	/**
	 * Register the GitHub event transport for receiving forwarded GitHub webhooks from CYHOST.
	 * This creates a /github-webhook endpoint that handles @cyrusagent mentions on GitHub PRs.
	 */
	private registerGitHubEventTransport(): void {
		// Use direct GitHub signature verification only when BOTH:
		// 1. GITHUB_WEBHOOK_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: GitHub sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the GitHub signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGithubWebhookSecret =
			process.env.GITHUB_WEBHOOK_SECRET != null &&
			process.env.GITHUB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGithubWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITHUB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitHubEventTransport = new GitHubEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
			ipAllowlist:
				useSignatureVerification && this.webhookIpValidator.isEnabled()
					? this.webhookIpValidator.getAllowlist("github")
					: undefined,
		});

		// Listen for legacy GitHub webhook events (deprecated, kept for backward compatibility)
		this.gitHubEventTransport.on("event", (event: GitHubWebhookEvent) => {
			// Route push events to the base branch notification handler
			if (event.eventType === "push") {
				this.handleGitHubPushWebhook(event).catch((error) => {
					this.logger.error(
						"Failed to handle GitHub push webhook",
						error instanceof Error ? error : new Error(String(error)),
					);
				});
				return;
			}
			if (event.eventType === "pull_request") {
				this.handleGitHubPullRequestWebhook(
					event as GitHubPullRequestWebhookEvent,
				).catch((error) => {
					this.logger.error(
						"Failed to handle GitHub pull_request webhook",
						error instanceof Error ? error : new Error(String(error)),
					);
				});
				return;
			}
			this.enqueueGitHubAgentSession(event as GitHubCommentWebhookEvent).catch(
				(error) => {
					this.logger.error(
						"Failed to enqueue GitHub webhook",
						error instanceof Error ? error : new Error(String(error)),
					);
				},
			);
		});

		// Listen for unified internal messages (new message bus)
		this.gitHubEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitHubEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /github-webhook endpoint
		this.gitHubEventTransport.register();

		// Initialize GitHub App token provider for self-hosted users
		const appId = process.env.GITHUB_APP_ID;
		const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
		if (appId && installationId) {
			const pemPath = join(this.cyrusHome, "github-app.pem");
			this.gitHubAppTokenProvider = new GitHubAppTokenProvider({
				appId,
				installationId,
				privateKeyPath: pemPath,
			});
			this.logger.info(
				"GitHub App token provider initialized (self-hosted mode)",
			);
		}

		this.logger.info(
			`GitHub event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /github-webhook");
	}

	/**
	 * Register the GitLab event transport for receiving forwarded GitLab webhooks.
	 * This creates a /gitlab-webhook endpoint that handles note events on merge requests.
	 */
	private registerGitLabEventTransport(): void {
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGitlabWebhookSecret =
			process.env.GITLAB_WEBHOOK_SECRET != null &&
			process.env.GITLAB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGitlabWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITLAB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitLabEventTransport = new GitLabEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
		});

		// Listen for legacy GitLab webhook events
		this.gitLabEventTransport.on("event", (event: GitLabWebhookEvent) => {
			this.handleGitLabWebhook(event).catch((error) => {
				this.logger.error(
					"Failed to handle GitLab webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		// Listen for unified internal messages (new message bus)
		this.gitLabEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitLabEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /gitlab-webhook endpoint
		this.gitLabEventTransport.register();

		this.logger.info(
			`GitLab event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /gitlab-webhook");
	}

	/**
	 * Whether Cyrus should follow plain replies in a Slack thread it was
	 * @mentioned in. Enabled by default; controlled by the per-team
	 * `slackThreadFollowing` config toggle (Behaviours page) and force-disabled
	 * by the `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` env kill-switch, which takes
	 * precedence over the toggle. When disabled, only @mentions are processed.
	 */
	private isSlackThreadFollowingEnabled(): boolean {
		const envValue = (process.env.CYRUS_SLACK_THREAD_FOLLOWING_DISABLED ?? "")
			.toLowerCase()
			.trim();
		if (envValue === "true" || envValue === "1" || envValue === "yes") {
			return false;
		}
		// Config toggle defaults to enabled when unset.
		return this.config.slackThreadFollowing !== false;
	}

	/**
	 * Register the Slack event transport for receiving forwarded Slack webhooks from CYHOST.
	 * This creates a /slack-webhook endpoint that handles @mention events from Slack.
	 */
	private registerSlackEventTransport(): void {
		// Live provider reads from the repository map on demand — no snapshot needed
		const chatRepositoryProvider = new LiveChatRepositoryProvider(
			this.repositories,
			() => this.config.linearWorkspaces || {},
		);

		const routingContext =
			this.promptBuilder.generateRoutingContextForAllWorkspaces();
		// Only managed teams (cloud or self-hosted, paired with cyrus-hosted)
		// have a Behaviours page where automatic Slack thread listening can be
		// turned off — CYRUS_API_KEY is proof of that pairing, so the
		// stop-listening prompt guidance is gated on it. Community members
		// don't have the key (or the page).
		const cyrusAppBaseUrl = process.env.CYRUS_API_KEY
			? getCyrusAppUrl()
			: undefined;
		const slackAdapter = new SlackChatAdapter(
			chatRepositoryProvider,
			this.logger,
			{ repositoryRoutingContext: routingContext, cyrusAppBaseUrl },
		);

		if (
			!chatRepositoryProvider.getDefaultLinearWorkspaceId() ||
			!chatRepositoryProvider.getDefaultRepository()
		) {
			this.logger.warn(
				"No repositories or workspaces configured — Slack sessions will not have access to MCP tools",
			);
		}

		this.chatSessionHandler = new ChatSessionHandler(
			slackAdapter,
			{
				cyrusHome: this.cyrusHome,
				chatRepositoryProvider,
				runnerConfigBuilder: this.runnerConfigBuilder,
				createRunner: (config) => {
					const runnerType = this.runnerSelectionService.getDefaultRunner();
					return this.createRunnerForType(runnerType, {
						...config,
						model: this.getDefaultModelForRunner(runnerType),
						fallbackModel: this.getDefaultFallbackModelForRunner(runnerType),
					});
				},
				// Live read so hot-reloaded config (`setConfig`) picks up new
				// per-platform MCP paths without rebuilding the handler.
				getPlatformMcpConfigOverrides: () => this.config.slackMcpConfigs,
				resolveSkillsConfig: async ({ repository, repositoryPaths }) => {
					const plugins = await this.skillsPluginResolver.resolve();
					const skills = await this.skillsPluginResolver.discoverSkillNames(
						plugins,
						{
							repositoryId: repository?.id,
							repoPaths: repositoryPaths,
						},
					);
					return { plugins, skills };
				},
				onWebhookStart: () => {
					this.activeWebhookCount++;
				},
				onWebhookEnd: () => {
					this.activeWebhookCount--;
				},
				onStateChange: () => this.savePersistedState(),
				onClaudeError: (error) => this.handleClaudeError(error),
			},
			this.logger,
		);

		// Use direct Slack signature verification only when BOTH:
		// 1. SLACK_SIGNING_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: Slack sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the Slack signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasSlackSigningSecret =
			process.env.SLACK_SIGNING_SECRET != null &&
			process.env.SLACK_SIGNING_SECRET !== "";
		const useDirectSlackWebhooks = isExternalHost && hasSlackSigningSecret;

		const slackVerificationMode = useDirectSlackWebhooks ? "direct" : "proxy";
		const slackSecret = useDirectSlackWebhooks
			? process.env.SLACK_SIGNING_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.slackEventTransport = new SlackEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode: slackVerificationMode,
			secret: slackSecret,
			// Live read so the per-team toggle (hot-reloaded via config) and the
			// env kill-switch both take effect without rebuilding the transport.
			isThreadFollowingEnabled: () => this.isSlackThreadFollowingEnabled(),
		});

		this.slackEventTransport.on("event", (event: SlackWebhookEvent) => {
			this.chatSessionHandler!.handleEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle Slack webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});
		this.slackEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});
		this.slackEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		this.slackEventTransport.register();

		this.logger.info(
			`Slack event transport registered (${slackVerificationMode} mode)`,
		);
	}

	/**
	 * Handle a GitHub webhook event (forwarded from CYHOST).
	 *
	 * This creates a new session for the GitHub PR comment, checks out the PR branch
	 * via git worktree, and processes the comment as a task prompt.
	 */
	/**
	 * Resolve a GitHub API token from (in priority order):
	 * 1. Forwarded installation token from CYHOST (cloud/proxy mode)
	 * 2. Self-minted installation token from GitHub App credentials (self-hosted)
	 * 3. Personal access token from GITHUB_TOKEN env var (fallback)
	 */
	private async resolveGitHubToken(
		event: GitHubWebhookEvent,
	): Promise<string | undefined> {
		if (event.installationToken) return event.installationToken;
		if (this.gitHubAppTokenProvider) {
			try {
				return await this.gitHubAppTokenProvider.getToken();
			} catch (error) {
				this.logger.warn(
					"Failed to mint GitHub App installation token, falling back to GITHUB_TOKEN",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return process.env.GITHUB_TOKEN;
	}

	private async setGitHubPullRequestDraftState(
		event: GitHubCommentWebhookEvent,
		draft: boolean,
	): Promise<boolean> {
		const prNumber = extractPRNumber(event);
		if (!prNumber) {
			return false;
		}

		const token = await this.resolveGitHubToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot update GitHub PR draft state: no installation token or GITHUB_TOKEN configured",
			);
			return false;
		}

		const owner = extractRepoOwner(event);
		const repo = extractRepoName(event);
		const repoFullName = extractRepoFullName(event);

		try {
			const prResponse = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			);
			if (!prResponse.ok) {
				const errorBody = await prResponse.text();
				throw new Error(
					`GitHub pull request lookup failed: ${prResponse.status} ${prResponse.statusText} - ${errorBody}`,
				);
			}

			const pullRequest = (await prResponse.json()) as {
				node_id?: string;
				draft?: boolean;
			};
			if (!pullRequest.node_id) {
				throw new Error("GitHub pull request response did not include node_id");
			}
			if (pullRequest.draft === draft) {
				return false;
			}

			const mutation = draft
				? `mutation($id: ID!) {
					convertPullRequestToDraft(input: { pullRequestId: $id }) {
						pullRequest { isDraft }
					}
				}`
				: `mutation($id: ID!) {
					markPullRequestReadyForReview(input: { pullRequestId: $id }) {
						pullRequest { isDraft }
					}
				}`;

			const graphResponse = await fetch("https://api.github.com/graphql", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: mutation,
					variables: { id: pullRequest.node_id },
				}),
			});
			const graphBody = (await graphResponse.json().catch(() => null)) as {
				errors?: Array<{ message?: string }>;
			} | null;
			if (!graphResponse.ok || graphBody?.errors?.length) {
				throw new Error(
					graphBody?.errors?.map((error) => error.message).join("; ") ||
						`GitHub GraphQL mutation failed: ${graphResponse.status} ${graphResponse.statusText}`,
				);
			}

			this.logger.info(
				`Marked ${repoFullName}#${prNumber} as ${
					draft ? "draft" : "ready for review"
				}`,
			);
			return true;
		} catch (error) {
			const action = draft ? "draft" : "ready for review";
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn(
				`Failed to mark ${repoFullName}#${prNumber} as ${action}: ${message}`,
			);
			void this.sendOperationalAlert({
				key: `github-pr-draft-state:${repoFullName}#${prNumber}:${action}`,
				severity: "warning",
				title: "GitHub PR state update failed",
				message: `Could not mark ${repoFullName}#${prNumber} as ${action}: ${message}`,
			});
			return false;
		}
	}

	private async postGitHubIssueComment(
		event: GitHubCommentWebhookEvent,
		body: string,
	): Promise<void> {
		const prNumber = extractPRNumber(event);
		if (!prNumber) {
			return;
		}

		const token = await this.resolveGitHubToken(event);
		if (!token) {
			this.logger.warn(
				`Cannot post GitHub queue status for ${this.getGitHubWorkItemIdentifier(event)}: no token configured`,
			);
			return;
		}

		try {
			await this.gitHubCommentService.postIssueComment({
				token,
				owner: extractRepoOwner(event),
				repo: extractRepoName(event),
				issueNumber: prNumber,
				body,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to post GitHub queue status for ${this.getGitHubWorkItemIdentifier(event)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async postGitHubLinkedLinearThought(
		event: GitHubCommentWebhookEvent,
		repository: RepositoryConfig | null | undefined,
		body: string,
	): Promise<void> {
		const link = this.resolveLinearSessionLinkForGitHubEvent(event, repository);
		if (!link) {
			return;
		}

		await this.activityPoster.postThoughtActivity(
			link.sessionId,
			link.workspaceId,
			body,
		);
	}

	private resolveLinearSessionLinkForGitHubEvent(
		event: GitHubCommentWebhookEvent,
		repository?: RepositoryConfig | null,
		branchRef?: string | null,
	): LinearSessionLink | null {
		const issueIdentifier = this.extractLinearIssueIdentifierFromGitHubEvent(
			event,
			branchRef,
		);
		if (!issueIdentifier) {
			return null;
		}

		const candidates = this.agentSessionManager
			.getAllSessions()
			.filter((session) => {
				if (
					session.issueContext?.trackerId !== "linear" ||
					!session.externalSessionId
				) {
					return false;
				}

				const sessionIssueIdentifier =
					session.issueContext.issueIdentifier ?? session.issue?.identifier;
				if (sessionIssueIdentifier !== issueIdentifier) {
					return false;
				}

				if (!repository) {
					return true;
				}

				return session.repositories.some(
					(repo) => repo.repositoryId === repository.id,
				);
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);

		const session = candidates[0];
		if (!session?.externalSessionId) {
			return null;
		}

		const workspaceId =
			repository?.linearWorkspaceId ??
			this.resolveLinearWorkspaceIdForSession(session);
		if (!workspaceId) {
			return null;
		}

		return {
			sessionId: session.externalSessionId,
			workspaceId,
			issueIdentifier,
		};
	}

	private resolveLinearWorkspaceIdForSession(
		session: CyrusAgentSession,
	): string | undefined {
		for (const repoContext of session.repositories) {
			const repository = this.repositories.get(repoContext.repositoryId);
			if (repository?.linearWorkspaceId) {
				return repository.linearWorkspaceId;
			}
		}
		return undefined;
	}

	private extractLinearIssueIdentifierFromGitHubEvent(
		event: GitHubCommentWebhookEvent,
		branchRef?: string | null,
	): string | undefined {
		const candidates = [
			extractPRTitle(event) ?? "",
			this.extractGitHubPullRequestBody(event) ?? "",
			branchRef ?? extractPRBranchRef(event) ?? "",
			extractCommentBody(event) ?? "",
		];

		for (const candidate of candidates) {
			const issueIdentifier =
				this.extractLinearIssueIdentifierFromText(candidate);
			if (issueIdentifier) {
				return issueIdentifier;
			}
		}

		return undefined;
	}

	private extractLinearIssueIdentifierFromText(
		text: string,
	): string | undefined {
		const match = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/i);
		return match?.[0]?.toUpperCase();
	}

	private extractGitHubPullRequestBody(
		event: GitHubCommentWebhookEvent,
	): string | null {
		if (isIssueCommentPayload(event.payload)) {
			return event.payload.issue.body;
		}
		if (
			isPullRequestReviewPayload(event.payload) ||
			isPullRequestReviewCommentPayload(event.payload)
		) {
			return event.payload.pull_request.body;
		}
		return null;
	}

	private shouldProcessGitHubChangeRequest(
		event: GitHubCommentWebhookEvent,
	): boolean {
		if (!isPullRequestReviewPayload(event.payload)) {
			return true;
		}

		if (event.payload.review.state !== "changes_requested") {
			this.logger.debug(
				`Ignoring pull_request_review with state: ${event.payload.review.state}`,
			);
			return false;
		}

		if (this.isGitHubPullRequestTerminal(event.payload.pull_request)) {
			this.logger.info(
				`Ignoring pull_request_review on ${this.getGitHubWorkItemIdentifier(event)} because the pull request is already merged or closed`,
			);
			return false;
		}

		if (!this.isCyrusOwnedPullRequest(event.payload.pull_request)) {
			this.logger.info(
				`Ignoring pull_request_review on ${this.getGitHubWorkItemIdentifier(event)} because the pull request was not opened by Cyrus`,
			);
			return false;
		}

		return true;
	}

	private isGitHubPullRequestTerminal(pullRequest: GitHubPullRequest): boolean {
		const terminalState = pullRequest.state?.toLowerCase() === "closed";
		const mergeMetadata = pullRequest as GitHubPullRequest & {
			merged?: boolean;
			merged_at?: string | null;
		};

		return (
			terminalState ||
			mergeMetadata.merged === true ||
			Boolean(mergeMetadata.merged_at)
		);
	}

	private isCyrusOwnedPullRequest(pullRequest: GitHubPullRequest): boolean {
		const authorLogin = pullRequest.user?.login?.toLowerCase();
		const explicitAuthorLogins = this.parseCommaSeparatedEnvSet(
			process.env.CYRUS_GITHUB_PR_AUTHOR_LOGINS,
		);

		if (explicitAuthorLogins.size > 0) {
			return authorLogin ? explicitAuthorLogins.has(authorLogin) : false;
		}

		const botUsername = process.env.GITHUB_BOT_USERNAME?.trim().toLowerCase();
		if (botUsername && authorLogin === botUsername) {
			return true;
		}

		return this.hasCyrusPullRequestSignature(pullRequest);
	}

	private hasCyrusPullRequestSignature(
		pullRequest: GitHubPullRequest,
	): boolean {
		const branchRef = pullRequest.head?.ref ?? "";
		if (
			this.getCyrusGitHubPrBranchPrefixes().some((prefix) =>
				branchRef.startsWith(prefix),
			)
		) {
			return true;
		}

		const title = pullRequest.title ?? "";
		const body = pullRequest.body ?? "";
		const issueIdentifier = this.extractLinearIssueIdentifierFromText(
			`${title}\n${body}`,
		);
		if (!issueIdentifier) {
			return false;
		}

		const normalizedIssue = issueIdentifier.toLowerCase();
		if (!branchRef.toLowerCase().includes(normalizedIssue)) {
			return false;
		}

		return (
			title.toLowerCase().startsWith(`${normalizedIssue}:`) ||
			body.toLowerCase().includes(`linear issue: ${normalizedIssue}`)
		);
	}

	private getCyrusGitHubPrBranchPrefixes(): string[] {
		const configuredPrefixes = this.parseCommaSeparatedEnvValues(
			process.env.CYRUS_GITHUB_PR_BRANCH_PREFIXES,
		);
		return configuredPrefixes.length > 0
			? configuredPrefixes
			: ["cyrus/", "cyrus2/"];
	}

	private parseCommaSeparatedEnvSet(value: string | undefined): Set<string> {
		return new Set(
			this.parseCommaSeparatedEnvValues(value).map((item) =>
				item.toLowerCase(),
			),
		);
	}

	private parseCommaSeparatedEnvValues(value: string | undefined): string[] {
		return (value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}

	private async handleGitHubWebhook(
		event: GitHubCommentWebhookEvent,
	): Promise<void> {
		this.activeWebhookCount++;

		try {
			// Only handle comments on pull requests
			if (!isCommentOnPullRequest(event)) {
				this.logger.debug("Ignoring GitHub comment on non-PR issue");
				return;
			}

			const repoFullName = extractRepoFullName(event);
			const prNumber = extractPRNumber(event);
			const commentBody = extractCommentBody(event);
			const commentAuthor = extractCommentAuthor(event);
			const prTitle = extractPRTitle(event);
			const sessionKey = extractSessionKey(event);

			const isPullRequestReview = isPullRequestReviewPayload(event.payload);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITHUB_BOT_USERNAME;
			if (botUsername && commentAuthor === botUsername) {
				this.logger.debug(
					`Ignoring comment from bot user @${botUsername} on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review events, defensively check review state and PR ownership
			// (must happen before the mention check — reviews don't contain @mentions)
			if (
				isPullRequestReviewPayload(event.payload) &&
				!this.shouldProcessGitHubChangeRequest(event)
			) {
				return;
			}

			// Honor the PR-review trigger toggle: when disabled, ignore
			// pull_request_review events entirely — no acknowledgement comment and
			// no agent session. Defaults to enabled when the flag is unset.
			if (isPullRequestReview && this.config.prReviewTrigger === false) {
				this.logger.debug(
					`PR review trigger is disabled, ignoring pull_request_review on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// Only trigger on comments that mention the bot (when configured)
			// Skip this check for pull_request_review events — reviews don't @mention the bot
			if (
				!isPullRequestReview &&
				botUsername &&
				!commentBody.includes(`@${botUsername}`)
			) {
				this.logger.debug(
					`Ignoring comment without @${botUsername} mention on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitHub webhook: ${repoFullName}#${prNumber} by @${commentAuthor}${isPullRequestReview ? " (pull_request_review)" : ""}`,
			);

			// Add "eyes" reaction to acknowledge receipt (not for pull_request_review — we post a comment instead)
			const reactionToken = await this.resolveGitHubToken(event);
			if (reactionToken && !isPullRequestReview) {
				const commentId = extractCommentId(event);
				if (commentId) {
					this.gitHubCommentService
						.addReaction({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							commentId,
							isPullRequestReviewComment: isPullRequestReviewCommentPayload(
								event.payload,
							),
							content: "eyes",
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to add reaction: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
			}

			// Find the repository configuration that matches this GitHub repo
			const repository = this.findRepositoryByGitHubUrl(repoFullName);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitHub repo: ${repoFullName}`,
				);

				// Only reply on signals where the user clearly directed something at us:
				// an explicit @-mention, or a pull_request_review requesting changes.
				const wasMentioned =
					!!botUsername && commentBody.includes(`@${botUsername}`);
				const shouldReply = wasMentioned || isPullRequestReview;

				if (shouldReply && reactionToken && prNumber) {
					// Presence of CYRUS_API_KEY indicates this worker is paired with the
					// managed control plane (paid customer). Absence means the worker is
					// running on the Community plan (self-managed config.json).
					const isManagedCustomer = !!process.env.CYRUS_API_KEY;

					const commonPreamble = [
						`Cyrus received this webhook but has no repository configured for \`${repoFullName}\`, so no agent session was started.`,
						``,
						`**Likely causes:**`,
						`- The owner/org was **renamed or transferred** on GitHub. Webhooks are delivered under the current owner name, but Cyrus's stored repository URL still points at the old one. GitHub's web redirects don't apply to webhook payloads — the stored URL has to be updated explicitly.`,
						`- The stored repository URL has a typo (e.g. wrong org/owner) and doesn't match the repo this event came from.`,
						`- The GitHub App / webhook is installed on a repo Cyrus isn't configured for at all.`,
						``,
					];

					const fix = isManagedCustomer
						? `**What to do:** there's currently no self-serve way to update the stored repository URL on your plan — please reach out to Cyrus support and reference \`${repoFullName}\` and we'll reconcile it on the backend.`
						: `**What to do:** open \`~/.cyrus/config.json\` on the worker and update the \`githubUrl\` of the relevant repository to \`https://github.com/${repoFullName}\`. The worker watches the config file and will pick up the change automatically. If this repo shouldn't be sending events to Cyrus at all, remove the GitHub App from it instead.`;

					this.gitHubCommentService
						.postIssueComment({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							issueNumber: prNumber,
							body: [...commonPreamble, fix].join("\n"),
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to post unconfigured-repo notice: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			// For pull_request_review events, post an instant acknowledgement comment
			if (isPullRequestReview && reactionToken && prNumber) {
				this.gitHubCommentService
					.postIssueComment({
						token: reactionToken,
						owner: extractRepoOwner(event),
						repo: extractRepoName(event),
						issueNumber: prNumber,
						body: "Received your change request. Getting started on those changes now.",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to post acknowledgement comment: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Determine the PR head branch and base branch
			let branchRef = extractPRBranchRef(event);
			let baseBranchRef = extractPRBaseBranchRef(event);

			// For issue_comment events, the branch refs are not in the payload
			// We need to fetch them from the GitHub API
			if (!branchRef && isIssueCommentPayload(event.payload)) {
				const refs = await this.fetchPRBranchRefs(event, repository);
				branchRef = refs?.headRef ?? null;
				baseBranchRef = refs?.baseRef ?? null;
			}

			if (!branchRef || !prNumber) {
				this.logger.error(
					`Could not determine branch or PR number for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review, the review body IS the task context (no mention to strip)
			// For other events, strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = isPullRequestReview
				? await this.buildGitHubChangeRequestInstructions(event, commentBody)
				: stripMention(commentBody, mentionHandle);
			const markedPullRequestDraft = await this.setGitHubPullRequestDraftState(
				event,
				true,
			);

			// Check for an existing multi-repo session that includes this repository.
			// If found, use its sub-worktree instead of creating a new workspace.
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = { path: subWorktreePath, isGitWorktree: true };
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace as before
				workspace = await this.createGitHubWorkspace(
					repository,
					branchRef,
					prNumber,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(`GitHub workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitHub PR comment
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${extractRepoName(event)}#${prNumber}`,
				title: prTitle || `PR #${prNumber}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitHub)
			const githubSessionId = `github-${event.deliveryId}`;
			agentSessionManager.createCyrusAgentSession(
				githubSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"github", // Don't stream activities to Linear for GitHub sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
						githubUrl: repository.githubUrl,
						githubReviewTeams: repository.githubReviewTeams,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(githubSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(githubSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(githubSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitHub webhook ${event.deliveryId}`,
				);
				return;
			}

			const linearSessionLink = this.resolveLinearSessionLinkForGitHubEvent(
				event,
				repository,
				branchRef,
			);
			if (linearSessionLink) {
				session.externalSessionId = linearSessionLink.sessionId;
				this.logger.info(
					`Linked GitHub follow-up ${repoFullName}#${prNumber} to Linear agent session ${linearSessionLink.sessionId} (${linearSessionLink.issueIdentifier})`,
				);
				await this.activityPoster.postThoughtActivity(
					linearSessionLink.sessionId,
					linearSessionLink.workspaceId,
					`GitHub follow-up started for ${repoFullName}#${prNumber}.`,
				);
			}

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitHub-specific metadata for reply posting
			session.metadata.commentId = String(extractCommentId(event));

			// Build the system prompt for this GitHub PR session
			const systemPrompt = isPullRequestReview
				? this.buildGitHubChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitHubSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver, which honors
			// `githubAllowedTools` on the workspace config and falls back to
			// `GITHUB_DEFAULT_ALLOWED_TOOLS` (which intentionally omits
			// `mcp__slack` — no subtractive filtering needed).
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					githubSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"github", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(githubSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitHub PR ${repoFullName}#${prNumber}`,
			);

			// Start the session and handle completion
			let completed = false;
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitHub session started: ${sessionInfo.sessionId}`);
				completed = true;

				await agentSessionManager.publishFrontendScreenshotsForPullRequest(
					githubSessionId,
					workspace.path,
					String(prNumber),
					{
						baseBranch: baseBranchRef ?? repository.baseBranch,
						branch: branchRef,
					},
				);

				await this.setGitHubPullRequestDraftState(event, false);

				// When session completes, post the reply back to GitHub
				await this.postGitHubReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitHub session error for ${repoFullName}#${prNumber}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				if (markedPullRequestDraft && !completed) {
					void this.sendOperationalAlert({
						key: `github-followup-failed:${repoFullName}#${prNumber}`,
						severity: "error",
						title: "GitHub follow-up failed",
						message: `${repoFullName}#${prNumber} was left as draft because Cyrus did not complete successfully.`,
					});
				}
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitHub webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.activeWebhookCount--;
		}
	}

	/**
	 * Handle GitHub push webhook events.
	 * When a base branch receives new commits, find active sessions tracking that
	 * branch and stream a rebase notification to the running agent.
	 */
	private async handleGitHubPushWebhook(
		event: GitHubWebhookEvent,
	): Promise<void> {
		const payload = event.payload as GitHubPushPayload;
		// Only handle branch pushes (refs/heads/*), not tags
		if (!payload.ref.startsWith("refs/heads/")) {
			return;
		}

		// Ignore branch deletions
		if (payload.deleted) {
			return;
		}

		const branchName = payload.ref.replace("refs/heads/", "");
		const repoFullName = payload.repository.full_name;

		// Find the matching repository config
		const repository = this.findRepositoryByGitHubUrl(repoFullName);
		if (!repository) {
			this.logger.info(
				`No repository configured for GitHub push from ${repoFullName}`,
			);
			return;
		}

		this.logger.info(`Handling GitHub push for ${repoFullName}@${branchName}`);

		// Find active sessions tracking this branch as their base branch
		const sessions = this.agentSessionManager.getSessionsByBaseBranch(
			branchName,
			repository.id,
		);

		if (sessions.length === 0) {
			this.logger.debug(
				`No active sessions tracking base branch ${branchName} for ${repository.name}`,
			);
		} else {
			// Build a notification prompt with commit summary
			const commitCount = payload.commits.length;
			const commitSummary = payload.commits
				.slice(0, 5)
				.map((c) => `- ${c.message.split("\n")[0]}`)
				.join("\n");
			const moreCommits =
				commitCount > 5 ? `\n- ... and ${commitCount - 5} more` : "";

			const notification = `<base_branch_update>
<branch>${branchName}</branch>
<repository>${repoFullName}</repository>
<commit_count>${commitCount}</commit_count>
<compare_url>${payload.compare}</compare_url>
<commits>
${commitSummary}${moreCommits}
</commits>
<guidance>
Your base branch \`${branchName}\` has received ${commitCount} new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\`
</guidance>
</base_branch_update>`;

			this.logger.info(
				`Base branch ${branchName} updated (${commitCount} commits) — notifying ${sessions.length} active session(s)`,
			);

			// Stream notification to the first running session that supports streaming
			const sortedSessions = [...sessions].sort(
				(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
			);

			for (const session of sortedSessions) {
				const existingRunner = session.agentRunner;
				const isRunning = existingRunner?.isRunning() || false;

				if (
					isRunning &&
					existingRunner?.supportsStreamingInput &&
					existingRunner.addStreamMessage
				) {
					// Best-effort notification; a steer-only backend may reject it if no
					// turn is active. Don't let that throw out of the update handler.
					try {
						existingRunner.addStreamMessage(notification);
						this.logger.debug(
							`[base-branch-update] Streamed notification to session ${session.id} for branch ${branchName}`,
						);
						break;
					} catch (error) {
						this.logger.debug(
							`[base-branch-update] Stream rejected for session ${session.id}; skipping`,
							{
								error: error instanceof Error ? error.message : String(error),
							},
						);
					}
				}
			}
		}

		await this.scanGitHubPullRequestsForConflicts(
			event,
			repository,
			branchName,
		);
	}

	private async handleGitHubPullRequestWebhook(
		event: GitHubPullRequestWebhookEvent,
	): Promise<void> {
		if (!this.isGitHubConflictRebaseEnabled()) {
			this.logger.debug(
				`Ignoring pull_request webhook for ${this.getGitHubPullRequestWorkItemIdentifier(event)} because conflict auto-rebase is disabled`,
			);
			return;
		}

		if (!this.isGitHubConflictRebaseAction(event.payload.action)) {
			return;
		}

		const repository = this.findRepositoryByGitHubUrl(
			extractRepoFullName(event),
		);
		if (!repository) {
			this.logger.debug(
				`No repository configured for GitHub pull_request from ${extractRepoFullName(event)}`,
			);
			return;
		}

		await this.enqueueGitHubConflictRebaseIfNeeded(
			event,
			repository,
			"pull_request",
		);
	}

	private async scanGitHubPullRequestsForConflicts(
		event: GitHubWebhookEvent,
		repository: RepositoryConfig,
		baseBranch: string,
	): Promise<void> {
		if (!this.isGitHubConflictRebaseEnabled()) {
			this.logger.info(
				`Skipping GitHub conflict rebase scan for ${extractRepoFullName(event)}@${baseBranch}: disabled`,
			);
			return;
		}

		this.logger.info(
			`Starting GitHub conflict rebase scan for ${extractRepoFullName(event)}@${baseBranch}`,
		);

		const token = await this.resolveGitHubToken(event);
		if (!token) {
			this.logger.warn(
				`Cannot scan ${extractRepoFullName(event)} PRs for conflicts: no GitHub token configured`,
			);
			return;
		}

		const pullRequests = await this.fetchOpenGitHubPullRequestsForBase(
			event,
			baseBranch,
			token,
		);
		this.logger.info(
			`Listed ${pullRequests.length} open ${extractRepoFullName(event)} PR(s) targeting ${baseBranch}`,
		);
		if (pullRequests.length === 0) {
			return;
		}

		this.logger.info(
			`Scanning ${pullRequests.length} open ${extractRepoFullName(event)} PR(s) targeting ${baseBranch} for merge conflicts`,
		);

		for (const pullRequest of pullRequests) {
			const pullRequestEvent = this.buildSyntheticPullRequestEvent(
				event,
				pullRequest,
			);
			await this.enqueueGitHubConflictRebaseIfNeeded(
				pullRequestEvent,
				repository,
				"base_branch_push",
			);
		}
	}

	private async scanConfiguredGitHubPullRequestsForConflicts(input: {
		repositoryId?: string;
		baseBranch?: string;
	}): Promise<{ statusCode: number; body: unknown }> {
		if (!this.isGitHubConflictRebaseEnabled()) {
			return {
				statusCode: 409,
				body: {
					ok: false,
					error: "GitHub conflict auto-rebase is disabled.",
				},
			};
		}

		const requestedRepositoryId = input.repositoryId?.trim();
		const requestedBaseBranch = input.baseBranch?.trim();
		const repositories = requestedRepositoryId
			? [this.repositories.get(requestedRepositoryId)].filter(
					(repository): repository is RepositoryConfig => Boolean(repository),
				)
			: Array.from(this.repositories.values()).filter((repository) =>
					Boolean(repository.githubUrl),
				);

		if (repositories.length === 0) {
			return {
				statusCode: requestedRepositoryId ? 404 : 400,
				body: {
					ok: false,
					error: requestedRepositoryId
						? "Repository not found."
						: "No GitHub repositories configured.",
				},
			};
		}

		const results: Array<{
			repositoryId: string;
			repository: string;
			baseBranch: string;
			queued: number;
			skipped?: string;
			error?: string;
		}> = [];

		for (const repository of repositories) {
			const repoFullName = repository.githubUrl
				? this.getGitHubFullNameFromUrl(repository.githubUrl)
				: undefined;
			const baseBranch = requestedBaseBranch || repository.baseBranch;

			if (!repoFullName) {
				results.push({
					repositoryId: repository.id,
					repository: repository.githubUrl ?? repository.name,
					baseBranch,
					queued: 0,
					skipped: "Repository has no parseable GitHub URL.",
				});
				continue;
			}

			const beforeQueueLength = this.linearSessionQueue.length;
			try {
				await this.scanGitHubPullRequestsForConflicts(
					this.buildSyntheticGitHubPushEvent(repoFullName, baseBranch),
					repository,
					baseBranch,
				);
				results.push({
					repositoryId: repository.id,
					repository: repoFullName,
					baseBranch,
					queued: Math.max(
						0,
						this.linearSessionQueue.length - beforeQueueLength,
					),
				});
			} catch (error) {
				results.push({
					repositoryId: repository.id,
					repository: repoFullName,
					baseBranch,
					queued: Math.max(
						0,
						this.linearSessionQueue.length - beforeQueueLength,
					),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return {
			statusCode: 200,
			body: {
				ok: true,
				results,
				queue: this.buildLinearQueueStatus(),
			},
		};
	}

	private buildSyntheticGitHubPushEvent(
		repoFullName: string,
		baseBranch: string,
	): GitHubWebhookEvent {
		const [owner = "unknown", repo = "unknown"] = repoFullName.split("/");
		const syntheticUser = {
			login: "cyrus",
			id: 0,
			avatar_url: "",
			html_url: "https://github.com/cyrus",
			type: "Bot",
		};
		const payload: GitHubPushPayload = {
			ref: `refs/heads/${baseBranch}`,
			deleted: false,
			created: false,
			forced: false,
			compare: "",
			before: "",
			after: "",
			commits: [],
			head_commit: null,
			repository: {
				id: 0,
				name: repo,
				full_name: repoFullName,
				html_url: `https://github.com/${repoFullName}`,
				clone_url: `https://github.com/${repoFullName}.git`,
				ssh_url: `git@github.com:${repoFullName}.git`,
				default_branch: baseBranch,
				owner: {
					login: owner,
					id: 0,
					avatar_url: "",
					html_url: `https://github.com/${owner}`,
					type: "Organization",
				},
			},
			pusher: { name: "cyrus", email: "cyrus@localhost" },
			sender: syntheticUser,
		};

		return {
			eventType: "push",
			deliveryId: `manual-conflict-scan-${Date.now()}`,
			payload,
		};
	}

	private isGitHubConflictRebaseEnabled(): boolean {
		const envValue = this.parseOptionalBooleanEnv(
			process.env.CYRUS_GITHUB_CONFLICT_REBASE,
		);
		return envValue ?? this.config.githubConflictRebaseTrigger === true;
	}

	private shouldRebaseExternalGitHubPullRequests(): boolean {
		const envValue = this.parseOptionalBooleanEnv(
			process.env.CYRUS_GITHUB_CONFLICT_REBASE_INCLUDE_EXTERNAL_AUTHORS,
		);
		return (
			envValue ??
			this.config.githubConflictRebaseIncludeExternalAuthors === true
		);
	}

	private parseOptionalBooleanEnv(value: string | undefined): boolean | null {
		const normalized = value?.trim().toLowerCase();
		if (!normalized) {
			return null;
		}
		if (["1", "true", "yes", "on"].includes(normalized)) {
			return true;
		}
		if (["0", "false", "no", "off"].includes(normalized)) {
			return false;
		}
		return null;
	}

	private isGitHubConflictRebaseAction(
		action: GitHubPullRequestPayload["action"],
	): boolean {
		return (
			action === "opened" ||
			action === "reopened" ||
			action === "ready_for_review" ||
			action === "synchronize" ||
			action === "edited"
		);
	}

	private async fetchOpenGitHubPullRequestsForBase(
		event: GitHubWebhookEvent,
		baseBranch: string,
		token: string,
	): Promise<GitHubPullRequest[]> {
		const owner = extractRepoOwner(event);
		const repo = extractRepoName(event);
		const pullRequests: GitHubPullRequest[] = [];

		for (let page = 1; page <= 5; page++) {
			const url = new URL(
				`https://api.github.com/repos/${owner}/${repo}/pulls`,
			);
			url.searchParams.set("state", "open");
			url.searchParams.set("base", baseBranch);
			url.searchParams.set("per_page", "100");
			url.searchParams.set("page", String(page));

			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
			if (!response.ok) {
				const body = await response.text();
				this.logger.warn(
					`Failed to list open PRs for ${owner}/${repo}@${baseBranch}: ${response.status} ${response.statusText} - ${body}`,
				);
				return pullRequests;
			}

			const pageItems = (await response.json()) as GitHubPullRequest[];
			pullRequests.push(...pageItems);
			if (pageItems.length < 100) {
				break;
			}
		}

		return pullRequests;
	}

	private buildSyntheticPullRequestEvent(
		sourceEvent: GitHubWebhookEvent,
		pullRequest: GitHubPullRequest,
	): GitHubPullRequestWebhookEvent {
		const payload = sourceEvent.payload as GitHubPushPayload;
		return {
			eventType: "pull_request",
			deliveryId: `${sourceEvent.deliveryId}-pr-${pullRequest.number}-${pullRequest.head.sha}`,
			installationToken: sourceEvent.installationToken,
			payload: {
				action: "synchronize",
				number: pullRequest.number,
				pull_request: pullRequest,
				repository: payload.repository,
				sender: payload.sender,
				installation: payload.installation,
			},
		};
	}

	private async fetchGitHubPullRequestDetails(
		event: GitHubWebhookEvent,
	): Promise<GitHubPullRequest | null> {
		const prNumber = extractPRNumber(event);
		if (!prNumber) {
			return null;
		}

		const owner = extractRepoOwner(event);
		const repo = extractRepoName(event);
		const token = await this.resolveGitHubToken(event);
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{ headers },
			);
			if (!response.ok) {
				const body = await response.text();
				this.logger.warn(
					`Failed to fetch PR details for ${owner}/${repo}#${prNumber}: ${response.status} ${response.statusText} - ${body}`,
				);
				return null;
			}

			const pullRequest = (await response.json()) as GitHubPullRequest;
			if (pullRequest.mergeable !== null || attempt === 2) {
				return pullRequest;
			}

			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}

		return null;
	}

	private isGitHubPullRequestMergeConflict(
		pullRequest: GitHubPullRequest,
	): boolean {
		const mergeableState = pullRequest.mergeable_state?.toLowerCase();
		return pullRequest.mergeable === false || mergeableState === "dirty";
	}

	private canAutoRebaseGitHubPullRequestHead(
		pullRequest: GitHubPullRequest,
		repository: RepositoryConfig,
	): boolean {
		const configuredRepo = repository.githubUrl
			? this.getGitHubFullNameFromUrl(repository.githubUrl)
			: undefined;
		const baseRepo = pullRequest.base?.repo?.full_name;
		const headRepo = pullRequest.head?.repo?.full_name;
		const expectedRepo = configuredRepo ?? baseRepo;

		return Boolean(
			expectedRepo &&
				baseRepo?.toLowerCase() === expectedRepo.toLowerCase() &&
				headRepo?.toLowerCase() === expectedRepo.toLowerCase(),
		);
	}

	private getGitHubFullNameFromUrl(url: string): string | undefined {
		const normalized = url.trim().replace(/\.git$/, "");
		const sshMatch = normalized.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/i);
		if (sshMatch?.[1]) {
			return sshMatch[1];
		}
		try {
			const parsed = new URL(normalized);
			if (!parsed.hostname.toLowerCase().endsWith("github.com")) {
				return undefined;
			}
			const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
			return path.split("/").slice(0, 2).join("/") || undefined;
		} catch {
			return undefined;
		}
	}

	private async enqueueGitHubConflictRebaseIfNeeded(
		event: GitHubPullRequestWebhookEvent,
		repository: RepositoryConfig,
		trigger: "pull_request" | "base_branch_push",
	): Promise<void> {
		const pullRequest =
			(await this.fetchGitHubPullRequestDetails(event)) ??
			event.payload.pull_request;
		const workItemIdentifier =
			this.getGitHubPullRequestWorkItemIdentifier(event);

		if (this.isGitHubPullRequestTerminal(pullRequest)) {
			this.logger.debug(
				`Ignoring conflict rebase for terminal PR ${workItemIdentifier}`,
			);
			return;
		}

		if (!this.isGitHubPullRequestMergeConflict(pullRequest)) {
			this.logger.debug(
				`No merge conflict detected for ${workItemIdentifier} (${pullRequest.mergeable_state ?? "unknown"})`,
			);
			return;
		}

		if (
			!this.shouldRebaseExternalGitHubPullRequests() &&
			!this.isCyrusOwnedPullRequest(pullRequest)
		) {
			this.logger.info(
				`Ignoring merge-conflicted PR ${workItemIdentifier} because it was not opened by Cyrus`,
			);
			return;
		}

		if (!this.canAutoRebaseGitHubPullRequestHead(pullRequest, repository)) {
			if (trigger === "pull_request") {
				await this.postGitHubPullRequestIssueComment(
					event,
					`Cyrus detected merge conflicts on this PR, but cannot automatically rebase it because the head branch is not in the configured repository. Please rebase \`${pullRequest.head.ref}\` onto \`${pullRequest.base.ref}\` manually or move the branch into the repository Cyrus can write to.`,
				);
			}
			this.logger.info(
				`Skipping conflict rebase for ${workItemIdentifier}: head branch is not writable by the configured repository checkout`,
			);
			return;
		}

		const sessionId = this.getGitHubConflictRebaseSessionId(event, pullRequest);
		if (
			this.linearSessionActiveItems.has(sessionId) ||
			this.linearSessionQueue.some((item) => item.sessionId === sessionId)
		) {
			this.logger.info(
				`Skipping duplicate GitHub conflict rebase queue item for ${workItemIdentifier}`,
			);
			return;
		}

		const body = `Cyrus detected merge conflicts between \`${pullRequest.head.ref}\` and \`${pullRequest.base.ref}\`. I am queueing an automatic rebase now and will push the rebased branch if the conflicts can be resolved safely.`;
		await this.postGitHubPullRequestIssueComment(event, body);
		await this.postGitHubLinkedLinearThoughtForPullRequestEvent(
			event,
			repository,
			body,
		);

		const now = Date.now();
		const item: AgentSessionQueueItem = {
			origin: "github",
			task: "github-conflict-rebase",
			githubPullRequestEvent: {
				...event,
				payload: {
					...event.payload,
					pull_request: pullRequest,
				},
			},
			githubRepositoryId: repository.id,
			workItemIdentifier,
			sessionId,
			queuedAt: now,
			availableAt: now,
			retryCount: 0,
		};

		this.linearSessionQueue.push(item);
		await this.saveLinearSessionQueue();
		this.logger.info(
			`Queued GitHub conflict rebase for ${workItemIdentifier} (${trigger})`,
		);
		this.drainLinearSessionQueue();
	}

	private getGitHubConflictRebaseSessionId(
		event: GitHubPullRequestWebhookEvent,
		pullRequest: GitHubPullRequest,
	): string {
		const repoSegment = extractRepoFullName(event).replace(
			/[^A-Za-z0-9.-]+/g,
			"-",
		);
		const shaSegment = (pullRequest.head.sha || "unknown").slice(0, 12);
		return `github-conflict-rebase-${repoSegment}-${pullRequest.number}-${shaSegment}`;
	}

	private getGitHubPullRequestWorkItemIdentifier(
		event: GitHubPullRequestWebhookEvent,
	): string {
		const prNumber = extractPRNumber(event);
		return `${extractRepoFullName(event)}#${prNumber ?? "unknown"}`;
	}

	private async postGitHubPullRequestIssueComment(
		event: GitHubWebhookEvent,
		body: string,
	): Promise<void> {
		const prNumber = extractPRNumber(event);
		if (!prNumber) {
			return;
		}

		const token = await this.resolveGitHubToken(event);
		if (!token) {
			this.logger.warn(
				`Cannot post GitHub PR comment for ${extractRepoFullName(event)}#${prNumber}: no token configured`,
			);
			return;
		}

		try {
			await this.gitHubCommentService.postIssueComment({
				token,
				owner: extractRepoOwner(event),
				repo: extractRepoName(event),
				issueNumber: prNumber,
				body,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to post GitHub PR comment for ${extractRepoFullName(event)}#${prNumber}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async postGitHubLinkedLinearThoughtForPullRequestEvent(
		event: GitHubPullRequestWebhookEvent,
		repository: RepositoryConfig,
		body: string,
	): Promise<void> {
		const link = this.resolveLinearSessionLinkForGitHubPullRequest(
			event.payload.pull_request,
			repository,
		);
		if (!link) {
			return;
		}

		await this.activityPoster.postThoughtActivity(
			link.sessionId,
			link.workspaceId,
			body,
		);
	}

	private resolveLinearSessionLinkForGitHubPullRequest(
		pullRequest: GitHubPullRequest,
		repository?: RepositoryConfig | null,
	): LinearSessionLink | null {
		const issueIdentifier = this.extractLinearIssueIdentifierFromText(
			`${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}\n${pullRequest.head?.ref ?? ""}`,
		);
		if (!issueIdentifier) {
			return null;
		}

		const candidates = this.agentSessionManager
			.getAllSessions()
			.filter((session) => {
				if (
					session.issueContext?.trackerId !== "linear" ||
					!session.externalSessionId
				) {
					return false;
				}

				const sessionIssueIdentifier =
					session.issueContext.issueIdentifier ?? session.issue?.identifier;
				if (sessionIssueIdentifier !== issueIdentifier) {
					return false;
				}

				if (!repository) {
					return true;
				}

				return session.repositories.some(
					(repo) => repo.repositoryId === repository.id,
				);
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);

		const session = candidates[0];
		if (!session?.externalSessionId) {
			return null;
		}

		const workspaceId =
			repository?.linearWorkspaceId ??
			this.resolveLinearWorkspaceIdForSession(session);
		if (!workspaceId) {
			return null;
		}

		return {
			sessionId: session.externalSessionId,
			workspaceId,
			issueIdentifier,
		};
	}

	/**
	 * Find a repository configuration that matches a GitHub repository URL.
	 * Matches against the githubUrl field in repository config.
	 */
	private findRepositoryByGitHubUrl(
		repoFullName: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.githubUrl) continue;
			// Match against full name (owner/repo) or URL containing it
			if (
				repo.githubUrl.includes(repoFullName) ||
				repo.githubUrl.endsWith(`/${repoFullName}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Fetch the PR head and base branch refs for an issue_comment webhook.
	 * For issue_comment events, the branch refs are not in the payload
	 * and must be fetched from the GitHub API.
	 */
	private async fetchPRBranchRefs(
		event: GitHubCommentWebhookEvent,
		_repository: RepositoryConfig,
	): Promise<{ headRef: string; baseRef: string } | null> {
		if (!isIssueCommentPayload(event.payload)) return null;

		const prUrl = event.payload.issue.pull_request?.url;
		if (!prUrl) return null;

		try {
			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = event.payload.issue.number;

			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}

			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{ headers },
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to fetch PR details from GitHub API: ${response.status}`,
				);
				return null;
			}

			const prData = (await response.json()) as {
				head?: { ref?: string };
				base?: { ref?: string };
			};
			const headRef = prData.head?.ref;
			const baseRef = prData.base?.ref;
			if (!headRef) return null;
			return { headRef, baseRef: baseRef ?? "" };
		} catch (error) {
			this.logger.error(
				"Failed to fetch PR branch refs",
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	private async buildGitHubChangeRequestInstructions(
		event: GitHubCommentWebhookEvent,
		reviewBody: string,
	): Promise<string> {
		const inlineComments = await this.fetchGitHubReviewComments(event);
		const sections: string[] = [];

		if (reviewBody.trim()) {
			sections.push(`## Review Summary\n${reviewBody.trim()}`);
		}

		if (inlineComments) {
			sections.push(`## Inline Review Comments\n${inlineComments}`);
		}

		if (sections.length > 0) {
			return sections.join("\n\n");
		}

		return "A reviewer has requested changes on this PR. Read the review comments to understand what needs to be changed.";
	}

	private async fetchGitHubReviewComments(
		event: GitHubCommentWebhookEvent,
	): Promise<string> {
		if (!isPullRequestReviewPayload(event.payload)) {
			return "";
		}

		const prNumber = extractPRNumber(event);
		if (!prNumber) {
			return "";
		}

		const token = await this.resolveGitHubToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot fetch GitHub review comments: no installation token or GITHUB_TOKEN configured",
			);
			return "";
		}

		const owner = extractRepoOwner(event);
		const repo = extractRepoName(event);
		const reviewId = event.payload.review.id;

		try {
			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
				{
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${token}`,
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to fetch GitHub review comments for ${owner}/${repo}#${prNumber}: ${response.status}`,
				);
				return "";
			}

			const comments = (await response.json()) as Array<{
				body?: string;
				path?: string;
				line?: number | null;
				start_line?: number | null;
				original_line?: number | null;
				diff_hunk?: string;
				html_url?: string;
				user?: { login?: string };
			}>;

			if (!Array.isArray(comments) || comments.length === 0) {
				return "";
			}

			const maxComments = 50;
			const formattedComments = comments
				.slice(0, maxComments)
				.map((comment, index) =>
					this.formatGitHubReviewCommentForPrompt(comment, index),
				)
				.join("\n\n");
			const omittedCount = comments.length - maxComments;

			return omittedCount > 0
				? `${formattedComments}\n\n_... ${omittedCount} additional review comment(s) omitted. Use \`gh api repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments\` if needed._`
				: formattedComments;
		} catch (error) {
			this.logger.error(
				"Failed to fetch GitHub review comments",
				error instanceof Error ? error : new Error(String(error)),
			);
			return "";
		}
	}

	private formatGitHubReviewCommentForPrompt(
		comment: {
			body?: string;
			path?: string;
			line?: number | null;
			start_line?: number | null;
			original_line?: number | null;
			diff_hunk?: string;
			html_url?: string;
			user?: { login?: string };
		},
		index: number,
	): string {
		const locationParts = [
			comment.path,
			this.formatGitHubReviewCommentLine(comment),
		].filter(Boolean);
		const location =
			locationParts.length > 0 ? locationParts.join(":") : "general";
		const author = comment.user?.login ? `@${comment.user.login}` : "reviewer";
		const body = comment.body?.trim() || "(no comment body)";
		const urlLine = comment.html_url ? `\nURL: ${comment.html_url}` : "";
		const diffHunk = comment.diff_hunk
			? `\nDiff context:\n${this.truncateGitHubReviewDiffHunk(comment.diff_hunk)}`
			: "";

		return `### Comment ${index + 1} (${location})\nAuthor: ${author}${urlLine}\nFeedback:\n${body}${diffHunk}`;
	}

	private formatGitHubReviewCommentLine(comment: {
		line?: number | null;
		start_line?: number | null;
		original_line?: number | null;
	}): string | undefined {
		if (
			comment.start_line &&
			comment.line &&
			comment.start_line !== comment.line
		) {
			return `${comment.start_line}-${comment.line}`;
		}

		const line = comment.line ?? comment.original_line;
		return line ? String(line) : undefined;
	}

	private truncateGitHubReviewDiffHunk(diffHunk: string): string {
		const maxLength = 1_500;
		if (diffHunk.length <= maxLength) {
			return diffHunk;
		}

		return `${diffHunk.slice(0, maxLength)}\n... [diff hunk truncated]`;
	}

	/**
	 * Create a git worktree for a GitHub PR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitHubWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		prNumber: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Use the GitService to create the worktree
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `github-pr-${prNumber}`,
				identifier: `PR-${prNumber}`,
				title: `PR #${prNumber}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitHub workspace for PR #${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitHub PR comment session.
	 */
	private buildGitHubSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		return `You are working on a GitHub Pull Request.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${commentAuthor}
- **Comment URL**: ${commentUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Cyrus manages the PR draft/ready state automatically for this follow-up
- For frontend/UI changes, capture at least one fresh screenshot before finishing when the app can reasonably be rendered locally. Save it under \`cyrus-screenshots/\` or another workspace path containing \`screenshot\`, leave it uncommitted, and use shell Playwright if no browser MCP/tool is available, e.g. \`mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/pr-${prNumber}-after.png\`. If a meaningful screenshot is impossible, state the exact blocker in your response.
- Be concise in your responses as they will be posted back to the GitHub PR`;
	}

	/**
	 * Build a system prompt for a GitHub PR change request review session.
	 */
	private buildGitHubChangeRequestSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Cyrus manages the PR draft/ready state automatically for this follow-up
- For frontend/UI changes, capture at least one fresh screenshot before finishing when the app can reasonably be rendered locally. Save it under \`cyrus-screenshots/\` or another workspace path containing \`screenshot\`, leave it uncommitted, and use shell Playwright if no browser MCP/tool is available, e.g. \`mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/pr-${prNumber}-after.png\`. If a meaningful screenshot is impossible, state the exact blocker in your response.
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Cyrus manages the PR draft/ready state automatically for this follow-up
- For frontend/UI changes, capture at least one fresh screenshot before finishing when the app can reasonably be rendered locally. Save it under \`cyrus-screenshots/\` or another workspace path containing \`screenshot\`, leave it uncommitted, and use shell Playwright if no browser MCP/tool is available, e.g. \`mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/pr-${prNumber}-after.png\`. If a meaningful screenshot is impossible, state the exact blocker in your response.
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${commentAuthor}
- **Review URL**: ${commentUrl}

${taskSection}`;
	}

	private buildGitHubConflictRebaseSystemPrompt(
		event: GitHubPullRequestWebhookEvent,
		pullRequest: GitHubPullRequest,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = pullRequest.number;
		const branchRef = pullRequest.head.ref;
		const baseBranchRef = pullRequest.base.ref;
		const prTitle = pullRequest.title || "Untitled";

		return `You are working on a GitHub Pull Request that currently has merge conflicts.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle}
- **Branch**: ${branchRef}
- **Base branch**: ${baseBranchRef}
- **PR URL**: ${pullRequest.html_url}

## Task
Rebase the PR branch \`${branchRef}\` onto \`origin/${baseBranchRef}\`, resolve merge conflicts, and push the rebased branch.

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Run \`git fetch origin\` before rebasing
- Rebase with \`git rebase origin/${baseBranchRef}\`
- Resolve only the conflicts caused by the rebase; keep the existing PR intent intact
- Keep changes minimal and do not make unrelated product, formatting, or cleanup changes
- Run focused checks that are relevant to touched files when practical
- Push the rebased branch with \`git push --force-with-lease origin ${branchRef}\`
- If the rebase cannot be completed safely, run \`git rebase --abort\`, leave the working tree clean, and explain the blocker
- Respond with a concise summary suitable for posting to the GitHub PR`;
	}

	/**
	 * Post a reply back to the GitHub PR comment after the session completes.
	 */
	private async postGitHubReply(
		event: GitHubCommentWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			const summary = this.extractRunnerSummary(
				runner,
				"Task completed. Please review the changes on this branch.",
			);

			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = extractPRNumber(event);
			const commentId = extractCommentId(event);

			if (!prNumber) {
				this.logger.warn("Cannot post GitHub reply: no PR number");
				return;
			}

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (!token) {
				this.logger.warn(
					"Cannot post GitHub reply: no installation token or GITHUB_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${owner}/${repo}#${prNumber} (comment ${commentId}): ${summary}`,
				);
				return;
			}

			if (event.eventType === "pull_request_review_comment") {
				// Reply to the specific review comment thread
				await this.gitHubCommentService.postReviewCommentReply({
					token,
					owner,
					repo,
					pullNumber: prNumber,
					commentId,
					body: summary,
				});
			} else {
				// Post as a regular issue comment on the PR
				await this.gitHubCommentService.postIssueComment({
					token,
					owner,
					repo,
					issueNumber: prNumber,
					body: summary,
				});
			}

			this.logger.info(`Posted GitHub reply to ${owner}/${repo}#${prNumber}`);
		} catch (error) {
			this.logger.error(
				"Failed to post GitHub reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private extractRunnerSummary(runner: IAgentRunner, fallback: string): string {
		const messages = runner.getMessages();
		const lastAssistantMessage = [...messages]
			.reverse()
			.find((m) => m.type === "assistant");

		if (
			lastAssistantMessage &&
			lastAssistantMessage.type === "assistant" &&
			"message" in lastAssistantMessage
		) {
			const msg = lastAssistantMessage as {
				message: { content: Array<{ type: string; text?: string }> };
			};
			const textBlock = msg.message.content?.find(
				(block) => block.type === "text" && block.text,
			);
			if (textBlock?.text) {
				return textBlock.text;
			}
		}

		return fallback;
	}

	/**
	 * Handle an incoming GitLab webhook event (note on a merge request).
	 * Mirrors the GitHub webhook handler but uses GitLab-specific utilities.
	 */
	private async handleGitLabWebhook(event: GitLabWebhookEvent): Promise<void> {
		this.activeWebhookCount++;

		try {
			// Only handle notes on merge requests
			if (!isNoteOnMergeRequest(event)) {
				this.logger.debug(
					"Ignoring GitLab event: not a note on a merge request",
				);
				return;
			}

			const projectPath = extractProjectPath(event);
			const mrIid = extractMRIid(event);
			const noteBody = extractNoteBody(event);
			const noteAuthor = extractNoteAuthor(event);
			const mrTitle = extractMRTitle(event);
			const sessionKey = extractGitLabSessionKey(event);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITLAB_BOT_USERNAME;
			if (botUsername && noteAuthor === botUsername) {
				this.logger.debug(
					`Ignoring note from bot user @${botUsername} on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Only trigger on notes that mention the bot (when configured)
			if (botUsername && !noteBody.includes(`@${botUsername}`)) {
				this.logger.debug(
					`Ignoring note without @${botUsername} mention on ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitLab webhook: ${projectPath}!${mrIid} by @${noteAuthor}`,
			);

			// Add "eyes" emoji reaction to acknowledge receipt
			const reactionToken =
				event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			const noteId = extractNoteId(event);
			const projectId = extractProjectId(event);
			if (reactionToken && noteId && projectId && mrIid) {
				this.gitLabCommentService
					.addAwardEmoji({
						token: reactionToken,
						projectId,
						mrIid,
						noteId,
						name: "eyes",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to add GitLab emoji reaction: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Find the repository configuration that matches this GitLab project
			const repository = this.findRepositoryByGitLabUrl(projectPath);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitLab project: ${projectPath}`,
				);
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			// Branch refs are available directly from the MR payload
			const branchRef = extractMRBranchRef(event);
			const baseBranchRef = extractMRBaseBranchRef(event);

			if (!branchRef || !mrIid) {
				this.logger.error(
					`Could not determine branch or MR iid for ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = stripGitLabMention(noteBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = {
						path: subWorktreePath,
						isGitWorktree: true,
					};
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace
				workspace = await this.createGitLabWorkspace(
					repository,
					branchRef,
					mrIid,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(`GitLab workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitLab MR note
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${projectPath}!${mrIid}`,
				title: mrTitle || `MR !${mrIid}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitLab)
			const gitlabSessionId = `gitlab-${Date.now()}`;
			agentSessionManager.createCyrusAgentSession(
				gitlabSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"gitlab", // Don't stream activities to Linear for GitLab sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(gitlabSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(gitlabSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(gitlabSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitLab webhook on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Initialize procedure metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitLab-specific metadata for reply posting
			// Reuse commentId for note ID (serves the same purpose across platforms)
			session.metadata.commentId = String(noteId);

			// Build the system prompt for this GitLab MR session
			// TODO: Use buildGitLabChangeRequestSystemPrompt for merge_request approval events
			const isMergeRequestEvent = event.eventType === "merge_request";
			const systemPrompt = isMergeRequestEvent
				? this.buildGitLabChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitLabSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver — GitLab and
			// GitHub share the same PR-targeted, single-repo intent, so they use
			// the same `githubAllowedTools` knob and the same `GITHUB_*` default.
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					gitlabSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"gitlab", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(gitlabSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitLab MR ${projectPath}!${mrIid}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitLab session started: ${sessionInfo.sessionId}`);

				// When session completes, post the reply back to GitLab
				await this.postGitLabReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitLab session error for ${projectPath}!${mrIid}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitLab webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.activeWebhookCount--;
		}
	}

	/**
	 * Find a repository configuration that matches a GitLab project URL.
	 * Matches against the gitlabUrl field in repository config.
	 */
	private findRepositoryByGitLabUrl(
		projectPath: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.gitlabUrl) continue;
			if (
				repo.gitlabUrl.includes(projectPath) ||
				repo.gitlabUrl.endsWith(`/${projectPath}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Create a git worktree for a GitLab MR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitLabWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		mrIid: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `gitlab-mr-${mrIid}`,
				identifier: `MR-${mrIid}`,
				title: `MR !${mrIid}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitLab workspace for MR !${mrIid}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitLab MR note session.
	 */
	private buildGitLabSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		return `You are working on a GitLab Merge Request.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${noteAuthor}
- **Note URL**: ${noteUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the MR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Use \`glab\` CLI commands for GitLab-specific operations
- Be concise in your responses as they will be posted back to the GitLab MR`;
	}

	/**
	 * Build a system prompt for a GitLab MR change request session.
	 */
	private buildGitLabChangeRequestSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the MR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`glab mr view ${mrIid}\` and \`glab mr diff ${mrIid}\` to review the MR context
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitLab Merge Request that has received a change request review.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${noteAuthor}
- **Note URL**: ${noteUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitLab MR after the session completes.
	 */
	private async postGitLabReply(
		event: GitLabWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: {
						content: Array<{ type: string; text?: string }>;
					};
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			const projectId = extractProjectId(event);
			const mrIid = extractMRIid(event);
			const discussionId = extractDiscussionId(event);

			if (!mrIid) {
				this.logger.warn("Cannot post GitLab reply: no MR iid");
				return;
			}

			const token = event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			if (!token) {
				this.logger.warn(
					"Cannot post GitLab reply: no access token or GITLAB_ACCESS_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${extractProjectPath(event)}!${mrIid}: ${summary}`,
				);
				return;
			}

			if (discussionId) {
				// Reply to the specific discussion thread
				await this.gitLabCommentService.postDiscussionReply({
					token,
					projectId,
					mrIid,
					discussionId,
					body: summary,
				});
			} else {
				// Post as a top-level MR note
				await this.gitLabCommentService.postMRNote({
					token,
					projectId,
					mrIid,
					body: summary,
				});
			}

			this.logger.info(
				`Posted GitLab reply to ${extractProjectPath(event)}!${mrIid}`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post GitLab reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Compute the current status of the Cyrus process
	 * @returns "idle" if the process can be safely restarted, "busy" if work is in progress
	 */
	private computeStatus(): "idle" | "busy" {
		// Busy if any webhooks are currently being processed
		if (this.activeWebhookCount > 0) {
			return "busy";
		}

		if (
			this.linearSessionActiveItems.size > 0 ||
			this.linearSessionQueue.length > 0
		) {
			return "busy";
		}

		// Busy if any runner is actively running
		const runners = this.agentSessionManager.getAllAgentRunners();
		for (const runner of runners) {
			if (runner.isRunning()) {
				return "busy";
			}
		}

		// Busy if any chat platform runner is actively running
		if (this.chatSessionHandler?.isAnyRunnerBusy()) {
			return "busy";
		}

		return "idle";
	}

	private buildStatusPayload() {
		const agentQueue = this.buildLinearQueueStatus();
		return {
			status: this.computeStatus(),
			activeWebhookCount: this.activeWebhookCount,
			activeRunnerCount: this.getActiveRunnerCount(),
			agentQueue,
			linearQueue: agentQueue,
			recentAlerts: this.operationalAlerts.slice(0, 10).map((alert) => ({
				severity: alert.severity,
				title: alert.title,
				message: alert.message,
				createdAt: new Date(alert.createdAt).toISOString(),
				lastSentAt: alert.lastSentAt
					? new Date(alert.lastSentAt).toISOString()
					: null,
				sendCount: alert.sendCount,
			})),
			garbageCollection: {
				enabled: this.garbageCollectionEnabled,
				running: this.garbageCollectionRunning,
				intervalMs: this.garbageCollectionIntervalMs,
				sessionTtlMs: this.garbageCollectionSessionTtlMs,
				terminalPrGraceMs: this.garbageCollectionTerminalPrGraceMs,
				worktreeTtlMs: this.garbageCollectionWorktreeTtlMs,
				deleteRemoteBranches: this.garbageCollectionDeleteRemoteBranches,
				runWhenBusy: this.garbageCollectionRunWhenBusy,
				maxRemovalsPerRun: this.garbageCollectionMaxRemovalsPerRun,
				tempTtlMs: this.garbageCollectionTempTtlMs,
				lastRun: this.lastGarbageCollectionSummary,
			},
			diskGuard: {
				enabled: this.diskGuardEnabled,
				minFreeBytes: this.diskGuardMinFreeBytes,
				minFreePercent: this.diskGuardMinFreePercent,
			},
		};
	}

	private buildLinearQueueStatus() {
		const now = Date.now();
		const cooldownRemainingMs = Math.max(
			0,
			this.linearSessionCooldownUntil - now,
		);
		const nextAvailableAt = this.linearSessionQueue.reduce<number | null>(
			(soonest, item) =>
				soonest === null
					? item.availableAt
					: Math.min(soonest, item.availableAt),
			null,
		);

		return {
			durable: true,
			pending: this.linearSessionQueue.length,
			active: this.linearSessionActiveItems.size,
			concurrency: this.linearSessionQueueConcurrency,
			cooldownUntil:
				this.linearSessionCooldownUntil > now
					? new Date(this.linearSessionCooldownUntil).toISOString()
					: null,
			cooldownRemainingMs,
			nextAvailableAt: nextAvailableAt
				? new Date(nextAvailableAt).toISOString()
				: null,
			maxRetries: this.linearSessionMaxRetries,
			retryDelayMs: this.linearSessionRetryDelayMs,
			sessionTimeoutMs: this.linearSessionTimeoutMs,
			activeItems: Array.from(this.linearSessionActiveItems.values()).map(
				(item) => ({
					origin: item.origin,
					task: item.task ?? "agent-session",
					sessionId: item.sessionId,
					issueIdentifier: item.workItemIdentifier,
					workItemUrl: this.getAgentQueueItemUrl(item),
					linearIssueIdentifier:
						this.getAgentQueueItemLinearIssueIdentifier(item),
					linearIssueUrl: this.getAgentQueueItemLinearIssueUrl(item),
					retryCount: item.retryCount,
					queuedForMs: Math.max(0, now - item.queuedAt),
					runningForMs: item.startedAt ? Math.max(0, now - item.startedAt) : 0,
					prioritizedAt: item.prioritizedAt
						? new Date(item.prioritizedAt).toISOString()
						: null,
					recoveredAt: item.recoveredAt
						? new Date(item.recoveredAt).toISOString()
						: null,
					startedAt: item.startedAt
						? new Date(item.startedAt).toISOString()
						: null,
					lastError: item.lastError,
				}),
			),
			pendingItems: this.linearSessionQueue.map((item, index) => ({
				origin: item.origin,
				task: item.task ?? "agent-session",
				position: index + 1,
				sessionId: item.sessionId,
				issueIdentifier: item.workItemIdentifier,
				workItemUrl: this.getAgentQueueItemUrl(item),
				linearIssueIdentifier:
					this.getAgentQueueItemLinearIssueIdentifier(item),
				linearIssueUrl: this.getAgentQueueItemLinearIssueUrl(item),
				canPrioritize: true,
				retryCount: item.retryCount,
				queuedForMs: Math.max(0, now - item.queuedAt),
				availableInMs: Math.max(0, item.availableAt - now),
				prioritizedAt: item.prioritizedAt
					? new Date(item.prioritizedAt).toISOString()
					: null,
				recoveredAt: item.recoveredAt
					? new Date(item.recoveredAt).toISOString()
					: null,
				availableAt: item.availableAt
					? new Date(item.availableAt).toISOString()
					: null,
				lastError: item.lastError,
			})),
		};
	}

	private async prioritizeAgentQueueItem(sessionId: string): Promise<{
		statusCode: number;
		body: {
			ok: boolean;
			message?: string;
			error?: string;
			item?: { sessionId: string; workItemIdentifier: string; origin: string };
			queue?: ReturnType<EdgeWorker["buildLinearQueueStatus"]>;
		};
	}> {
		const index = this.linearSessionQueue.findIndex(
			(item) => item.sessionId === sessionId,
		);
		if (index === -1) {
			if (this.linearSessionActiveItems.has(sessionId)) {
				return {
					statusCode: 409,
					body: {
						ok: false,
						error: "Task is already active and cannot be reprioritized.",
					},
				};
			}

			return {
				statusCode: 404,
				body: {
					ok: false,
					error: "Task was not found in the waiting queue.",
				},
			};
		}

		const now = Date.now();
		const [item] = this.linearSessionQueue.splice(index, 1);
		if (!item) {
			return {
				statusCode: 404,
				body: {
					ok: false,
					error: "Task was not found in the waiting queue.",
				},
			};
		}

		item.availableAt = Math.min(item.availableAt, now);
		item.prioritizedAt = now;
		this.linearSessionQueue.unshift(item);
		await this.saveLinearSessionQueue();
		this.drainLinearSessionQueue();

		return {
			statusCode: 200,
			body: {
				ok: true,
				message: `${item.workItemIdentifier} was moved to the front of the queue.`,
				item: {
					sessionId: item.sessionId,
					workItemIdentifier: item.workItemIdentifier,
					origin: item.origin,
				},
				queue: this.buildLinearQueueStatus(),
			},
		};
	}

	private getAgentQueueItemUrl(item: AgentSessionQueueItem): string | null {
		if (item.origin === "github") {
			return this.getGitHubQueueItemUrl(item);
		}

		if (item.origin === "linear") {
			return this.getLinearQueueItemUrl(item);
		}

		return null;
	}

	private getAgentQueueItemLinearIssueIdentifier(
		item: AgentSessionQueueItem,
	): string | null {
		if (item.origin === "linear") {
			return this.getLinearQueueItemIdentifier(item);
		}

		if (item.origin === "github" && item.githubEvent) {
			return (
				this.extractLinearIssueIdentifierFromGitHubEvent(item.githubEvent) ??
				null
			);
		}

		if (item.origin === "github" && item.githubPullRequestEvent) {
			return (
				this.extractLinearIssueIdentifierFromText(
					`${item.githubPullRequestEvent.payload.pull_request.title ?? ""}\n${item.githubPullRequestEvent.payload.pull_request.body ?? ""}\n${item.githubPullRequestEvent.payload.pull_request.head?.ref ?? ""}`,
				) ?? null
			);
		}

		return null;
	}

	private getAgentQueueItemLinearIssueUrl(
		item: AgentSessionQueueItem,
	): string | null {
		const identifier = this.getAgentQueueItemLinearIssueIdentifier(item);
		return identifier
			? this.getLinearIssueUrlForIdentifier(item, identifier)
			: null;
	}

	private getLinearQueueItemUrl(item: AgentSessionQueueItem): string | null {
		const issue = item.webhook?.agentSession?.issue as
			| { url?: unknown }
			| undefined;
		if (typeof issue?.url === "string" && issue.url.trim()) {
			return issue.url.trim();
		}

		const identifier = this.getLinearQueueItemIdentifier(item);
		return identifier
			? this.getLinearIssueUrlForIdentifier(item, identifier)
			: null;
	}

	private getLinearQueueItemIdentifier(
		item: AgentSessionQueueItem,
	): string | null {
		const issue = item.webhook?.agentSession?.issue as
			| { url?: unknown; identifier?: unknown }
			| undefined;
		if (typeof issue?.url === "string" && issue.url.trim()) {
			const identifier = this.extractLinearIssueIdentifierFromText(issue.url);
			if (identifier) {
				return identifier;
			}
		}

		const identifier =
			typeof issue?.identifier === "string" && issue.identifier.trim()
				? issue.identifier.trim()
				: item.workItemIdentifier;
		if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(identifier)) {
			return null;
		}

		return identifier.toUpperCase();
	}

	private getLinearIssueUrlForIdentifier(
		item: AgentSessionQueueItem,
		identifier: string,
	): string | null {
		const workspaceSlug = this.getLinearWorkspaceSlugForQueueItem(item);
		if (!workspaceSlug) {
			return null;
		}

		return `https://linear.app/${encodeURIComponent(workspaceSlug)}/issue/${encodeURIComponent(identifier.toUpperCase())}`;
	}

	private getLinearWorkspaceSlugForQueueItem(
		item: AgentSessionQueueItem,
	): string | undefined {
		if (item.githubRepositoryId) {
			const repository = this.repositories.get(item.githubRepositoryId);
			const workspaceSlug = repository?.linearWorkspaceId
				? this.config.linearWorkspaces?.[repository.linearWorkspaceId]
						?.linearWorkspaceSlug
				: undefined;
			if (workspaceSlug) {
				return workspaceSlug;
			}
		}

		if (item.origin === "github" && item.githubEvent) {
			const repository = this.findRepositoryByGitHubUrl(
				extractRepoFullName(item.githubEvent),
			);
			const workspaceSlug = repository?.linearWorkspaceId
				? this.config.linearWorkspaces?.[repository.linearWorkspaceId]
						?.linearWorkspaceSlug
				: undefined;
			if (workspaceSlug) {
				return workspaceSlug;
			}
		}

		if (item.origin === "github" && item.githubPullRequestEvent) {
			const repository = this.findRepositoryByGitHubUrl(
				extractRepoFullName(item.githubPullRequestEvent),
			);
			const workspaceSlug = repository?.linearWorkspaceId
				? this.config.linearWorkspaces?.[repository.linearWorkspaceId]
						?.linearWorkspaceSlug
				: undefined;
			if (workspaceSlug) {
				return workspaceSlug;
			}
		}

		const webhook = item.webhook as { organizationId?: unknown } | undefined;
		const organizationId =
			typeof webhook?.organizationId === "string"
				? webhook.organizationId
				: undefined;
		const workspaceSlug = organizationId
			? this.config.linearWorkspaces?.[organizationId]?.linearWorkspaceSlug
			: undefined;
		if (workspaceSlug) {
			return workspaceSlug;
		}

		const fallbackSlug =
			process.env.CYRUS_LINEAR_WORKSPACE_SLUG ||
			process.env.LINEAR_WORKSPACE_SLUG;
		if (fallbackSlug) {
			return fallbackSlug;
		}

		const workspaceConfigs = Object.values(this.config.linearWorkspaces ?? {});
		if (workspaceConfigs.length === 1) {
			return workspaceConfigs[0]?.linearWorkspaceSlug;
		}

		return undefined;
	}

	private getGitHubQueueItemUrl(item: AgentSessionQueueItem): string | null {
		const payload = (item.githubEvent?.payload ??
			item.githubPullRequestEvent?.payload) as
			| {
					pull_request?: { html_url?: unknown };
					issue?: { html_url?: unknown };
			  }
			| undefined;
		const payloadUrl =
			typeof payload?.pull_request?.html_url === "string"
				? payload.pull_request.html_url
				: typeof payload?.issue?.html_url === "string"
					? payload.issue.html_url
					: undefined;
		if (payloadUrl?.trim()) {
			return payloadUrl.trim();
		}

		const match = item.workItemIdentifier.match(
			/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/,
		);
		if (!match?.[1] || !match?.[2]) {
			return null;
		}

		return `https://github.com/${match[1]}/pull/${match[2]}`;
	}

	private getActiveRunnerCount(): number {
		let activeRunnerCount = 0;
		const runners = this.agentSessionManager.getAllAgentRunners();
		for (const runner of runners) {
			if (runner.isRunning()) {
				activeRunnerCount++;
			}
		}

		if (this.chatSessionHandler?.isAnyRunnerBusy()) {
			activeRunnerCount++;
		}

		return activeRunnerCount;
	}

	private startOperationalMonitor(): void {
		if (this.operationalMonitorTimer) {
			clearInterval(this.operationalMonitorTimer);
		}

		this.checkOperationalHealth();
		this.operationalMonitorTimer = setInterval(() => {
			this.checkOperationalHealth();
		}, this.operationalMonitorIntervalMs);
	}

	private startGarbageCollector(): void {
		if (!this.garbageCollectionEnabled) {
			this.logger.info("Garbage collection disabled");
			return;
		}
		if (this.garbageCollectionTimer) {
			clearInterval(this.garbageCollectionTimer);
		}

		this.garbageCollectionTimer = setInterval(() => {
			void this.runGarbageCollection("scheduled");
		}, this.garbageCollectionIntervalMs);
		this.garbageCollectionTimer.unref?.();
	}

	private async runGarbageCollection(
		reason: string,
		options: { ignoreBusy?: boolean } = {},
	): Promise<void> {
		if (!this.garbageCollectionEnabled || this.garbageCollectionRunning) {
			return;
		}

		this.garbageCollectionRunning = true;
		const summary: GarbageCollectionSummary = {
			reason,
			startedAt: new Date().toISOString(),
			scannedWorktrees: 0,
			removedWorktrees: 0,
			scannedBranches: 0,
			removedLocalBranches: 0,
			removedRemoteBranches: 0,
			scannedTempDirs: 0,
			removedTempDirs: 0,
			removedSessions: 0,
			removedRegistrySessions: 0,
			removedInactiveWorktrees: 0,
			skippedProtected: 0,
			skippedOpenPullRequests: 0,
			skippedUnknownPullRequests: 0,
			skippedFreshWorktrees: 0,
			skippedDirtyWorktrees: 0,
			errors: [],
		};

		try {
			if (
				!this.garbageCollectionRunWhenBusy &&
				!options.ignoreBusy &&
				this.computeStatus() !== "idle"
			) {
				summary.skippedBecauseBusy = true;
				return;
			}

			summary.removedSessions = this.agentSessionManager.cleanup(
				this.garbageCollectionSessionTtlMs,
			);
			summary.removedRegistrySessions = this.globalSessionRegistry.cleanup(
				this.garbageCollectionSessionTtlMs,
			);

			const protection = this.buildGarbageCollectionProtection();
			await this.collectGarbageFromTempDirs(protection, summary);
			await this.collectGarbageFromWorktrees(protection, summary);
			await this.collectGarbageFromLocalBranches(protection, summary);

			if (summary.removedSessions > 0 || summary.removedRegistrySessions > 0) {
				await this.savePersistedState();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summary.errors.push(message);
			this.logger.error("Garbage collection failed", error);
		} finally {
			summary.finishedAt = new Date().toISOString();
			this.lastGarbageCollectionSummary = summary;
			this.garbageCollectionRunning = false;
		}

		if (
			summary.removedWorktrees > 0 ||
			summary.removedLocalBranches > 0 ||
			summary.removedRemoteBranches > 0 ||
			summary.removedTempDirs > 0 ||
			summary.removedSessions > 0 ||
			summary.removedRegistrySessions > 0 ||
			summary.errors.length > 0
		) {
			this.logger.info(
				`Garbage collection finished: removed ${summary.removedWorktrees} worktree(s), ${summary.removedLocalBranches} local branch(es), ${summary.removedRemoteBranches} remote branch(es), ${summary.removedTempDirs} temp dir(s), ${summary.removedSessions} persisted session(s)`,
			);
		}
	}

	private buildGarbageCollectionProtection(): GarbageCollectionProtection {
		const issueIdentifiers = new Set<string>();
		const branchNames = new Set<string>();
		const tempDirNames = new Set<string>();
		const addIssueIdentifier = (identifier?: string | null) => {
			if (identifier?.trim()) {
				issueIdentifiers.add(identifier.trim().toLowerCase());
			}
		};
		const addBranchName = (branchName?: string | null) => {
			if (branchName?.trim()) {
				branchNames.add(branchName.trim().toLowerCase());
			}
		};
		const addSessionId = (sessionId?: string | null) => {
			if (sessionId?.trim()) {
				tempDirNames.add(
					basename(getSessionTempDir(this.cyrusHome, sessionId)),
				);
			}
		};
		const addQueueItem = (item: AgentSessionQueueItem) => {
			addSessionId(item.sessionId);
			if (item.origin === "linear") {
				addIssueIdentifier(item.workItemIdentifier);
				addIssueIdentifier(item.webhook?.agentSession?.issue?.identifier);
				return;
			}
			addBranchName(
				item.githubEvent ? extractPRBranchRef(item.githubEvent) : undefined,
			);
			addBranchName(
				item.githubPullRequestEvent
					? extractPRBranchRef(item.githubPullRequestEvent)
					: undefined,
			);
		};

		for (const item of this.linearSessionQueue) {
			addQueueItem(item);
		}
		for (const item of this.linearSessionActiveItems.values()) {
			addQueueItem(item);
		}
		for (const session of this.agentSessionManager.getActiveSessions()) {
			addSessionId(session.id);
			addIssueIdentifier(session.issueContext?.issueIdentifier);
			addIssueIdentifier(session.issue?.identifier);
			for (const repoContext of session.repositories) {
				addBranchName(repoContext.branchName);
			}
		}
		for (const parked of this.parkedSessions.values()) {
			addIssueIdentifier(parked.agentSession.issue?.identifier);
		}

		return { issueIdentifiers, branchNames, tempDirNames };
	}

	private async collectGarbageFromTempDirs(
		protection: GarbageCollectionProtection,
		summary: GarbageCollectionSummary,
	): Promise<void> {
		const tempRoot = getSessionTempRoot(this.cyrusHome);
		if (!existsSync(tempRoot)) {
			return;
		}

		const cutoff = Date.now() - this.garbageCollectionTempTtlMs;
		const entries = await readdir(tempRoot, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			if (!entry.isDirectory() || !isSessionTempDirName(entry.name)) {
				continue;
			}

			summary.scannedTempDirs++;
			if (protection.tempDirNames.has(entry.name)) {
				summary.skippedProtected++;
				continue;
			}

			const tempPath = join(tempRoot, entry.name);
			const info = await stat(tempPath).catch(() => undefined);
			if (!info || info.mtimeMs >= cutoff) {
				continue;
			}

			try {
				await rm(tempPath, { recursive: true, force: true });
				summary.removedTempDirs++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				summary.errors.push(
					`Failed to remove temp directory ${entry.name}: ${message}`,
				);
			}
		}
	}

	private async collectGarbageFromWorktrees(
		protection: GarbageCollectionProtection,
		summary: GarbageCollectionSummary,
	): Promise<void> {
		const worktreesDir = getDefaultWorktreesDir(this.cyrusHome);
		if (!existsSync(worktreesDir)) {
			return;
		}

		const entries = await readdir(worktreesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (this.hasReachedGarbageCollectionRemovalLimit(summary)) {
				break;
			}
			if (!entry.isDirectory()) {
				continue;
			}

			const issueIdentifier = entry.name;
			const workspacePath = join(worktreesDir, issueIdentifier);
			summary.scannedWorktrees++;

			if (this.isProtectedIssueIdentifier(issueIdentifier, protection)) {
				summary.skippedProtected++;
				continue;
			}

			const branchRefs = this.listWorktreeBranchRefs(workspacePath);
			if (branchRefs.length === 0) {
				const blocker = await this.getInactiveWorktreeRemovalBlocker(
					workspacePath,
					branchRefs,
				);
				if (blocker) {
					if (blocker === "stat") {
						summary.skippedUnknownPullRequests++;
					} else {
						this.recordInactiveWorktreeRemovalBlocker(blocker, summary);
					}
					continue;
				}

				await this.deleteGarbageCollectedWorktree(
					issueIdentifier,
					summary,
					true,
				);
				continue;
			}

			const terminalRefs: Array<{
				ref: WorktreeBranchRef;
				pr: PullRequestGarbageCollectionState;
			}> = [];
			let hasProtectedBranch = false;
			let hasOpenPullRequest = false;
			let hasUnknownPullRequest = false;
			let hasNonCyrusBranch = false;

			for (const ref of branchRefs) {
				if (this.isProtectedBranch(ref.branch, protection)) {
					summary.skippedProtected++;
					hasProtectedBranch = true;
					break;
				}

				if (!this.isCyrusGarbageCollectionBranch(ref.branch, issueIdentifier)) {
					hasNonCyrusBranch = true;
					continue;
				}

				const pr = this.getPullRequestGarbageCollectionState(
					ref.path,
					ref.branch,
				);
				if (!pr) {
					hasUnknownPullRequest = true;
					continue;
				}
				if (!this.isTerminalPullRequestEligibleForGarbageCollection(pr)) {
					hasOpenPullRequest = true;
					continue;
				}

				terminalRefs.push({ ref, pr });
			}

			if (hasProtectedBranch) {
				continue;
			}

			if (terminalRefs.length === branchRefs.length) {
				await this.deleteGarbageCollectedWorktree(
					issueIdentifier,
					summary,
					false,
				);
				for (const { ref, pr } of terminalRefs) {
					this.deleteGarbageCollectedBranch(
						ref.repoPath,
						ref.branch,
						pr,
						summary,
					);
				}
				continue;
			}

			const blocker = await this.getInactiveWorktreeRemovalBlocker(
				workspacePath,
				branchRefs,
			);
			if (!blocker) {
				await this.deleteGarbageCollectedWorktree(
					issueIdentifier,
					summary,
					true,
				);
				continue;
			}

			if (blocker === "stat") {
				if (hasOpenPullRequest) {
					summary.skippedOpenPullRequests++;
				} else if (hasUnknownPullRequest || hasNonCyrusBranch) {
					summary.skippedUnknownPullRequests++;
				}
			} else {
				this.recordInactiveWorktreeRemovalBlocker(blocker, summary);
			}
		}
	}

	private async deleteGarbageCollectedWorktree(
		issueIdentifier: string,
		summary: GarbageCollectionSummary,
		inactiveOnly: boolean,
	): Promise<void> {
		try {
			await this.gitService.deleteWorktree(issueIdentifier);
			summary.removedWorktrees++;
			if (inactiveOnly) {
				summary.removedInactiveWorktrees++;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summary.errors.push(
				`Failed to remove worktree ${issueIdentifier}: ${message}`,
			);
		}
	}

	private async getInactiveWorktreeRemovalBlocker(
		workspacePath: string,
		branchRefs: WorktreeBranchRef[],
	): Promise<InactiveWorktreeRemovalBlocker | null> {
		const info = await stat(workspacePath).catch(() => undefined);
		if (!info) {
			return "stat";
		}

		if (Date.now() - info.mtimeMs < this.garbageCollectionWorktreeTtlMs) {
			return "fresh";
		}

		for (const ref of branchRefs) {
			if (!this.isGitWorktreeClean(ref.path)) {
				return "dirty";
			}
		}

		return null;
	}

	private recordInactiveWorktreeRemovalBlocker(
		blocker: InactiveWorktreeRemovalBlocker,
		summary: GarbageCollectionSummary,
	): void {
		if (blocker === "fresh") {
			summary.skippedFreshWorktrees++;
			return;
		}
		if (blocker === "dirty") {
			summary.skippedDirtyWorktrees++;
		}
	}

	private async collectGarbageFromLocalBranches(
		protection: GarbageCollectionProtection,
		summary: GarbageCollectionSummary,
	): Promise<void> {
		for (const repository of this.repositories.values()) {
			if (
				!repository.repositoryPath ||
				!existsSync(repository.repositoryPath)
			) {
				continue;
			}

			const checkedOutBranches = this.listCheckedOutBranches(
				repository.repositoryPath,
			);
			for (const branch of this.listLocalBranches(repository.repositoryPath)) {
				if (this.hasReachedGarbageCollectionRemovalLimit(summary)) {
					return;
				}
				if (!this.isCyrusGarbageCollectionBranch(branch)) {
					continue;
				}

				summary.scannedBranches++;
				if (
					checkedOutBranches.has(branch.toLowerCase()) ||
					this.isProtectedBranch(branch, protection)
				) {
					summary.skippedProtected++;
					continue;
				}

				const pr = this.getPullRequestGarbageCollectionState(
					repository.repositoryPath,
					branch,
				);
				if (!pr) {
					summary.skippedUnknownPullRequests++;
					continue;
				}
				if (!this.isTerminalPullRequestEligibleForGarbageCollection(pr)) {
					summary.skippedOpenPullRequests++;
					continue;
				}

				this.deleteGarbageCollectedBranch(
					repository.repositoryPath,
					branch,
					pr,
					summary,
				);
			}
		}
	}

	private hasReachedGarbageCollectionRemovalLimit(
		summary: GarbageCollectionSummary,
	): boolean {
		return (
			summary.removedWorktrees +
				summary.removedLocalBranches +
				summary.removedRemoteBranches >=
			this.garbageCollectionMaxRemovalsPerRun
		);
	}

	private listWorktreeBranchRefs(workspacePath: string): WorktreeBranchRef[] {
		const candidates = [workspacePath];
		try {
			for (const entry of readdirSync(workspacePath, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					candidates.push(join(workspacePath, entry.name));
				}
			}
		} catch {
			// If listing subdirectories fails, still inspect the workspace root.
		}

		const refs: WorktreeBranchRef[] = [];
		for (const path of candidates) {
			if (!existsSync(join(path, ".git"))) {
				continue;
			}

			const branch = this.readGitOutput(path, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);
			if (!branch || branch === "HEAD") {
				continue;
			}

			const gitCommonDir = this.readGitOutput(path, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]);
			const repoPath = gitCommonDir?.endsWith(".git")
				? dirname(gitCommonDir)
				: path;
			refs.push({ path, branch, repoPath });
		}

		return refs;
	}

	private listLocalBranches(repositoryPath: string): string[] {
		const output = this.readGitOutput(repositoryPath, [
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		if (!output) {
			return [];
		}

		return output
			.split("\n")
			.map((branch) => branch.trim())
			.filter(Boolean);
	}

	private listCheckedOutBranches(repositoryPath: string): Set<string> {
		const output = this.readGitOutput(repositoryPath, [
			"worktree",
			"list",
			"--porcelain",
		]);
		const branches = new Set<string>();
		if (!output) {
			return branches;
		}

		for (const line of output.split("\n")) {
			if (line.startsWith("branch refs/heads/")) {
				branches.add(line.slice("branch refs/heads/".length).toLowerCase());
			}
		}
		return branches;
	}

	private readGitOutput(cwd: string, args: string[]): string | null {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 20_000,
			}).trim();
		} catch {
			return null;
		}
	}

	private isGitWorktreeClean(cwd: string): boolean {
		const output = this.readGitOutput(cwd, ["status", "--porcelain"]);
		return output === "";
	}

	private getPullRequestGarbageCollectionState(
		cwd: string,
		branch: string,
	): PullRequestGarbageCollectionState | null {
		try {
			const raw = execFileSync(
				"gh",
				[
					"pr",
					"view",
					branch,
					"--json",
					"state,mergedAt,closedAt,url,headRefName",
				],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30_000,
				},
			);
			return JSON.parse(raw) as PullRequestGarbageCollectionState;
		} catch {
			return null;
		}
	}

	private isTerminalPullRequestEligibleForGarbageCollection(
		pr: PullRequestGarbageCollectionState,
	): boolean {
		const state = pr.state?.toUpperCase();
		if (state !== "MERGED" && state !== "CLOSED") {
			return false;
		}

		const terminalAt = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
		if (!Number.isFinite(terminalAt)) {
			return true;
		}

		return Date.now() - terminalAt >= this.garbageCollectionTerminalPrGraceMs;
	}

	private deleteGarbageCollectedBranch(
		repositoryPath: string,
		branch: string,
		pr: PullRequestGarbageCollectionState,
		summary: GarbageCollectionSummary,
	): void {
		try {
			execFileSync("git", ["branch", "-D", branch], {
				cwd: repositoryPath,
				stdio: "pipe",
				timeout: 20_000,
			});
			summary.removedLocalBranches++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summary.errors.push(
				`Failed to delete local branch ${branch}: ${message}`,
			);
		}

		if (!this.garbageCollectionDeleteRemoteBranches || !pr.mergedAt) {
			return;
		}

		try {
			execFileSync("git", ["push", "origin", "--delete", branch], {
				cwd: repositoryPath,
				stdio: "pipe",
				timeout: 30_000,
			});
			summary.removedRemoteBranches++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summary.errors.push(
				`Failed to delete remote branch ${branch}: ${message}`,
			);
		}
	}

	private isProtectedIssueIdentifier(
		issueIdentifier: string,
		protection: GarbageCollectionProtection,
	): boolean {
		return protection.issueIdentifiers.has(issueIdentifier.toLowerCase());
	}

	private isProtectedBranch(
		branch: string,
		protection: GarbageCollectionProtection,
	): boolean {
		const normalizedBranch = branch.toLowerCase();
		if (protection.branchNames.has(normalizedBranch)) {
			return true;
		}

		const issueIdentifier = this.extractLinearIssueIdentifierFromText(branch);
		return issueIdentifier
			? protection.issueIdentifiers.has(issueIdentifier.toLowerCase())
			: false;
	}

	private isCyrusGarbageCollectionBranch(
		branch: string,
		_issueIdentifier?: string,
	): boolean {
		const normalizedBranch = branch.toLowerCase();
		return this.getCyrusGitHubPrBranchPrefixes().some((prefix) =>
			normalizedBranch.startsWith(prefix.toLowerCase()),
		);
	}

	private checkOperationalHealth(): void {
		const now = Date.now();

		for (const item of this.linearSessionQueue) {
			const queuedForMs = Math.max(0, now - item.queuedAt);
			if (queuedForMs >= this.queueWaitAlertMs) {
				void this.sendOperationalAlert({
					key: `agent-queue-wait:${item.sessionId}`,
					severity: "warning",
					title: "Agent task waiting in queue",
					message: `${item.workItemIdentifier} (${item.origin}) has been queued for ${Math.round(
						queuedForMs / 60_000,
					)} minutes.`,
				});
			}
		}

		for (const item of this.linearSessionActiveItems.values()) {
			const runningForMs = item.startedAt
				? Math.max(0, now - item.startedAt)
				: 0;
			if (runningForMs >= this.activeTaskAlertMs) {
				void this.sendOperationalAlert({
					key: `agent-active-stuck:${item.sessionId}`,
					severity: "warning",
					title: "Agent task running for a long time",
					message: `${item.workItemIdentifier} (${item.origin}) has been running for ${Math.round(
						runningForMs / 60_000,
					)} minutes.`,
				});
			}
		}

		if (this.linearSessionCooldownUntil > now) {
			void this.sendOperationalAlert({
				key: "linear-rate-limit-cooldown",
				severity: "warning",
				title: "Linear queue is rate limited",
				message: `Queue paused until ${new Date(
					this.linearSessionCooldownUntil,
				).toISOString()}.`,
			});
		}
	}

	private async sendOperationalAlert(input: {
		key: string;
		severity: OperationalAlertSeverity;
		title: string;
		message: string;
	}): Promise<void> {
		const now = Date.now();
		const lastSentAt = this.operationalAlertLastSentByKey.get(input.key);
		const shouldSend =
			!lastSentAt || now - lastSentAt >= this.operationalAlertDedupeMs;

		const existing = this.operationalAlerts.find(
			(alert) => alert.key === input.key,
		);
		if (existing) {
			existing.severity = input.severity;
			existing.title = input.title;
			existing.message = input.message;
			if (shouldSend) {
				existing.lastSentAt = now;
				existing.sendCount += 1;
			}
		} else {
			this.operationalAlerts.unshift({
				...input,
				createdAt: now,
				lastSentAt: shouldSend ? now : undefined,
				sendCount: shouldSend ? 1 : 0,
			});
			this.operationalAlerts = this.operationalAlerts.slice(0, 50);
		}

		if (!shouldSend) {
			return;
		}

		this.operationalAlertLastSentByKey.set(input.key, now);
		await this.postSlackOperationalAlert(input);
	}

	private async postSlackOperationalAlert(input: {
		severity: OperationalAlertSeverity;
		title: string;
		message: string;
	}): Promise<void> {
		const token = process.env.SLACK_BOT_TOKEN?.trim();
		const channel =
			process.env.CYRUS_ALERT_SLACK_CHANNEL_ID?.trim() ||
			process.env.CYRUS_ALERT_SLACK_CHANNEL?.trim();
		if (!token || !channel) {
			return;
		}

		const response = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				channel,
				text: `[${input.severity.toUpperCase()}] ${input.title}: ${
					input.message
				}`,
				unfurl_links: false,
				unfurl_media: false,
			}),
		});
		const body = (await response.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
		} | null;
		if (!response.ok || body?.ok === false) {
			this.logger.warn(
				`Failed to post Slack operational alert: ${
					body?.error || response.statusText
				}`,
			);
		}
	}

	/**
	 * Test-only: dispatch a synthetic Slack webhook event through the chat
	 * session handler. Used by the F1 test harness to exercise the Slack →
	 * ClaudeRunner code path end-to-end without a real Slack signature.
	 */
	async dispatchChatTestEvent(event: SlackWebhookEvent): Promise<void> {
		if (!this.chatSessionHandler) {
			throw new Error("chatSessionHandler not initialized");
		}
		await this.chatSessionHandler.handleEvent(event);
	}

	/**
	 * Public accessor for the shared Fastify-based application server.
	 * Used by F1 to register test-only routes alongside production webhook routes.
	 */
	getSharedApplicationServer(): SharedApplicationServer {
		return this.sharedApplicationServer;
	}

	/**
	 * Test-only: list active chat threads (threadKey → sessionId).
	 */
	listChatThreads(): Array<{ threadKey: string; sessionId: string }> {
		if (!this.chatSessionHandler) return [];
		return this.chatSessionHandler.listThreads();
	}

	/**
	 * Test-only: fetch the last assistant text reply for a chat thread.
	 * Returns null when the thread or runner is unknown, or no assistant
	 * message has been produced yet.
	 */
	getChatThreadLastReply(threadKey: string): {
		text: string;
		isRunning: boolean;
		messageCount: number;
	} | null {
		if (!this.chatSessionHandler) return null;
		const runner = this.chatSessionHandler.getRunnerForThread(threadKey);
		if (!runner) return null;
		const messages = runner.getMessages();
		const lastAssistant = [...messages]
			.reverse()
			.find((m) => m.type === "assistant");
		let text = "";
		if (
			lastAssistant &&
			lastAssistant.type === "assistant" &&
			"message" in lastAssistant
		) {
			const msg = lastAssistant as {
				message: { content: Array<{ type: string; text?: string }> };
			};
			const block = msg.message.content?.find(
				(b) => b.type === "text" && b.text,
			);
			if (block?.text) text = block.text;
		}
		return {
			text,
			isRunning: runner.isRunning(),
			messageCount: messages.length,
		};
	}

	/**
	 * Stop the edge worker
	 */
	async stop(): Promise<void> {
		if (this.operationalMonitorTimer) {
			clearInterval(this.operationalMonitorTimer);
			this.operationalMonitorTimer = null;
		}
		if (this.garbageCollectionTimer) {
			clearInterval(this.garbageCollectionTimer);
			this.garbageCollectionTimer = null;
		}

		// Stop config file watcher
		await this.configManager.stop();

		try {
			await this.saveLinearSessionQueue();
			await this.savePersistedState();
			this.logger.info("✅ EdgeWorker state saved successfully");
		} catch (error) {
			this.logger.error(
				"❌ Failed to save EdgeWorker state during shutdown:",
				error,
			);
		}

		// get all agent runners (including chat platform sessions)
		const agentRunners: IAgentRunner[] = [
			...this.agentSessionManager.getAllAgentRunners(),
		];
		if (this.chatSessionHandler) {
			agentRunners.push(...this.chatSessionHandler.getAllRunners());
		}

		// Kill all agent processes with null checking
		for (const runner of agentRunners) {
			if (runner) {
				try {
					runner.stop();
				} catch (error) {
					this.logger.error("Error stopping Claude runner:", error);
				}
			}
		}

		// Clear event transport (no explicit cleanup needed, routes are removed when server stops)
		this.linearEventTransport = null;
		this.configUpdater = null;
		this.mcpConfigService.clearAllContexts();
		this.cyrusToolsMcpSessions.removeAllListeners();
		this.cyrusToolsMcpRegistered = false;

		// Stop egress proxy
		if (this.egressProxy) {
			await this.egressProxy.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}

		// Stop shared application server (this also stops Cloudflare tunnel if running)
		await this.sharedApplicationServer.stop();
	}

	/**
	 * Apply sandbox config changes from a config reload.
	 * Handles three transitions:
	 * - enabled → enabled: update network policy on the running proxy
	 * - disabled → enabled: start a new proxy
	 * - enabled → disabled: stop the running proxy
	 */
	private async applySandboxConfigChanges(
		newConfig: EdgeWorkerConfig,
	): Promise<void> {
		const wasEnabled = this.egressProxy !== null;
		const isEnabled = newConfig.sandbox?.enabled === true;

		if (wasEnabled && isEnabled) {
			// Policy update — proxy stays running, rules change
			// Pass current policy (or empty object to reset to allow-all)
			this.egressProxy!.updateNetworkPolicy(
				newConfig.sandbox?.networkPolicy ?? {},
			);
			// Handle systemWideCert toggling while proxy is running
			if (newConfig.sandbox?.systemWideCert) {
				this.egressCaCertPath = null;
			} else if (!this.egressCaCertPath) {
				this.egressCaCertPath = this.egressProxy!.buildCACertBundle();
			}
		} else if (!wasEnabled && isEnabled) {
			// Start proxy for the first time
			this.logger.info("🛡️  Sandbox egress proxy: starting (config change)...");
			this.egressProxy = new EgressProxy(
				newConfig.sandbox!,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};
			const systemWideCert = newConfig.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else if (wasEnabled && !isEnabled) {
			// Stop proxy
			this.logger.info(
				"🛡️  Sandbox egress proxy: stopping (disabled in config)",
			);
			await this.egressProxy!.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}
	}

	/**
	 * Log instructions for trusting the egress proxy CA certificate.
	 * When systemWideCert is true, logs that env vars are skipped and trust
	 * is expected from the OS cert store. Otherwise logs env var list and
	 * checks macOS keychain trust status.
	 */
	private logCertTrustInstructions(
		certPath: string,
		systemWideCert = false,
	): void {
		this.logger.info(`🛡️  Sandbox TLS interception CA certificate: ${certPath}`);

		if (systemWideCert) {
			this.logger.info(
				"🛡️  systemWideCert: true — per-session CA cert env vars are skipped (OS cert store handles trust)",
			);
		} else {
			this.logger.info(
				"🛡️  Per-session env vars are set automatically: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, PIP_CERT, CURL_CA_BUNDLE, CARGO_HTTP_CAINFO, AWS_CA_BUNDLE, DENO_CERT",
			);
		}

		const trusted = this.isCertTrustedSystemWide();
		if (trusted) {
			this.logger.info("🛡️  CA certificate is trusted system-wide ✓");
			if (!systemWideCert) {
				this.logger.info(
					"🛡️  Tip: set sandbox.systemWideCert: true in config.json to skip per-session cert env vars",
				);
			}
		} else {
			if (process.platform === "darwin") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted in the macOS System keychain. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
				);
			} else if (process.platform === "linux") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted system-wide. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo cp ${certPath} /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`,
				);
			}
			if (systemWideCert) {
				this.logger.warn(
					"🛡️  systemWideCert is true but cert is not trusted — tools using the OS cert store will fail TLS verification",
				);
			}
		}
	}

	/**
	 * Check whether the Cyrus egress proxy CA is trusted at the OS level.
	 * macOS: searches the System keychain. Linux: checks update-ca-certificates output.
	 */
	private isCertTrustedSystemWide(): boolean {
		try {
			if (process.platform === "darwin") {
				execSync(
					'security find-certificate -c "Cyrus Egress Proxy CA" /Library/Keychains/System.keychain',
					{ stdio: "ignore" },
				);
				return true;
			}
			if (process.platform === "linux") {
				// Check if our cert exists in the system CA certificates directory
				execSync(
					"test -f /usr/local/share/ca-certificates/cyrus-egress-ca.crt",
					{ stdio: "ignore" },
				);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Set the config file path for dynamic reloading
	 */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
		this.configManager.setConfigPath(configPath);
	}

	/**
	 * Handle resuming a parent session when a child session completes
	 * This is the core logic used by the resume parent session callback
	 * Extracted to reduce duplication between constructor and addNewRepositories
	 */
	private async handleResumeParentSession(
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId: parentSessionId });
		log.info(
			`Child session completed, resuming parent session ${parentSessionId}`,
		);

		// Find parent session from the single session manager
		log.debug(`Looking up parent session ${parentSessionId}`);
		const parentSession = this.agentSessionManager.getSession(parentSessionId);
		const parentRepoId = this.sessionRepositories.get(parentSessionId);
		const parentRepo = parentRepoId
			? this.repositories.get(parentRepoId)
			: undefined;
		const parentAgentSessionManager = this.agentSessionManager;

		if (!parentSession || !parentRepo) {
			log.error(
				`Parent session ${parentSessionId} not found in any repository's agent session manager`,
			);
			return;
		}

		// Extract workspace ID once for all operations in this method
		const parentWorkspaceId = requireLinearWorkspaceId(parentRepo);

		log.debug(
			`Found parent session - Issue: ${parentSession.issueId}, Workspace: ${parentSession.workspace.path}`,
		);

		// Get the child session to access its workspace path
		const childSession = this.agentSessionManager.getSession(childSessionId);
		const childWorkspaceDirs: string[] = [];
		if (childSession) {
			childWorkspaceDirs.push(childSession.workspace.path);
			log.debug(
				`Adding child workspace to parent allowed directories: ${childSession.workspace.path}`,
			);
		} else {
			log.warn(
				`Could not find child session ${childSessionId} to add workspace to parent allowed directories`,
			);
		}

		await this.postParentResumeAcknowledgment(
			parentSessionId,
			parentWorkspaceId,
		);

		// Post thought showing child result receipt
		// Use parent's issue tracker since we're posting to the parent's session
		const issueTracker = this.issueTrackers.get(parentWorkspaceId);
		if (issueTracker && childSession) {
			const childIssueIdentifier =
				childSession.issue?.identifier || childSession.issueId;
			const resultThought = `Received result from sub-issue ${childIssueIdentifier}:\n\n---\n\n${prompt}\n\n---`;

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId: parentSessionId,
					content: { type: "thought", body: resultThought },
				},
				"child result receipt",
			);
		}

		// Use centralized streaming check and routing logic
		log.info(`Handling child result for parent session ${parentSessionId}`);
		try {
			await this.handlePromptWithStreamingCheck(
				parentSession,
				parentRepo,
				parentSessionId,
				parentAgentSessionManager,
				prompt,
				"", // No attachment manifest for child results
				false, // Not a new session
				childWorkspaceDirs, // Add child workspace directories to parent's allowed directories
				"parent resume from child",
				parentWorkspaceId,
			);
			log.info(
				`Successfully handled child result for parent session ${parentSessionId}`,
			);
		} catch (error) {
			log.error(`Failed to resume parent session ${parentSessionId}:`, error);
			log.error(
				`Error context - Parent issue: ${parentSession.issueId}, Repository: ${parentRepo.name}`,
			);
		}
	}

	/**
	 * Detect workspace token changes and update all dependent services.
	 *
	 * When an OAuth token is refreshed (at least once per day), the new token is
	 * persisted to config.json which triggers the file watcher.  This method
	 * compares the previous in-memory tokens against the new config and calls
	 * `setAccessToken()` on any affected `LinearIssueTrackerService` instances,
	 * and pushes the updated workspace configs to `AttachmentService`.
	 */
	private updateLinearWorkspaceTokens(newConfig: EdgeWorkerConfig): void {
		const oldWorkspaces = this.config.linearWorkspaces ?? {};
		const newWorkspaces = newConfig.linearWorkspaces ?? {};

		let anyTokenChanged = false;

		for (const [workspaceId, newWsConfig] of Object.entries(newWorkspaces)) {
			const oldToken = oldWorkspaces[workspaceId]?.linearToken;
			const newToken = newWsConfig.linearToken;

			if (oldToken === newToken) continue;

			anyTokenChanged = true;

			// Update existing issue tracker in-place
			const issueTracker = this.issueTrackers.get(workspaceId);
			if (issueTracker) {
				(issueTracker as LinearIssueTrackerService).setAccessToken(newToken);
				this.logger.info(
					`🔑 Updated Linear token for workspace ${workspaceId}`,
				);
			} else if (this.config.platform !== "cli") {
				// Workspace is new — create a tracker and activity sink for it
				const newIssueTracker = new LinearIssueTrackerService(
					new LinearClient({ accessToken: newToken }),
					this.buildOAuthConfig(workspaceId),
				);
				this.issueTrackers.set(workspaceId, newIssueTracker);
				this.activitySinks.set(
					workspaceId,
					new LinearActivitySink(newIssueTracker, workspaceId),
				);
				this.logger.info(
					`🔑 Created issue tracker for new workspace ${workspaceId}`,
				);
			}
		}

		if (anyTokenChanged) {
			// Push refreshed workspace configs to AttachmentService
			this.attachmentService.setLinearWorkspaces(newWorkspaces);
		}
	}

	/**
	 * Add new repositories to the running EdgeWorker
	 */
	private async addNewRepositories(repos: RepositoryConfig[]): Promise<void> {
		for (const repo of repos) {
			if (repo.isActive === false) {
				this.logger.info(`⏭️  Skipping inactive repository: ${repo.name}`);
				continue;
			}

			try {
				this.logger.info(`➕ Adding repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Add to internal map
				this.repositories.set(repo.id, resolvedRepo);

				this.logger.info(`✅ Repository added successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(`❌ Failed to add repository ${repo.name}:`, error);
			}
		}
	}

	/**
	 * Update existing repositories
	 */
	private async updateModifiedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				const oldRepo = this.repositories.get(repo.id);
				if (!oldRepo) {
					this.logger.warn(
						`⚠️  Repository ${repo.id} not found for update, skipping`,
					);
					continue;
				}

				this.logger.info(`🔄 Updating repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Update stored config
				this.repositories.set(repo.id, resolvedRepo);

				// If active status changed
				if (oldRepo.isActive !== repo.isActive) {
					if (repo.isActive === false) {
						this.logger.info(
							`  ⏸️  Repository set to inactive - existing sessions will continue`,
						);
					} else {
						this.logger.info(`  ▶️  Repository reactivated`);
					}
				}

				this.logger.info(`✅ Repository updated successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to update repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Remove deleted repositories
	 */
	private async removeDeletedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				this.logger.info(`🗑️  Removing repository: ${repo.name} (${repo.id})`);

				// Check for active sessions for this repository
				const allActiveSessions = this.agentSessionManager.getActiveSessions();
				const activeSessions = allActiveSessions.filter(
					(s) => this.sessionRepositories.get(s.id) === repo.id,
				);

				if (activeSessions.length > 0) {
					this.logger.warn(
						`  ⚠️  Repository has ${activeSessions.length} active sessions - stopping them`,
					);

					// Stop all active sessions and notify Linear
					for (const session of activeSessions) {
						try {
							this.logger.debug(
								`  🛑 Stopping session for issue ${session.issueId}`,
							);

							// Get the agent runner for this session
							const runner = this.agentSessionManager.getAgentRunner(
								session.id,
							);
							if (runner) {
								// Stop the agent process
								runner.stop();
								this.logger.debug(
									`  ✅ Stopped Claude runner for session ${session.id}`,
								);
							}

							// Post cancellation message to tracker
							const issueTracker = this.issueTrackers.get(
								requireLinearWorkspaceId(repo),
							);
							if (issueTracker && session.externalSessionId) {
								await this.postActivityDirect(
									issueTracker,
									{
										agentSessionId: session.externalSessionId,
										content: {
											type: "response",
											body: `**Repository Removed from Configuration**\n\nThis repository (\`${repo.name}\`) has been removed from the Cyrus configuration. All active sessions for this repository have been stopped.\n\nIf you need to continue working on this issue, please contact your administrator to restore the repository configuration.`,
										},
									},
									"repository removal",
								);
							}
						} catch (error) {
							this.logger.error(
								`  ❌ Failed to stop session ${session.id}:`,
								error,
							);
						}
					}
				}

				// Remove repository from the repositories map.
				// Note: we intentionally do NOT remove workspace-level issue trackers
				// or activity sinks here. They are keyed by workspace ID and may be
				// needed by other repositories in the same workspace, or by new
				// repositories about to be added in the same configChanged cycle.
				// They will be naturally replaced when workspace tokens are updated.
				this.repositories.delete(repo.id);

				this.logger.info(`✅ Repository removed successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to remove repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle errors
	 */
	private handleError(error: Error): void {
		this.emit("error", error);
		this.config.handlers?.onError?.(error);
	}

	/**
	 * Get cached repositories for an issue (used by agentSessionPrompted Branch 3)
	 * Returns null if nothing cached, or array of resolved RepositoryConfigs.
	 */
	private getCachedRepositories(issueId: string): RepositoryConfig[] | null {
		return this.repositoryRouter.getCachedRepositories(
			issueId,
			this.repositories,
		);
	}

	/**
	 * Get first cached repository for an issue (convenience for single-repo callers)
	 */
	private getCachedRepository(issueId: string): RepositoryConfig | null {
		const repos = this.getCachedRepositories(issueId);
		return repos && repos.length > 0 ? repos[0]! : null;
	}

	/**
	 * Handle webhook events from proxy - main router for all webhooks
	 */
	private async handleWebhook(
		webhook: Webhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		// Track active webhook processing for status endpoint
		this.activeWebhookCount++;

		const webhookAction = (webhook as { action?: string }).action;
		const webhookType = (webhook as { type?: string }).type;
		this.logger.event("webhook_received", {
			source: "linear",
			action: webhookAction,
			type: webhookType,
			repoCount: repos.length,
		});

		// Log verbose webhook info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Full webhook payload:`,
				JSON.stringify(webhook, null, 2),
			);
		}

		try {
			// Route to specific webhook handlers based on webhook type
			// NOTE: Traditional webhooks (assigned, comment) are disabled in favor of agent session events
			if (isIssueAssignedWebhook(webhook)) {
				return;
			} else if (isIssueCommentMentionWebhook(webhook)) {
				return;
			} else if (isIssueNewCommentWebhook(webhook)) {
				return;
			} else if (isIssueUnassignedWebhook(webhook)) {
				// Keep unassigned webhook active
				await this.handleIssueUnassignedWebhook(webhook);
			} else if (isAgentSessionCreatedWebhook(webhook)) {
				await this.enqueueLinearAgentSession(webhook, repos);
			} else if (isAgentSessionPromptedWebhook(webhook)) {
				await this.handleUserPromptedAgentActivity(webhook);
			} else if (isIssueStateChangeWebhook(webhook)) {
				// Intentional early return: state changes are handled exclusively via the message bus
				// (handleIssueStateChangeMessage), not the legacy webhook path. This differs from
				// unassign which still uses the legacy handler — state change was built message-bus-first.
				return;
			} else if (isIssueDeletedWebhook(webhook)) {
				// Issue deletion also handled via message bus — same cleanup as terminal state.
				return;
			} else if (isIssueTitleOrDescriptionUpdateWebhook(webhook)) {
				// Handle issue title/description/attachments updates - feed changes into active session
				await this.handleIssueContentUpdate(webhook);
			} else if (isIssueStateIdUpdateWebhook(webhook)) {
				// Handle issue state changes — wake up parked sessions when blocking issues complete
				await this.handleIssueStateChange(webhook);
			} else {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.debug(
						`Unhandled webhook type: ${(webhook as any).action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process webhook: ${(webhook as any).action}`,
				error,
			);
			// Don't re-throw webhook processing errors to prevent application crashes
			// The error has been logged and individual webhook failures shouldn't crash the entire system
		} finally {
			// Always decrement counter when webhook processing completes
			this.activeWebhookCount--;
		}
	}

	// ============================================================================
	// INTERNAL MESSAGE BUS HANDLERS
	// ============================================================================
	// These handlers process unified InternalMessage types from the message bus.
	// They provide a platform-agnostic interface for handling events from
	// Linear, GitHub, Slack, and other platforms.
	// ============================================================================

	/**
	 * Handle unified internal messages from the message bus.
	 * This is the new entry point for processing events from all platforms.
	 *
	 * Note: For now, this runs in parallel with legacy webhook handlers.
	 * Once migration is complete, legacy handlers will be removed.
	 */
	private async handleMessage(message: InternalMessage): Promise<void> {
		// NOTE: activeWebhookCount is NOT tracked here because legacy webhook handlers
		// already increment/decrement it for every event. Counting here would double-count.
		// TODO: When legacy handlers are removed, restore activeWebhookCount tracking here.

		// Log verbose message info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Internal message received: ${message.source}/${message.action}`,
				JSON.stringify(message, null, 2),
			);
		}

		try {
			// Route to specific message handlers based on action type
			if (isSessionStartMessage(message)) {
				await this.handleSessionStartMessage(message);
			} else if (isUserPromptMessage(message)) {
				await this.handleUserPromptMessage(message);
			} else if (isStopSignalMessage(message)) {
				await this.handleStopSignalMessage(message);
			} else if (isContentUpdateMessage(message)) {
				await this.handleContentUpdateMessage(message);
			} else if (isUnassignMessage(message)) {
				await this.handleUnassignMessage(message);
			} else if (isIssueStateChangeMessage(message)) {
				await this.handleIssueStateChangeMessage(message);
			} else {
				// This branch should never be reached due to exhaustive type checking
				// If it is reached, log the unexpected message for debugging
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					const unexpectedMessage = message as InternalMessage;
					this.logger.debug(
						`Unhandled message action: ${unexpectedMessage.action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process message: ${message.source}/${message.action}`,
				error,
			);
			// Don't re-throw message processing errors to prevent application crashes
		}
	}

	/**
	 * Handle session start message (unified handler for session creation).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleAgentSessionCreatedWebhook and handleGitHubWebhook.
	 */
	private async handleSessionStartMessage(
		message: SessionStartMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Session start: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified session start handling
		// For now, the legacy handlers (handleAgentSessionCreatedWebhook, handleGitHubWebhook)
		// continue to process the actual session creation via the 'event' emitter.
	}

	/**
	 * Handle user prompt message (unified handler for mid-session prompts).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 3).
	 */
	private async handleUserPromptMessage(
		message: UserPromptMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] User prompt: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified user prompt handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual prompt via the 'event' emitter.
	}

	/**
	 * Handle stop signal message (unified handler for session termination).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 1).
	 */
	private async handleStopSignalMessage(
		message: StopSignalMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Stop signal: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified stop signal handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual stop via the 'event' emitter.
	}

	/**
	 * Handle content update message (unified handler for issue/PR content changes).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueContentUpdate.
	 */
	private async handleContentUpdateMessage(
		message: ContentUpdateMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Content update: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified content update handling
		// For now, the legacy handler (handleIssueContentUpdate)
		// continues to process the actual update via the 'event' emitter.
	}

	/**
	 * Handle unassign message (unified handler for task unassignment).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueUnassignedWebhook.
	 */
	private async handleUnassignMessage(message: UnassignMessage): Promise<void> {
		this.logger.debug(
			`[MessageBus] Unassign: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified unassign handling
		// For now, the legacy handler (handleIssueUnassignedWebhook)
		// continues to process the actual unassignment via the 'event' emitter.
	}

	/**
	 * Handle issue state change message (terminal state reached).
	 * Stops active sessions and deletes worktrees for the issue.
	 */
	private async handleIssueStateChangeMessage(
		message: IssueStateChangeMessage,
	): Promise<void> {
		this.logger.info(
			`[MessageBus] Issue reached terminal state: ${message.workItemIdentifier}`,
		);

		const issueId = message.workItemId;

		// Stop all active sessions for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		for (const session of sessions) {
			this.logger.info(
				`Stopping agent runner for ${message.workItemIdentifier} (issue terminal)`,
			);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Post a response activity to each stopped session's Linear thread,
		// then remove the session so subsequent prompts don't find stale state.
		for (const session of sessions) {
			await this.agentSessionManager.createResponseActivity(
				session.id,
				`Session stopped — ${message.workItemIdentifier} was marked as Done or Canceled.`,
			);
			this.agentSessionManager.removeSession(session.id);
		}

		// Build the set of repositories involved with this issue so per-repo
		// cyrus-teardown.sh scripts (if present) can run before worktrees are
		// removed. Source-of-truth is the session manager: each session's
		// repositoryId maps to a configured RepositoryConfig.
		const repoIds = new Set<string>();
		for (const session of sessions) {
			const repoId = this.sessionRepositories.get(session.id);
			if (repoId) repoIds.add(repoId);
		}
		const teardownRepositories: RepositoryConfig[] = [];
		for (const repoId of repoIds) {
			const repo = this.repositories.get(repoId);
			if (repo) teardownRepositories.push(repo);
		}

		// Delete worktrees for this issue, keyed by the Linear issue identifier.
		await this.gitService.deleteWorktree(message.workItemIdentifier, {
			repositories: teardownRepositories,
		});

		this.logger.info(
			`Completed cleanup for ${message.workItemIdentifier}: stopped ${sessions.length} session(s)`,
		);
	}

	// ============================================================================
	// LEGACY WEBHOOK HANDLERS
	// ============================================================================

	/**
	 * Handle issue unassignment webhook
	 */
	private async handleIssueUnassignedWebhook(
		webhook: IssueUnassignedWebhook,
	): Promise<void> {
		if (!webhook.notification.issue) {
			this.logger.warn("Received issue unassignment webhook without issue");
			return;
		}

		const issueId = webhook.notification.issue.id;
		await this.removeLinearQueueItemsForIssue(
			issueId,
			webhook.notification.issue.identifier,
		);

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			this.logger.info(
				`No cached repository for issue unassignment ${webhook.notification.issue.identifier}, searching sessions`,
			);

			const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
			if (sessions.length > 0) {
				const firstSession = sessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for unassignment of ${webhook.notification.issue.identifier} from session manager`,
						);
					}
				}

				if (!repository) {
					// Sessions exist but no repository mapping — still stop the sessions
					this.logger.warn(
						`Found ${sessions.length} session(s) for unassigned issue ${webhook.notification.issue.identifier} but no repository mapping, stopping sessions without farewell comment`,
					);
					for (const session of sessions) {
						this.agentSessionManager.requestSessionStop(session.id);
						session.agentRunner?.stop();
					}
					return;
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for unassigned issue ${webhook.notification.issue.identifier}`,
				);
				return;
			}
		}

		this.logger.info(
			`Handling issue unassignment: ${webhook.notification.issue.identifier}`,
		);

		await this.handleIssueUnassigned(
			webhook.notification.issue,
			webhook.organizationId,
		);
	}

	/**
	 * Handle issue content update webhook (title, description, or attachments).
	 *
	 * When the title, description, or attachments of an issue are updated, this handler feeds
	 * the changes into any active session for that issue, allowing the AI to
	 * compare old vs new values and decide whether to take action.
	 *
	 * The prompt uses XML-style formatting to clearly show what changed:
	 * - <issue_update> wrapper with timestamp and issue identifier
	 * - <title_change> with <old_title> and <new_title> if title changed
	 * - <description_change> with <old_description> and <new_description> if description changed
	 * - <attachments_change> with <old_attachments> and <new_attachments> if attachments changed
	 * - <guidance> section instructing the agent to evaluate whether changes affect its work
	 *
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload
	 */
	private async handleIssueContentUpdate(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		// Check if issue update trigger is enabled (defaults to true if not set)
		if (this.config.issueUpdateTrigger === false) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					"Issue update trigger is disabled, skipping issue content update",
				);
			}
			return;
		}

		const issueData = webhook.data;
		const issueId = issueData.id;
		const issueIdentifier = issueData.identifier;
		const updatedFrom = webhook.updatedFrom;
		const webhookKey = `${webhook.createdAt}:${issueId}`;

		if (!updatedFrom) {
			this.logger.warn(
				`Issue update webhook for ${issueIdentifier} has no updatedFrom data`,
			);
			return;
		}

		// Deduplicate: skip if we've already processed a webhook with the same key
		if (this.processedIssueUpdateKeys.has(webhookKey)) {
			this.logger.debug(
				`Duplicate issue update webhook for ${issueIdentifier} (key=${webhookKey}), skipping`,
			);
			return;
		}
		this.processedIssueUpdateKeys.add(webhookKey);

		// Prevent unbounded growth — prune old keys when the set gets large
		if (this.processedIssueUpdateKeys.size > 500) {
			const keys = [...this.processedIssueUpdateKeys];
			for (const key of keys.slice(0, 250)) {
				this.processedIssueUpdateKeys.delete(key);
			}
		}

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			const issueSessions =
				this.agentSessionManager.getSessionsByIssueId(issueId);
			if (issueSessions.length > 0) {
				const firstSession = issueSessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for issue update ${issueIdentifier} from session manager`,
						);
					}
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for issue update ${issueIdentifier}`,
				);
				return;
			}
		}

		// Determine what changed for logging
		const changedFields: string[] = [];
		if ("title" in updatedFrom) changedFields.push("title");
		if ("description" in updatedFrom) changedFields.push("description");
		if ("attachments" in updatedFrom) changedFields.push("attachments");

		this.logger.info(
			`Handling issue content update: ${issueIdentifier} (changed: ${changedFields.join(", ")})`,
		);

		// Find session(s) for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		if (sessions.length === 0) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					`No sessions found for issue ${issueIdentifier} to receive update`,
				);
			}
			return;
		}

		// Process attachments from the updated description if description changed
		let attachmentManifest = "";
		if ("description" in updatedFrom && issueData.description) {
			const firstSession = sessions[0];
			if (!firstSession) {
				this.logger.debug(`No sessions found for issue ${issueIdentifier}`);
				return;
			}
			const workspaceFolderName = basename(firstSession.workspace.path);
			const attachmentsDir = join(
				this.cyrusHome,
				workspaceFolderName,
				"attachments",
			);

			try {
				// Ensure directory exists
				await mkdir(attachmentsDir, { recursive: true });

				// Count existing attachments
				const existingFiles = await readdir(attachmentsDir).catch(() => []);
				const existingAttachmentCount = existingFiles.filter(
					(file) => file.startsWith("attachment_") || file.startsWith("image_"),
				).length;

				// Download attachments from the new description
				// Use organizationId from webhook as the Linear-native workspace ID source
				const linearToken = this.getLinearTokenForWorkspace(
					webhook.organizationId,
				);
				const downloadResult = await this.downloadCommentAttachments(
					issueData.description,
					attachmentsDir,
					linearToken,
					existingAttachmentCount,
				);

				if (downloadResult.totalNewAttachments > 0) {
					attachmentManifest =
						this.generateNewAttachmentManifest(downloadResult);
					this.logger.debug(
						`Downloaded ${downloadResult.totalNewAttachments} attachments from updated description`,
					);
				}
			} catch (error) {
				this.logger.error(
					"Failed to process attachments from updated description:",
					error,
				);
			}
		}

		// Build the XML-formatted prompt showing old vs new values
		const promptBody = this.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);

		// CYPACK-954: Issue update events are ONLY delivered to the first running
		// session (by most-recently-updated) that supports streaming input.
		// If no such session exists, the event is silently ignored.

		// Combine prompt body with attachment manifest
		let fullPrompt = promptBody;
		if (attachmentManifest) {
			fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
		}

		// Sort by updatedAt descending so the most recent session is first
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		let delivered = false;
		for (const session of sortedSessions) {
			const sessionId = session.id;
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort; a steer-only backend may reject when no turn is active.
				try {
					existingRunner.addStreamMessage(fullPrompt);
					delivered = true;
					this.logger.debug(
						`[issue-update] Streamed update to session ${sessionId} (key=${webhookKey}, changed=[${changedFields.join(", ")}])`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[issue-update] Stream rejected for session ${sessionId}; skipping (key=${webhookKey})`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			} else if (isRunning) {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is running but doesn't support streaming input, skipping (key=${webhookKey})`,
				);
			} else {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is idle, ignoring update (key=${webhookKey})`,
				);
			}
		}

		if (!delivered) {
			this.logger.debug(
				`[issue-update] No running streaming sessions for ${issueIdentifier}, update discarded (key=${webhookKey})`,
			);
		}
	}

	/**
	 * Build an XML-formatted prompt for issue content updates (title, description, attachments).
	 *
	 * The prompt clearly shows what fields changed by comparing old vs new values,
	 * and includes guidance for the agent to evaluate whether these changes affect
	 * its current implementation or action plan.
	 */
	/**
	 * Check if an issue has unresolved blocked-by dependencies.
	 * Fetches the issue from Linear and checks its inverse relations for blocking issues
	 * that haven't been completed or canceled.
	 */
	private async checkBlockedByDependencies(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		linearWorkspaceId: string,
	): Promise<{
		blocked: boolean;
		blockingIssueIds: string[];
		blockingIdentifiers: string[];
	}> {
		const issue = agentSession.issue;
		if (!issue) {
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}

		try {
			const fullIssue = await this.fetchFullIssueDetails(
				issue.id,
				linearWorkspaceId,
			);
			if (!fullIssue) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			const blockingIssues =
				await this.promptBuilder.fetchBlockingIssues(fullIssue);
			if (blockingIssues.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			// Filter to only unresolved blockers (not completed or canceled)
			const unresolvedBlockers: Array<{
				id: string;
				identifier: string;
			}> = [];
			for (const blocker of blockingIssues) {
				try {
					const state = await blocker.state;
					if (
						state &&
						state.type !== "completed" &&
						state.type !== "canceled"
					) {
						unresolvedBlockers.push({
							id: blocker.id,
							identifier: blocker.identifier,
						});
					}
				} catch {
					// If we can't resolve the state, assume it's unresolved
					unresolvedBlockers.push({
						id: blocker.id,
						identifier: blocker.identifier,
					});
				}
			}

			if (unresolvedBlockers.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			return {
				blocked: true,
				blockingIssueIds: unresolvedBlockers.map((b) => b.id),
				blockingIdentifiers: unresolvedBlockers.map((b) => b.identifier),
			};
		} catch (error) {
			this.logger.error(
				`Failed to check blocked-by dependencies for ${issue.identifier}:`,
				error,
			);
			// On error, don't block — proceed with normal flow
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}
	}

	/**
	 * Handle issue state change webhooks.
	 * When a blocking issue is completed, wake up any parked sessions that were waiting on it.
	 */
	private async handleIssueStateChange(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		const issueData = webhook.data;
		const completedIssueId = issueData.id;
		const issueIdentifier = issueData.identifier;

		// Only care about transitions TO completed or canceled states
		// The IssueWebhookPayload has a stateId field — resolve the state
		// via the issue tracker to check if it's a completion state
		const stateId = issueData.stateId;
		if (!stateId) {
			return;
		}

		// Find workspace for this webhook to resolve state type
		const linearWorkspaceId = webhook.organizationId;
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			return;
		}

		// Fetch the issue to check its current state type
		let stateType: string | undefined;
		try {
			const fullIssue = await issueTracker.fetchIssue(completedIssueId);
			const state = await fullIssue.state;
			stateType = state?.type;
		} catch {
			// Can't resolve state — skip
			return;
		}

		if (stateType !== "completed" && stateType !== "canceled") {
			return;
		}

		this.logger.debug(
			`Issue ${issueIdentifier} moved to ${stateType} — checking for parked sessions to wake`,
		);

		// Find parked sessions that were blocked by this issue
		const sessionsToWake: string[] = [];
		for (const [blockedIssueId, parked] of this.parkedSessions.entries()) {
			if (parked.blockingIssueIds.includes(completedIssueId)) {
				// Remove this blocker from the list
				parked.blockingIssueIds = parked.blockingIssueIds.filter(
					(id) => id !== completedIssueId,
				);

				// If no more blockers, wake the session
				if (parked.blockingIssueIds.length === 0) {
					sessionsToWake.push(blockedIssueId);
				} else {
					this.logger.debug(
						`Parked session for issue ${blockedIssueId} still has ${parked.blockingIssueIds.length} remaining blocker(s)`,
					);
				}
			}
		}

		// Wake up unblocked sessions
		for (const blockedIssueId of sessionsToWake) {
			const parked = this.parkedSessions.get(blockedIssueId);
			if (!parked) continue;

			this.parkedSessions.delete(blockedIssueId);

			this.logger.info(
				`Waking parked session for issue ${parked.agentSession.issue?.identifier} — all blockers resolved`,
			);

			// Post activity about waking up
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`All blocking dependencies are now resolved — starting work.`,
			);

			// Replay the normal initializeAgentRunner flow
			try {
				await this.initializeAgentRunner(
					parked.agentSession,
					parked.repositories,
					parked.linearWorkspaceId,
					parked.guidance,
					parked.commentBody,
					parked.baseBranchOverrides,
					parked.routingMethod,
				);
			} catch (error) {
				this.logger.error(
					`Failed to wake parked session for issue ${blockedIssueId}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle a user re-prompt on a parked (blocked-by) session.
	 * Re-checks blocking status: if clear, wakes the session; if still blocked, re-posts status.
	 */
	private async handleParkedSessionReprompt(
		_webhook: AgentSessionPromptedWebhook,
		issueId: string,
	): Promise<void> {
		const parked = this.parkedSessions.get(issueId);
		if (!parked) return;

		const blockResult = await this.checkBlockedByDependencies(
			parked.agentSession,
			parked.linearWorkspaceId,
		);

		if (blockResult.blocked) {
			// Still blocked — update the parked entry and re-post status
			parked.blockingIssueIds = blockResult.blockingIssueIds;
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`Still blocked by ${blockerList}. Will start automatically when resolved.`,
			);
			this.logger.info(
				`Re-prompt on parked session for ${parked.agentSession.issue?.identifier}: still blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Blockers resolved — wake the session
		this.parkedSessions.delete(issueId);
		this.logger.info(
			`Re-prompt cleared blockers for ${parked.agentSession.issue?.identifier} — waking session`,
		);

		await this.activityPoster.postThoughtActivity(
			parked.agentSession.id,
			parked.linearWorkspaceId,
			`Blocking dependencies are now resolved — starting work.`,
		);

		try {
			await this.initializeAgentRunner(
				parked.agentSession,
				parked.repositories,
				parked.linearWorkspaceId,
				parked.guidance,
				parked.commentBody,
				parked.baseBranchOverrides,
				parked.routingMethod,
			);
		} catch (error) {
			this.logger.error(
				`Failed to wake parked session for issue ${issueId} on re-prompt:`,
				error,
			);
		}
	}

	private buildIssueUpdatePrompt(
		issueIdentifier: string,
		issueData: {
			title: string;
			description?: string | null;
			attachments?: unknown;
		},
		updatedFrom: {
			title?: string;
			description?: string;
			attachments?: unknown;
		},
	): string {
		return this.promptBuilder.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);
	}

	/**
	 * Get issue tracker for a workspace (direct lookup by workspace ID)
	 */
	private getIssueTrackerForWorkspace(
		linearWorkspaceId: string,
	): IIssueTrackerService | undefined {
		return this.issueTrackers.get(linearWorkspaceId);
	}

	/**
	 * Get the activity sink for a repository by looking up its workspace.
	 */
	private getActivitySinkForRepo(repoId: string): IActivitySink | undefined {
		const repo = this.repositories.get(repoId);
		if (!repo?.linearWorkspaceId) return undefined;
		return this.activitySinks.get(repo.linearWorkspaceId);
	}

	/**
	 * Get the Linear API token for a workspace from workspace-level config.
	 */
	private getLinearTokenForWorkspace(linearWorkspaceId: string): string | null {
		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig) {
			return null; // CLI platform or unconfigured workspace
		}
		return workspaceConfig.linearToken;
	}

	/**
	 * Create a new Cyrus agent session with all necessary setup
	 * @param sessionId The Linear agent activity session ID
	 * @param issue Linear issue object
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param agentSessionManager Agent session manager instance
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @returns Object containing session details and setup information
	 */
	private async createCyrusAgentSession(
		sessionId: string,
		issue: { id: string; identifier: string },
		repositoriesOrSingle: RepositoryConfig | RepositoryConfig[],
		agentSessionManager: AgentSessionManager,
		linearWorkspaceId: string,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<AgentSessionData> {
		const repositories = Array.isArray(repositoriesOrSingle)
			? repositoriesOrSingle
			: [repositoriesOrSingle];
		const primaryRepo = repositories[0]!;

		// Fetch full Linear issue details using workspace ID from webhook context
		const fullIssue = await this.fetchFullIssueDetails(
			issue.id,
			linearWorkspaceId,
		);
		if (!fullIssue) {
			throw new Error(`Failed to fetch full issue details for ${issue.id}`);
		}

		// Move issue to started state automatically, in case it's not already
		await this.moveIssueToStartedState(fullIssue, linearWorkspaceId);

		// Create workspace using full issue data
		// IMPORTANT: The CLI app (apps/cli/src/services/WorkerService.ts) typically provides
		// a custom createWorkspace handler, so the handler path is the one taken in production.
		// When adding new options here, always update the handler signature in config-types.ts
		// AND the CLI's handler implementation in WorkerService.ts to pass them through.
		this.logger.info(
			`createCyrusAgentSession: passing baseBranchOverrides=${baseBranchOverrides ? `Map(size=${baseBranchOverrides.size}, keys=[${Array.from(baseBranchOverrides.keys()).join(",")}])` : "undefined"}, useCustomHandler=${!!this.config.handlers?.createWorkspace}`,
		);
		const workspace = this.config.handlers?.createWorkspace
			? await this.config.handlers.createWorkspace(fullIssue, repositories, {
					baseBranchOverrides,
					onRepoSetupHookEvent: (activity) =>
						this.activityPoster.postRepoSetupHookActivity(
							sessionId,
							linearWorkspaceId,
							activity,
						),
					normalizeCyrusBranchPrefix: true,
				})
			: await this.gitService.createGitWorktree(fullIssue, repositories, {
					baseBranchOverrides,
					onRepoSetupHookEvent: (activity) =>
						this.activityPoster.postRepoSetupHookActivity(
							sessionId,
							linearWorkspaceId,
							activity,
						),
					normalizeCyrusBranchPrefix: true,
				});

		this.logger.debug(`Workspace created at: ${workspace.path}`);

		const issueMinimal = this.convertLinearIssueToCore(fullIssue);

		// Create RepositoryContext entries for ALL repositories
		// Use resolved base branches from workspace creation (already accounts for
		// commit-ish overrides, graphite blocked-by, parent issues, and defaults)
		const repositoryContexts = repositories.map((repo) => ({
			repositoryId: repo.id,
			branchName: issueMinimal.branchName,
			baseBranchName:
				workspace.resolvedBaseBranches?.[repo.id]?.branch ?? repo.baseBranch,
			githubUrl: repo.githubUrl,
			githubReviewTeams: repo.githubReviewTeams,
		}));

		agentSessionManager.createCyrusAgentSession(
			sessionId,
			issue.id,
			issueMinimal,
			workspace,
			"linear",
			repositoryContexts,
		);

		// Register session-to-repo mapping and activity sink (use primary repo)
		this.sessionRepositories.set(sessionId, primaryRepo.id);
		const activitySink = this.getActivitySinkForRepo(primaryRepo.id);
		if (activitySink) {
			agentSessionManager.setActivitySink(sessionId, activitySink);
		}

		// Post combined routing + base branch activity
		{
			const repoLines = repositories.map((repo) => {
				const resolution = workspace.resolvedBaseBranches?.[repo.id];
				const branch = resolution?.branch ?? repo.baseBranch;
				const sourceLabel = !resolution
					? "default"
					: resolution.source === "commit-ish"
						? "override"
						: resolution.source === "graphite-blocked-by"
							? (resolution.detail ?? "graphite")
							: resolution.source === "parent-issue"
								? (resolution.detail ?? "parent")
								: "default";
				return `- **${repo.name}** → \`${branch}\` (${sourceLabel})`;
			});
			await this.postRoutingActivity(
				sessionId,
				linearWorkspaceId,
				repoLines,
				routingMethod,
			);
		}

		// Get the newly created session
		const session = agentSessionManager.getSession(sessionId);
		if (!session) {
			throw new Error(
				`Failed to create session for agent activity session ${sessionId}`,
			);
		}

		// Download attachments before creating Claude runner
		const attachmentResult = await this.downloadIssueAttachments(
			fullIssue,
			linearWorkspaceId,
			workspace.path,
		);

		// Pre-create attachments directory even if no attachments exist yet
		const workspaceFolderName = basename(workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		await mkdir(attachmentsDir, { recursive: true });

		// Write Claude settings to disable co-authored-by attribution in the workspace.
		// This uses the SDK's "local" settings source (loaded via settingSources: ["user", "project", "local"])
		// to ensure Cyrus sessions don't add "Co-Authored-By: Claude" trailers to git commits.
		const claudeSettingsDir = join(workspace.path, ".claude");
		await mkdir(claudeSettingsDir, { recursive: true });
		await writeFile(
			join(claudeSettingsDir, "settings.local.json"),
			JSON.stringify(
				{
					includeCoAuthoredBy: false,
				},
				null,
				"\t",
			),
		);

		// Build allowed directories list - always include attachments directory
		// Include repository paths from all repositories
		const allRepoPaths = repositories.map((repo) => repo.repositoryPath);
		const allowedDirectories: string[] = [
			...new Set([
				attachmentsDir,
				...allRepoPaths,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(workspace),
			]),
		];

		this.logger.debug(
			`Configured allowed directories for ${fullIssue.identifier}:`,
			allowedDirectories,
		);

		// Build allowed tools list with Linear MCP tools
		const allowedTools = this.buildAllowedTools(repositories);
		const disallowedTools = this.buildDisallowedTools(repositories);

		return {
			session,
			fullIssue,
			workspace,
			attachmentResult,
			attachmentsDir,
			allowedDirectories,
			allowedTools,
			disallowedTools,
		};
	}

	private async enqueueLinearAgentSession(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		const sessionId = webhook.agentSession?.id;
		const issueIdentifier =
			webhook.agentSession?.issue?.identifier || "unknown issue";

		if (!sessionId) {
			await this.handleAgentSessionCreatedWebhook(webhook, repos);
			return;
		}

		if (
			this.linearSessionActiveItems.has(sessionId) ||
			this.linearSessionQueue.some((item) => item.sessionId === sessionId)
		) {
			this.logger.info(
				`Skipping duplicate Linear agent session queue item for ${issueIdentifier}`,
			);
			return;
		}

		const now = Date.now();
		const item: AgentSessionQueueItem = {
			origin: "linear",
			webhook,
			repoIds: repos.map((repo) => repo.id),
			workItemIdentifier: issueIdentifier,
			sessionId,
			queuedAt: now,
			availableAt: now,
			retryCount: 0,
		};

		this.linearSessionQueue.push(item);
		await this.saveLinearSessionQueue();

		if (
			this.linearSessionActiveItems.size >=
				this.linearSessionQueueConcurrency ||
			this.linearSessionCooldownUntil > now ||
			this.linearSessionQueue.length > 1
		) {
			await this.postAgentQueueAcknowledgment(item, "queued");
		}

		this.drainLinearSessionQueue();
	}

	private async enqueueGitHubAgentSession(
		event: GitHubCommentWebhookEvent,
	): Promise<void> {
		if (!this.isQueueableGitHubEvent(event)) {
			return;
		}

		const sessionId = `github-${event.deliveryId}`;
		const workItemIdentifier = this.getGitHubWorkItemIdentifier(event);
		if (
			this.linearSessionActiveItems.has(sessionId) ||
			this.linearSessionQueue.some((item) => item.sessionId === sessionId)
		) {
			this.logger.info(
				`Skipping duplicate GitHub agent queue item for ${workItemIdentifier}`,
			);
			return;
		}

		const repository = this.findRepositoryByGitHubUrl(
			extractRepoFullName(event),
		);
		const now = Date.now();
		const item: AgentSessionQueueItem = {
			origin: "github",
			githubEvent: event,
			githubRepositoryId: repository?.id,
			workItemIdentifier,
			sessionId,
			queuedAt: now,
			availableAt: now,
			retryCount: 0,
		};

		this.linearSessionQueue.push(item);
		await this.saveLinearSessionQueue();

		if (
			this.linearSessionActiveItems.size >=
				this.linearSessionQueueConcurrency ||
			this.linearSessionCooldownUntil > now ||
			this.linearSessionQueue.length > 1
		) {
			await this.postAgentQueueAcknowledgment(item, "queued");
		}

		this.drainLinearSessionQueue();
	}

	private isQueueableGitHubEvent(event: GitHubCommentWebhookEvent): boolean {
		if (!isCommentOnPullRequest(event)) {
			this.logger.debug("Ignoring GitHub comment on non-PR issue");
			return false;
		}

		if (
			isIssueCommentPayload(event.payload) &&
			event.payload.issue.state?.toLowerCase() === "closed"
		) {
			this.logger.info(
				`Ignoring GitHub comment on ${this.getGitHubWorkItemIdentifier(event)} because the pull request is already closed`,
			);
			return false;
		}

		if (
			(isPullRequestReviewPayload(event.payload) ||
				isPullRequestReviewCommentPayload(event.payload)) &&
			this.isGitHubPullRequestTerminal(event.payload.pull_request)
		) {
			this.logger.info(
				`Ignoring GitHub webhook on ${this.getGitHubWorkItemIdentifier(event)} because the pull request is already merged or closed`,
			);
			return false;
		}

		const commentAuthor = extractCommentAuthor(event);
		const botUsername = process.env.GITHUB_BOT_USERNAME;
		if (botUsername && commentAuthor === botUsername) {
			this.logger.debug(
				`Ignoring comment from bot user @${botUsername} on ${this.getGitHubWorkItemIdentifier(event)}`,
			);
			return false;
		}

		if (isPullRequestReviewPayload(event.payload)) {
			return this.shouldProcessGitHubChangeRequest(event);
		}

		if (botUsername && !extractCommentBody(event).includes(`@${botUsername}`)) {
			this.logger.debug(
				`Ignoring comment without @${botUsername} mention on ${this.getGitHubWorkItemIdentifier(event)}`,
			);
			return false;
		}

		return true;
	}

	private getGitHubWorkItemIdentifier(
		event: GitHubCommentWebhookEvent,
	): string {
		const prNumber = extractPRNumber(event);
		return `${extractRepoFullName(event)}#${prNumber ?? "unknown"}`;
	}

	private drainLinearSessionQueue(): void {
		if (this.linearSessionQueueDrainTimer) {
			clearTimeout(this.linearSessionQueueDrainTimer);
			this.linearSessionQueueDrainTimer = null;
		}

		const now = Date.now();
		if (this.linearSessionCooldownUntil > now) {
			this.scheduleLinearSessionQueueDrain(
				this.linearSessionCooldownUntil - now,
			);
			return;
		}

		while (
			this.linearSessionActiveItems.size < this.linearSessionQueueConcurrency
		) {
			const nextIndex = this.linearSessionQueue.findIndex(
				(item) => item.availableAt <= now,
			);

			if (nextIndex === -1) {
				const nextAvailableAt = this.linearSessionQueue.reduce(
					(min, item) => Math.min(min, item.availableAt),
					Number.POSITIVE_INFINITY,
				);
				if (Number.isFinite(nextAvailableAt)) {
					this.scheduleLinearSessionQueueDrain(nextAvailableAt - now);
				}
				return;
			}

			const item = this.linearSessionQueue.splice(nextIndex, 1)[0]!;
			item.startedAt = Date.now();
			this.linearSessionActiveItems.set(item.sessionId, item);
			void this.saveLinearSessionQueue();
			void this.processLinearSessionQueueItem(item);
		}
	}

	private scheduleLinearSessionQueueDrain(delayMs: number): void {
		const boundedDelayMs = Math.max(1_000, delayMs);
		this.linearSessionQueueDrainTimer = setTimeout(() => {
			this.linearSessionQueueDrainTimer = null;
			this.drainLinearSessionQueue();
		}, boundedDelayMs);
	}

	private async processLinearSessionQueueItem(
		item: AgentSessionQueueItem,
	): Promise<void> {
		try {
			const canStart = await this.postAgentQueueAcknowledgment(
				item,
				"starting",
			);
			if (!canStart) {
				await this.requeueOrFailLinearSessionItem(
					item,
					new Error("Rate limit while posting queue start"),
					true,
				);
				return;
			}
			await this.ensureDiskSpaceForAgentTask(item);
			await this.runAgentSessionQueueItemWithWatchdog(item);
		} catch (error) {
			const isRateLimited = this.applyLinearRateLimitCooldown(error);
			await this.requeueOrFailLinearSessionItem(item, error, isRateLimited);
		} finally {
			this.linearSessionActiveItems.delete(item.sessionId);
			await this.saveLinearSessionQueue();
			this.drainLinearSessionQueue();
		}
	}

	private async runAgentSessionQueueItemWithWatchdog(
		item: AgentSessionQueueItem,
	): Promise<void> {
		let timeout: NodeJS.Timeout | undefined;
		const abortController = new AbortController();
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				abortController.abort();
				const error = new Error(
					`${item.origin} agent session ${item.workItemIdentifier} timed out after ${Math.round(
						this.linearSessionTimeoutMs / 60_000,
					)} minutes`,
				) as Error & { code?: string };
				error.code = "CYRUS_LINEAR_SESSION_TIMEOUT";
				reject(error);
			}, this.linearSessionTimeoutMs);
		});

		try {
			const workPromise =
				item.origin === "github"
					? this.runQueuedGitHubSession(item)
					: this.runQueuedLinearSession(item, abortController.signal);
			void workPromise.catch(() => {
				// Promise.race observes the first failure. If the watchdog wins, this
				// prevents a later runner failure from surfacing as an unhandled rejection.
			});
			await Promise.race([workPromise, timeoutPromise]);
		} catch (error) {
			this.stopLinearSessionQueueItem(item);
			throw error;
		} finally {
			abortController.abort();
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	private async ensureDiskSpaceForAgentTask(
		item: AgentSessionQueueItem,
	): Promise<void> {
		if (!this.diskGuardEnabled) {
			return;
		}

		const before = await this.getDiskAvailability(this.cyrusHome);
		if (this.hasRequiredDiskSpace(before)) {
			return;
		}

		this.logger.warn(
			`Low disk space before ${item.workItemIdentifier}: ${this.formatBytes(
				before.availableBytes,
			)} free (${before.availablePercent.toFixed(1)}%)`,
		);

		await this.runGarbageCollection("low-disk", { ignoreBusy: true });

		const after = await this.getDiskAvailability(this.cyrusHome);
		if (this.hasRequiredDiskSpace(after)) {
			this.logger.info(
				`Disk guard recovered space for ${item.workItemIdentifier}: ${this.formatBytes(
					after.availableBytes,
				)} free (${after.availablePercent.toFixed(1)}%)`,
			);
			return;
		}

		throw new Error(
			`Insufficient disk space for ${item.workItemIdentifier}: ${this.formatBytes(
				after.availableBytes,
			)} free (${after.availablePercent.toFixed(1)}%). Required at least ${this.formatBytes(
				this.diskGuardMinFreeBytes,
			)} and ${this.diskGuardMinFreePercent}% free.`,
		);
	}

	private async getDiskAvailability(path: string): Promise<{
		availableBytes: number;
		totalBytes: number;
		availablePercent: number;
	}> {
		const info = await statfs(path);
		const availableBytes = Number(info.bavail) * Number(info.bsize);
		const totalBytes = Number(info.blocks) * Number(info.bsize);
		const availablePercent =
			totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0;
		return { availableBytes, totalBytes, availablePercent };
	}

	private hasRequiredDiskSpace(space: {
		availableBytes: number;
		availablePercent: number;
	}): boolean {
		return (
			space.availableBytes >= this.diskGuardMinFreeBytes &&
			space.availablePercent >= this.diskGuardMinFreePercent
		);
	}

	private formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) {
			return "0 B";
		}

		const units = ["B", "KiB", "MiB", "GiB", "TiB"];
		let value = bytes;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}
		return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
	}

	private async runQueuedLinearSession(
		item: AgentSessionQueueItem,
		abortSignal: AbortSignal,
	): Promise<void> {
		if (!item.webhook) {
			throw new Error(`Missing Linear webhook payload for ${item.sessionId}`);
		}

		await this.handleAgentSessionCreatedWebhook(
			item.webhook,
			this.resolveLinearSessionQueueRepos(item),
		);
		await this.waitForQueuedLinearSessionCompletion(item, abortSignal);
	}

	private async waitForQueuedLinearSessionCompletion(
		item: AgentSessionQueueItem,
		abortSignal: AbortSignal,
	): Promise<void> {
		const session = this.agentSessionManager.getSession(item.sessionId);
		if (!session || session.status !== "active") {
			return;
		}

		await new Promise<void>((resolve) => {
			let interval: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (interval) {
					clearInterval(interval);
					interval = undefined;
				}
				abortSignal.removeEventListener("abort", check);
			};
			const check = () => {
				const currentSession = this.agentSessionManager.getSession(
					item.sessionId,
				);
				if (
					abortSignal.aborted ||
					!currentSession ||
					currentSession.status !== "active"
				) {
					cleanup();
					resolve();
				}
			};

			interval = setInterval(check, 1_000);
			abortSignal.addEventListener("abort", check, { once: true });
			check();
		});
	}

	private async runQueuedGitHubSession(
		item: AgentSessionQueueItem,
	): Promise<void> {
		if (item.task === "github-conflict-rebase") {
			await this.runQueuedGitHubConflictRebaseSession(item);
			return;
		}

		if (!item.githubEvent) {
			throw new Error(`Missing GitHub webhook payload for ${item.sessionId}`);
		}

		await this.handleGitHubWebhook(item.githubEvent);
	}

	private async runQueuedGitHubConflictRebaseSession(
		item: AgentSessionQueueItem,
	): Promise<void> {
		const event = item.githubPullRequestEvent;
		if (!event) {
			throw new Error(
				`Missing GitHub pull_request payload for ${item.sessionId}`,
			);
		}

		const repository =
			(item.githubRepositoryId
				? this.repositories.get(item.githubRepositoryId)
				: undefined) ??
			this.findRepositoryByGitHubUrl(extractRepoFullName(event));
		if (!repository) {
			throw new Error(
				`No repository configured for GitHub repo ${extractRepoFullName(event)}`,
			);
		}

		const pullRequest =
			(await this.fetchGitHubPullRequestDetails(event)) ??
			event.payload.pull_request;
		if (!this.isGitHubPullRequestMergeConflict(pullRequest)) {
			await this.postGitHubPullRequestIssueComment(
				event,
				`Cyrus checked this PR again before starting. GitHub no longer reports merge conflicts for \`${pullRequest.head.ref}\` against \`${pullRequest.base.ref}\`, so no rebase was needed.`,
			);
			return;
		}

		const branchRef = pullRequest.head.ref;
		const baseBranchRef = pullRequest.base.ref;
		const prNumber = pullRequest.number;
		const repoFullName = extractRepoFullName(event);

		const workspace = await this.createGitHubWorkspace(
			repository,
			branchRef,
			prNumber,
		);
		if (!workspace) {
			throw new Error(
				`Failed to create workspace for ${repoFullName}#${prNumber}`,
			);
		}

		const issueMinimal: IssueMinimal = {
			id: `github-conflict-rebase-${repoFullName}#${prNumber}`,
			identifier: `${extractRepoName(event)}#${prNumber}`,
			title: pullRequest.title || `PR #${prNumber}`,
			branchName: branchRef,
		};

		this.agentSessionManager.createCyrusAgentSession(
			item.sessionId,
			`github:${repoFullName}#${prNumber}`,
			issueMinimal,
			workspace,
			"github",
			[
				{
					repositoryId: repository.id,
					branchName: branchRef,
					baseBranchName: baseBranchRef,
					githubUrl: repository.githubUrl,
					githubReviewTeams: repository.githubReviewTeams,
				},
			],
		);

		this.sessionRepositories.set(item.sessionId, repository.id);
		const activitySink = this.getActivitySinkForRepo(repository.id);
		if (activitySink) {
			this.agentSessionManager.setActivitySink(item.sessionId, activitySink);
		}

		const session = this.agentSessionManager.getSession(item.sessionId);
		if (!session) {
			throw new Error(`Failed to create session ${item.sessionId}`);
		}

		const linearSessionLink = this.resolveLinearSessionLinkForGitHubPullRequest(
			pullRequest,
			repository,
		);
		if (linearSessionLink) {
			session.externalSessionId = linearSessionLink.sessionId;
			await this.activityPoster.postThoughtActivity(
				linearSessionLink.sessionId,
				linearSessionLink.workspaceId,
				`GitHub conflict rebase started for ${repoFullName}#${prNumber}.`,
			);
		}

		const systemPrompt = this.buildGitHubConflictRebaseSystemPrompt(
			event,
			pullRequest,
		);
		const taskInstructions = `Rebase PR #${prNumber} branch \`${branchRef}\` onto \`origin/${baseBranchRef}\`, resolve merge conflicts only, and push the rebased branch with --force-with-lease.`;
		const allowedTools =
			this.toolPermissionResolver.buildGithubAllowedTools(repository);
		const disallowedTools = this.buildDisallowedTools(repository);
		const allowedDirectories: string[] = [repository.repositoryPath];

		const { config: runnerConfig, runnerType } =
			await this.buildAgentRunnerConfig(
				session,
				repository,
				item.sessionId,
				systemPrompt,
				allowedTools,
				allowedDirectories,
				disallowedTools,
				undefined,
				undefined,
				undefined,
				80,
				undefined,
				this.buildSkillSessionContext(repository, undefined, session),
				"github",
			);

		const runner = this.createRunnerForType(runnerType, runnerConfig);
		this.agentSessionManager.addAgentRunner(item.sessionId, runner);
		await this.savePersistedState();

		this.logger.info(
			`Starting ${runnerType} runner for GitHub conflict rebase ${repoFullName}#${prNumber}`,
		);

		try {
			await runner.start(taskInstructions);
			const summary = this.extractRunnerSummary(
				runner,
				"Conflict rebase completed. Please review the updated branch.",
			);
			await this.postGitHubPullRequestIssueComment(event, summary);
			if (linearSessionLink) {
				await this.activityPoster.postThoughtActivity(
					linearSessionLink.sessionId,
					linearSessionLink.workspaceId,
					`GitHub conflict rebase completed for ${repoFullName}#${prNumber}.`,
				);
			}
		} finally {
			await this.savePersistedState();
		}
	}

	private resolveLinearSessionQueueRepos(
		item: AgentSessionQueueItem,
	): RepositoryConfig[] {
		const repos = (item.repoIds ?? [])
			.map((repoId) => this.repositories.get(repoId))
			.filter((repo): repo is RepositoryConfig => Boolean(repo));

		if (repos.length > 0) {
			return repos;
		}

		const fallbackRepos = Array.from(this.repositories.values()).filter(
			(repo) => repo.isActive !== false,
		);
		if (fallbackRepos.length === 0) {
			throw new Error(
				`No active repositories available for ${item.workItemIdentifier}`,
			);
		}

		return fallbackRepos;
	}

	private stopLinearSessionQueueItem(item: AgentSessionQueueItem): void {
		const session = this.agentSessionManager.getSession(item.sessionId);
		if (!session) {
			return;
		}

		this.agentSessionManager.requestSessionStop(item.sessionId);
		session.agentRunner?.stop();
	}

	private async requeueOrFailLinearSessionItem(
		item: AgentSessionQueueItem,
		error: unknown,
		isRateLimited: boolean,
	): Promise<void> {
		const nextRetryCount = item.retryCount + 1;
		const errorMessage = this.formatLinearQueueError(error);

		if (nextRetryCount > this.linearSessionMaxRetries) {
			this.logger.error(
				`${item.origin} agent session ${item.workItemIdentifier} failed after ${item.retryCount} retries: ${errorMessage}`,
			);
			void this.sendOperationalAlert({
				key: `agent-session-failed:${item.sessionId}`,
				severity: "error",
				title: "Agent task failed",
				message: `${item.workItemIdentifier} (${item.origin}) failed after ${
					this.linearSessionMaxRetries + 1
				} attempt(s): ${errorMessage}`,
			});
			if (!isRateLimited) {
				await this.postAgentQueueFailure(item, errorMessage);
			}
			return;
		}

		const delayMs = isRateLimited
			? Math.max(
					this.linearSessionCooldownUntil - Date.now(),
					this.linearSessionRetryDelayMs,
				)
			: this.linearSessionRetryDelayMs * nextRetryCount;

		this.linearSessionQueue.push({
			...item,
			retryCount: nextRetryCount,
			availableAt: Date.now() + delayMs,
			lastError: errorMessage,
			startedAt: undefined,
		});

		this.logger.warn(
			`Re-queued ${item.workItemIdentifier} after failure (retry ${nextRetryCount}/${this.linearSessionMaxRetries})`,
		);
	}

	private async postAgentQueueAcknowledgment(
		item: AgentSessionQueueItem,
		state: "queued" | "starting",
	): Promise<boolean> {
		if (item.origin === "github") {
			await this.postGitHubQueueAcknowledgment(item, state);
			return true;
		}

		return this.postLinearQueueAcknowledgment(item, state);
	}

	private async postLinearQueueAcknowledgment(
		item: AgentSessionQueueItem,
		state: "queued" | "starting",
	): Promise<boolean> {
		if (!item.webhook) {
			return true;
		}

		try {
			const waitingCount = this.linearSessionQueue.length;
			const body =
				state === "starting"
					? `Starting ${item.workItemIdentifier}.`
					: `Queued ${item.workItemIdentifier}. Cyrus is already running ${this.linearSessionActiveItems.size} task(s); ${waitingCount} task(s) are waiting.`;

			await this.activityPoster.postThoughtActivity(
				item.sessionId,
				item.webhook.organizationId,
				body,
			);
			return true;
		} catch (error) {
			const isRateLimited = this.applyLinearRateLimitCooldown(error);
			this.logger.warn(
				`Failed to post Linear queue acknowledgment for ${item.workItemIdentifier}: ${this.formatLinearQueueError(error)}`,
			);
			return !isRateLimited;
		}
	}

	private async postGitHubQueueAcknowledgment(
		item: AgentSessionQueueItem,
		state: "queued" | "starting",
	): Promise<void> {
		if (!item.githubEvent && !item.githubPullRequestEvent) {
			return;
		}

		const waitingCount = this.linearSessionQueue.length;
		const taskLabel =
			item.task === "github-conflict-rebase"
				? "GitHub conflict rebase"
				: "GitHub follow-up";
		const body =
			state === "starting"
				? `Starting ${taskLabel} for ${item.workItemIdentifier}.`
				: `Queued ${taskLabel} for ${item.workItemIdentifier}. Cyrus is already running ${this.linearSessionActiveItems.size} task(s); ${waitingCount} task(s) are waiting.`;

		const repository = item.githubRepositoryId
			? this.repositories.get(item.githubRepositoryId)
			: null;
		if (item.githubEvent) {
			await this.postGitHubLinkedLinearThought(
				item.githubEvent,
				repository,
				body,
			);
		} else if (item.githubPullRequestEvent && repository) {
			await this.postGitHubLinkedLinearThoughtForPullRequestEvent(
				item.githubPullRequestEvent,
				repository,
				body,
			);
		}

		if (state === "queued" && item.githubEvent) {
			await this.postGitHubIssueComment(item.githubEvent, body);
		}
	}

	private async postAgentQueueFailure(
		item: AgentSessionQueueItem,
		errorMessage: string,
	): Promise<void> {
		if (item.origin === "github") {
			await this.postGitHubQueueFailure(item, errorMessage);
			return;
		}

		await this.postLinearQueueFailure(item, errorMessage);
	}

	private async postLinearQueueFailure(
		item: AgentSessionQueueItem,
		errorMessage: string,
	): Promise<void> {
		if (!item.webhook) {
			return;
		}

		try {
			await this.activityPoster.postThoughtActivity(
				item.sessionId,
				item.webhook.organizationId,
				`Cyrus could not start ${item.workItemIdentifier} after ${this.linearSessionMaxRetries + 1} attempt(s). Last error: ${errorMessage}`,
			);
		} catch (error) {
			this.applyLinearRateLimitCooldown(error);
			this.logger.warn(
				`Failed to post Linear queue failure for ${item.workItemIdentifier}: ${this.formatLinearQueueError(error)}`,
			);
		}
	}

	private async postGitHubQueueFailure(
		item: AgentSessionQueueItem,
		errorMessage: string,
	): Promise<void> {
		if (!item.githubEvent && !item.githubPullRequestEvent) {
			return;
		}

		const body = `Cyrus could not complete ${item.workItemIdentifier} after ${
			this.linearSessionMaxRetries + 1
		} attempt(s). Last error: ${errorMessage}`;
		const repository = item.githubRepositoryId
			? this.repositories.get(item.githubRepositoryId)
			: null;
		if (item.githubEvent) {
			await this.postGitHubLinkedLinearThought(
				item.githubEvent,
				repository,
				body,
			);
			await this.postGitHubIssueComment(item.githubEvent, body);
		} else if (item.githubPullRequestEvent) {
			if (repository) {
				await this.postGitHubLinkedLinearThoughtForPullRequestEvent(
					item.githubPullRequestEvent,
					repository,
					body,
				);
			}
			await this.postGitHubPullRequestIssueComment(
				item.githubPullRequestEvent,
				body,
			);
		}
	}

	private applyLinearRateLimitCooldown(error: unknown): boolean {
		if (!this.isLinearRateLimitError(error)) {
			return false;
		}

		const cooldownUntil = this.getLinearRateLimitResetMs(error);
		this.linearSessionCooldownUntil = Math.max(
			this.linearSessionCooldownUntil,
			cooldownUntil,
		);
		this.logger.warn(
			`Linear rate limit detected; pausing Linear queue until ${new Date(
				this.linearSessionCooldownUntil,
			).toISOString()}`,
		);
		void this.sendOperationalAlert({
			key: "linear-rate-limit-cooldown",
			severity: "warning",
			title: "Linear queue is rate limited",
			message: `Queue paused until ${new Date(
				this.linearSessionCooldownUntil,
			).toISOString()}.`,
		});
		return true;
	}

	private isLinearRateLimitError(error: unknown): boolean {
		const candidate = error as {
			status?: number;
			statusCode?: number;
			code?: string | number;
			type?: string;
			response?: { status?: number };
			message?: string;
		};
		const status =
			candidate.status ??
			candidate.statusCode ??
			candidate.response?.status ??
			candidate.code;

		if (status === 429 || status === "429") {
			return true;
		}

		const text = `${candidate.type ?? ""} ${candidate.message ?? ""} ${
			candidate.code ?? ""
		}`;
		return /rate.?limit|too many requests|429/i.test(text);
	}

	private getLinearRateLimitResetMs(error: unknown): number {
		const candidate = error as {
			headers?: RateLimitHeaders;
			response?: {
				headers?: RateLimitHeaders;
			};
		};
		const headers = candidate.response?.headers ?? candidate.headers;
		const retryAfter = this.getHeaderValue(headers, "retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				return Date.now() + retryAfterSeconds * 1_000 + 5_000;
			}
		}

		const resetHeader =
			this.getHeaderValue(headers, "x-ratelimit-reset") ??
			this.getHeaderValue(headers, "x-rate-limit-reset");
		if (resetHeader) {
			const numericReset = Number(resetHeader);
			if (Number.isFinite(numericReset)) {
				return numericReset < 10_000_000_000
					? numericReset * 1_000 + 5_000
					: numericReset + 5_000;
			}

			const dateReset = Date.parse(resetHeader);
			if (Number.isFinite(dateReset)) {
				return dateReset + 5_000;
			}
		}

		return Date.now() + this.linearRateLimitFallbackMs;
	}

	private getHeaderValue(
		headers: RateLimitHeaders | undefined,
		name: string,
	): string | undefined {
		if (!headers) {
			return undefined;
		}

		if ("get" in headers && typeof headers.get === "function") {
			return headers.get(name) ?? undefined;
		}

		const lowerName = name.toLowerCase();
		const record = headers as Record<string, string | number | undefined>;
		const value =
			record[name] ??
			record[lowerName] ??
			record[lowerName.replaceAll("-", "_")];
		return value === undefined ? undefined : String(value);
	}

	private formatLinearQueueError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	private async loadLinearSessionQueue(): Promise<void> {
		if (!existsSync(this.linearSessionQueueFile)) {
			return;
		}

		try {
			const rawQueue = await readFile(this.linearSessionQueueFile, "utf8");
			const parsed = JSON.parse(rawQueue) as
				| SerializedAgentSessionQueueItem[]
				| { items?: SerializedAgentSessionQueueItem[] };
			const items = Array.isArray(parsed) ? parsed : parsed.items || [];
			const now = Date.now();
			let recoveredRunningCount = 0;

			this.linearSessionQueue = items
				.filter(
					(item) =>
						item?.sessionId &&
						(item?.webhook ||
							item?.githubEvent ||
							item?.githubPullRequestEvent) &&
						(item.origin === "github" ||
							item.origin === "linear" ||
							!item.origin),
				)
				.map((item) => {
					const wasRunning = item.state === "running";
					const retryCount = Number.isFinite(item.retryCount)
						? item.retryCount
						: 0;
					const availableAt = Number.isFinite(item.availableAt)
						? item.availableAt
						: now;
					if (wasRunning) {
						recoveredRunningCount++;
					}

					return {
						...item,
						origin: item.origin ?? "linear",
						task:
							item.task ??
							(item.githubPullRequestEvent
								? "github-conflict-rebase"
								: "agent-session"),
						workItemIdentifier:
							item.workItemIdentifier ?? item.issueIdentifier ?? item.sessionId,
						repoIds: Array.isArray(item.repoIds) ? item.repoIds : [],
						retryCount: wasRunning ? retryCount + 1 : retryCount,
						availableAt: wasRunning
							? now + this.linearSessionRetryDelayMs
							: availableAt,
						lastError: wasRunning
							? "Recovered after Cyrus restart; retrying automatically."
							: item.lastError,
						recoveredAt: wasRunning ? now : item.recoveredAt,
						prioritizedAt: Number.isFinite(item.prioritizedAt)
							? item.prioritizedAt
							: undefined,
						startedAt: undefined,
					};
				});

			if (this.linearSessionQueue.length > 0) {
				this.logger.info(
					`Loaded ${this.linearSessionQueue.length} agent queue item(s) from disk`,
				);
			}
			if (recoveredRunningCount > 0) {
				await this.saveLinearSessionQueue();
				void this.sendOperationalAlert({
					key: "linear-queue-recovered-running",
					severity: "warning",
					title: "Recovered interrupted Linear work",
					message: `${recoveredRunningCount} running task(s) were restored from the durable queue and will be retried automatically.`,
				});
			}
		} catch (error) {
			this.logger.error(
				`Failed to load Linear session queue from ${this.linearSessionQueueFile}`,
				error,
			);
			this.linearSessionQueue = [];
		}
	}

	private async recoverInterruptedActiveLinearSessionsFromState(): Promise<void> {
		const now = Date.now();
		const trackedSessionIds = new Set([
			...this.linearSessionQueue.map((item) => item.sessionId),
			...Array.from(this.linearSessionActiveItems.keys()),
		]);
		const recoveredItems: AgentSessionQueueItem[] = [];

		for (const session of this.agentSessionManager.getActiveSessions()) {
			const sessionId = session.externalSessionId ?? session.id;
			if (
				session.issueContext?.trackerId !== "linear" ||
				session.agentRunner ||
				this.isRecoveredActiveLinearSessionTooOld(session, now) ||
				trackedSessionIds.has(sessionId)
			) {
				continue;
			}

			const item = this.createRecoveredLinearSessionQueueItem(session, now);
			if (!item) {
				continue;
			}

			recoveredItems.push(item);
			trackedSessionIds.add(item.sessionId);
		}

		if (recoveredItems.length === 0) {
			return;
		}

		this.linearSessionQueue.push(...recoveredItems);
		await this.saveLinearSessionQueue();
		this.logger.warn(
			`Recovered ${recoveredItems.length} interrupted Linear session(s) from persisted state`,
		);
		void this.sendOperationalAlert({
			key: "linear-state-recovered-active",
			severity: "warning",
			title: "Recovered interrupted Linear sessions",
			message: `${recoveredItems.length} active Linear session(s) had no live runner after restart and were returned to the durable queue.`,
		});
	}

	private createRecoveredLinearSessionQueueItem(
		session: CyrusAgentSession,
		now: number,
	): AgentSessionQueueItem | null {
		const issue = session.issue;
		const issueIdentifier =
			session.issueContext?.issueIdentifier ?? issue?.identifier;
		const issueId = session.issueContext?.issueId ?? issue?.id;
		const sessionId = session.externalSessionId ?? session.id;
		const linearWorkspaceId = this.resolveLinearWorkspaceIdForSession(session);

		if (!issue || !issueIdentifier || !issueId || !linearWorkspaceId) {
			this.logger.warn(
				`Cannot recover interrupted Linear session ${sessionId}: missing issue or workspace context`,
			);
			return null;
		}

		const repoIds = session.repositories
			.map((repoContext) => repoContext.repositoryId)
			.filter((repoId) => this.repositories.has(repoId));

		return {
			origin: "linear",
			webhook: {
				action: "created",
				type: "AgentSession",
				organizationId: linearWorkspaceId,
				appUserId: "",
				oauthClientId: "",
				createdAt: new Date(now).toISOString(),
				agentSession: {
					id: sessionId,
					issue: {
						...issue,
						id: issueId,
						identifier: issueIdentifier,
					},
				},
			} as unknown as AgentSessionCreatedWebhook,
			repoIds,
			workItemIdentifier: issueIdentifier,
			sessionId,
			queuedAt: now,
			availableAt: now,
			retryCount: 1,
			lastError: "Recovered active session after Cyrus restart.",
			recoveredAt: now,
		};
	}

	private isRecoveredActiveLinearSessionTooOld(
		session: CyrusAgentSession,
		now: number,
	): boolean {
		const lastTouchedAt = session.updatedAt ?? session.createdAt ?? 0;
		return now - lastTouchedAt > this.interruptedSessionRecoveryLookbackMs;
	}

	private async saveLinearSessionQueue(): Promise<void> {
		const save = this.linearSessionQueueSavePromise.then(() =>
			this.writeLinearSessionQueueSnapshot(),
		);
		this.linearSessionQueueSavePromise = save.catch(() => undefined);
		await save;
	}

	private async writeLinearSessionQueueSnapshot(): Promise<void> {
		const items: SerializedAgentSessionQueueItem[] = [
			...Array.from(this.linearSessionActiveItems.values()).map((item) => ({
				...item,
				state: "running" as const,
			})),
			...this.linearSessionQueue.map((item) => ({
				...item,
				state: "queued" as const,
			})),
		];

		await mkdir(this.cyrusHome, { recursive: true });
		const tempPath = `${this.linearSessionQueueFile}.${process.pid}.${Date.now()}.${Math.random()
			.toString(36)
			.slice(2)}.tmp`;
		await writeFile(
			tempPath,
			JSON.stringify(
				{
					version: 1,
					items,
				},
				null,
				2,
			),
		);
		await rename(tempPath, this.linearSessionQueueFile);
	}

	private async removeLinearQueueItemsForIssue(
		issueId: string,
		issueIdentifier?: string,
	): Promise<void> {
		const beforeCount = this.linearSessionQueue.length;
		this.linearSessionQueue = this.linearSessionQueue.filter(
			(item) =>
				item.origin !== "linear" ||
				(item.webhook?.agentSession?.issue?.id !== issueId &&
					item.webhook?.agentSession?.issue?.identifier !== issueIdentifier),
		);

		for (const item of this.linearSessionActiveItems.values()) {
			if (
				item.origin === "linear" &&
				(item.webhook?.agentSession?.issue?.id === issueId ||
					item.webhook?.agentSession?.issue?.identifier === issueIdentifier)
			) {
				this.stopLinearSessionQueueItem(item);
			}
		}

		if (beforeCount !== this.linearSessionQueue.length) {
			await this.saveLinearSessionQueue();
		}
	}

	/**
	 * Handle agent session created webhook
	 * Can happen due to being 'delegated' or @ mentioned in a new thread
	 * @param webhook The agent session created webhook
	 * @param repos All available repositories for routing
	 */
	private async handleAgentSessionCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		const issueId = webhook.agentSession?.issue?.id;

		// Check the cache first, as the agentSessionCreated webhook may have been triggered by an @mention
		// on an issue that already has an agentSession and an associated repository.
		let repositories: RepositoryConfig[] | null = null;
		let baseBranchOverrides: Map<string, string> | undefined;
		let routingMethod: string | undefined;
		if (issueId) {
			const cachedRepos = this.getCachedRepositories(issueId);
			if (cachedRepos && cachedRepos.length > 0) {
				repositories = cachedRepos;
				this.logger.debug(
					`Using cached repositories [${cachedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
				);
			}
		}

		// If not cached, perform routing logic
		if (!repositories) {
			const routingResult =
				await this.repositoryRouter.determineRepositoryForWebhook(
					webhook,
					repos,
				);

			if (routingResult.type === "none") {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.info(
						`No repository configured for webhook from workspace ${webhook.organizationId}`,
					);
				}
				return;
			}

			// Handle needs_selection case
			if (routingResult.type === "needs_selection") {
				await this.repositoryRouter.elicitUserRepositorySelection(
					webhook,
					routingResult.workspaceRepos,
				);
				// Selection in progress - will be handled by handleRepositorySelectionResponse
				return;
			}

			// At this point, routingResult.type === "selected"
			repositories = routingResult.repositories;
			baseBranchOverrides = routingResult.baseBranchOverrides;
			if (baseBranchOverrides && baseBranchOverrides.size > 0) {
				this.logger.info(
					`baseBranchOverrides received from routing: ${Array.from(
						baseBranchOverrides.entries(),
					)
						.map(([id, branch]) => `${id}→${branch}`)
						.join(", ")}`,
				);
			} else {
				this.logger.info(`No baseBranchOverrides from routing result`);
			}
			routingMethod = routingResult.routingMethod;

			// Cache all matched repositories for this issue as string[]
			if (issueId) {
				this.repositoryRouter.getIssueRepositoryCache().set(
					issueId,
					repositories.map((r) => r.id),
				);
			}
		}

		if (!webhook.agentSession.issue) {
			this.logger.warn("Agent session created webhook missing issue");
			return;
		}

		// User access control check (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from delegating: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		const log = this.logger.withContext({
			sessionId: webhook.agentSession.id,
			platform: this.getRepositoryPlatform(linearWorkspaceId),
			issueIdentifier: webhook.agentSession.issue.identifier,
		});
		log.info(`Handling agent session created`);
		const { agentSession, guidance } = webhook;
		const commentBody = agentSession.comment?.body;

		// Check for blocked-by dependencies before starting work
		const blockResult = await this.checkBlockedByDependencies(
			agentSession,
			linearWorkspaceId,
		);
		if (blockResult.blocked) {
			// Park the session — don't create worktree or runner
			const parkedIssueId = agentSession.issue!.id;
			this.parkedSessions.set(parkedIssueId, {
				agentSession,
				repositories,
				linearWorkspaceId,
				guidance,
				commentBody,
				baseBranchOverrides,
				routingMethod,
				blockingIssueIds: blockResult.blockingIssueIds,
			});

			// Post acknowledgment to the Linear agent session
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				agentSession.id,
				linearWorkspaceId,
				`Blocked by ${blockerList} — will start automatically when ${blockResult.blockingIdentifiers.length === 1 ? "it is" : "they are"} resolved.`,
			);

			log.info(
				`Session parked: issue ${agentSession.issue!.identifier} is blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Initialize agent runner using shared logic (pass full repositories array)
		await this.initializeAgentRunner(
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			commentBody,
			baseBranchOverrides,
			routingMethod,
		);
	}

	/**

	/**
	 * Initialize and start agent runner for an agent session
	 * This method contains the shared logic for creating an agent runner that both
	 * handleAgentSessionCreatedWebhook and handleUserPromptedAgentActivity use.
	 *
	 * @param agentSession The Linear agent session
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @param guidance Optional guidance rules from Linear
	 * @param commentBody Optional comment body (for mentions)
	 * @param baseBranchOverrides Per-repo base branch overrides from [repo=name#branch] syntax
	 */
	private async initializeAgentRunner(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		repositories: RepositoryConfig[],
		linearWorkspaceId: string,
		guidance?: AgentSessionCreatedWebhook["guidance"],
		commentBody?: string | null,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<void> {
		const sessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.logger.warn("Cannot initialize Claude runner without issue");
			return;
		}

		const primaryRepo = repositories[0]!;

		const log = this.logger.withContext({
			sessionId,
			issueIdentifier: issue.identifier,
		});

		// Log guidance if present
		if (guidance && guidance.length > 0) {
			log.debug(`Agent guidance received: ${guidance.length} rule(s)`);
			for (const rule of guidance) {
				let origin = "Unknown";
				if (rule.origin) {
					if (rule.origin.__typename === "TeamOriginWebhookPayload") {
						origin = `Team: ${rule.origin.team.displayName}`;
					} else {
						origin = "Organization";
					}
				}
				log.info(`- ${origin}: ${rule.body.substring(0, 100)}...`);
			}
		}

		// HACK: This is required since the comment body is always populated, thus there is no other way to differentiate between the two trigger events
		const AGENT_SESSION_MARKER = "This thread is for an agent session";
		const isMentionTriggered =
			commentBody && !commentBody.includes(AGENT_SESSION_MARKER);
		// Check if the comment contains the /label-based-prompt command
		const isLabelBasedPromptRequested = commentBody?.includes(
			"/label-based-prompt",
		);

		const agentSessionManager = this.agentSessionManager;

		// Post instant acknowledgment thought
		await this.postInstantAcknowledgment(sessionId, linearWorkspaceId);

		// Create the session using the shared method (pass full repositories array)
		const sessionData = await this.createCyrusAgentSession(
			sessionId,
			issue,
			repositories,
			agentSessionManager,
			linearWorkspaceId,
			baseBranchOverrides,
			routingMethod,
		);

		// Destructure the session data (excluding allowedTools which we'll build with promptType)
		const {
			session,
			fullIssue,
			workspace: _workspace,
			attachmentResult,
			attachmentsDir: _attachmentsDir,
			allowedDirectories,
		} = sessionData;

		// Fetch labels early (needed for system prompt and runner selection)
		const labels = await this.fetchIssueLabels(fullIssue);

		log.info(`Starting agent session for issue ${fullIssue.identifier}`);

		// Build and start Claude with initial prompt using full issue (streaming mode)
		log.info(`Building initial prompt for issue ${fullIssue.identifier}`);
		try {
			// Create input for unified prompt assembly
			const input: PromptAssemblyInput = {
				session,
				fullIssue,
				repositories,
				repository: primaryRepo,
				userComment: commentBody || "", // Empty for delegation, present for mentions
				attachmentManifest: attachmentResult.manifest,
				guidance: guidance || undefined,
				agentSession,
				labels,
				isNewSession: true,
				isStreaming: false, // Not yet streaming
				isMentionTriggered: isMentionTriggered || false,
				isLabelBasedPromptRequested: isLabelBasedPromptRequested || false,
				resolvedBaseBranches: sessionData.workspace.resolvedBaseBranches,
				linearWorkspaceId,
			};

			// Use unified prompt assembly
			const assembly = await this.assemblePrompt(input);

			// Get systemPromptVersion for tracking (TODO: add to PromptAssembly metadata)
			let systemPromptVersion: string | undefined;
			let promptType:
				| "debugger"
				| "builder"
				| "scoper"
				| "orchestrator"
				| "graphite-orchestrator"
				| undefined;

			if (!isMentionTriggered || isLabelBasedPromptRequested) {
				const systemPromptResult = await this.determineSystemPromptFromLabels(
					labels,
					primaryRepo,
				);
				systemPromptVersion = systemPromptResult?.version;
				promptType = systemPromptResult?.type;

				// Post thought about system prompt selection
				if (assembly.systemPrompt) {
					await this.postSystemPromptSelectionThought(
						sessionId,
						labels,
						linearWorkspaceId,
						primaryRepo.id,
					);
				}
			}

			// Build allowed tools list with Linear MCP tools (now with prompt type context)
			const allowedTools = this.buildAllowedTools(repositories, promptType);
			const disallowedTools = this.buildDisallowedTools(
				repositories,
				promptType,
			);

			log.debug(
				`Configured allowed tools for ${fullIssue.identifier}:`,
				allowedTools,
			);
			if (disallowedTools.length > 0) {
				log.debug(
					`Configured disallowed tools for ${fullIssue.identifier}:`,
					disallowedTools,
				);
			}

			// Create agent runner with system prompt from assembly
			// buildAgentRunnerConfig now determines runner type from labels internally
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					primaryRepo,
					sessionId,
					assembly.systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					labels, // Pass labels for runner selection and model override
					fullIssue.description || undefined, // Description tags can override label selectors
					undefined, // maxTurns
					linearWorkspaceId,
					this.buildSkillSessionContext(primaryRepo, fullIssue, session),
				);

			log.debug(
				`Label-based runner selection for new session: ${runnerType} (session ${sessionId})`,
			);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store runner by comment ID
			agentSessionManager.addAgentRunner(sessionId, runner);

			// Save state after mapping changes
			await this.savePersistedState();

			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, primaryRepo.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				primaryRepo.id,
			);

			// Update runner with version information (if available)
			// Note: updatePromptVersions is specific to ClaudeRunner
			if (
				systemPromptVersion &&
				"updatePromptVersions" in runner &&
				typeof runner.updatePromptVersions === "function"
			) {
				runner.updatePromptVersions({
					systemPromptVersion,
				});
			}

			// Log metadata for debugging
			log.debug(
				`Initial prompt built successfully - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}, length: ${assembly.userPrompt.length} characters`,
			);

			// Start session - use streaming mode if supported for ability to add messages later
			if (runner.supportsStreamingInput && runner.startStreaming) {
				log.debug(`Starting streaming session`);
				const sessionInfo = await runner.startStreaming(assembly.userPrompt);
				log.debug(`Streaming session started: ${sessionInfo.sessionId}`);
			} else {
				log.debug(`Starting non-streaming session`);
				const sessionInfo = await runner.start(assembly.userPrompt);
				log.debug(`Non-streaming session started: ${sessionInfo.sessionId}`);
			}
			// Note: AgentSessionManager will be initialized automatically when the first system message
			// is received via handleClaudeMessage() callback
		} catch (error) {
			log.error(`Error in prompt building/starting:`, error);
			throw error;
		}
	}

	/**
	 * Handle stop signal from prompted webhook
	 * Branch 1 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * IMPORTANT: Stop signals do NOT require repository lookup.
	 * The session must already exist (per CLAUDE.md), so we search
	 * all agent session managers to find it.
	 */
	private async handleStopSignal(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;
		const { issue } = webhook.agentSession;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		log.info(
			`Received stop signal for agent activity session ${agentSessionId}`,
		);

		// Find the session in the single session manager
		const foundSession = this.agentSessionManager.getSession(agentSessionId);

		if (!foundSession) {
			// Legacy recovery: session lost after restart/migration
			// Post acknowledgment so the user doesn't see a hanging state
			log.info(
				`No session found for stop signal ${agentSessionId} (likely a legacy session after restart)`,
			);

			const issueTitle = issue?.title || "this issue";
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Stop signal received for ${issueTitle}. No active session was found (the session may have ended or the system was restarted). No further action is needed.`,
			);
			return;
		}

		// Double-stop detection: two stop signals within 10s → full abort
		const now = Date.now();
		const lastStop = this.lastStopTimeBySession.get(agentSessionId);
		const isDoubleStop = lastStop !== undefined && now - lastStop < 10_000;
		this.lastStopTimeBySession.set(agentSessionId, now);

		const existingRunner = foundSession.agentRunner;
		const issueTitle = issue?.title || "this issue";
		const senderName = webhook.agentSession.creator?.name || "user";

		// Only warm sessions can be safely interrupted without killing the
		// underlying request. Non-warm sessions get a single-shot full stop —
		// calling interrupt() on them surfaces a "Request was aborted" error
		// from the SDK (see CYPACK-1145).
		const supportsInterrupt = Boolean(
			existingRunner?.interrupt && existingRunner?.isWarm?.(),
		);

		if (isDoubleStop || !supportsInterrupt) {
			// Either a second stop within window, or a non-warm runner — full kill
			this.agentSessionManager.requestSessionStop(agentSessionId);
			if (existingRunner) {
				existingRunner.stop();
				log.info(
					isDoubleStop
						? `Double-stop: fully aborted session ${agentSessionId}`
						: `Stopped session ${agentSessionId} (interrupt not supported)`,
				);
			}
			this.lastStopTimeBySession.delete(agentSessionId);
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				isDoubleStop
					? `I've fully stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName} (second stop)\n**Action Taken:** Session terminated`
					: `I've stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName}\n**Action Taken:** Session terminated`,
			);
		} else {
			// First stop on a warm session — interrupt current turn, keep session warm
			await existingRunner!.interrupt!();
			log.info(
				`Interrupted current turn for session ${agentSessionId} (send stop again within 10s to fully terminate)`,
			);
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Interrupted by ${senderName}\n**Tip:** Type and send "stop" within 10 seconds to fully terminate the session.`,
			);
		}
	}

	/**
	 * Handle repository selection response from prompted webhook
	 * Branch 2 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * This method extracts the user's repository selection from their response,
	 * or uses the fallback repository if their message doesn't match any option.
	 * In both cases, the selected repository is cached for future use.
	 */
	private async handleRepositorySelectionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity, guidance } = webhook;
		const commentBody = agentSession.comment?.body;
		const agentSessionId = agentSession.id;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		if (!agentActivity) {
			log.warn("Cannot handle repository selection without agentActivity");
			return;
		}

		if (!agentSession.issue) {
			log.warn("Cannot handle repository selection without issue");
			return;
		}

		const userMessage = agentActivity.content.body;

		log.debug(`Processing repository selection response: "${userMessage}"`);

		// Get the selected repository (or fallback)
		const repository = await this.repositoryRouter.selectRepositoryFromResponse(
			agentSessionId,
			userMessage,
		);

		if (!repository) {
			log.error(
				`Failed to select repository for agent session ${agentSessionId}`,
			);
			return;
		}

		// Cache the selected repository for this issue as string[]
		const issueId = agentSession.issue.id;
		this.repositoryRouter
			.getIssueRepositoryCache()
			.set(issueId, [repository.id]);

		log.debug(
			`Initializing agent runner after repository selection: ${agentSession.issue.identifier} -> ${repository.name}`,
		);

		// Initialize agent runner with the selected repository (wrapped in array)
		// routingMethod="user-selected" will be included in the combined routing activity
		// Use organizationId from webhook as the Linear-native workspace ID source
		await this.initializeAgentRunner(
			agentSession,
			[repository],
			webhook.organizationId,
			guidance,
			commentBody,
			undefined,
			"user-selected",
		);
	}

	/**
	 * Handle AskUserQuestion response from prompted webhook
	 * Branch 2.5: User response to a question posed via AskUserQuestion tool
	 *
	 * @param webhook The prompted webhook containing user's response
	 */
	private async handleAskUserQuestionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity } = webhook;
		const agentSessionId = agentSession.id;

		if (!agentActivity) {
			this.logger.warn(
				"Cannot handle AskUserQuestion response without agentActivity",
			);
			// Resolve with a denial to unblock the waiting promise
			this.askUserQuestionHandler.cancelPendingQuestion(
				agentSessionId,
				"No agent activity in webhook",
			);
			return;
		}

		// Extract the user's response from the activity body
		const userResponse = agentActivity.content?.body || "";

		this.logger.debug(
			`Processing AskUserQuestion response for session ${agentSessionId}: "${userResponse}"`,
		);

		// Pass the response to the handler to resolve the waiting promise
		const handled = this.askUserQuestionHandler.handleUserResponse(
			agentSessionId,
			userResponse,
		);

		if (!handled) {
			this.logger.warn(
				`AskUserQuestion response not handled for session ${agentSessionId} (no pending question)`,
			);
		} else {
			this.logger.debug(
				`AskUserQuestion response handled for session ${agentSessionId}`,
			);
		}
	}

	/**
	 * Handle normal prompted activity (existing session continuation)
	 * Branch 3 of agentSessionPrompted (see packages/CLAUDE.md)
	 */
	private async handleNormalPromptedActivity(
		webhook: AgentSessionPromptedWebhook,
		repositories: RepositoryConfig[],
	): Promise<void> {
		const repository = repositories[0]!;
		const { agentSession } = webhook;
		const sessionId = agentSession.id;
		const { issue } = agentSession;
		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		if (!issue) {
			this.logger.warn("Cannot handle prompted activity without issue");
			return;
		}

		if (!webhook.agentActivity) {
			this.logger.warn("Cannot handle prompted activity without agentActivity");
			return;
		}

		const commentId = webhook.agentActivity.sourceCommentId;

		const agentSessionManager = this.agentSessionManager;

		let session = agentSessionManager.getSession(sessionId);
		let isNewSession = false;
		let fullIssue: Issue | null = null;

		if (!session) {
			this.logger.debug(
				`No existing session found for agent activity session ${sessionId}, creating new session`,
			);
			isNewSession = true;

			// Post instant acknowledgment for new session creation
			await this.postInstantPromptedAcknowledgment(
				sessionId,
				linearWorkspaceId,
				false,
			);

			// Create the session using the shared method with all repositories
			const sessionData = await this.createCyrusAgentSession(
				sessionId,
				issue,
				repositories,
				agentSessionManager,
				linearWorkspaceId,
			);

			// Destructure session data for new session
			fullIssue = sessionData.fullIssue;
			session = sessionData.session;

			this.logger.debug(`Created new session ${sessionId} (prompted webhook)`);

			// Save state and emit events for new session
			await this.savePersistedState();
			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, repository.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				repository.id,
			);
		} else {
			this.logger.debug(
				`Found existing session ${sessionId} for new user prompt`,
			);

			// Post instant acknowledgment for existing session BEFORE any async work
			// Check if runner is currently running (streaming is Claude-specific, use isRunning for both)
			const isCurrentlyStreaming = session?.agentRunner?.isRunning() || false;

			await this.postInstantPromptedAcknowledgment(
				sessionId,
				linearWorkspaceId,
				isCurrentlyStreaming,
			);

			// Need to fetch full issue for routing context
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (issueTracker) {
				try {
					fullIssue = await issueTracker.fetchIssue(issue.id);
				} catch (error) {
					this.logger.warn(
						`Failed to fetch full issue for routing: ${issue.id}`,
						error,
					);
					// Continue with degraded routing context
				}
			}
		}

		// Note: Streaming check happens later in handlePromptWithStreamingCheck
		// after attachments are processed

		// Ensure session is not null after creation/retrieval
		if (!session) {
			throw new Error(
				`Failed to get or create session for agent activity session ${sessionId}`,
			);
		}

		// Acknowledgment already posted above for both new and existing sessions
		// (before any async routing work to ensure instant user feedback)

		// Get issue tracker using workspace ID from webhook context
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.error(
				"Unexpected: There was no IssueTrackerService for workspace",
				linearWorkspaceId,
			);
			return;
		}

		// Always set up attachments directory, even if no attachments in current comment
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		// Ensure directory exists
		await mkdir(attachmentsDir, { recursive: true });

		let attachmentManifest = "";
		let commentAuthor: string | undefined;
		let commentTimestamp: string | undefined;

		if (!commentId) {
			this.logger.warn("No comment ID provided for attachment handling");
		}

		try {
			const comment = commentId
				? await issueTracker.fetchComment(commentId)
				: null;

			// Extract comment metadata for multi-player context
			if (comment) {
				const user = await comment.user;
				commentAuthor =
					user?.displayName || user?.name || user?.email || "Unknown";
				commentTimestamp = comment.createdAt
					? comment.createdAt.toISOString()
					: new Date().toISOString();
			}

			// Count existing attachments
			const existingFiles = await readdir(attachmentsDir).catch(() => []);
			const existingAttachmentCount = existingFiles.filter(
				(file) => file.startsWith("attachment_") || file.startsWith("image_"),
			).length;

			// Download new attachments from the comment
			const linearTokenForAttachments =
				this.getLinearTokenForWorkspace(linearWorkspaceId);
			const downloadResult = comment
				? await this.downloadCommentAttachments(
						comment.body,
						attachmentsDir,
						linearTokenForAttachments,
						existingAttachmentCount,
					)
				: {
						totalNewAttachments: 0,
						newAttachmentMap: {},
						newImageMap: {},
						failedCount: 0,
					};

			if (downloadResult.totalNewAttachments > 0) {
				attachmentManifest = this.generateNewAttachmentManifest(downloadResult);
			}
		} catch (error) {
			this.logger.error("Failed to fetch comments for attachments:", error);
		}

		const promptBody = webhook.agentActivity.content.body;

		// Use centralized streaming check and routing logic
		try {
			await this.handlePromptWithStreamingCheck(
				session,
				repository,
				sessionId,
				agentSessionManager,
				promptBody,
				attachmentManifest,
				isNewSession,
				[], // No additional allowed directories for regular continuation
				`prompted webhook (${isNewSession ? "new" : "existing"} session)`,
				linearWorkspaceId,
				commentAuthor,
				commentTimestamp,
			);
		} catch (error) {
			this.logger.error("Failed to handle prompted webhook:", error);
		}
	}

	/**
	 * Handle user-prompted agent activity webhook
	 * Implements three-branch architecture from packages/CLAUDE.md:
	 *   1. Stop signal - terminate existing runner
	 *   2. Repository selection response - initialize Claude runner for first time
	 *   3. Normal prompted activity - continue existing session or create new one
	 *
	 * @param webhook The prompted webhook containing user's message
	 */
	private async handleUserPromptedAgentActivity(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;
		const activityBody = webhook.agentActivity?.content?.body || "";
		const signal = (webhook.agentActivity as any)?.signal;
		const isTextStopRequest = /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(
			activityBody,
		);

		// Branch 1: Handle stop signal (checked FIRST, before any routing work)
		// Per CLAUDE.md: "an agentSession MUST already exist" for stop signals
		// IMPORTANT: Stop signals do NOT require repository lookup
		if (signal === "stop" || isTextStopRequest) {
			await this.handleStopSignal(webhook);
			return;
		}

		// Branch 1.5: Handle re-prompt for parked (blocked-by) sessions
		// When a user re-prompts and the session is parked, re-check blocking status.
		// If blockers are resolved, wake the session immediately.
		const issueIdForParkedCheck = webhook.agentSession?.issue?.id;
		if (
			issueIdForParkedCheck &&
			this.parkedSessions.has(issueIdForParkedCheck)
		) {
			await this.handleParkedSessionReprompt(webhook, issueIdForParkedCheck);
			return;
		}

		// Branch 2: Handle repository selection response
		// This is the first Claude runner initialization after user selects a repository.
		// The selection handler extracts the choice from the response (or uses fallback)
		// and caches the repository for future use.
		if (this.repositoryRouter.hasPendingSelection(agentSessionId)) {
			await this.handleRepositorySelectionResponse(webhook);
			return;
		}

		// Branch 2.5: Handle AskUserQuestion response
		// This handles responses to questions posed via the AskUserQuestion tool.
		// The response is passed to the pending promise resolver.
		if (this.askUserQuestionHandler.hasPendingQuestion(agentSessionId)) {
			await this.handleAskUserQuestionResponse(webhook);
			return;
		}

		// Branch 3: Handle normal prompted activity (existing session continuation)
		// Per CLAUDE.md: "an agentSession MUST exist and a repository MUST already
		// be associated with the Linear issue. The repository will be retrieved from
		// the issue-to-repository cache - no new routing logic is performed."
		const issueId = webhook.agentSession?.issue?.id;
		if (!issueId) {
			this.logger.error(
				`No issue ID found in prompted webhook ${agentSessionId}`,
			);
			return;
		}

		// Resolve ALL cached repositories for this issue (not just the first).
		// Multi-repo sessions need the full set for workspace recreation.
		let repositories = this.getCachedRepositories(issueId);
		if (!repositories || repositories.length === 0) {
			// Fallback: attempt to recover repository for legacy/restarted sessions
			this.logger.info(
				`No cached repository for prompted webhook ${agentSessionId}, attempting fallback resolution`,
			);

			// First, check if the session manager already has this session
			const session = this.agentSessionManager.getSession(agentSessionId);
			if (session) {
				const repoId = this.sessionRepositories.get(agentSessionId);
				if (repoId) {
					const repo = this.repositories.get(repoId) ?? null;
					if (repo) {
						repositories = [repo];
						this.repositoryRouter
							.getIssueRepositoryCache()
							.set(issueId, [repoId]);
						this.logger.info(
							`Recovered repository ${repoId} for issue ${issueId} from session manager`,
						);
					}
				}
			}

			// Second fallback: re-route via repository router
			if (!repositories || repositories.length === 0) {
				try {
					const repos = Array.from(this.repositories.values());
					const routingResult =
						await this.repositoryRouter.determineRepositoryForWebhook(
							webhook,
							repos,
						);

					if (routingResult.type === "selected") {
						repositories = routingResult.repositories;
						this.repositoryRouter.getIssueRepositoryCache().set(
							issueId,
							routingResult.repositories.map((r) => r.id),
						);
						this.logger.info(
							`Recovered repositories [${repositories.map((r) => r.name).join(", ")}] for issue ${issueId} via fallback routing (${routingResult.routingMethod})`,
						);
					}
				} catch (error) {
					this.logger.warn(
						`Fallback repository routing failed for prompted webhook ${agentSessionId}`,
						error,
					);
				}
			}

			if (!repositories || repositories.length === 0) {
				// All recovery attempts failed - post visible feedback
				await this.agentSessionManager.createResponseActivity(
					agentSessionId,
					"I couldn't process your message because the session configuration was lost. Please create a new session by mentioning me (@cyrus) in a new comment with your prompt.",
				);
				this.logger.warn(
					`Failed to recover repository for prompted webhook ${agentSessionId} - all fallback methods exhausted`,
				);
				return;
			}
		}

		// User access control check for mid-session prompts (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from prompting: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		await this.handleNormalPromptedActivity(webhook, repositories);
	}

	/**
	 * Handle issue unassignment
	 * @param issue Linear issue object from webhook data
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 */
	private async handleIssueUnassigned(
		issue: WebhookIssue,
		linearWorkspaceId: string,
	): Promise<void> {
		const sessions = this.agentSessionManager.getSessionsByIssueId(issue.id);
		const activeThreadCount = sessions.length;

		// Stop all agent runners for this issue
		for (const session of sessions) {
			this.logger.info(`Stopping agent runner for issue ${issue.identifier}`);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Post ONE farewell comment on the issue (not in any thread) if there were active sessions
		if (activeThreadCount > 0) {
			await this.postComment(
				issue.id,
				"I've been unassigned and am stopping work now.",
				linearWorkspaceId,
				// No parentId - post as a new comment on the issue
			);
		}

		// Emit events
		this.logger.info(
			`Stopped ${activeThreadCount} sessions for unassigned issue ${issue.identifier}`,
		);
	}

	/**
	 * Handle Claude messages
	 */
	private async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
		_repositoryId: string,
	): Promise<void> {
		await this.agentSessionManager.handleClaudeMessage(sessionId, message);
	}

	/**
	 * Handle Claude session error
	 * Silently ignores AbortError (user-initiated stop), logs other errors
	 */
	private async handleClaudeError(error: Error): Promise<void> {
		// AbortError is expected when user stops Claude process, don't log it
		// Check by name since the SDK's AbortError class may not match our imported definition
		const isAbortError =
			error.name === "AbortError" || error.message.includes("aborted by user");

		// Also check for SIGTERM (exit code 143), which indicates graceful termination
		const isSigterm = error.message.includes(
			"Claude Code process exited with code 143",
		);

		if (isAbortError || isSigterm) {
			return;
		}
		this.logger.error("Unhandled claude error:", error);
	}

	/**
	 * Fetch issue labels for a given issue
	 */
	private async fetchIssueLabels(issue: Issue): Promise<string[]> {
		return this.promptBuilder.fetchIssueLabels(issue);
	}

	/**
	 * Build the session context used to evaluate per-skill scope restrictions.
	 *
	 * Skill scopes (persisted in `scope.json` sidecars by the config-updater)
	 * match against:
	 * - the active repository's Cyrus config ID,
	 * - the Linear team that owns the issue, and
	 * - the Linear label IDs attached to the issue.
	 *
	 * The session's repo working-tree path(s) are also captured so that
	 * repo-local skills (`<repoPath>/.claude/skills/*`) get unioned into the
	 * resolved whitelist. When a `session` is provided its workspace is used to
	 * resolve those paths (covering multi-repo sessions); otherwise the active
	 * repository's path is used.
	 */
	private buildSkillSessionContext(
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	): SkillSessionContext {
		const context: SkillSessionContext = {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		if (fullIssue?.teamId) {
			context.linearTeamId = fullIssue.teamId;
		}
		if (
			Array.isArray(fullIssue?.labelIds) &&
			(fullIssue?.labelIds?.length ?? 0) > 0
		) {
			context.linearLabelIds = [...(fullIssue?.labelIds ?? [])];
		}
		return context;
	}

	/**
	 * Resolve the repo working-tree path(s) whose `.claude/skills/` directories
	 * should contribute to the skill whitelist for a session.
	 *
	 * - Multi-repo sessions: every sub-worktree in `workspace.repoPaths`.
	 * - Single-repo / GitHub-mention sessions: the active repository's path.
	 */
	private resolveSkillRepoPaths(
		repository: RepositoryConfig,
		session?: CyrusAgentSession,
	): string[] {
		const repoPaths = session?.workspace?.repoPaths;
		if (repoPaths) {
			const paths = Object.values(repoPaths).filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
			if (paths.length > 0) {
				return [...new Set(paths)];
			}
		}
		return [repository.repositoryPath];
	}

	/**
	 * Resolve default model for a given runner from config with sensible built-in defaults.
	 * Supports legacy config keys for backwards compatibility.
	 */
	private getDefaultModelForRunner(runnerType: RunnerType): string {
		return this.runnerSelectionService.getDefaultModelForRunner(runnerType);
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	private getDefaultFallbackModelForRunner(runnerType: RunnerType): string {
		return this.runnerSelectionService.getDefaultFallbackModelForRunner(
			runnerType,
		);
	}

	/**
	 * Instantiate the appropriate runner for the given type.
	 */
	private createRunnerForType(
		runnerType: "claude" | "gemini" | "codex" | "cursor",
		config: AgentRunnerConfig,
	): IAgentRunner {
		switch (runnerType) {
			case "claude": {
				// Inject the hosted SessionStore at the last moment so it only
				// attaches to Claude runners (the field is Claude-specific).
				const claudeConfig = this.claudeSessionStore
					? { ...config, sessionStore: this.claudeSessionStore }
					: config;
				return new ClaudeRunner(claudeConfig, this.isWarmSessionsEnabled());
			}
			case "gemini":
				return new GeminiRunner(config);
			case "codex":
				return new CodexRunner(config);
			case "cursor":
				return new CursorRunner(config);
			default:
				throw new Error(`Unknown runner type: ${runnerType satisfies never}`);
		}
	}

	/**
	 * Determine system prompt based on issue labels and repository configuration
	 */
	private async determineSystemPromptFromLabels(
		labels: string[],
		repository: RepositoryConfig,
	): Promise<
		| {
				prompt: string;
				version?: string;
				type?:
					| "debugger"
					| "builder"
					| "scoper"
					| "orchestrator"
					| "graphite-orchestrator";
		  }
		| undefined
	> {
		return this.promptBuilder.determineSystemPromptFromLabels(labels, [
			repository,
		]);
	}

	/**
	 * Build prompt for mention-triggered sessions
	 * @param issue Full Linear issue object
	 * @param repository Repository configuration
	 * @param agentSession The agent session containing the mention
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns The constructed prompt and optional version tag
	 */
	private async buildMentionPrompt(
		issue: Issue,
		agentSession: WebhookAgentSession,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<{ prompt: string; version?: string }> {
		return this.promptBuilder.buildMentionPrompt(
			issue,
			agentSession,
			attachmentManifest,
			guidance,
		);
	}

	/**
	 * Convert full Linear SDK issue to CoreIssue interface for Session creation
	 */
	private convertLinearIssueToCore(issue: Issue): IssueMinimal {
		return this.promptBuilder.convertLinearIssueToCore(issue);
	}

	/**
	 * Get connection status by repository ID
	 */
	getConnectionStatus(): Map<string, boolean> {
		const status = new Map<string, boolean>();
		// Single event transport is "connected" if it exists
		if (this.linearEventTransport) {
			// Mark all repositories as connected since they share the single transport
			for (const repoId of this.repositories.keys()) {
				status.set(repoId, true);
			}
		}
		return status;
	}

	/**
	 * Get event transport (for testing purposes)
	 * @internal
	 */
	_getClientByToken(_token: string): any {
		// Return the single shared event transport
		return this.linearEventTransport;
	}

	/**
	 * Start OAuth flow using the shared application server
	 */
	async startOAuthFlow(proxyUrl?: string): Promise<{
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}> {
		const oauthProxyUrl = proxyUrl || this.config.proxyUrl || DEFAULT_PROXY_URL;
		return this.sharedApplicationServer.startOAuthFlow(oauthProxyUrl);
	}

	/**
	 * Get the server port
	 */
	getServerPort(): number {
		return this.config.serverPort || this.config.webhookPort || 3456;
	}

	/**
	 * Get the OAuth callback URL
	 */
	getOAuthCallbackUrl(): string {
		return this.sharedApplicationServer.getOAuthCallbackUrl();
	}

	/**
	 * Move issue to started state when assigned
	 * @param issue Full Linear issue object from Linear SDK
	 * @param linearWorkspaceId Workspace ID for issue tracker lookup
	 */

	private async moveIssueToStartedState(
		issue: Issue,
		linearWorkspaceId: string,
	): Promise<void> {
		try {
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (!issueTracker) {
				this.logger.warn(
					`No issue tracker found for workspace ${linearWorkspaceId}, skipping state update`,
				);
				return;
			}

			// Check if issue is already in a started state
			const currentState = await issue.state;
			if (currentState?.type === "started") {
				this.logger.debug(
					`Issue ${issue.identifier} is already in started state (${currentState.name})`,
				);
				return;
			}

			// Get team for the issue
			const team = await issue.team;
			if (!team) {
				this.logger.warn(
					`No team found for issue ${issue.identifier}, skipping state update`,
				);
				return;
			}

			// Get available workflow states for the issue's team
			const teamStates = await issueTracker.fetchWorkflowStates(team.id);

			const states = teamStates;

			// Find all states with type "started" and pick the one with lowest position
			// This ensures we pick "In Progress" over "In Review" when both have type "started"
			// Linear uses standardized state types: triage, backlog, unstarted, started, completed, canceled
			const startedStates = states.nodes.filter(
				(state) => state.type === "started",
			);
			const startedState = startedStates.sort(
				(a, b) => a.position - b.position,
			)[0];

			if (!startedState) {
				throw new Error(
					'Could not find a state with type "started" for this team',
				);
			}

			// Update the issue state
			this.logger.debug(
				`Moving issue ${issue.identifier} to started state: ${startedState.name}`,
			);
			if (!issue.id) {
				this.logger.warn(
					`Issue ${issue.identifier} has no ID, skipping state update`,
				);
				return;
			}

			await issueTracker.updateIssue(issue.id, {
				stateId: startedState.id,
			});

			this.logger.debug(
				`✅ Successfully moved issue ${issue.identifier} to ${startedState.name} state`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to move issue ${issue.identifier} to started state:`,
				error,
			);
			// Don't throw - we don't want to fail the entire assignment process due to state update failure
		}
	}

	/**
	 * Post initial comment when assigned to issue
	 */
	// private async postInitialComment(issueId: string, repositoryId: string): Promise<void> {
	//   const body = "I'm getting started right away."
	//   // Get the issue tracker for this repository
	//   const issueTracker = this.issueTrackers.get(repositoryId)
	//   if (!issueTracker) {
	//     throw new Error(`No issue tracker found for repository ${repositoryId}`)
	//   }
	//   const commentData = {

	//     body
	//   }
	//   await issueTracker.createComment(commentData)
	// }

	/**
	 * Post a comment to Linear
	 */
	private async postComment(
		issueId: string,
		body: string,
		linearWorkspaceId: string,
		parentId?: string,
	): Promise<void> {
		return this.activityPoster.postComment(
			issueId,
			body,
			linearWorkspaceId,
			parentId,
		);
	}

	/**
	 * Format todos as Linear checklist markdown
	 */
	// private formatTodosAsChecklist(todos: Array<{id: string, content: string, status: string, priority: string}>): string {
	//   return todos.map(todo => {
	//     const checkbox = todo.status === 'completed' ? '[x]' : '[ ]'
	//     const statusEmoji = todo.status === 'in_progress' ? ' 🔄' : ''
	//     return `- ${checkbox} ${todo.content}${statusEmoji}`
	//   }).join('\n')
	// }

	/**
	 * Download attachments from Linear issue
	 * @param issue Linear issue object from webhook data
	 * @param repository Repository configuration
	 * @param workspacePath Path to workspace directory
	 */
	private async downloadIssueAttachments(
		issue: Issue,
		linearWorkspaceId: string,
		workspacePath: string,
	): Promise<{ manifest: string; attachmentsDir: string | null }> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		return this.attachmentService.downloadIssueAttachments(
			issue,
			linearWorkspaceId,
			workspacePath,
			issueTracker,
		);
	}

	/**
	 * Download attachments from a specific comment
	 * @param commentBody The body text of the comment
	 * @param attachmentsDir Directory where attachments should be saved
	 * @param linearToken Linear API token
	 * @param existingAttachmentCount Current number of attachments already downloaded
	 */
	private async downloadCommentAttachments(
		commentBody: string,
		attachmentsDir: string,
		linearToken: string | null,
		existingAttachmentCount: number,
	): Promise<{
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}> {
		return this.attachmentService.downloadCommentAttachments(
			commentBody,
			attachmentsDir,
			linearToken,
			existingAttachmentCount,
		);
	}

	/**
	 * Generate attachment manifest for new comment attachments
	 */
	private generateNewAttachmentManifest(result: {
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}): string {
		return this.attachmentService.generateNewAttachmentManifest(result);
	}

	private async registerCyrusToolsMcpEndpoint(): Promise<void> {
		if (this.cyrusToolsMcpRegistered) {
			return;
		}

		const fastify = this.sharedApplicationServer.getFastifyInstance() as any;
		if (
			typeof fastify.register !== "function" ||
			typeof fastify.addHook !== "function"
		) {
			console.warn(
				"[EdgeWorker] Skipping cyrus-tools MCP endpoint registration: Fastify instance does not support register/addHook",
			);
			return;
		}

		fastify.addHook("onRequest", (request: any, _reply: any, done: any) => {
			const rawUrl =
				typeof request?.raw?.url === "string"
					? request.raw.url
					: typeof request?.url === "string"
						? request.url
						: "";
			const requestPath = rawUrl.split("?")[0];

			if (requestPath !== this.cyrusToolsMcpEndpoint) {
				done();
				return;
			}

			if (
				!this.mcpConfigService.isAuthorizationValid(
					request.headers?.authorization,
				)
			) {
				_reply.code(401).send({
					error: "Unauthorized cyrus-tools MCP request",
				});
				done();
				return;
			}

			const rawContextHeader = request.headers?.["x-cyrus-mcp-context-id"];
			const contextId = Array.isArray(rawContextHeader)
				? rawContextHeader[0]
				: rawContextHeader;

			this.cyrusToolsMcpRequestContext.run({ contextId }, () => {
				done();
			});
		});

		this.cyrusToolsMcpSessions.on("connected", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session connected: ${sessionId}`,
			);
		});

		this.cyrusToolsMcpSessions.on("terminated", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session terminated: ${sessionId}`,
			);
		});

		this.cyrusToolsMcpSessions.on("error", (error) => {
			console.error("[EdgeWorker] cyrus-tools MCP session error:", error);
		});

		await fastify.register(streamableHttp, {
			stateful: true,
			mcpEndpoint: this.cyrusToolsMcpEndpoint,
			sessions: this.cyrusToolsMcpSessions,
			createServer: async () => {
				const contextId =
					this.cyrusToolsMcpRequestContext.getStore()?.contextId;
				if (!contextId) {
					throw new Error(
						"Missing x-cyrus-mcp-context-id header for cyrus-tools MCP request",
					);
				}

				const context = this.mcpConfigService.getContext(contextId);
				if (!context) {
					throw new Error(
						`Unknown cyrus-tools MCP context '${contextId}'. Build MCP config before connecting.`,
					);
				}

				const sdkServer =
					context.prebuiltServer ||
					createCyrusToolsServer(
						context.linearClient,
						this.createCyrusToolsOptions(context.parentSessionId),
					);
				this.mcpConfigService.clearPrebuiltServer(contextId);

				return sdkServer.server;
			},
		});

		this.cyrusToolsMcpRegistered = true;
		console.log(
			`✅ Cyrus tools MCP endpoint registered at ${this.cyrusToolsMcpEndpoint}`,
		);
	}

	private failureModesClient: FailureModesHttpClient | null = null;

	/**
	 * Lazily build the HTTP client used by `log_failure_mode` to POST to
	 * cyrus-hosted. Uses `CYRUS_APP_URL` (the same env var the remote
	 * session-store client reads, see top of this file) so preview
	 * environments and prod share a single way to point at a control
	 * plane. Returns null when either the URL or the `CYRUS_API_KEY` are
	 * missing — in that mode the tool is simply not registered, so
	 * customer-mode CLI users without a control plane don't see a broken
	 * tool.
	 */
	private getFailureModesClient(): FailureModesHttpClient | null {
		if (this.failureModesClient) return this.failureModesClient;
		const apiKey = process.env.CYRUS_API_KEY?.trim();
		if (!apiKey) return null;
		const baseUrl = getCyrusAppUrl();
		this.failureModesClient = createFetchFailureModesClient({
			baseUrl,
			apiKey,
		});
		return this.failureModesClient;
	}

	/**
	 * Resolve a working-directory string to the agent session id that owns
	 * that workspace. The `log_failure_mode` MCP tool calls this with the
	 * agent's reported `cwd`. We normalize and compare against each known
	 * session's `workspace.path` (and any sub-repo paths the session opens).
	 */
	/**
	 * Resolve a working-directory string to the rich session bundle a
	 * Cyrus team member needs to triage a failure-mode report: the
	 * internal session id (for dedup), the runner session id + runner
	 * type (so triage can pull the Claude/Gemini/Codex/Cursor transcript),
	 * the Linear AgentSession + source-issue identifiers (so triage can
	 * jump to the customer thread), and the workspace path (for repro).
	 *
	 * Returns null only when no session matches. We prefer an exact
	 * workspace-path or sub-repo-path match; if neither hits, we fall
	 * back to a prefix match for nested cwds (e.g. shells in a subdir).
	 */
	/**
	 * Aggregator over every place active sessions live in this process.
	 * Today: the primary AgentSessionManager (issue sessions) and the
	 * ChatSessionHandler's private one (Slack / GitHub-PR-chat / future
	 * chat platforms). New session origins should be added here so
	 * downstream consumers (currently just resolveSessionFromCwd) keep
	 * working without modification — single open extension point (OCP),
	 * single responsibility (SRP: this method's only job is "where do
	 * sessions live?", separate from "how do we match one by cwd?").
	 */
	private getAllKnownSessions(): CyrusAgentSession[] {
		return [
			...this.agentSessionManager.getAllSessions(),
			...(this.chatSessionHandler?.getAllChatSessions() ?? []),
		];
	}

	private resolveSessionFromCwd(cwd: string): ResolvedSession | null {
		if (!cwd) return null;
		const normalize = (p: string) => p.replace(/\/+$/, "");
		const target = normalize(cwd);

		const sessions = this.getAllKnownSessions();

		const exact = sessions.find((session) => {
			if (normalize(session.workspace?.path ?? "") === target) return true;
			const repoPaths = session.workspace?.repoPaths;
			if (repoPaths) {
				for (const p of Object.values(repoPaths)) {
					if (typeof p === "string" && normalize(p) === target) return true;
				}
			}
			return false;
		});

		const prefix = exact
			? undefined
			: sessions.find((session) => {
					const root = normalize(session.workspace?.path ?? "");
					return root && target.startsWith(`${root}/`);
				});

		const session = exact ?? prefix;
		if (!session) return null;

		const runnerType = session.claudeSessionId
			? "claude"
			: session.geminiSessionId
				? "gemini"
				: session.codexSessionId
					? "codex"
					: session.cursorSessionId
						? "cursor"
						: null;
		const runnerSessionId =
			session.claudeSessionId ??
			session.geminiSessionId ??
			session.codexSessionId ??
			session.cursorSessionId ??
			null;

		const sessionSource = session.id.startsWith("github-")
			? "github"
			: session.id.startsWith("gitlab-")
				? "gitlab"
				: session.id.startsWith("slack-")
					? "slack"
					: (session.issueContext?.trackerId ?? "linear");

		// For Linear-source sessions, `session.id` is already the Linear
		// AgentSession id (they're literally the same UUID — the v3 rename
		// from `linearAgentActivitySessionId` to `id` kept the value). So we
		// don't surface a separate `linearAgentSessionId` — the server keys
		// dedup on `session_id` and that *is* the Linear AgentSession id when
		// `session_source === 'linear'`.
		return {
			sessionId: session.id,
			runnerSessionId,
			runnerType,
			sourceIssueIdentifier:
				session.issueContext?.issueIdentifier ??
				session.issue?.identifier ??
				null,
			workspacePath: session.workspace?.path ?? null,
			sessionSource,
		};
	}

	private createCyrusToolsOptions(parentSessionId?: string): CyrusToolsOptions {
		const failureModesClient = this.getFailureModesClient();
		const options: CyrusToolsOptions = {
			parentSessionId,
			onSessionCreated: (childSessionId: string, parentId: string) => {
				this.handleChildSessionMapping(childSessionId, parentId);
			},
			onFeedbackDelivery: async (childSessionId: string, message: string) => {
				return this.handleFeedbackDeliveryToChildSession(
					childSessionId,
					message,
				);
			},
		};
		if (failureModesClient) {
			options.failureModes = {
				resolveSessionFromCwd: (cwd: string) => this.resolveSessionFromCwd(cwd),
				httpClient: failureModesClient,
			};
		}
		return options;
	}

	private handleChildSessionMapping(
		childSessionId: string,
		parentSessionId: string,
	): void {
		console.log(
			`[EdgeWorker] Agent session created: ${childSessionId}, mapping to parent ${parentSessionId}`,
		);
		this.globalSessionRegistry.setParentSession(
			childSessionId,
			parentSessionId,
		);
		console.log(
			`[EdgeWorker] Parent-child mapping registered in GlobalSessionRegistry`,
		);
	}

	private async handleFeedbackDeliveryToChildSession(
		childSessionId: string,
		message: string,
	): Promise<boolean> {
		console.log(
			`[EdgeWorker] Processing feedback delivery to child session ${childSessionId}`,
		);

		// Find the parent session ID for context
		const parentSessionId =
			this.globalSessionRegistry.getParentSessionId(childSessionId);

		// Find the repository containing the child session
		const childRepoId = this.sessionRepositories.get(childSessionId);
		const childRepo = childRepoId
			? this.repositories.get(childRepoId)
			: undefined;

		if (
			!childRepo ||
			!this.agentSessionManager.hasAgentRunner(childSessionId)
		) {
			console.error(
				`[EdgeWorker] Child session ${childSessionId} not found in any repository`,
			);
			return false;
		}

		// Get the child session
		const childSession = this.agentSessionManager.getSession(childSessionId);
		if (!childSession) {
			console.error(`[EdgeWorker] Child session ${childSessionId} not found`);
			return false;
		}

		console.log(
			`[EdgeWorker] Found child session - Issue: ${childSession.issueId}`,
		);

		// Get parent session info for better context in the thought
		let parentIssueId: string | undefined;
		if (parentSessionId) {
			const parentSession =
				this.agentSessionManager.getSession(parentSessionId);
			if (parentSession) {
				parentIssueId =
					parentSession.issue?.identifier || parentSession.issueId;
			}
		}

		// Extract workspace ID once for all operations
		const childWorkspaceId = requireLinearWorkspaceId(childRepo);

		// Post thought to Linear showing feedback receipt
		const issueTracker = this.issueTrackers.get(childWorkspaceId);
		if (issueTracker) {
			const feedbackThought = parentIssueId
				? `Received feedback from orchestrator (${parentIssueId}):\n\n---\n\n${message}\n\n---`
				: `Received feedback from orchestrator:\n\n---\n\n${message}\n\n---`;

			try {
				const result = await issueTracker.createAgentActivity({
					agentSessionId: childSessionId,
					content: {
						type: "thought",
						body: feedbackThought,
					},
				});

				if (result.success) {
					console.log(
						`[EdgeWorker] Posted feedback receipt thought for child session ${childSessionId}`,
					);
				} else {
					console.error(
						`[EdgeWorker] Failed to post feedback receipt thought:`,
						result,
					);
				}
			} catch (error) {
				console.error(
					`[EdgeWorker] Error posting feedback receipt thought:`,
					error,
				);
			}
		}

		const feedbackPrompt = `## Received feedback from orchestrator\n\n---\n\n${message}\n\n---`;

		console.log(
			`[EdgeWorker] Handling feedback delivery to child session ${childSessionId}`,
		);

		this.handlePromptWithStreamingCheck(
			childSession,
			childRepo,
			childSessionId,
			this.agentSessionManager,
			feedbackPrompt,
			"",
			false,
			[],
			"give feedback to child",
			childWorkspaceId,
		)
			.then(() => {
				console.log(
					`[EdgeWorker] Child session ${childSessionId} completed processing feedback`,
				);
			})
			.catch((error) => {
				console.error(
					`[EdgeWorker] Failed to process feedback in child session:`,
					error,
				);
			});

		console.log(
			`[EdgeWorker] Feedback delivered successfully to child session ${childSessionId}`,
		);
		return true;
	}

	private getCyrusToolsMcpUrl(): string {
		const server = this.sharedApplicationServer as {
			getPort?: () => number;
		};
		const port =
			typeof server.getPort === "function"
				? server.getPort()
				: this.config.serverPort || this.config.webhookPort || 3456;
		return `http://127.0.0.1:${port}${this.cyrusToolsMcpEndpoint}`;
	}

	/**
	 * Build the complete prompt for a session - shows full prompt assembly in one place
	 *
	 * New session prompt structure:
	 * 1. Issue context (from buildIssueContextPrompt)
	 * 2. User comment
	 *
	 * Existing session prompt structure:
	 * 1. User comment
	 * 2. Attachment manifest (if present)
	 */
	private async buildSessionPrompt(
		isNewSession: boolean,
		session: CyrusAgentSession,
		fullIssue: Issue,
		repository: RepositoryConfig,
		promptBody: string,
		attachmentManifest?: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<string> {
		// Fetch labels for system prompt determination
		const labels = await this.fetchIssueLabels(fullIssue);

		// Create input for unified prompt assembly
		const input: PromptAssemblyInput = {
			session,
			fullIssue,
			repositories: [repository],
			repository,
			userComment: promptBody,
			commentAuthor,
			commentTimestamp,
			attachmentManifest,
			isNewSession,
			isStreaming: false, // This path is only for non-streaming prompts
			labels,
		};

		// Use unified prompt assembly
		const assembly = await this.assemblePrompt(input);

		// Log metadata for debugging
		this.logger.debug(
			`Built prompt - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}`,
		);

		return assembly.userPrompt;
	}

	/**
	 * Assemble a complete prompt - unified entry point for all prompt building
	 * This method contains all prompt assembly logic in one place
	 */
	private async assemblePrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		// If actively streaming, just pass through the comment
		if (input.isStreaming) {
			return this.buildStreamingPrompt(input);
		}

		// If new session, build full prompt with all components
		if (input.isNewSession) {
			return this.buildNewSessionPrompt(input);
		}

		// Existing session continuation - just user comment + attachments
		return this.buildContinuationPrompt(input);
	}

	/**
	 * Build prompt for actively streaming session - pass through user comment as-is
	 */
	private buildStreamingPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		const parts: string[] = [input.userComment];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		};
	}

	/**
	 * Build prompt for new session - includes issue context and user comment
	 */
	private async buildNewSessionPrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		const components: PromptComponent[] = [];
		const parts: string[] = [];

		// 1. Determine system prompt from labels
		// Only for delegation (not mentions) or when /label-based-prompt is requested
		const repositories = input.repositories ?? [input.repository];
		let labelBasedSystemPrompt: string | undefined;
		if (!input.isMentionTriggered || input.isLabelBasedPromptRequested) {
			const result = await this.promptBuilder.determineSystemPromptFromLabels(
				input.labels || [],
				repositories,
			);
			labelBasedSystemPrompt = result?.prompt;
		}

		// 2. Determine system prompt based on prompt type
		// Label-based: Use only the label-based system prompt
		// Fallback: Use scenarios system prompt (shared instructions)
		let systemPrompt: string;
		if (labelBasedSystemPrompt) {
			// Use label-based system prompt as-is (no shared instructions)
			systemPrompt = labelBasedSystemPrompt;
		} else {
			// Use scenarios system prompt for fallback cases
			const sharedInstructions = await this.loadSharedInstructions();
			systemPrompt = sharedInstructions;
		}

		// 3. Append skills guidance — instruct the agent to use skills based on context.
		// Skills hidden by per-skill scope (repo / Linear team / Linear label) are
		// omitted from the guidance so the model doesn't reference skills it
		// cannot invoke.
		const skillsContext = this.buildSkillSessionContext(
			repositories[0]!,
			input.fullIssue,
			input.session,
		);
		systemPrompt += await this.skillsPluginResolver.buildSkillsGuidance(
			undefined,
			skillsContext,
		);

		// 4. Append agent context — dynamic values for skills to reference
		systemPrompt += this.buildAgentContextBlock();

		// 5. Build issue context using appropriate builder
		// Use label-based prompt ONLY if we have a label-based system prompt
		const promptType = this.determinePromptType(
			input,
			!!labelBasedSystemPrompt,
		);
		// Build workspace repo paths map for prompt context.
		// For multi-repo sessions, workspace.repoPaths maps each repo ID to its worktree.
		// For single-repo sessions, use workspace.path as the worktree for the primary repo.
		const workspaceRepoPaths =
			input.session.workspace.repoPaths ??
			(repositories.length === 1
				? { [repositories[0]!.id]: input.session.workspace.path }
				: undefined);
		const issueContext = await this.buildIssueContextForPromptAssembly(
			input.fullIssue,
			repositories,
			promptType,
			input.attachmentManifest,
			input.guidance,
			input.agentSession,
			input.resolvedBaseBranches,
			workspaceRepoPaths,
		);

		parts.push(issueContext.prompt);
		components.push("issue-context");

		// 4. Add user comment (if present)
		// Skip for mention-triggered prompts since the comment is already in the mention block
		if (input.userComment.trim() && !input.isMentionTriggered) {
			// If we have author/timestamp metadata, include it for multi-player context
			if (input.commentAuthor || input.commentTimestamp) {
				const author = input.commentAuthor || "Unknown";
				const timestamp = input.commentTimestamp || new Date().toISOString();
				parts.push(`<user_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</user_comment>`);
			} else {
				// Legacy format without metadata
				parts.push(`<user_comment>\n${input.userComment}\n</user_comment>`);
			}
			components.push("user-comment");
		}

		// 6. Add guidance rules (if present)
		if (input.guidance && input.guidance.length > 0) {
			components.push("guidance-rules");
		}

		return {
			systemPrompt,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType,
				isNewSession: true,
				isStreaming: false,
			},
		};
	}

	/**
	 * Build an <agent_context> block with dynamic values that skills can reference.
	 *
	 * Provides bot usernames so skills (e.g. verify-and-ship) can refer to the
	 * correct bot account without hardcoding.
	 */
	private buildAgentContextBlock(): string {
		const githubBot = process.env.GITHUB_BOT_USERNAME || "";
		const gitlabBot = process.env.GITLAB_BOT_USERNAME || "";

		if (!githubBot && !gitlabBot) {
			return "";
		}

		const lines: string[] = ["\n\n<agent_context>"];
		if (githubBot) {
			lines.push(`  <github_bot_username>${githubBot}</github_bot_username>`);
		}
		if (gitlabBot) {
			lines.push(`  <gitlab_bot_username>${gitlabBot}</gitlab_bot_username>`);
		}
		lines.push("</agent_context>");

		return lines.join("\n");
	}

	/**
	 * Build prompt for existing session continuation - user comment and attachments only
	 */
	private buildContinuationPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		// Wrap comment in XML with author and timestamp for multi-player context
		const author = input.commentAuthor || "Unknown";
		const timestamp = input.commentTimestamp || new Date().toISOString();

		const commentXml = `<new_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</new_comment>`;

		const parts: string[] = [commentXml];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		};
	}

	/**
	 * Determine the prompt type based on input flags and system prompt availability
	 */
	private determinePromptType(
		input: PromptAssemblyInput,
		hasSystemPrompt: boolean,
	): PromptType {
		if (input.isMentionTriggered && input.isLabelBasedPromptRequested) {
			return "label-based-prompt-command";
		}
		if (input.isMentionTriggered) {
			return "mention";
		}
		if (hasSystemPrompt) {
			return "label-based";
		}
		return "fallback";
	}

	/**
	 * Load shared instructions that get appended to all system prompts
	 */
	private async loadSharedInstructions(): Promise<string> {
		return this.promptBuilder.loadSharedInstructions();
	}

	/**
	 * Adapter method for prompt assembly - routes to appropriate issue context builder
	 */
	private async buildIssueContextForPromptAssembly(
		issue: Issue,
		repositories: RepositoryConfig[],
		promptType: PromptType,
		attachmentManifest?: string,
		guidance?: GuidanceRule[],
		agentSession?: WebhookAgentSession,
		resolvedBaseBranches?: Record<string, BaseBranchResolution>,
		workspaceRepoPaths?: Record<string, string>,
	): Promise<IssueContextResult> {
		// Delegate to appropriate builder based on promptType
		if (promptType === "mention") {
			if (!agentSession) {
				throw new Error(
					"agentSession is required for mention-triggered prompts",
				);
			}
			return this.buildMentionPrompt(
				issue,
				agentSession,
				attachmentManifest,
				guidance,
			);
		}
		if (
			promptType === "label-based" ||
			promptType === "label-based-prompt-command"
		) {
			return this.promptBuilder.buildLabelBasedPrompt(
				issue,
				repositories,
				attachmentManifest,
				guidance,
				resolvedBaseBranches,
			);
		}
		// Fallback to standard issue context
		return this.promptBuilder.buildIssueContextPrompt(
			issue,
			repositories,
			undefined, // No new comment for initial prompt assembly
			attachmentManifest,
			guidance,
			resolvedBaseBranches,
			workspaceRepoPaths,
		);
	}

	/**
	 * Resolve the default runner type for SimpleRunner (classification) use.
	 * Uses config.defaultRunner if set, otherwise auto-detects from API keys,
	 * falling back to "claude".
	 */
	/**
	 * Build agent runner configuration with common settings.
	 * Delegates to RunnerConfigBuilder for shared config assembly.
	 * @returns Object containing the runner config and runner type to use
	 */
	private async buildAgentRunnerConfig(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		systemPrompt: string | undefined,
		allowedTools: string[],
		allowedDirectories: string[],
		disallowedTools: string[],
		resumeSessionId?: string,
		labels?: string[],
		issueDescription?: string,
		maxTurns?: number,
		linearWorkspaceId?: string,
		skillContext?: SkillSessionContext,
		/**
		 * Which platform initiated the session — drives which
		 * `EdgeWorkerConfig.<platform>McpConfigs` override list applies.
		 * Defaults to `"linear"` (the pre-platform-aware behavior).
		 */
		sessionPlatform: "linear" | "github" | "gitlab" = "linear",
	): Promise<{ config: AgentRunnerConfig; runnerType: RunnerType }> {
		const log = this.logger.withContext({
			sessionId,
			platform: session.issueContext?.trackerId,
			issueIdentifier: session.issueContext?.issueIdentifier,
		});

		// Resolve plugins once so we can also derive the per-session scoped
		// skill allow-list from the same filesystem snapshot.
		const plugins = await this.skillsPluginResolver.resolve();
		const resolvedSkillContext: SkillSessionContext = skillContext ?? {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		const allowedSkillNames =
			await this.skillsPluginResolver.discoverSkillNames(
				plugins,
				resolvedSkillContext,
			);
		const sessionTempDir = getSessionTempDir(this.cyrusHome, sessionId);
		session.metadata = {
			...session.metadata,
			sessionTempDir,
		};
		const runnerAllowedDirectories = [
			...new Set([...allowedDirectories, sessionTempDir]),
		];

		const result = this.runnerConfigBuilder.buildIssueConfig({
			session,
			repository,
			sessionId,
			systemPrompt,
			allowedTools,
			allowedDirectories: runnerAllowedDirectories,
			disallowedTools,
			resumeSessionId,
			labels,
			issueDescription,
			maxTurns,
			// Per-platform MCP config paths — GitHub + GitLab share the
			// `githubMcpConfigs` knob (single-repo PR contexts both); Linear
			// gets `linearMcpConfigs`. Not a blanket override: the builder
			// uses `repository.mcpConfigPath` when this repo has its own
			// `allowedTools` override (so the repo's permission rules and
			// MCP server set travel as a unit), and only falls through to
			// this list when the repo inherits the platform allow-list.
			platformMcpConfigOverrides:
				sessionPlatform === "linear"
					? this.config.linearMcpConfigs
					: this.config.githubMcpConfigs,
			linearWorkspaceId,
			sessionTempDir,
			cyrusHome: this.cyrusHome,
			logger: log,
			plugins,
			skills: allowedSkillNames,
			sandboxSettings: this.sdkSandboxSettings ?? undefined,
			egressCaCertPath: this.egressCaCertPath ?? undefined,
			onMessage: (message: SDKMessage) => {
				this.handleClaudeMessage(sessionId, message, repository.id);
			},
			onError: (error: Error) => this.handleClaudeError(error),
			createAskUserQuestionCallback: (sid, wid) =>
				this.createAskUserQuestionCallback(sid, wid)!,
			requireLinearWorkspaceId,
		});

		// Attach pre-warmed session if available (only for Claude runner).
		// Skipped entirely when warm sessions are not enabled.
		if (result.runnerType === "claude" && this.isWarmSessionsEnabled()) {
			const warmSession = this.warmInstances.get(sessionId);
			if (warmSession) {
				this.warmInstances.delete(sessionId);
				(
					result.config as AgentRunnerConfig & { warmSession?: WarmQuery }
				).warmSession = warmSession;
				log.debug("Attaching pre-warmed session to runner config");
			}
		}

		return result;
	}

	/**
	 * Create an onAskUserQuestion callback for the ClaudeRunner.
	 * This callback delegates to the AskUserQuestionHandler which posts
	 * elicitations to Linear and waits for user responses.
	 *
	 * @param linearAgentSessionId - Linear agent session ID for tracking
	 * @param organizationId - Linear organization/workspace ID
	 */
	private createAskUserQuestionCallback(
		linearAgentSessionId: string,
		organizationId: string,
	): AgentRunnerConfig["onAskUserQuestion"] {
		return async (input, _sessionId, signal) => {
			// Note: We use linearAgentSessionId (from closure) instead of the passed sessionId
			// because the passed sessionId is the Claude session ID, not the Linear agent session ID
			return this.askUserQuestionHandler.handleAskUserQuestion(
				input,
				linearAgentSessionId,
				organizationId,
				signal,
			);
		};
	}

	/**
	 * Build disallowed tools list following the same hierarchy as allowed tools.
	 * Accepts single or multiple repositories (intersection for multi-repo).
	 */
	private buildDisallowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildDisallowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Build allowed tools list with Linear MCP tools automatically included.
	 * Accepts single or multiple repositories (union for multi-repo).
	 */
	private buildAllowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildAllowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Get Agent Sessions for an issue
	 */
	public getAgentSessionsForIssue(
		issueId: string,
		_repositoryId: string,
	): any[] {
		return this.agentSessionManager.getSessionsByIssueId(issueId);
	}

	// ========================================================================
	// User Access Control
	// ========================================================================

	/**
	 * Check if the user who triggered the webhook is allowed to interact.
	 * @param webhook The webhook containing user information
	 * @param repository The repository configuration
	 * @returns Access check result with allowed status and user name
	 */
	private checkUserAccess(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
	): { allowed: true } | { allowed: false; reason: string; userName: string } {
		const creator = webhook.agentSession.creator;
		const userId = creator?.id;
		const userEmail = creator?.email;
		const userName = creator?.name || userId || "Unknown";

		const result = this.userAccessControl.checkAccess(
			userId,
			userEmail,
			repository.id,
		);

		if (!result.allowed) {
			return { allowed: false, reason: result.reason, userName };
		}
		return { allowed: true };
	}

	/**
	 * Handle blocked user according to configured behavior.
	 * Posts a response activity to end the session.
	 * @param webhook The webhook that triggered the blocked access
	 * @param repository The repository configuration
	 * @param _reason The reason for blocking (for logging)
	 */
	private async handleBlockedUser(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
		_reason: string,
	): Promise<void> {
		// Use organizationId from webhook as the Linear-native workspace ID source
		const issueTracker = this.issueTrackers.get(webhook.organizationId);
		const agentSessionId = webhook.agentSession.id;
		const behavior = this.userAccessControl.getBlockBehavior(repository.id);

		if (!issueTracker) {
			return;
		}

		if (behavior === "comment") {
			// Get user info for templating
			const creator = webhook.agentSession.creator;
			const userName = creator?.name || "User";
			const userId = creator?.id || "";

			// Get the message template and replace variables
			// Supported variables:
			// - {{userName}} - The user's display name
			// - {{userId}} - The user's Linear ID
			let message = this.userAccessControl.getBlockMessage(repository.id);
			message = message
				.replace(/\{\{userName\}\}/g, userName)
				.replace(/\{\{userId\}\}/g, userId);

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId,
					content: { type: "response", body: message },
				},
				"blocked user message",
			);
		}
		// For "silent" behavior, we don't post any activity.
		// The session will remain in "Working" state until manually stopped or timed out.
	}

	/**
	 * Load persisted EdgeWorker state for all repositories
	 */
	private async loadPersistedState(): Promise<void> {
		try {
			const state = await this.persistenceManager.loadEdgeWorkerState();
			if (state) {
				this.restoreMappings(state);
				this.logger.debug(
					`✅ Loaded persisted EdgeWorker state with ${Object.keys(state.agentSessions || {}).length} sessions`,
				);
			}
		} catch (error) {
			this.logger.error(`Failed to load persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Whether the warm-session feature is enabled.
	 *
	 * Warm sessions are an opt-in optimization that pre-spawns Claude Code
	 * subprocesses on startup so the first query after a restart skips the
	 * cold-start cost. Disabled by default; opt in by setting
	 * `CYRUS_ENABLE_WARM_SESSIONS=1` (or `=true`).
	 */
	private isWarmSessionsEnabled(): boolean {
		const raw = process.env.CYRUS_ENABLE_WARM_SESSIONS;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Whether the remote Claude session store is explicitly disabled.
	 *
	 * The remote store mirrors SDK transcripts to the Cyrus hosted control
	 * plane and is on by default whenever `CYRUS_APP_URL`, `CYRUS_API_KEY`,
	 * and `CYRUS_TEAM_ID` are all set. Operators can opt out — without
	 * unsetting those vars (which other features depend on) — by setting
	 * `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` (or `=true`).
	 */
	private isRemoteSessionStoreDisabled(): boolean {
		const raw = process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Pre-warm the N most recently updated Claude sessions so the first query
	 * after a CLI restart has near-zero cold-start latency (~20x faster).
	 *
	 * Uses startup() from @anthropic-ai/claude-agent-sdk with MCP_CONNECTION_NONBLOCKING=true
	 * so the warm instances are ready in ~500ms rather than ~4s.
	 * Warm instances are stored in this.warmInstances keyed by agentSessionId and
	 * consumed by buildAgentRunnerConfig() when the first message arrives.
	 *
	 * Gated by `isWarmSessionsEnabled()` — callers should check before invoking.
	 */
	private async warmupRecentSessions(count = 30): Promise<void> {
		const allSessions = this.agentSessionManager.getAllSessions();

		// Only warm Claude sessions that have a persisted session ID and a workspace path
		const candidates = allSessions
			.filter((s) => s.claudeSessionId && s.workspace?.path)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, count);

		if (candidates.length === 0) {
			this.logger.debug("No Claude sessions to pre-warm");
			return;
		}

		this.logger.info(
			`Pre-warming ${candidates.length} most recent Claude sessions...`,
		);

		const { startup } = await import("@anthropic-ai/claude-agent-sdk");

		await Promise.all(
			candidates.map(async (session) => {
				try {
					const repoId = this.sessionRepositories.get(session.id);
					const repo = repoId ? this.repositories.get(repoId) : undefined;
					if (!repo) {
						this.logger.debug(
							`No repo for session ${session.id}, skipping warmup`,
						);
						return;
					}

					// Build MCP config for this session (same as the live runner would use)
					const linearWorkspaceId = requireLinearWorkspaceId(repo);
					const mcpConfig = this.mcpConfigService.buildMcpConfig(
						repo.id,
						linearWorkspaceId,
						session.id,
					);

					// Merge any file-based MCP configs (reuses shared normalization).
					// Warmup paths reconstruct Linear-triggered issue sessions:
					// if the repo has its own `allowedTools` override its
					// mcpConfigPath stays scoped to that repo, otherwise the
					// team-level `linearMcpConfigs` list applies. Same coupling
					// the live `buildIssueConfig` path uses.
					const mcpConfigPath = resolveIssueMcpConfigPath(
						repo,
						this.config.linearMcpConfigs,
						this.mcpConfigService.buildMergedMcpConfigPath.bind(
							this.mcpConfigService,
						),
					);
					let mcpServers: Record<string, McpServerConfig> = { ...mcpConfig };
					if (mcpConfigPath) {
						const paths = Array.isArray(mcpConfigPath)
							? mcpConfigPath
							: [mcpConfigPath];
						for (const filePath of paths) {
							try {
								if (existsSync(filePath)) {
									const fileContent = JSON.parse(
										readFileSync(filePath, "utf8"),
									);
									const servers = fileContent.mcpServers || {};
									normalizeMcpHttpTransport(servers);
									mcpServers = { ...mcpServers, ...servers };
								}
							} catch {
								// Ignore unreadable MCP config files
							}
						}
					}

					const repoConfig = repo as unknown as Record<string, unknown>;
					const model =
						(session.metadata?.model as string | undefined) ||
						(repoConfig.claudeDefaultModel as string | undefined) ||
						(repoConfig.model as string | undefined) ||
						"claude-opus-4-6";

					// Build allowed/disallowed tools — same as what buildAgentRunnerConfig() uses.
					// Without these, startup() inherits the user's defaultMode ("default"),
					// which causes macOS permission prompts for file writes.
					const allowedTools = this.buildAllowedTools(repo);
					const disallowedTools = this.buildDisallowedTools(repo);

					const warm = await startup({
						options: {
							resume: session.claudeSessionId,
							model,
							cwd: session.workspace.path,
							...(Object.keys(mcpServers).length > 0 && { mcpServers }),
							...(allowedTools.length > 0 && { allowedTools }),
							...(disallowedTools.length > 0 && { disallowedTools }),
							settingSources: ["user", "project", "local"],
							// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not set here;
							// see CYPACK-1108 and ClaudeRunner.start() for context.
							env: buildBaseSessionEnv(),
						},
					});

					this.warmInstances.set(session.id, warm);
					this.logger.info(
						`Pre-warmed session ${session.id} (${session.issueContext?.issueIdentifier ?? "unknown"})`,
					);
				} catch (err) {
					this.logger.debug(`Failed to pre-warm session ${session.id}:`, err);
				}
			}),
		);

		this.logger.info(
			`Session pre-warm complete: ${this.warmInstances.size} sessions ready`,
		);
	}

	/**
	 * Save current EdgeWorker state for all repositories
	 */
	private async savePersistedState(): Promise<void> {
		try {
			const state = this.serializeMappings();
			await this.persistenceManager.saveEdgeWorkerState(state);
			this.logger.debug(
				`✅ Saved EdgeWorker state for ${Object.keys(state.agentSessions || {}).length} sessions`,
			);
		} catch (error) {
			this.logger.error(`Failed to save persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Serialize EdgeWorker mappings to a serializable format (v4.0 flat format)
	 */
	public serializeMappings(): SerializableEdgeWorkerState {
		// Serialize Agent Session state - flat structure from single ASM
		const serializedState = this.agentSessionManager.serializeState();

		// Serialize child to parent agent session mapping from GlobalSessionRegistry
		const registryState = this.globalSessionRegistry.serializeState();
		const childToParentAgentSession = registryState.childToParentMap;

		// Serialize issue to repository cache from RepositoryRouter
		const issueRepositoryCache = Object.fromEntries(
			this.repositoryRouter.getIssueRepositoryCache().entries(),
		);

		return {
			agentSessions: serializedState.sessions,
			agentSessionEntries: serializedState.entries,
			childToParentAgentSession,
			issueRepositoryCache,
		};
	}

	/**
	 * Restore EdgeWorker mappings from serialized state (v4.0 flat format)
	 */
	public restoreMappings(state: SerializableEdgeWorkerState): void {
		// Restore Agent Session state from flat format
		if (state.agentSessions && state.agentSessionEntries) {
			this.agentSessionManager.restoreState(
				state.agentSessions,
				state.agentSessionEntries,
			);

			// Rebuild session-to-repo mapping from issueRepositoryCache
			// For each restored session, look up its issue in the cache to find the repo
			if (state.issueRepositoryCache) {
				for (const [sessionId, session] of Object.entries(
					state.agentSessions,
				)) {
					const issueId =
						(session as any).issueContext?.issueId ?? (session as any).issueId;
					if (issueId && state.issueRepositoryCache[issueId]) {
						const cachedRepoIds = state.issueRepositoryCache[issueId];
						// Use first repo ID for session-to-repo mapping (primary repo)
						const repoId = cachedRepoIds[0];
						if (repoId) {
							this.sessionRepositories.set(sessionId, repoId);
							// Also register the activity sink for this restored session
							const activitySink = this.getActivitySinkForRepo(repoId);
							if (activitySink) {
								this.agentSessionManager.setActivitySink(
									sessionId,
									activitySink,
								);
							}
						}
					}
				}
			}

			this.logger.debug(
				`Restored ${Object.keys(state.agentSessions).length} sessions`,
			);
		}

		// Restore child to parent agent session mapping into GlobalSessionRegistry
		if (state.childToParentAgentSession) {
			const entries = Object.entries(state.childToParentAgentSession);
			for (const [childId, parentId] of entries) {
				this.globalSessionRegistry.setParentSession(childId, parentId);
			}
			this.logger.debug(
				`Restored ${entries.length} child-to-parent agent session mappings`,
			);
		}

		// Restore issue to repository cache in RepositoryRouter
		// Handles migration from old Record<string, string> to Record<string, string[]>
		if (state.issueRepositoryCache) {
			const cache = new Map(
				Object.entries(state.issueRepositoryCache) as [
					string,
					string | string[],
				][],
			);
			this.repositoryRouter.restoreIssueRepositoryCache(cache);
			this.logger.debug(
				`Restored ${cache.size} issue-to-repository cache mappings`,
			);
		}
	}

	/**
	 * Post an activity directly via an issue tracker instance.
	 * Consolidates try/catch and success/error logging for EdgeWorker call sites
	 * that already have the issueTracker and agentSessionId resolved.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
	): Promise<string | null> {
		return this.activityPoster.postActivityDirect(issueTracker, input, label);
	}

	/**
	 * Post instant acknowledgment thought when agent session is created
	 */
	private async postInstantAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postInstantAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Post parent resume acknowledgment thought when parent session is resumed from child
	 */
	private async postParentResumeAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postParentResumeAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Post combined routing activity showing repos selected + base branches resolved
	 */
	private async postRoutingActivity(
		sessionId: string,
		linearWorkspaceId: string,
		repoLines: string[],
		routingMethod?: string,
	): Promise<void> {
		return this.activityPoster.postRoutingActivity(
			sessionId,
			linearWorkspaceId,
			repoLines,
			routingMethod,
		);
	}

	/**
	 * Handle prompt with streaming check - centralized logic for all input types
	 *
	 * This method implements the unified pattern for handling prompts:
	 * 1. Check if runner is actively streaming
	 * 2. Add to stream if streaming, OR resume session if not
	 *
	 * @param session The Cyrus agent session
	 * @param repository Repository configuration
	 * @param sessionId Linear agent activity session ID
	 * @param agentSessionManager Agent session manager instance
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param isNewSession Whether this is a new session
	 * @param additionalAllowedDirs Additional directories to allow access to
	 * @param logContext Context string for logging (e.g., "prompted webhook", "parent resume")
	 * @returns true if message was added to stream, false if session was resumed
	 */
	private async handlePromptWithStreamingCheck(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string,
		isNewSession: boolean,
		additionalAllowedDirs: string[],
		logContext: string,
		linearWorkspaceId: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<boolean> {
		const log = this.logger.withContext({ sessionId });
		const existingRunner = session.agentRunner;

		// Handle running case - add message to existing stream (if supported)
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			log.debug(
				`Adding prompt to existing stream for ${sessionId} (${logContext})`,
			);

			// Append attachment manifest to the prompt if we have one
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}

			// `addStreamMessage` can reject the message if the turn ended in the
			// race window between "still running" and "turn finished" (e.g. the
			// Codex app-server backend, which only steers an active turn). Fall
			// through to the resume path so the comment is never dropped. Claude's
			// streaming input never throws here, so this is a no-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return true; // Message added to stream
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume (${logContext})`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Not streaming (or streaming was rejected) - resume/start session
		log.debug(`Resuming Claude session for ${sessionId} (${logContext})`);

		await this.resumeAgentSession(
			session,
			repository,
			sessionId,
			agentSessionManager,
			promptBody,
			attachmentManifest,
			isNewSession,
			additionalAllowedDirs,
			linearWorkspaceId,
			undefined, // maxTurns
			commentAuthor,
			commentTimestamp,
		);

		return false; // Session was resumed
	}

	/**
	 * Post thought about system prompt selection based on labels
	 */
	private async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		linearWorkspaceId: string,
		repositoryId: string,
	): Promise<void> {
		return this.activityPoster.postSystemPromptSelectionThought(
			sessionId,
			labels,
			linearWorkspaceId,
			repositoryId,
		);
	}

	/**
	 * Resume or create an Agent session with the given prompt
	 * This is the core logic for handling prompted agent activities
	 * @param session The Cyrus agent session
	 * @param repository The repository configuration
	 * @param sessionId The Linear agent session ID
	 * @param agentSessionManager The agent session manager
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest
	 * @param isNewSession Whether this is a new session
	 */
	async resumeAgentSession(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string = "",
		isNewSession: boolean = false,
		additionalAllowedDirectories: string[] = [],
		linearWorkspaceId?: string,
		maxTurns?: number,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId });
		// Check for existing runner
		const existingRunner = session.agentRunner;

		// If there's an existing running runner that supports streaming, add to it
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}
			// See handlePromptWithStreamingCheck: a steer-only backend can reject
			// the message if the turn just ended. Fall through to a fresh resume
			// turn rather than dropping the comment. No-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return;
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Stop existing runner if it's not running
		if (existingRunner) {
			existingRunner.stop();
		}

		// Get issueId from issueContext (preferred) or deprecated issueId field
		const issueIdForResume = session.issueContext?.issueId ?? session.issueId;
		if (!issueIdForResume) {
			log.error(`No issue ID found for session ${session.id}`);
			throw new Error(`No issue ID found for session ${session.id}`);
		}

		// Fetch full issue details using workspace ID (from webhook context or repo fallback)
		const resolvedWorkspaceId =
			linearWorkspaceId ?? requireLinearWorkspaceId(repository);
		const fullIssue = await this.fetchFullIssueDetails(
			issueIdForResume,
			resolvedWorkspaceId,
		);
		if (!fullIssue) {
			log.error(`Failed to fetch full issue details for ${issueIdForResume}`);
			throw new Error(
				`Failed to fetch full issue details for ${issueIdForResume}`,
			);
		}

		// Fetch issue labels early to determine runner type
		const labels = await this.fetchIssueLabels(fullIssue);

		// Determine which runner to use based on existing session IDs
		const hasClaudeSession = !isNewSession && Boolean(session.claudeSessionId);
		const hasGeminiSession = !isNewSession && Boolean(session.geminiSessionId);
		const hasCodexSession = !isNewSession && Boolean(session.codexSessionId);
		const hasCursorSession = !isNewSession && Boolean(session.cursorSessionId);
		const needsNewSession =
			isNewSession ||
			(!hasClaudeSession &&
				!hasGeminiSession &&
				!hasCodexSession &&
				!hasCursorSession);

		// Fetch system prompt based on labels

		const systemPromptResult = await this.determineSystemPromptFromLabels(
			labels,
			repository,
		);
		const systemPrompt = systemPromptResult?.prompt;
		const promptType = systemPromptResult?.type;

		// Build allowed and disallowed tools lists
		const allowedTools = this.buildAllowedTools(repository, promptType);
		const disallowedTools = this.buildDisallowedTools(repository, promptType);

		// Set up attachments directory
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = join(
			this.cyrusHome,
			workspaceFolderName,
			"attachments",
		);
		await mkdir(attachmentsDir, { recursive: true });

		const allowedDirectories = [
			...new Set([
				attachmentsDir,
				repository.repositoryPath,
				...additionalAllowedDirectories,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(
					session.workspace,
				),
			]),
		];

		const resumeSessionId = needsNewSession
			? undefined
			: session.claudeSessionId
				? session.claudeSessionId
				: session.geminiSessionId
					? session.geminiSessionId
					: session.codexSessionId
						? session.codexSessionId
						: session.cursorSessionId;

		console.log(
			`[resumeAgentSession] needsNewSession=${needsNewSession}, resumeSessionId=${resumeSessionId ?? "none"}`,
		);

		// Create runner configuration
		// buildAgentRunnerConfig determines runner type from labels for new sessions
		// For existing sessions, we still need labels for model override but ignore runner type
		const { config: runnerConfig, runnerType } =
			await this.buildAgentRunnerConfig(
				session,
				repository,
				sessionId,
				systemPrompt,
				allowedTools,
				allowedDirectories,
				disallowedTools,
				resumeSessionId,
				labels, // Always pass labels to preserve model override
				fullIssue.description || undefined, // Description tags can override label selectors
				maxTurns, // Pass maxTurns if specified
				resolvedWorkspaceId,
				this.buildSkillSessionContext(repository, fullIssue, session),
			);

		// Create the appropriate runner based on session state
		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store runner
		agentSessionManager.addAgentRunner(sessionId, runner);

		// Save state
		await this.savePersistedState();

		// Prepare the full prompt
		const fullPrompt = await this.buildSessionPrompt(
			isNewSession,
			session,
			fullIssue,
			repository,
			promptBody,
			attachmentManifest,
			commentAuthor,
			commentTimestamp,
		);

		// Start session - use streaming mode if supported for ability to add messages later
		try {
			if (runner.supportsStreamingInput && runner.startStreaming) {
				await runner.startStreaming(fullPrompt);
			} else {
				await runner.start(fullPrompt);
			}
		} catch (error) {
			log.error(`Failed to start streaming session for ${sessionId}:`, error);
			throw error;
		}
	}

	/**
	 * Post instant acknowledgment thought when receiving prompted webhook
	 */
	private async postInstantPromptedAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		return this.activityPoster.postInstantPromptedAcknowledgment(
			sessionId,
			linearWorkspaceId,
			isStreaming,
		);
	}

	/**
	 * Get the platform type for a workspace's issue tracker.
	 */
	private getRepositoryPlatform(linearWorkspaceId: string): string | undefined {
		try {
			return this.issueTrackers.get(linearWorkspaceId)?.getPlatformType();
		} catch {
			return undefined;
		}
	}

	/**
	 * Fetch complete issue details from Linear API
	 */
	public async fetchFullIssueDetails(
		issueId: string,
		linearWorkspaceId: string,
	): Promise<Issue | null> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.warn(
				`No issue tracker found for workspace ${linearWorkspaceId}`,
			);
			return null;
		}

		try {
			this.logger.debug(`Fetching full issue details for ${issueId}`);
			const fullIssue = await issueTracker.fetchIssue(issueId);
			this.logger.debug(`Successfully fetched issue details for ${issueId}`);

			// Check if issue has a parent
			try {
				const parent = await fullIssue.parent;
				if (parent) {
					this.logger.debug(
						`Issue ${issueId} has parent: ${parent.identifier}`,
					);
				}
			} catch (_error) {
				// Parent field might not exist, ignore error
			}

			return fullIssue;
		} catch (error) {
			this.logger.error(`Failed to fetch issue details for ${issueId}:`, error);
			return null;
		}
	}

	// ========================================================================
	// OAuth Token Refresh
	// ========================================================================

	/**
	 * Build OAuth config for LinearIssueTrackerService.
	 * Uses workspace-level token storage.
	 * Returns undefined if OAuth credentials are not available.
	 */
	private buildOAuthConfig(
		linearWorkspaceId: string,
	): LinearOAuthConfig | undefined {
		const clientId = process.env.LINEAR_CLIENT_ID;
		const clientSecret = process.env.LINEAR_CLIENT_SECRET;

		if (!clientId || !clientSecret) {
			this.logger.warn(
				"LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET not set, token refresh disabled",
			);
			return undefined;
		}

		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig?.linearRefreshToken) {
			this.logger.warn(
				`No refresh token for workspace ${linearWorkspaceId}, token refresh disabled`,
			);
			return undefined;
		}

		// Get workspace name from workspace-level config
		const workspaceName =
			this.config.linearWorkspaces?.[linearWorkspaceId]?.linearWorkspaceName ||
			linearWorkspaceId;

		return {
			clientId,
			clientSecret,
			refreshToken: workspaceConfig.linearRefreshToken,
			workspaceId: linearWorkspaceId,
			onTokenRefresh: async (tokens) => {
				// Update workspace config in memory
				if (this.config.linearWorkspaces?.[linearWorkspaceId]) {
					this.config.linearWorkspaces[linearWorkspaceId].linearToken =
						tokens.accessToken;
					this.config.linearWorkspaces[linearWorkspaceId].linearRefreshToken =
						tokens.refreshToken;
				}

				// Persist tokens to config.json
				await this.saveOAuthTokens({
					linearToken: tokens.accessToken,
					linearRefreshToken: tokens.refreshToken,
					linearWorkspaceId: linearWorkspaceId,
					linearWorkspaceName: workspaceName,
				});
			},
		};
	}

	/**
	 * Save OAuth tokens to config.json (workspace-level storage)
	 */
	private async saveOAuthTokens(tokens: {
		linearToken: string;
		linearRefreshToken?: string;
		linearWorkspaceId: string;
		linearWorkspaceName?: string;
	}): Promise<void> {
		if (!this.configPath) {
			this.logger.warn("No config path set, cannot save OAuth tokens");
			return;
		}

		try {
			const configContent = await readFile(this.configPath, "utf-8");
			const config = JSON.parse(configContent);

			// Ensure linearWorkspaces exists
			if (!config.linearWorkspaces) {
				config.linearWorkspaces = {};
			}

			// Update workspace-level token storage
			config.linearWorkspaces[tokens.linearWorkspaceId] = {
				linearToken: tokens.linearToken,
				...(tokens.linearRefreshToken
					? { linearRefreshToken: tokens.linearRefreshToken }
					: config.linearWorkspaces[tokens.linearWorkspaceId]
								?.linearRefreshToken
						? {
								linearRefreshToken:
									config.linearWorkspaces[tokens.linearWorkspaceId]
										.linearRefreshToken,
							}
						: {}),
				...(tokens.linearWorkspaceName
					? { linearWorkspaceName: tokens.linearWorkspaceName }
					: config.linearWorkspaces[tokens.linearWorkspaceId]
								?.linearWorkspaceName
						? {
								linearWorkspaceName:
									config.linearWorkspaces[tokens.linearWorkspaceId]
										.linearWorkspaceName,
							}
						: {}),
			};

			await writeFile(this.configPath, JSON.stringify(config, null, "\t"));
			this.logger.debug(
				`OAuth tokens saved to config for workspace ${tokens.linearWorkspaceId}`,
			);
		} catch (error) {
			this.logger.error("Failed to save OAuth tokens:", error);
		}
	}
}
