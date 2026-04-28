import { readFile, stat } from "node:fs/promises";
import {
	type AgentActivityContent,
	AgentActivitySignal,
	type IIssueTrackerService,
} from "cyrus-core";
import type {
	ActivityFileUploadInput,
	ActivityFileUploadResult,
	ActivityPostOptions,
	ActivityPostResult,
	ActivitySignal,
	IActivitySink,
} from "./IActivitySink.js";

/**
 * Linear-specific implementation of IActivitySink.
 *
 * LinearActivitySink wraps an IIssueTrackerService instance to provide activity
 * sink functionality for Linear workspaces. It delegates activity posting and
 * session creation to the underlying issue tracker service.
 *
 * @example
 * ```typescript
 * const issueTracker = new LinearIssueTrackerService(linearClient, {
 *   workspaceId: 'workspace-123',
 *   // ... other OAuth config
 * });
 *
 * const sink = new LinearActivitySink(issueTracker, 'workspace-123');
 *
 * // Create a session
 * const sessionId = await sink.createAgentSession('issue-id-456');
 *
 * // Post activities
 * const result = await sink.postActivity(sessionId, {
 *   type: 'thought',
 *   body: 'Analyzing the issue...'
 * });
 * ```
 */
export class LinearActivitySink implements IActivitySink {
	/**
	 * Unique identifier for this sink (Linear workspace ID).
	 */
	public readonly id: string;

	private readonly issueTracker: IIssueTrackerService;

	/**
	 * Create a new LinearActivitySink.
	 *
	 * @param issueTracker - The IIssueTrackerService instance to delegate to
	 * @param workspaceId - The Linear workspace ID (used as sink ID)
	 */
	constructor(issueTracker: IIssueTrackerService, workspaceId: string) {
		this.issueTracker = issueTracker;
		this.id = workspaceId;
	}

	/**
	 * Map a platform-agnostic ActivitySignal string to Linear's AgentActivitySignal enum.
	 */
	private mapSignal(signal: ActivitySignal): AgentActivitySignal {
		switch (signal) {
			case "auth":
				return AgentActivitySignal.Auth;
			case "select":
				return AgentActivitySignal.Select;
			case "stop":
				return AgentActivitySignal.Stop;
			case "continue":
				return AgentActivitySignal.Continue;
		}
	}

	/**
	 * Post an activity to an existing agent session.
	 *
	 * Wraps IIssueTrackerService.createAgentActivity() to provide a simplified
	 * interface for activity posting.
	 *
	 * @param sessionId - The agent session ID to post to
	 * @param activity - The activity content (thought, action, response, error, etc.)
	 * @param options - Optional settings for ephemeral, signal, signalMetadata
	 * @returns Promise that resolves with the activity post result
	 */
	async postActivity(
		sessionId: string,
		activity: AgentActivityContent,
		options?: ActivityPostOptions,
	): Promise<ActivityPostResult> {
		const result = await this.issueTracker.createAgentActivity({
			agentSessionId: sessionId,
			content: activity,
			...(options?.ephemeral !== undefined && { ephemeral: options.ephemeral }),
			...(options?.signal && { signal: this.mapSignal(options.signal) }),
			...(options?.signalMetadata && {
				signalMetadata: options.signalMetadata,
			}),
		});

		if (result.success && result.agentActivity) {
			const agentActivity = await result.agentActivity;
			return { activityId: agentActivity.id };
		}

		return {};
	}

	/**
	 * Create a new agent session on an issue.
	 *
	 * Wraps IIssueTrackerService.createAgentSessionOnIssue() to provide a simplified
	 * interface for session creation.
	 *
	 * @param issueId - The issue ID to attach the session to
	 * @returns Promise that resolves with the created session ID
	 */
	async createAgentSession(issueId: string): Promise<string> {
		const result = await this.issueTracker.createAgentSessionOnIssue({
			issueId,
		});

		if (!result.success) {
			throw new Error(
				`Failed to create agent session for issue ${issueId}: request was not successful`,
			);
		}

		// Extract session ID from the result
		// Result has `agentSession` property that may be a Promise
		const session = await result.agentSession;
		if (!session) {
			throw new Error(
				`Failed to create agent session for issue ${issueId}: session is undefined`,
			);
		}
		return session.id;
	}

	/**
	 * Upload a local file through Linear and return the resulting asset URL.
	 */
	async uploadFile(
		input: ActivityFileUploadInput,
	): Promise<ActivityFileUploadResult> {
		const fileStat = await stat(input.filePath);
		if (!fileStat.isFile()) {
			throw new Error(`Cannot upload ${input.filePath}: not a file`);
		}

		const upload = await this.issueTracker.requestFileUpload({
			contentType: input.contentType,
			filename: input.filename,
			size: fileStat.size,
			makePublic: input.makePublic,
		});

		const uploadHeaders: Record<string, string> = {
			"Content-Type": input.contentType,
			"Cache-Control": "public, max-age=31536000",
			...upload.headers,
		};
		const uploadResponse = await fetch(upload.uploadUrl, {
			method: "PUT",
			headers: uploadHeaders,
			body: await readFile(input.filePath),
		});

		if (!uploadResponse.ok) {
			const errorText = await uploadResponse.text();
			throw new Error(
				`Failed to upload ${input.filename}: ${uploadResponse.status} ${uploadResponse.statusText} ${errorText}`,
			);
		}

		return {
			assetUrl: upload.assetUrl,
			filename: input.filename,
			contentType: input.contentType,
			size: fileStat.size,
		};
	}
}
