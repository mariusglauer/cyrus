/**
 * Prompt Assembly Tests - New Sessions
 *
 * Tests prompt assembly for new (initial) sessions with full issue context.
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - New Sessions", () => {
	it("assignment-based (no labels) - should have system prompt with shared instructions", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			identifier: "CEE-123",
			title: "Fix authentication bug",
			description: "Users cannot log in",
		};

		const repository = {
			id: "repo-uuid-1234-5678-90ab-cdef12345678",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</id>
  <identifier>CEE-123</identifier>
  <title>Fix authentication bug</title>
  <description>
Users cannot log in
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>

<frontend_screenshot_requirement>
If you changed frontend/UI code and the app can reasonably be rendered locally, capture at least one fresh screenshot before your final response.
Save the screenshot under \`cyrus-screenshots/\` or another workspace path containing \`screenshot\`, and leave it uncommitted so Cyrus can attach it to the GitHub PR.
If no browser MCP/tool is available, use shell Playwright instead, for example: \`mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/frontend-after.png\`
If you cannot capture a meaningful screenshot because the app cannot be run, requires unavailable auth/data, or there is no visual surface to render, state that exact reason in your final response.
</frontend_screenshot_requirement>
`)
			.expectSystemPrompt(`<task_management_instructions>
Keep task tracking lightweight and useful.
- For simple or narrow bug fixes, do not create a task list unless it meaningfully helps.
- For larger work, create a short checklist and update it only at meaningful milestones.
- Avoid frequent progress-only task updates; keep Linear activity concise so API quota is preserved for real status and final responses.
</task_management_instructions>


## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});

	it("assignment-based (with user comment) - should include user comment in XML wrapper", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			identifier: "CEE-456",
			title: "Implement new feature",
			description: "Add payment processing",
		};

		const repository = {
			id: "repo-uuid-2345-6789-01bc-def123456789",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Please add Stripe integration")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>b2c3d4e5-f6a7-8901-bcde-f12345678901</id>
  <identifier>CEE-456</identifier>
  <title>Implement new feature</title>
  <description>
Add payment processing
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>

<frontend_screenshot_requirement>
If you changed frontend/UI code and the app can reasonably be rendered locally, capture at least one fresh screenshot before your final response.
Save the screenshot under \`cyrus-screenshots/\` or another workspace path containing \`screenshot\`, and leave it uncommitted so Cyrus can attach it to the GitHub PR.
If no browser MCP/tool is available, use shell Playwright instead, for example: \`mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/frontend-after.png\`
If you cannot capture a meaningful screenshot because the app cannot be run, requires unavailable auth/data, or there is no visual surface to render, state that exact reason in your final response.
</frontend_screenshot_requirement>


<user_comment>
Please add Stripe integration
</user_comment>`)
			.expectSystemPrompt(`<task_management_instructions>
Keep task tracking lightweight and useful.
- For simple or narrow bug fixes, do not create a task list unless it meaningfully helps.
- For larger work, create a short checklist and update it only at meaningful milestones.
- Avoid frequent progress-only task updates; keep Linear activity concise so API quota is preserved for real status and final responses.
</task_management_instructions>


## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`)
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.verify();
	});
});
