import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	APIAssistantMessage,
	APIUserMessage,
	SDKAssistantMessage,
	SDKMessage,
	SDKRateLimitEvent,
	SDKResultMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "cyrus-claude-runner";
import {
	type AgentPendingWork,
	AgentSessionStatus,
	AgentSessionType,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	createLogger,
	type IAgentRunner,
	type ILogger,
	type IssueMinimal,
	type RepositoryContext,
	type SerializedCyrusAgentSession,
	type SerializedCyrusAgentSessionEntry,
	type Workspace,
} from "cyrus-core";

import {
	formatPendingWorkThought,
	formatScheduleWakeupResponse,
	tryParseScheduleWakeupInput,
} from "./PendingWorkFormatter.js";
import type {
	ActivityPostOptions,
	ActivitySignal,
	IActivitySink,
} from "./sinks/index.js";

const execFileAsync = promisify(execFile);
const AUTO_PR_MAX_BUFFER = 10 * 1024 * 1024;
const PR_SCREENSHOT_COMMENT_MARKER = "<!-- cyrus-frontend-screenshots -->";
const MAX_FRONTEND_SCREENSHOTS = 6;
const MAX_SCREENSHOT_SIZE_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_SCAN_MAX_FILES = 5000;
const SCREENSHOT_SCAN_MAX_DEPTH = 8;
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKIPPED_SCREENSHOT_DIRS = new Set([
	".git",
	".next",
	".turbo",
	"build",
	"dist",
	"node_modules",
	"out",
]);

/**
 * Events emitted by AgentSessionManager
 */
// biome-ignore lint/complexity/noBannedTypes: Empty events type (events removed in CYPACK-996 skill refactor)
export type AgentSessionManagerEvents = {};

type OperationalAlertHandler = (alert: {
	key: string;
	severity: "info" | "warning" | "error";
	title: string;
	message: string;
}) => void | Promise<void>;

type PullRequestInfo = {
	url?: string;
	isDraft?: boolean;
	title?: string;
	body?: string;
	baseRefName?: string;
	headRefName?: string;
};

type ScreenshotCandidate = {
	path: string;
	filename: string;
	contentType: string;
	size: number;
	mtimeMs: number;
	source: "tool" | "scan";
};

/**
 * Type-safe event emitter interface for AgentSessionManager
 */
export declare interface AgentSessionManager {
	on<K extends keyof AgentSessionManagerEvents>(
		event: K,
		listener: AgentSessionManagerEvents[K],
	): this;
	emit<K extends keyof AgentSessionManagerEvents>(
		event: K,
		...args: Parameters<AgentSessionManagerEvents[K]>
	): boolean;
}

/**
 * Manages Agent Sessions integration with Claude Code SDK
 * Transforms Claude streaming messages into Agent Session format
 * Handles session lifecycle: create → active → complete/error
 *
 * Single instance shared across all repositories. Activity sinks are
 * registered per-session so each session posts to the correct tracker.
 */
export class AgentSessionManager extends EventEmitter {
	private logger: ILogger;
	private activitySinks: Map<string, IActivitySink> = new Map(); // Per-session activity sinks
	private sessions: Map<string, CyrusAgentSession> = new Map();
	private entries: Map<string, CyrusAgentSessionEntry[]> = new Map(); // Stores a list of session entries per each session by its id
	private activeTasksBySession: Map<string, string> = new Map(); // Maps session ID to active Task tool use ID
	private toolCallsByToolUseId: Map<string, { name: string; input: any }> =
		new Map(); // Track tool calls by their tool_use_id
	private lastAssistantBodyBySession: Map<string, string> = new Map(); // Buffer: last assistant text per session for posting as response on result
	private lastAssistantBodyIsToolInputBySession: Map<string, boolean> =
		new Map(); // Whether the buffered body above is a tool_use input JSON (no trailing assistant text) — guards against posting raw JSON as the "response" (CYPACK-1177)
	private bufferedAssistantEntryBySession: Map<string, CyrusAgentSessionEntry> =
		new Map(); // One-behind buffer: holds last assistant entry until next message or result
	private screenshotPathsBySession: Map<string, Set<string>> = new Map(); // Screenshot file paths observed from browser/screenshot tool calls
	private taskSubjectsByToolUseId: Map<string, string> = new Map(); // Cache TaskCreate subjects by toolUseId until result arrives with task ID
	private taskSubjectsById: Map<string, string> = new Map(); // Cache task subjects by task ID (e.g., "1" → "Fix login bug")
	private activeStatusActivitiesBySession: Map<string, string> = new Map(); // Maps session ID to active compacting status activity ID
	private stopRequestedSessions: Set<string> = new Set(); // Sessions explicitly stopped by user signal
	// Per-session serialization queue for handleClaudeMessage. The EdgeWorker's
	// onMessage callback is fire-and-forget, so without serialization the async
	// handlers can interleave — causing tool_result to be processed before its
	// matching tool_use registers in toolCallsByToolUseId (seen with parallel
	// deferred tools like ToolSearch, where a tool_use and its tool_result can
	// arrive back-to-back in the same microtask batch).
	private messageProcessingQueues: Map<string, Promise<void>> = new Map();
	private getParentSessionId?: (childSessionId: string) => string | undefined;
	private resumeParentSession?: (
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	) => Promise<void>;
	private operationalAlertHandler?: OperationalAlertHandler;

	constructor(
		getParentSessionId?: (childSessionId: string) => string | undefined,
		resumeParentSession?: (
			parentSessionId: string,
			prompt: string,
			childSessionId: string,
		) => Promise<void>,
		logger?: ILogger,
		operationalAlertHandler?: OperationalAlertHandler,
	) {
		super();
		this.logger = logger ?? createLogger({ component: "AgentSessionManager" });
		this.getParentSessionId = getParentSessionId;
		this.resumeParentSession = resumeParentSession;
		this.operationalAlertHandler = operationalAlertHandler;
	}

	/**
	 * Register an activity sink for a specific session.
	 * This associates the session with the correct issue tracker for activity posting.
	 */
	setActivitySink(sessionId: string, sink: IActivitySink): void {
		this.activitySinks.set(sessionId, sink);
	}

	/**
	 * Get the activity sink for a session.
	 */
	private getActivitySink(sessionId: string): IActivitySink | undefined {
		return this.activitySinks.get(sessionId);
	}

	/**
	 * Get a session-scoped logger with context (sessionId, platform, issueIdentifier).
	 */
	private sessionLog(sessionId: string): ILogger {
		const session = this.sessions.get(sessionId);
		return this.logger.withContext({
			sessionId,
			platform: session?.issueContext?.trackerId,
			issueIdentifier: session?.issueContext?.issueIdentifier,
		});
	}

	/**
	 * Initialize an agent session from webhook
	 * The session is already created by the platform, we just need to track it
	 *
	 * @param sessionId - Internal session ID
	 * @param issueId - Issue/PR identifier
	 * @param issueMinimal - Minimal issue data
	 * @param workspace - Workspace configuration
	 * @param platform - Source platform ("linear", "github", "gitlab", "slack"). Defaults to "linear".
	 *                   Only "linear" sessions will have activities streamed to Linear.
	 * @param repositories - Repository contexts for the session (defaults to empty array)
	 */
	createCyrusAgentSession(
		sessionId: string,
		issueId: string,
		issueMinimal: IssueMinimal,
		workspace: Workspace,
		platform: "linear" | "github" | "gitlab" | "slack" = "linear",
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({
			sessionId,
			platform,
			issueIdentifier: issueMinimal.identifier,
		});
		log.info(`Tracking session for issue ${issueId}`);

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			// Only Linear sessions have a valid external session ID for posting activities
			externalSessionId: platform === "linear" ? sessionId : undefined,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			issueContext: {
				trackerId: platform,
				issueId: issueId,
				issueIdentifier: issueMinimal.identifier,
			},
			issueId, // Kept for backwards compatibility
			issue: issueMinimal,
			repositories,
			workspace: workspace,
		};

		// Store locally
		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Create an agent session for chat-style platforms (Slack, etc.) that are
	 * not tied to a specific issue or repository.
	 *
	 * Unlike {@link createCyrusAgentSession}, this does NOT require issue
	 * context — the session lives in a standalone workspace with no issue
	 * tracker linkage.
	 *
	 * @param repositories - Repository contexts for the session (defaults to empty array for chatbot sessions)
	 */
	createChatSession(
		sessionId: string,
		workspace: Workspace,
		platform: string,
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({ sessionId, platform });
		log.info("Creating chat session");

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			repositories,
			workspace,
		};

		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Update Agent Session with session ID from system initialization
	 * Automatically detects whether it's Claude or Gemini based on the runner
	 */
	updateAgentSessionWithRunnerSessionId(
		sessionId: string,
		claudeSystemMessage: SDKSystemMessage,
	): void {
		const linearSession = this.sessions.get(sessionId);
		if (!linearSession) {
			const log = this.sessionLog(sessionId);
			log.warn(`No session found`);
			return;
		}

		// Determine which runner is being used
		const runner = linearSession.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// Update the appropriate session ID based on runner type
		if (runnerType === "gemini") {
			linearSession.geminiSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "codex") {
			linearSession.codexSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "cursor") {
			linearSession.cursorSessionId = claudeSystemMessage.session_id;
		} else {
			linearSession.claudeSessionId = claudeSystemMessage.session_id;
		}

		linearSession.updatedAt = Date.now();
		linearSession.metadata = {
			...linearSession.metadata, // Preserve existing metadata
			model: claudeSystemMessage.model,
			tools: claudeSystemMessage.tools,
			permissionMode: claudeSystemMessage.permissionMode,
			apiKeySource: claudeSystemMessage.apiKeySource,
		};
	}

	/**
	 * Create a session entry from user/assistant message (without syncing to Linear)
	 */
	private async createSessionEntry(
		sessionId: string,
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): Promise<CyrusAgentSessionEntry> {
		// Extract tool info if this is an assistant message
		const toolInfo =
			sdkMessage.type === "assistant" ? this.extractToolInfo(sdkMessage) : null;
		// Extract tool_use_id and error status if this is a user message with tool_result
		const toolResultInfo =
			sdkMessage.type === "user"
				? this.extractToolResultInfo(sdkMessage)
				: null;
		// Extract SDK error from assistant messages (e.g., rate_limit, billing_error)
		// SDKAssistantMessage has optional `error?: SDKAssistantMessageError` field
		// See: @anthropic-ai/claude-agent-sdk sdk.d.ts lines 1013-1022
		// Evidence from ~/.cyrus/logs/CYGROW-348 session jsonl shows assistant messages with
		// "error":"rate_limit" field when usage limits are hit
		const sdkError =
			sdkMessage.type === "assistant" ? sdkMessage.error : undefined;

		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		const sessionEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: sdkMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: sdkMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: sdkMessage.session_id }
						: { claudeSessionId: sdkMessage.session_id }),
			type: sdkMessage.type,
			content: this.extractContent(sdkMessage),
			metadata: {
				timestamp: Date.now(),
				parentToolUseId: sdkMessage.parent_tool_use_id || undefined,
				...(toolInfo && {
					toolUseId: toolInfo.id,
					toolName: toolInfo.name,
					toolInput: toolInfo.input,
				}),
				...(toolResultInfo && {
					toolUseId: toolResultInfo.toolUseId,
					toolResultError: toolResultInfo.isError,
				}),
				...(sdkError && { sdkError }),
			},
		};

		// DON'T store locally yet - wait until we actually post to Linear
		return sessionEntry;
	}

	/**
	 * Complete a session from Claude result message.
	 * Posts the final result to the issue tracker and handles child session completion.
	 */
	async completeSession(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			const log = this.sessionLog(sessionId);
			log.error(`No session found`);
			return;
		}

		const log = this.sessionLog(sessionId);

		// Clear any active Task when session completes
		this.activeTasksBySession.delete(sessionId);

		const wasStopRequested = this.consumeStopRequest(sessionId);
		const status = wasStopRequested
			? AgentSessionStatus.Error
			: resultMessage.subtype === "success"
				? AgentSessionStatus.Complete
				: AgentSessionStatus.Error;

		// Update session status and metadata
		await this.updateSessionStatus(sessionId, status, {
			totalCostUsd: resultMessage.total_cost_usd,
			usage: resultMessage.usage,
		});

		if (wasStopRequested) {
			log.info(`Session was stopped by user`);
			return;
		}

		const finalResultMessage =
			status === AgentSessionStatus.Complete
				? await this.ensurePullRequestForLinearCodeChanges(
						sessionId,
						resultMessage,
					)
				: resultMessage;

		// Post final result to issue tracker
		await this.addResultEntry(sessionId, finalResultMessage);

		// When the turn ended with work still scheduled or in flight
		// (ScheduleWakeup/cron timers, backgrounded tasks), the runner holds
		// its session open and the wakeup will stream new messages in later.
		// Post a thought AFTER the response so Linear's agent panel returns
		// to its working state and the user can see what the session is
		// waiting on.
		if (resultMessage.subtype === "success") {
			const pendingWork = this.getRunnerPendingWork(sessionId);
			if (pendingWork) {
				const thoughtBody = formatPendingWorkThought(pendingWork);
				if (thoughtBody) {
					await this.createThoughtActivity(sessionId, thoughtBody);
					log.info(
						`Posted pending-work thought (${pendingWork.sessionCrons.length} crons, ${pendingWork.backgroundTasks.length} background tasks)`,
					);
				}
			}
		}

		// Handle child session completion
		const parentSessionId = this.getParentSessionId?.(sessionId);
		if (parentSessionId && this.resumeParentSession) {
			await this.handleChildSessionCompletion(sessionId, finalResultMessage);
		}

		log.info(`Session completed (subtype: ${resultMessage.subtype})`);
	}

	/**
	 * Pending work (scheduled wakeups/crons, in-flight background tasks) for
	 * the session's runner, or null when the runner doesn't support pending
	 * work reporting or nothing is pending.
	 */
	private getRunnerPendingWork(sessionId: string): AgentPendingWork | null {
		const runner = this.sessions.get(sessionId)?.agentRunner;
		if (!runner?.getPendingWork) return null;
		const pendingWork = runner.getPendingWork();
		return pendingWork.sessionCrons.length > 0 ||
			pendingWork.backgroundTasks.length > 0
			? pendingWork
			: null;
	}

	private consumeStopRequest(linearAgentActivitySessionId: string): boolean {
		if (!this.stopRequestedSessions.has(linearAgentActivitySessionId)) {
			return false;
		}

		this.stopRequestedSessions.delete(linearAgentActivitySessionId);
		return true;
	}

	requestSessionStop(linearAgentActivitySessionId: string): void {
		this.stopRequestedSessions.add(linearAgentActivitySessionId);
	}

	private async ensurePullRequestForLinearCodeChanges(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<SDKResultMessage> {
		const session = this.sessions.get(sessionId);
		if (!session || session.issueContext?.trackerId !== "linear") {
			return resultMessage;
		}

		const repository = session.repositories[0];
		const repoDir = repository?.repositoryId
			? (session.workspace.repoPaths?.[repository.repositoryId] ??
				session.workspace.path)
			: session.workspace.path;
		const issueIdentifier =
			session.issueContext?.issueIdentifier ?? session.issue?.identifier;

		if (!repoDir || !issueIdentifier) {
			return resultMessage;
		}

		try {
			const gitStatus = await this.tryWorkspaceCommand(repoDir, "git", [
				"status",
				"--porcelain",
			]);
			if (!gitStatus) {
				return resultMessage;
			}

			if (gitStatus.stdout.trim()) {
				await this.runWorkspaceCommand(repoDir, "git", ["add", "-A"]);
				await this.unstageGeneratedScreenshotCandidates(repoDir, session);
				const stagedStatus = await this.runWorkspaceCommand(repoDir, "git", [
					"diff",
					"--cached",
					"--name-only",
				]);
				if (stagedStatus.stdout.trim()) {
					await this.runWorkspaceCommand(repoDir, "git", [
						"commit",
						"-m",
						this.buildAutoCommitMessage(session),
					]);
				}
			}

			const currentBranch = (
				await this.runWorkspaceCommand(repoDir, "git", [
					"branch",
					"--show-current",
				])
			).stdout.trim();
			if (!currentBranch) {
				return resultMessage;
			}

			const baseBranch = this.getSessionBaseBranch(session);
			if (currentBranch === baseBranch) {
				return resultMessage;
			}

			const baseRef = (await this.tryWorkspaceCommand(repoDir, "git", [
				"rev-parse",
				"--verify",
				baseBranch,
			]))
				? baseBranch
				: `origin/${baseBranch}`;
			const aheadCount = (
				await this.runWorkspaceCommand(repoDir, "git", [
					"rev-list",
					"--count",
					`${baseRef}..${currentBranch}`,
				])
			).stdout.trim();
			if (aheadCount === "0") {
				return resultMessage;
			}
			const changedFiles = await this.getChangedFilesForRefRange(
				repoDir,
				baseRef,
				currentBranch,
			);

			await this.runWorkspaceCommand(repoDir, "git", [
				"push",
				"-u",
				"origin",
				currentBranch,
			]);

			const existingPullRequest = await this.findExistingPullRequest(
				repoDir,
				currentBranch,
			);
			const pullRequestUrl =
				existingPullRequest?.url ??
				(await this.createPullRequest(
					repoDir,
					currentBranch,
					baseBranch,
					session,
					resultMessage,
				));
			await this.ensurePullRequestMeetsRequirements(repoDir, pullRequestUrl, {
				issueIdentifier,
				baseBranch,
				branch: currentBranch,
				session,
				resultMessage,
			});
			await this.requestConfiguredGitHubTeamReviews(
				repoDir,
				pullRequestUrl,
				session,
			);
			await this.publishFrontendScreenshotsForPullRequest(
				sessionId,
				repoDir,
				pullRequestUrl,
				{
					changedFiles,
					baseBranch,
					branch: currentBranch,
					resultMessage,
				},
			);

			return this.appendResultNote(resultMessage, pullRequestUrl);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.sessionLog(sessionId).error(
				`Failed to create or update pull request:`,
				error,
			);
			await this.postOperationalAlert({
				key: `linear-pr-automation-failed:${issueIdentifier}`,
				severity: "error",
				title: "Linear PR automation failed",
				message: `${issueIdentifier}: ${errorMessage}`,
			});
			return this.appendResultWarning(
				resultMessage,
				`PR automation failed: ${errorMessage}`,
			);
		}
	}

	private buildAutoCommitMessage(session: CyrusAgentSession): string {
		const issueIdentifier =
			session.issueContext?.issueIdentifier ?? session.issue?.identifier;
		const title = this.cleanPullRequestTitle(
			session.issue?.title ?? "Linear task changes",
		);
		return `fix: ${issueIdentifier ? `${issueIdentifier} ` : ""}${title}`;
	}

	private getSessionBaseBranch(session: CyrusAgentSession): string {
		const repository = session.repositories[0];
		if (repository?.baseBranchName) {
			return repository.baseBranchName;
		}

		if (repository?.repositoryId) {
			const resolved =
				session.workspace.resolvedBaseBranches?.[repository.repositoryId];
			if (resolved?.branch) {
				return resolved.branch;
			}
		}

		return "main";
	}

	private async findExistingPullRequest(
		repoDir: string,
		branch: string,
	): Promise<PullRequestInfo | undefined> {
		const result = await this.tryWorkspaceCommand(repoDir, "gh", [
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"url,isDraft,title,body,baseRefName,headRefName",
		]);
		if (!result) {
			return undefined;
		}

		const pullRequests = JSON.parse(result.stdout || "[]") as PullRequestInfo[];
		const pullRequest = pullRequests[0];
		if (!pullRequest?.url) {
			return undefined;
		}

		return pullRequest;
	}

	async publishFrontendScreenshotsForPullRequest(
		sessionId: string,
		repoDir: string,
		pullRequestRef: string,
		options: {
			changedFiles?: string[];
			baseBranch?: string;
			branch?: string;
			resultMessage?: SDKResultMessage;
		} = {},
	): Promise<string[]> {
		const session = this.sessions.get(sessionId);
		const log = this.sessionLog(sessionId);
		if (!session) {
			log.warn("Cannot publish frontend screenshots: no session found");
			return [];
		}

		try {
			const contextChangedFiles =
				options.changedFiles ??
				(await this.getChangedFilesForPullRequestContext(
					repoDir,
					session,
					options,
				));
			const changedFiles = contextChangedFiles.length
				? contextChangedFiles
				: await this.getChangedFilesFromPullRequest(repoDir, pullRequestRef);
			if (!this.isFrontendTask(session, changedFiles, options.resultMessage)) {
				return [];
			}

			const activitySink = this.getActivitySink(sessionId);
			if (!activitySink?.uploadFile) {
				log.info(
					"Skipping frontend screenshot PR comment: activity sink does not support file uploads",
				);
				return [];
			}

			const candidates = await this.collectScreenshotCandidates(session);
			if (!candidates.length) {
				log.info(
					"Frontend-like changes detected, but no screenshot artifacts were found",
				);
				return [];
			}

			if (
				await this.pullRequestAlreadyHasScreenshotComment(
					repoDir,
					pullRequestRef,
				)
			) {
				log.info("Skipping frontend screenshot PR comment: already posted");
				return [];
			}

			const uploadedScreenshots: Array<{ filename: string; assetUrl: string }> =
				[];
			for (const candidate of candidates) {
				try {
					const upload = await activitySink.uploadFile({
						filePath: candidate.path,
						filename: candidate.filename,
						contentType: candidate.contentType,
						makePublic: true,
					});
					if (upload.assetUrl) {
						uploadedScreenshots.push({
							filename: upload.filename,
							assetUrl: upload.assetUrl,
						});
					}
				} catch (error) {
					log.warn(
						`Failed to upload screenshot ${candidate.path}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}

			if (!uploadedScreenshots.length) {
				return [];
			}

			await this.runWorkspaceCommand(repoDir, "gh", [
				"pr",
				"comment",
				pullRequestRef,
				"--body",
				this.buildScreenshotComment(uploadedScreenshots),
			]);
			log.info(
				`Posted ${uploadedScreenshots.length} frontend screenshot(s) to ${pullRequestRef}`,
			);
			return uploadedScreenshots.map((screenshot) => screenshot.assetUrl);
		} catch (error) {
			log.warn(
				`Failed to publish frontend screenshots to PR: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return [];
		}
	}

	private async getChangedFilesForPullRequestContext(
		repoDir: string,
		session: CyrusAgentSession,
		options: { baseBranch?: string; branch?: string },
	): Promise<string[]> {
		const branch =
			options.branch ??
			(
				await this.runWorkspaceCommand(repoDir, "git", [
					"branch",
					"--show-current",
				])
			).stdout.trim();
		if (!branch) {
			return [];
		}

		const baseBranch = options.baseBranch ?? this.getSessionBaseBranch(session);
		const baseRef = (await this.tryWorkspaceCommand(repoDir, "git", [
			"rev-parse",
			"--verify",
			baseBranch,
		]))
			? baseBranch
			: `origin/${baseBranch}`;
		return await this.getChangedFilesForRefRange(repoDir, baseRef, branch);
	}

	private async getChangedFilesForRefRange(
		repoDir: string,
		baseRef: string,
		branch: string,
	): Promise<string[]> {
		const result = await this.tryWorkspaceCommand(repoDir, "git", [
			"diff",
			"--name-only",
			`${baseRef}..${branch}`,
		]);
		return (result?.stdout ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}

	private async getChangedFilesFromPullRequest(
		repoDir: string,
		pullRequestRef: string,
	): Promise<string[]> {
		const result = await this.tryWorkspaceCommand(repoDir, "gh", [
			"pr",
			"view",
			pullRequestRef,
			"--json",
			"files",
		]);
		if (!result) {
			return [];
		}

		const parsed = JSON.parse(result.stdout || "{}") as {
			files?: Array<{ path?: string; filename?: string; name?: string }>;
		};
		return (parsed.files ?? [])
			.map((file) => file.path ?? file.filename ?? file.name ?? "")
			.map((file) => file.trim())
			.filter(Boolean);
	}

	private async unstageGeneratedScreenshotCandidates(
		repoDir: string,
		session: CyrusAgentSession,
	): Promise<void> {
		const candidates = await this.collectScreenshotCandidates(session);
		for (const candidate of candidates) {
			const relativePath = this.getRepoRelativePath(repoDir, candidate.path);
			if (!relativePath) {
				continue;
			}
			await this.tryWorkspaceCommand(repoDir, "git", [
				"restore",
				"--staged",
				"--",
				relativePath,
			]);
		}
	}

	private getRepoRelativePath(
		repoDir: string,
		filePath: string,
	): string | undefined {
		const resolvedRepoDir = resolve(repoDir);
		const resolvedFilePath = resolve(filePath);
		const relativePath = relative(resolvedRepoDir, resolvedFilePath);
		if (
			!relativePath ||
			relativePath.startsWith("..") ||
			isAbsolute(relativePath)
		) {
			return undefined;
		}
		return relativePath;
	}

	private isFrontendTask(
		session: CyrusAgentSession,
		changedFiles: string[],
		resultMessage?: SDKResultMessage,
	): boolean {
		if (changedFiles.some((file) => this.isFrontendFile(file))) {
			return true;
		}

		const resultText =
			resultMessage &&
			"result" in resultMessage &&
			typeof resultMessage.result === "string"
				? resultMessage.result
				: "";
		const issueDescription =
			"description" in (session.issue ?? {})
				? String((session.issue as { description?: unknown }).description ?? "")
				: "";
		const text = [session.issue?.title, issueDescription, resultText]
			.filter(Boolean)
			.join("\n")
			.toLowerCase();

		return /\b(frontend|front-end|ui|ux|visual|style|css|scss|sass|tailwind|react|vue|svelte|component|modal|button|layout|responsive|mobile|desktop|browser|page|screen|view|form|dropdown|navbar|dashboard)\b/.test(
			text,
		);
	}

	private isFrontendFile(file: string): boolean {
		const normalized = file.replace(/\\/g, "/").toLowerCase();
		if (
			/\.(astro|css|html|jsx|less|scss|sass|svelte|tsx|vue)$/.test(normalized)
		) {
			return true;
		}
		return (
			normalized.startsWith("apps/app/") ||
			normalized.startsWith("apps/page-assets/") ||
			normalized.startsWith("client/") ||
			normalized.startsWith("frontend/") ||
			normalized.startsWith("web/") ||
			/(^|\/)(components|pages|screens|styles|ui|views)\//.test(normalized)
		);
	}

	private async collectScreenshotCandidates(
		session: CyrusAgentSession,
	): Promise<ScreenshotCandidate[]> {
		const workspacePath = session.workspace.path;
		const cutoffMs = Math.max(0, session.createdAt - 10 * 60 * 1000);
		const seen = new Set<string>();
		const candidates: ScreenshotCandidate[] = [];

		const addCandidate = async (
			filePath: string,
			source: ScreenshotCandidate["source"],
		): Promise<void> => {
			const resolvedPath = isAbsolute(filePath)
				? filePath
				: resolve(workspacePath, filePath);
			if (seen.has(resolvedPath)) {
				return;
			}
			const candidate = await this.toScreenshotCandidate(
				resolvedPath,
				source,
				cutoffMs,
			);
			if (!candidate) {
				return;
			}
			seen.add(resolvedPath);
			candidates.push(candidate);
		};

		const trackedPaths = this.screenshotPathsBySession.get(session.id);
		if (trackedPaths) {
			for (const filePath of trackedPaths) {
				await addCandidate(filePath, "tool");
			}
		}

		const scannedCandidates = await this.scanWorkspaceForScreenshots(
			workspacePath,
			cutoffMs,
		);
		for (const candidate of scannedCandidates) {
			if (!seen.has(candidate.path)) {
				seen.add(candidate.path);
				candidates.push(candidate);
			}
		}

		return candidates
			.sort((a, b) => {
				if (a.source !== b.source) {
					return a.source === "tool" ? -1 : 1;
				}
				return b.mtimeMs - a.mtimeMs;
			})
			.slice(0, MAX_FRONTEND_SCREENSHOTS);
	}

	private async scanWorkspaceForScreenshots(
		workspacePath: string,
		cutoffMs: number,
	): Promise<ScreenshotCandidate[]> {
		const candidates: ScreenshotCandidate[] = [];
		const stack: Array<{ dir: string; depth: number }> = [
			{ dir: workspacePath, depth: 0 },
		];
		let scannedFiles = 0;

		while (
			stack.length > 0 &&
			candidates.length < MAX_FRONTEND_SCREENSHOTS &&
			scannedFiles < SCREENSHOT_SCAN_MAX_FILES
		) {
			const current = stack.pop();
			if (!current) {
				continue;
			}

			const entries = await readdir(current.dir, { withFileTypes: true }).catch(
				() => [],
			);
			for (const entry of entries) {
				const entryPath = resolve(current.dir, entry.name);
				if (entry.isDirectory()) {
					if (
						current.depth < SCREENSHOT_SCAN_MAX_DEPTH &&
						!SKIPPED_SCREENSHOT_DIRS.has(entry.name)
					) {
						stack.push({ dir: entryPath, depth: current.depth + 1 });
					}
					continue;
				}

				if (!entry.isFile()) {
					continue;
				}
				scannedFiles++;
				if (!this.looksLikeGeneratedScreenshotPath(entryPath)) {
					continue;
				}
				const candidate = await this.toScreenshotCandidate(
					entryPath,
					"scan",
					cutoffMs,
				);
				if (candidate) {
					candidates.push(candidate);
				}
			}
		}

		return candidates;
	}

	private async toScreenshotCandidate(
		filePath: string,
		source: ScreenshotCandidate["source"],
		cutoffMs: number,
	): Promise<ScreenshotCandidate | undefined> {
		const extension = extname(filePath).toLowerCase();
		if (!SCREENSHOT_EXTENSIONS.has(extension)) {
			return undefined;
		}

		const fileStat = await stat(filePath).catch(() => undefined);
		if (
			!fileStat?.isFile() ||
			fileStat.size <= 0 ||
			fileStat.size > MAX_SCREENSHOT_SIZE_BYTES
		) {
			return undefined;
		}
		if (source === "scan" && fileStat.mtimeMs < cutoffMs) {
			return undefined;
		}

		return {
			path: filePath,
			filename: this.sanitizeScreenshotFilename(basename(filePath)),
			contentType: this.getImageContentType(extension),
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
			source,
		};
	}

	private looksLikeGeneratedScreenshotPath(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return /screenshot|screen-shot|playwright|cypress|test-results|visual|browser|chrome-devtools|puppeteer|snapshot/.test(
			lower,
		);
	}

	private sanitizeScreenshotFilename(filename: string): string {
		const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
		return sanitized || `screenshot${Date.now()}.png`;
	}

	private getImageContentType(extension: string): string {
		switch (extension) {
			case ".jpg":
			case ".jpeg":
				return "image/jpeg";
			case ".webp":
				return "image/webp";
			default:
				return "image/png";
		}
	}

	private async pullRequestAlreadyHasScreenshotComment(
		repoDir: string,
		pullRequestRef: string,
	): Promise<boolean> {
		const result = await this.tryWorkspaceCommand(repoDir, "gh", [
			"pr",
			"view",
			pullRequestRef,
			"--json",
			"comments",
		]);
		if (!result) {
			return false;
		}

		const parsed = JSON.parse(result.stdout || "{}") as {
			comments?: Array<{ body?: string }>;
		};
		return (
			parsed.comments?.some((comment) =>
				comment.body?.includes(PR_SCREENSHOT_COMMENT_MARKER),
			) ?? false
		);
	}

	private buildScreenshotComment(
		screenshots: Array<{ filename: string; assetUrl: string }>,
	): string {
		const lines = [
			PR_SCREENSHOT_COMMENT_MARKER,
			"## Frontend screenshots",
			"",
			"Cyrus collected these after finishing the frontend change:",
			"",
		];
		for (const screenshot of screenshots) {
			lines.push(`![${screenshot.filename}](${screenshot.assetUrl})`, "");
		}
		return lines.join("\n").trim();
	}

	private rememberScreenshotPathsFromToolInteraction(
		sessionId: string,
		toolName: string,
		toolInput?: unknown,
		toolResultContent?: string,
	): void {
		if (!this.isScreenshotRelatedTool(toolName, toolInput, toolResultContent)) {
			return;
		}

		for (const filePath of this.extractScreenshotPaths(toolInput)) {
			this.rememberScreenshotPath(sessionId, filePath);
		}
		for (const filePath of this.extractScreenshotPaths(toolResultContent)) {
			this.rememberScreenshotPath(sessionId, filePath);
		}
	}

	private isScreenshotRelatedTool(
		toolName: string,
		toolInput?: unknown,
		toolResultContent?: string,
	): boolean {
		const haystack = [
			toolName,
			this.stringifyForSearch(toolInput),
			toolResultContent,
		]
			.filter(Boolean)
			.join("\n")
			.toLowerCase();
		return /screenshot|screen-shot|take_screenshot|playwright|chrome-devtools|puppeteer|browser|computer|gif_creator/.test(
			haystack,
		);
	}

	private stringifyForSearch(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		try {
			return JSON.stringify(value ?? {});
		} catch {
			return "";
		}
	}

	private extractScreenshotPaths(value: unknown): string[] {
		const strings: string[] = [];
		const visit = (current: unknown, depth: number): void => {
			if (depth > 4 || current === null || current === undefined) {
				return;
			}
			if (typeof current === "string") {
				strings.push(current);
				return;
			}
			if (Array.isArray(current)) {
				for (const item of current) {
					visit(item, depth + 1);
				}
				return;
			}
			if (typeof current === "object") {
				for (const item of Object.values(current as Record<string, unknown>)) {
					visit(item, depth + 1);
				}
			}
		};

		visit(value, 0);

		const paths = new Set<string>();
		const absolutePathRegex =
			/(?:\/[^\s"'`<>|]+?\.(?:png|jpe?g|webp))|(?:[A-Za-z]:\\[^\r\n"'`<>|]+?\.(?:png|jpe?g|webp))/gi;
		const relativePathRegex =
			/(?:^|[\s"'`])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s"'`<>|]+?\.(?:png|jpe?g|webp))/gi;

		for (const text of strings) {
			for (const match of text.matchAll(absolutePathRegex)) {
				if (match[0]) {
					paths.add(match[0]);
				}
			}
			for (const match of text.matchAll(relativePathRegex)) {
				if (match[1]) {
					paths.add(match[1]);
				}
			}
		}

		return Array.from(paths);
	}

	private rememberScreenshotPath(sessionId: string, filePath: string): void {
		const trimmedPath = filePath.trim();
		if (!trimmedPath) {
			return;
		}
		const existing = this.screenshotPathsBySession.get(sessionId) ?? new Set();
		existing.add(trimmedPath);
		this.screenshotPathsBySession.set(sessionId, existing);
	}

	private async createPullRequest(
		repoDir: string,
		branch: string,
		baseBranch: string,
		session: CyrusAgentSession,
		resultMessage: SDKResultMessage,
	): Promise<string> {
		const issueIdentifier =
			session.issueContext?.issueIdentifier ?? session.issue?.identifier;
		const titlePrefix = issueIdentifier ? `${issueIdentifier}: ` : "";
		const title = `${titlePrefix}${this.cleanPullRequestTitle(
			session.issue?.title ?? "Cyrus changes",
		)}`;
		const rawBody =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result
				: `Automated changes for ${issueIdentifier}.`;
		const body = this.ensurePullRequestBodyMentionsIssue(
			rawBody,
			issueIdentifier,
		);
		const result = await this.runWorkspaceCommand(repoDir, "gh", [
			"pr",
			"create",
			"--base",
			baseBranch,
			"--head",
			branch,
			"--title",
			title,
			"--body",
			body,
		]);

		return result.stdout.trim();
	}

	private async ensurePullRequestMeetsRequirements(
		repoDir: string,
		pullRequestUrl: string,
		options: {
			issueIdentifier: string;
			baseBranch: string;
			branch: string;
			session: CyrusAgentSession;
			resultMessage: SDKResultMessage;
		},
	): Promise<void> {
		let pullRequest = await this.getPullRequestInfo(repoDir, pullRequestUrl);
		const titlePrefix = `${options.issueIdentifier}:`;
		const expectedTitle = `${titlePrefix} ${this.cleanPullRequestTitle(
			options.session.issue?.title ?? "Cyrus changes",
		)}`;

		if (pullRequest.isDraft) {
			await this.runWorkspaceCommand(repoDir, "gh", [
				"pr",
				"ready",
				pullRequestUrl,
			]);
		}

		if (!pullRequest.title?.startsWith(titlePrefix)) {
			await this.runWorkspaceCommand(repoDir, "gh", [
				"pr",
				"edit",
				pullRequestUrl,
				"--title",
				expectedTitle,
			]);
		}

		if (
			pullRequest.baseRefName &&
			pullRequest.baseRefName !== options.baseBranch
		) {
			await this.runWorkspaceCommand(repoDir, "gh", [
				"pr",
				"edit",
				pullRequestUrl,
				"--base",
				options.baseBranch,
			]);
		}

		const body = this.ensurePullRequestBodyMentionsIssue(
			pullRequest.body ??
				("result" in options.resultMessage &&
				typeof options.resultMessage.result === "string"
					? options.resultMessage.result
					: ""),
			options.issueIdentifier,
		);
		if (body !== (pullRequest.body ?? "")) {
			await this.runWorkspaceCommand(repoDir, "gh", [
				"pr",
				"edit",
				pullRequestUrl,
				"--body",
				body,
			]);
		}

		pullRequest = await this.getPullRequestInfo(repoDir, pullRequestUrl);
		if (pullRequest.isDraft) {
			throw new Error(`Pull request is still a draft: ${pullRequestUrl}`);
		}
		if (!pullRequest.title?.startsWith(titlePrefix)) {
			throw new Error(
				`Pull request title must start with ${titlePrefix}: ${pullRequestUrl}`,
			);
		}
		if (
			pullRequest.baseRefName &&
			pullRequest.baseRefName !== options.baseBranch
		) {
			throw new Error(
				`Pull request base is ${pullRequest.baseRefName}, expected ${options.baseBranch}: ${pullRequestUrl}`,
			);
		}
		if (pullRequest.headRefName && pullRequest.headRefName !== options.branch) {
			throw new Error(
				`Pull request head is ${pullRequest.headRefName}, expected ${options.branch}: ${pullRequestUrl}`,
			);
		}
	}

	private async requestConfiguredGitHubTeamReviews(
		repoDir: string,
		pullRequestUrl: string,
		session: CyrusAgentSession,
	): Promise<void> {
		const configuredTeams = this.getConfiguredGitHubReviewTeams(session);
		if (!configuredTeams.length) {
			return;
		}

		const pullRequest = this.parseGitHubPullRequestUrl(pullRequestUrl);
		if (!pullRequest) {
			this.sessionLog(session.id).warn(
				`Cannot request GitHub team review(s) for unrecognized PR URL: ${pullRequestUrl}`,
			);
			await this.postOperationalAlert({
				key: `github-review-request-invalid-url:${pullRequestUrl}`,
				severity: "warning",
				title: "GitHub team review request skipped",
				message: `Could not parse GitHub pull request URL: ${pullRequestUrl}`,
			});
			return;
		}

		const reviewers = this.formatGitHubTeamReviewers(
			configuredTeams,
			pullRequest.owner,
		);
		const teamSlugs = this.formatGitHubTeamReviewSlugs(configuredTeams);
		if (!teamSlugs.length) {
			return;
		}

		const args = [
			"api",
			"--method",
			"POST",
			`repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/requested_reviewers`,
		];
		for (const teamSlug of teamSlugs) {
			args.push("-f", `team_reviewers[]=${teamSlug}`);
		}

		try {
			await this.runWorkspaceCommand(repoDir, "gh", args);
			this.sessionLog(session.id).info(
				`Requested GitHub review from team(s): ${reviewers.join(", ")}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sessionLog(session.id).warn(
				`Failed to request GitHub team review(s) ${reviewers.join(", ")}: ${message}`,
			);
			await this.postOperationalAlert({
				key: `github-review-request-failed:${pullRequestUrl}`,
				severity: "warning",
				title: "GitHub team review request failed",
				message: `Could not request GitHub review from ${reviewers.join(", ")} for ${pullRequestUrl}: ${message}`,
			});
		}
	}

	private getConfiguredGitHubReviewTeams(session: CyrusAgentSession): string[] {
		const teams = session.repositories.flatMap(
			(repository) => repository.githubReviewTeams ?? [],
		);
		return [...new Set(teams.map((team) => team.trim()).filter(Boolean))];
	}

	private formatGitHubTeamReviewers(teams: string[], owner?: string): string[] {
		return teams
			.map((team) => team.trim())
			.filter(Boolean)
			.map((team) => {
				if (team.includes("/") || !owner) {
					return team;
				}
				return `${owner}/${team}`;
			});
	}

	private formatGitHubTeamReviewSlugs(teams: string[]): string[] {
		return [
			...new Set(
				teams
					.map((team) => team.trim().split("/").pop()?.trim())
					.filter((team): team is string => Boolean(team)),
			),
		];
	}

	private parseGitHubPullRequestUrl(
		pullRequestUrl: string,
	): { owner: string; repo: string; number: string } | undefined {
		const match = pullRequestUrl.match(
			/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[?#].*)?$/,
		);
		if (!match) {
			return undefined;
		}

		return {
			owner: match[1]!,
			repo: match[2]!,
			number: match[3]!,
		};
	}

	private async getPullRequestInfo(
		repoDir: string,
		pullRequestUrl: string,
	): Promise<PullRequestInfo> {
		const result = await this.runWorkspaceCommand(repoDir, "gh", [
			"pr",
			"view",
			pullRequestUrl,
			"--json",
			"url,isDraft,title,body,baseRefName,headRefName",
		]);
		const pullRequest = JSON.parse(result.stdout || "{}") as PullRequestInfo;
		if (!pullRequest.url) {
			throw new Error(`Unable to verify pull request: ${pullRequestUrl}`);
		}
		return pullRequest;
	}

	private ensurePullRequestBodyMentionsIssue(
		body: string,
		issueIdentifier?: string,
	): string {
		const trimmedBody = body.trim();
		if (!issueIdentifier) {
			return trimmedBody || "Automated changes from Cyrus.";
		}
		if (trimmedBody.includes(issueIdentifier)) {
			return trimmedBody || `Automated changes for ${issueIdentifier}.`;
		}
		return `${trimmedBody}\n\nLinear issue: ${issueIdentifier}`.trim();
	}

	private cleanPullRequestTitle(title: string): string {
		return title.replace(/^(wip|draft):\s*/i, "").trim() || "Cyrus changes";
	}

	private appendResultNote(
		resultMessage: SDKResultMessage,
		pullRequestUrl: string,
	): SDKResultMessage {
		if (
			!("result" in resultMessage) ||
			typeof resultMessage.result !== "string" ||
			resultMessage.result.includes(pullRequestUrl)
		) {
			return resultMessage;
		}

		return {
			...resultMessage,
			result: `${resultMessage.result.trim()}\n\nPull request: ${pullRequestUrl}`,
		} as SDKResultMessage;
	}

	private appendResultWarning(
		resultMessage: SDKResultMessage,
		warning: string,
	): SDKResultMessage {
		if (
			!("result" in resultMessage) ||
			typeof resultMessage.result !== "string" ||
			resultMessage.result.includes(warning)
		) {
			return resultMessage;
		}

		return {
			...resultMessage,
			result: `${resultMessage.result.trim()}\n\n${warning}`,
		} as SDKResultMessage;
	}

	private async postOperationalAlert(alert: {
		key: string;
		severity: "info" | "warning" | "error";
		title: string;
		message: string;
	}): Promise<void> {
		try {
			await this.operationalAlertHandler?.(alert);
		} catch (error) {
			this.logger.warn(
				`Failed to post operational alert: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async runWorkspaceCommand(
		cwd: string,
		command: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		return await execFileAsync(command, args, {
			cwd,
			maxBuffer: AUTO_PR_MAX_BUFFER,
		});
	}

	private async tryWorkspaceCommand(
		cwd: string,
		command: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string } | undefined> {
		try {
			return await this.runWorkspaceCommand(cwd, command, args);
		} catch {
			return undefined;
		}
	}

	/**
	 * Handle child session completion and resume parent
	 */
	private async handleChildSessionCompletion(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		if (!this.getParentSessionId || !this.resumeParentSession) {
			return;
		}

		const parentAgentSessionId = this.getParentSessionId(sessionId);

		if (!parentAgentSessionId) {
			log.error(`No parent session ID found for child session`);
			return;
		}

		log.info(
			`Child session completed, resuming parent ${parentAgentSessionId}`,
		);

		try {
			const childResult =
				"result" in resultMessage
					? resultMessage.result
					: "No result available";
			const promptToParent = `Child agent session ${sessionId} completed with result:\n\n${childResult}`;

			await this.resumeParentSession(
				parentAgentSessionId,
				promptToParent,
				sessionId,
			);

			log.info(`Successfully resumed parent session ${parentAgentSessionId}`);
		} catch (error) {
			log.error(`Failed to resume parent session:`, error);
		}
	}

	/**
	 * Handle streaming Claude messages and route to appropriate methods.
	 *
	 * Serializes processing per session so concurrent onMessage callbacks from
	 * the runner (which is fire-and-forget) do not interleave their async work.
	 * Without this serialization, a tool_result message could run its handler
	 * ahead of the matching tool_use registration in toolCallsByToolUseId,
	 * producing a fallback action="Tool" activity in Linear (seen with parallel
	 * deferred tools like ToolSearch).
	 */
	async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		const prev =
			this.messageProcessingQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(() => this.processClaudeMessage(sessionId, message));
		// Swallow errors in the chained promise so one failure does not block
		// future messages for this session. The concrete handler already logs
		// errors internally.
		this.messageProcessingQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * Actual message dispatch. Invoked only via the per-session queue in
	 * handleClaudeMessage so at most one instance runs for a given session.
	 */
	private async processClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			switch (message.type) {
				case "system":
					if (message.subtype === "init") {
						this.updateAgentSessionWithRunnerSessionId(sessionId, message);

						// Post model notification
						const systemMessage = message as SDKSystemMessage;
						if (systemMessage.model) {
							await this.postModelNotificationThought(
								sessionId,
								systemMessage.model,
							);
						}
					} else if (message.subtype === "status") {
						// Handle status updates (compacting, etc.)
						await this.handleStatusMessage(
							sessionId,
							message as SDKStatusMessage,
						);
					}
					break;

				case "user": {
					const userEntry = await this.createSessionEntry(
						sessionId,
						message as SDKUserMessage,
					);
					await this.syncEntryToActivitySink(userEntry, sessionId);
					break;
				}

				case "assistant": {
					const assistantEntry = await this.createSessionEntry(
						sessionId,
						message as SDKAssistantMessage,
					);
					// Buffer the text content so addResultEntry can post it as the response.
					// Track whether this body is a tool_use input (JSON) rather than real
					// assistant prose, so addResultEntry never posts raw tool JSON as the
					// final "response" when a turn ends on a tool call (CYPACK-1177).
					if (assistantEntry.content) {
						this.lastAssistantBodyBySession.set(
							sessionId,
							assistantEntry.content,
						);
						this.lastAssistantBodyIsToolInputBySession.set(
							sessionId,
							!!assistantEntry.metadata?.toolUseId,
						);
					}
					if (assistantEntry.metadata?.toolUseId) {
						// Tool-use message: flush any buffered text first (preserves ordering),
						// then post immediately for real-time "in progress" display
						await this.flushBufferedAssistant(sessionId);
						await this.syncEntryToActivitySink(assistantEntry, sessionId);
					} else {
						// Text-only message: buffer it so the LAST one can be posted as "response"
						// Flush any previous buffered text first (posts as thought)
						await this.flushBufferedAssistant(sessionId);
						// Skip empty/whitespace-only text turns — otherwise they post as
						// blank thoughts in Linear, showing up as an extra blank line
						// between activities (e.g. between "Using model: ..." and the
						// first real assistant turn).
						if (assistantEntry.content?.trim()) {
							this.bufferedAssistantEntryBySession.set(
								sessionId,
								assistantEntry,
							);
						}
					}
					break;
				}

				case "result":
					// Result arrived: discard buffered entry (addResultEntry uses lastAssistantBodyBySession
					// to post the content as a response activity)
					this.bufferedAssistantEntryBySession.delete(sessionId);
					await this.completeSession(sessionId, message as SDKResultMessage);
					break;

				case "rate_limit_event":
					this.handleRateLimitEvent(sessionId, message as SDKRateLimitEvent);
					break;

				default:
					log.warn(`Unknown message type: ${(message as any).type}`);
			}
		} catch (error) {
			log.error(`Error handling message:`, error);
			// Mark session as error state
			await this.updateSessionStatus(sessionId, AgentSessionStatus.Error);
		}
	}

	/**
	 * Flush the buffered assistant entry as thought/action (non-result flush).
	 * Called when a new message arrives before result, to post the previous
	 * assistant message as a thought/action activity.
	 */
	private async flushBufferedAssistant(sessionId: string): Promise<void> {
		const buffered = this.bufferedAssistantEntryBySession.get(sessionId);
		if (!buffered) return;
		this.bufferedAssistantEntryBySession.delete(sessionId);
		// Defensive guard: never post a blank thought — it would appear as an
		// empty line between real activities in Linear.
		if (!buffered.content?.trim()) return;
		await this.syncEntryToActivitySink(buffered, sessionId);
	}

	/**
	 * Handle rate limit events from Claude runners
	 */
	private handleRateLimitEvent(
		sessionId: string,
		message: SDKRateLimitEvent,
	): void {
		const log = this.sessionLog(sessionId);
		const info = message.rate_limit_info;

		if (info.status === "rejected") {
			const resetsAt = info.resetsAt
				? new Date(info.resetsAt * 1000).toISOString()
				: "unknown";
			log.warn(
				`Rate limited (${info.rateLimitType ?? "unknown"}), resets at ${resetsAt}`,
			);
		} else if (info.status === "allowed_warning") {
			log.info(
				`Rate limit warning: ${Math.round((info.utilization ?? 0) * 100)}% utilization (${info.rateLimitType ?? "unknown"})`,
			);
		}
		// "allowed" status is a no-op — fires frequently and provides no actionable information
	}

	/**
	 * Update session status and metadata
	 */
	private async updateSessionStatus(
		sessionId: string,
		status: AgentSessionStatus,
		additionalMetadata?: Partial<CyrusAgentSession["metadata"]>,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		session.status = status;
		session.updatedAt = Date.now();

		if (additionalMetadata) {
			session.metadata = { ...session.metadata, ...additionalMetadata };
		}

		this.sessions.set(sessionId, session);
	}

	/**
	 * Add result entry from result message
	 */
	private async addResultEntry(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// For error results, content may be in errors[] rather than result.
		const resultText =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result.trim()
				: "";

		// For success results, prefer the buffered last assistant message
		// (structured content) over result.result (a plain-text duplicate). But
		// when a turn ENDS on a tool call with no trailing assistant text, that
		// buffered body is the tool's raw input JSON — which must never be posted
		// as the Linear "response" (CYPACK-1177 / CYHOST-905: sessions showed a
		// "Finished" entry whose body was raw ScheduleWakeup / background-Bash
		// JSON).
		const bufferedAssistant = this.lastAssistantBodyBySession.get(sessionId);
		const bufferedIsToolInput =
			this.lastAssistantBodyIsToolInputBySession.get(sessionId) ?? false;
		this.lastAssistantBodyBySession.delete(sessionId);
		this.lastAssistantBodyIsToolInputBySession.delete(sessionId);

		let content: string;
		if (resultMessage.is_error) {
			content = (
				"errors" in resultMessage &&
				Array.isArray(resultMessage.errors) &&
				resultMessage.errors.length > 0
					? resultMessage.errors.join("\n")
					: resultText
			).trim();
		} else if (bufferedIsToolInput) {
			// Turn ended on a tool call. Render a friendly response for a
			// ScheduleWakeup (gated on the runner actually reporting a pending
			// cron so a finished session is never rewritten); otherwise fall back
			// to the SDK's result text and, failing that, post nothing — the raw
			// tool JSON is never surfaced. Any pending work is declared by the
			// separate "Standing by" thought, so an empty response here is fine.
			const pendingWork = this.getRunnerPendingWork(sessionId);
			const wakeupInput =
				pendingWork && pendingWork.sessionCrons.length > 0
					? tryParseScheduleWakeupInput(bufferedAssistant ?? "")
					: null;
			content = wakeupInput
				? formatScheduleWakeupResponse(wakeupInput)
				: resultText;
		} else {
			content = (bufferedAssistant ?? resultText).trim();
		}

		// Never post an empty/blank "response" activity — that renders as a
		// bare "Finished" with no body. Skip it entirely (the timeline already
		// shows the trailing action, and pending work has its own thought).
		if (!content.trim()) {
			return;
		}

		const resultEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: resultMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: resultMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: resultMessage.session_id }
						: { claudeSessionId: resultMessage.session_id }),
			type: "result",
			content,
			metadata: {
				timestamp: Date.now(),
				durationMs: resultMessage.duration_ms,
				isError: resultMessage.is_error,
			},
		};

		// DON'T store locally - syncEntryToActivitySink will do it
		// Sync to Linear
		await this.syncEntryToActivitySink(resultEntry, sessionId);
	}

	/**
	 * Extract content from Claude message
	 */
	private extractContent(
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): string {
		const message =
			sdkMessage.type === "user"
				? (sdkMessage.message as APIUserMessage)
				: (sdkMessage.message as APIAssistantMessage);

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			return message.content
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					} else if (block.type === "tool_use") {
						// For tool use blocks, return the input as JSON string
						return JSON.stringify(block.input, null, 2);
					} else if (block.type === "tool_result") {
						// For tool_result blocks, extract just the text content
						// Also store the error status in metadata if needed
						if ("is_error" in block && block.is_error) {
							// Mark this as an error result - we'll handle this elsewhere
						}
						if (typeof block.content === "string") {
							return block.content;
						}
						if (Array.isArray(block.content)) {
							return block.content
								.map((contentBlock: any) => {
									if (contentBlock.type === "text") {
										return contentBlock.text;
									}
									// ToolSearch emits tool_reference blocks; preserve the tool name
									// so the formatter can render "Loaded tools: `X`, `Y`".
									if (
										contentBlock.type === "tool_reference" &&
										contentBlock.tool_name
									) {
										return contentBlock.tool_name;
									}
									return "";
								})
								.filter(Boolean)
								.join("\n");
						}
						return "";
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}

		return "";
	}

	/**
	 * Extract tool information from Claude assistant message
	 */
	private extractToolInfo(
		sdkMessage: SDKAssistantMessage,
	): { id: string; name: string; input: any } | null {
		const message = sdkMessage.message as APIAssistantMessage;

		if (Array.isArray(message.content)) {
			const toolUse = message.content.find(
				(block) => block.type === "tool_use",
			);
			if (
				toolUse &&
				"id" in toolUse &&
				"name" in toolUse &&
				"input" in toolUse
			) {
				return {
					id: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool_use_id and error status from Claude user message containing tool_result
	 */
	private extractToolResultInfo(
		sdkMessage: SDKUserMessage,
	): { toolUseId: string; isError: boolean } | null {
		const message = sdkMessage.message as APIUserMessage;

		if (Array.isArray(message.content)) {
			const toolResult = message.content.find(
				(block) => block.type === "tool_result",
			);
			if (toolResult && "tool_use_id" in toolResult) {
				return {
					toolUseId: toolResult.tool_use_id,
					isError: "is_error" in toolResult && toolResult.is_error === true,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool result content and error status from session entry
	 */
	private extractToolResult(
		entry: CyrusAgentSessionEntry,
	): { content: string; isError: boolean } | null {
		// Check if we have the error status in metadata
		const isError = entry.metadata?.toolResultError || false;

		return {
			content: entry.content,
			isError: isError,
		};
	}

	/**
	 * Sync session entry to external tracker (create AgentActivity)
	 */
	private async syncEntryToActivitySink(
		entry: CyrusAgentSessionEntry,
		sessionId: string,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				log.warn(`No session found`);
				return;
			}

			// Store entry locally first
			const entries = this.entries.get(sessionId) || [];
			entries.push(entry);
			this.entries.set(sessionId, entries);

			// Build activity content based on entry type
			let content: any;
			let ephemeral = false;
			switch (entry.type) {
				case "user": {
					const activeTaskId = this.activeTasksBySession.get(sessionId);
					if (activeTaskId && activeTaskId === entry.metadata?.toolUseId) {
						content = {
							type: "thought",
							body: `✅ Task Completed\n\n\n\n${entry.content}\n\n---\n\n`,
						};
						this.activeTasksBySession.delete(sessionId);
					} else if (entry.metadata?.toolUseId) {
						// This is a tool result - create an action activity with the result
						const toolResult = this.extractToolResult(entry);
						if (toolResult) {
							// Get the original tool information
							const originalTool = this.toolCallsByToolUseId.get(
								entry.metadata.toolUseId,
							);
							const toolName = originalTool?.name || "Tool";
							const toolInput = originalTool?.input || "";
							this.rememberScreenshotPathsFromToolInteraction(
								sessionId,
								toolName,
								toolInput,
								toolResult.content,
							);

							// Clean up the tool call from our tracking map
							if (entry.metadata.toolUseId) {
								this.toolCallsByToolUseId.delete(entry.metadata.toolUseId);
							}

							// Handle TaskCreate results: cache the task ID → subject mapping
							const baseToolName = toolName.replace("↪ ", "");
							if (baseToolName === "TaskCreate" && entry.metadata?.toolUseId) {
								const cachedSubject = this.taskSubjectsByToolUseId.get(
									entry.metadata.toolUseId,
								);
								if (cachedSubject) {
									// Parse task ID from result like "Task #1 created successfully: ..."
									const taskIdMatch = toolResult.content?.match(/Task #(\d+)/);
									if (taskIdMatch?.[1]) {
										this.taskSubjectsById.set(taskIdMatch[1], cachedSubject);
									}
									this.taskSubjectsByToolUseId.delete(
										entry.metadata.toolUseId!,
									);
								}
							}

							// Handle TaskUpdate/TaskGet results: post enriched thought with subject
							if (baseToolName === "TaskUpdate" || baseToolName === "TaskGet") {
								const formatter = session.agentRunner?.getFormatter();
								if (!formatter) {
									log.warn(`No formatter available for session ${sessionId}`);
									return;
								}

								// Try to enrich toolInput with subject from cache or result
								const enrichedInput = { ...toolInput };
								if (!enrichedInput.subject) {
									const taskId = enrichedInput.taskId || "";
									// First try: look up subject from our cache
									const cachedSubject = this.taskSubjectsById.get(taskId);
									if (cachedSubject) {
										enrichedInput.subject = cachedSubject;
									} else if (baseToolName === "TaskGet" && toolResult.content) {
										// Second try: parse subject from TaskGet result content
										// Format: "ID: 123\nSubject: Fix bug\nStatus: ..."
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											// Also cache it for future TaskUpdate calls
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									} else if (
										baseToolName === "TaskUpdate" &&
										toolResult.content
									) {
										// Try to parse subject from TaskUpdate result content
										// Format: "Updated task #3 subject" or may contain task details
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									}
								}

								const formattedTask = formatter.formatTaskParameter(
									baseToolName,
									enrichedInput,
								);
								content = {
									type: "thought",
									body: formattedTask,
								};
								ephemeral = false;
								break;
							}

							// Skip creating activity for TodoWrite/write_todos results since they already created a non-ephemeral thought
							// Skip TaskCreate/TaskList results since they already created a non-ephemeral thought
							// Skip AskUserQuestion results since it's custom handled via Linear's select signal elicitation
							if (
								toolName === "TodoWrite" ||
								toolName === "↪ TodoWrite" ||
								toolName === "write_todos" ||
								toolName === "TaskCreate" ||
								toolName === "↪ TaskCreate" ||
								toolName === "TaskList" ||
								toolName === "↪ TaskList" ||
								toolName === "AskUserQuestion" ||
								toolName === "↪ AskUserQuestion"
							) {
								return;
							}

							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Format parameter and result using runner's formatter
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const formattedResult = formatter.formatToolResult(
								toolName,
								toolInput,
								toolResult.content?.trim() || "",
								toolResult.isError,
							);

							// Format the action name (with description for Bash tool)
							const formattedAction = formatter.formatToolActionName(
								toolName,
								toolInput,
								toolResult.isError,
							);

							content = {
								type: "action",
								action: formattedAction,
								parameter: formattedParameter,
								result: formattedResult,
							};
						} else {
							return;
						}
					} else {
						return;
					}
					break;
				}
				case "assistant": {
					// Assistant messages can be thoughts or responses
					if (entry.metadata?.toolUseId) {
						const toolName = entry.metadata.toolName || "Tool";
						this.rememberScreenshotPathsFromToolInteraction(
							sessionId,
							toolName,
							entry.metadata.toolInput,
						);

						// Store tool information for later use in tool results
						if (entry.metadata.toolUseId) {
							// Check if this is a subtask with arrow prefix
							let storedName = toolName;
							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									storedName = `↪ ${toolName}`;
								}
							}

							this.toolCallsByToolUseId.set(entry.metadata.toolUseId, {
								name: storedName,
								input: entry.metadata.toolInput || entry.content,
							});
						}

						// Skip AskUserQuestion tool - it's custom handled via Linear's select signal elicitation
						if (toolName === "AskUserQuestion") {
							return;
						}

						// Special handling for TodoWrite tool (Claude) and write_todos (Gemini) - treat as thought instead of action
						if (toolName === "TodoWrite" || toolName === "write_todos") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							const formattedTodos = formatter.formatTodoWriteParameter(
								entry.content,
							);
							content = {
								type: "thought",
								body: formattedTodos,
							};
							// TodoWrite/write_todos is not ephemeral
							ephemeral = false;
						} else if (toolName === "TaskCreate" || toolName === "TaskList") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available for session ${sessionId}`);
								return;
							}

							// Special handling for Task tools - format as thought instead of action
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedTask = formatter.formatTaskParameter(
								toolName,
								toolInput,
							);
							content = {
								type: "thought",
								body: formattedTask,
							};
							// Task tools are not ephemeral
							ephemeral = false;

							// Cache TaskCreate subject by toolUseId so we can map it to task ID when result arrives
							if (
								toolName === "TaskCreate" &&
								toolInput?.subject &&
								entry.metadata.toolUseId
							) {
								this.taskSubjectsByToolUseId.set(
									entry.metadata.toolUseId,
									toolInput.subject,
								);
							}
						} else if (toolName === "TaskUpdate" || toolName === "TaskGet") {
							// Skip posting at tool_use time — defer to tool_result time
							// so we can enrich with subject from result or cache
							return;
						} else if (toolName === "Task") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Special handling for Task tool - add start marker and track active task
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const displayName = toolName;

							// Track this as the active Task for this session
							if (entry.metadata?.toolUseId) {
								this.activeTasksBySession.set(
									sessionId,
									entry.metadata.toolUseId,
								);
							}

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Task is not ephemeral
							ephemeral = false;
						} else {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Other tools - check if they're within an active Task
							const toolInput = entry.metadata.toolInput || entry.content;
							let displayName = toolName;

							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									displayName = `↪ ${toolName}`;
								}
							}

							const formattedParameter = formatter.formatToolParameter(
								displayName,
								toolInput,
							);

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Standard tool calls are ephemeral
							ephemeral = true;
						}
					} else if (entry.metadata?.sdkError) {
						// Assistant message with SDK error (e.g., rate_limit, billing_error)
						// Create an error type so it's visible to users (not just a thought)
						// Per CYPACK-719: usage limits should trigger "error" type activity
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						// Regular assistant message - create a thought
						content = {
							type: "thought",
							body: entry.content,
						};
					}
					break;
				}

				case "system":
					// System messages are thoughts
					content = {
						type: "thought",
						body: entry.content,
					};
					break;

				case "result":
					// Result messages can be responses or errors
					if (entry.metadata?.isError) {
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						content = {
							type: "response",
							body: entry.content,
						};
					}
					break;

				default:
					// Default to thought
					content = {
						type: "thought",
						body: entry.content,
					};
			}

			// Ensure we have an external session ID for activity posting
			if (!session.externalSessionId) {
				log.debug(
					`Skipping activity sync - no external session ID (platform: ${session.issueContext?.trackerId || "unknown"})`,
				);
				return;
			}

			if (ephemeral && process.env.CYRUS_LINEAR_STREAM_ACTIONS !== "true") {
				return;
			}

			const activityToolName = entry.metadata?.toolName || "";
			if (
				activityToolName &&
				process.env.CYRUS_LINEAR_STREAM_TASKS !== "true" &&
				/^(↪ )?(TaskCreate|TaskUpdate|TaskGet|TaskList|TodoWrite|write_todos)$/.test(
					activityToolName,
				)
			) {
				return;
			}

			const options: ActivityPostOptions = {};
			if (ephemeral) {
				options.ephemeral = true;
			}

			const activitySink = this.getActivitySink(sessionId);
			if (!activitySink) {
				log.debug(
					`Skipping activity sync - no activity sink registered for session`,
				);
				return;
			}

			const result = await activitySink.postActivity(
				session.externalSessionId,
				content,
				options,
			);

			if (result.activityId) {
				entry.linearAgentActivityId = result.activityId;
				if (entry.type === "result") {
					log.info(
						`Result message emitted to Linear (activity ${entry.linearAgentActivityId})`,
					);
				} else {
					log.debug(
						`Created ${content.type} activity ${entry.linearAgentActivityId}`,
					);
				}
			}
		} catch (error) {
			log.error(`Failed to sync entry to activity sink:`, error);
		}
	}

	/**
	 * Get session by ID
	 */
	getSession(sessionId: string): CyrusAgentSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get session entries by session ID
	 */
	getSessionEntries(sessionId: string): CyrusAgentSessionEntry[] {
		return this.entries.get(sessionId) || [];
	}

	/**
	 * Get all active sessions
	 */
	getActiveSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Add or update agent runner for a session
	 */
	addAgentRunner(sessionId: string, agentRunner: IAgentRunner): void {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			log.warn(`No session found`);
			return;
		}

		session.agentRunner = agentRunner;
		session.updatedAt = Date.now();
		log.debug(`Added agent runner`);
	}

	/**
	 *  Get all agent runners
	 */
	getAllAgentRunners(): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Resolve the issue ID from a session, checking issueContext first then deprecated issueId.
	 */
	private getSessionIssueId(session: CyrusAgentSession): string | undefined {
		return session.issueContext?.issueId ?? session.issueId;
	}

	/**
	 * Get all agent runners for a specific issue
	 */
	getAgentRunnersForIssue(issueId: string): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.filter((session) => this.getSessionIssueId(session) === issueId)
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Get sessions by issue ID
	 */
	getSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => this.getSessionIssueId(session) === issueId,
		);
	}

	/**
	 * Get active sessions by issue ID
	 */
	getActiveSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				this.getSessionIssueId(session) === issueId &&
				session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Get active sessions where the issue's branch name matches the given branch.
	 * Useful for detecting when multiple sessions share the same worktree.
	 */
	getActiveSessionsByBranchName(branchName: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.issue?.branchName === branchName,
		);
	}

	/**
	 * Get active sessions tracking a given base branch for a specific repository.
	 * Used by GitHub push webhook handling to notify agents when their base branch receives new commits.
	 */
	getSessionsByBaseBranch(
		baseBranchName: string,
		repositoryId: string,
	): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.repositories.some(
					(r) =>
						r.repositoryId === repositoryId &&
						r.baseBranchName === baseBranchName,
				),
		);
	}

	/**
	 * Find an active multi-repo session that includes the given repository.
	 * Used by GitHub webhook handling to resolve the correct sub-worktree
	 * when a @ mention targets a specific repo within a multi-repo workspace.
	 */
	getActiveMultiRepoSessionForRepository(
		repositoryId: string,
	): CyrusAgentSession | null {
		for (const session of this.sessions.values()) {
			if (session.status !== AgentSessionStatus.Active) continue;
			if (!session.workspace.repoPaths) continue; // not multi-repo
			const matchesRepo = session.repositories.some(
				(r) => r.repositoryId === repositoryId,
			);
			if (matchesRepo) {
				return session;
			}
		}
		return null;
	}

	/**
	 * Get all sessions
	 */
	getAllSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Get agent runner for a specific session
	 */
	getAgentRunner(sessionId: string): IAgentRunner | undefined {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner;
	}

	/**
	 * Check if an agent runner exists for a session
	 */
	hasAgentRunner(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner !== undefined;
	}

	/**
	 * Post an activity to the activity sink for a session.
	 * Consolidates session lookup, externalSessionId guard, try/catch, and logging.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivity(
		sessionId: string,
		input: {
			content: any;
			ephemeral?: boolean;
			signal?: ActivitySignal;
			signalMetadata?: Record<string, unknown>;
		},
		label: string,
	): Promise<string | null> {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);

		if (!session?.externalSessionId) {
			log.debug(
				`Skipping ${label} - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return null;
		}

		try {
			const options: ActivityPostOptions = {};
			if (input.ephemeral !== undefined) {
				options.ephemeral = input.ephemeral;
			}
			if (input.signal) {
				options.signal = input.signal;
			}
			if (input.signalMetadata) {
				options.signalMetadata = input.signalMetadata;
			}

			const activitySink = this.getActivitySink(sessionId);
			if (!activitySink) {
				log.debug(
					`Skipping ${label} - no activity sink registered for session`,
				);
				return null;
			}

			const result = await activitySink.postActivity(
				session.externalSessionId,
				input.content,
				options,
			);

			if (result.activityId) {
				log.debug(`Created ${label} activity ${result.activityId}`);
				return result.activityId;
			}
			log.debug(`Created ${label}`);
			return null;
		} catch (error) {
			log.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	/**
	 * Create a thought activity
	 */
	async createThoughtActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body } },
			"thought",
		);
	}

	/**
	 * Create an action activity
	 */
	async createActionActivity(
		sessionId: string,
		action: string,
		parameter: string,
		result?: string,
	): Promise<void> {
		const content: any = { type: "action", action, parameter };
		if (result !== undefined) {
			content.result = result;
		}
		await this.postActivity(sessionId, { content }, "action");
	}

	/**
	 * Create a response activity
	 */
	async createResponseActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "response", body } },
			"response",
		);
	}

	/**
	 * Create an error activity
	 */
	async createErrorActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "error", body } },
			"error",
		);
	}

	/**
	 * Create an elicitation activity
	 */
	async createElicitationActivity(
		sessionId: string,
		body: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "elicitation", body } },
			"elicitation",
		);
	}

	/**
	 * Create an approval elicitation activity with auth signal
	 */
	async createApprovalElicitation(
		sessionId: string,
		body: string,
		approvalUrl: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{
				content: { type: "elicitation", body },
				signal: "auth",
				signalMetadata: { url: approvalUrl },
			},
			"approval elicitation",
		);
	}

	/**
	 * Remove a session and all associated tracking state.
	 * Use for immediate cleanup when a session is permanently done
	 * (e.g., issue moved to terminal state).
	 */
	removeSession(sessionId: string): void {
		const log = this.sessionLog(sessionId);
		this.sessions.delete(sessionId);
		this.entries.delete(sessionId);
		this.activitySinks.delete(sessionId);
		this.activeTasksBySession.delete(sessionId);
		this.activeStatusActivitiesBySession.delete(sessionId);
		this.stopRequestedSessions.delete(sessionId);
		this.lastAssistantBodyBySession.delete(sessionId);
		this.bufferedAssistantEntryBySession.delete(sessionId);
		this.messageProcessingQueues.delete(sessionId);
		log.debug("Removed session");
	}

	/**
	 * Clear completed sessions older than specified time
	 */
	cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): number {
		const cutoff = Date.now() - olderThanMs;
		let removedCount = 0;

		for (const [sessionId, session] of this.sessions.entries()) {
			if (
				(session.status === "complete" || session.status === "error") &&
				session.updatedAt < cutoff
			) {
				const log = this.sessionLog(sessionId);
				this.removeSession(sessionId);
				removedCount++;
				log.debug(`Cleaned up session`);
			}
		}

		return removedCount;
	}

	/**
	 * Serialize Agent Session state for persistence
	 */
	serializeState(): {
		sessions: Record<string, SerializedCyrusAgentSession>;
		entries: Record<string, SerializedCyrusAgentSessionEntry[]>;
	} {
		const sessions: Record<string, SerializedCyrusAgentSession> = {};
		const entries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Serialize sessions
		for (const [sessionId, session] of this.sessions.entries()) {
			// Exclude agentRunner from serialization as it's not serializable
			const { agentRunner: _agentRunner, ...serializableSession } = session;
			sessions[sessionId] = serializableSession;
		}

		// Serialize entries
		for (const [sessionId, sessionEntries] of this.entries.entries()) {
			entries[sessionId] = sessionEntries.map((entry) => ({
				...entry,
			}));
		}

		return { sessions, entries };
	}

	/**
	 * Restore Agent Session state from serialized data
	 */
	restoreState(
		serializedSessions: Record<string, SerializedCyrusAgentSession>,
		serializedEntries: Record<string, SerializedCyrusAgentSessionEntry[]>,
	): void {
		// Clear existing state
		this.sessions.clear();
		this.entries.clear();

		// Restore sessions (migrate old sessions without repositories field)
		for (const [sessionId, sessionData] of Object.entries(serializedSessions)) {
			const session: CyrusAgentSession = {
				...sessionData,
				repositories: sessionData.repositories ?? [],
			};
			this.sessions.set(sessionId, session);
		}

		// Restore entries
		for (const [sessionId, entriesData] of Object.entries(serializedEntries)) {
			const sessionEntries: CyrusAgentSessionEntry[] = entriesData.map(
				(entryData) => ({
					...entryData,
				}),
			);
			this.entries.set(sessionId, sessionEntries);
		}

		this.logger.debug(
			`Restored ${this.sessions.size} sessions, ${Object.keys(serializedEntries).length} entry collections`,
		);
	}

	/**
	 * Post a thought about the model being used
	 */
	private async postModelNotificationThought(
		sessionId: string,
		model: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body: `Using model: ${model}` } },
			"model notification",
		);
	}

	/**
	 * Post an ephemeral "Analyzing your request..." thought and return the activity ID
	 */
	async postAnalyzingThought(sessionId: string): Promise<string | null> {
		return this.postActivity(
			sessionId,
			{
				content: { type: "thought", body: "Analyzing your request…" },
				ephemeral: true,
			},
			"analyzing thought",
		);
	}

	/**
	 * Handle status messages (compacting, etc.)
	 */
	private async handleStatusMessage(
		sessionId: string,
		message: SDKStatusMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session?.externalSessionId) {
			const log = this.sessionLog(sessionId);
			log.debug(
				`Skipping status message - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return;
		}

		if (message.status === "compacting") {
			const activityId = await this.postActivity(
				sessionId,
				{
					content: {
						type: "thought",
						body: "Compacting conversation history…",
					},
					ephemeral: true,
				},
				"compacting status",
			);
			if (activityId) {
				this.activeStatusActivitiesBySession.set(sessionId, activityId);
			}
		} else if (message.status === null) {
			// Clear the status - post a non-ephemeral thought to replace the ephemeral one
			await this.postActivity(
				sessionId,
				{
					content: { type: "thought", body: "Conversation history compacted" },
					ephemeral: false,
				},
				"status clear",
			);
			// Clean up the stored activity ID regardless — stale IDs do no harm
			this.activeStatusActivitiesBySession.delete(sessionId);
		}
	}
}
