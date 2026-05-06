import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

describe("AgentSessionManager - GitHub review teams", () => {
	const manager = new AgentSessionManager();

	it("prefixes bare team slugs with the GitHub owner", () => {
		expect(
			(manager as any).formatGitHubTeamReviewers(
				["engineering", "funnelcockpit/security"],
				"funnelcockpit",
			),
		).toEqual(["funnelcockpit/engineering", "funnelcockpit/security"]);
	});

	it("preserves bare team slugs when no owner is available", () => {
		expect(
			(manager as any).formatGitHubTeamReviewers(["engineering"], undefined),
		).toEqual(["engineering"]);
	});

	it("normalizes team reviewer slugs for the GitHub API", () => {
		expect(
			(manager as any).formatGitHubTeamReviewSlugs([
				"engineering",
				"funnelcockpit/security",
				"funnelcockpit/engineering",
				"",
			]),
		).toEqual(["engineering", "security"]);
	});

	it("parses GitHub pull request URLs for API review requests", () => {
		expect(
			(manager as any).parseGitHubPullRequestUrl(
				"https://github.com/funnelcockpit/funnelcockpit/pull/363",
			),
		).toEqual({
			owner: "funnelcockpit",
			repo: "funnelcockpit",
			number: "363",
		});
		expect(
			(manager as any).parseGitHubPullRequestUrl(
				"https://github.com/funnelcockpit/funnelcockpit/pull/363#issuecomment-1",
			),
		).toEqual({
			owner: "funnelcockpit",
			repo: "funnelcockpit",
			number: "363",
		});
		expect(
			(manager as any).parseGitHubPullRequestUrl(
				"git@github.com:funnelcockpit/funnelcockpit.git",
			),
		).toBeUndefined();
	});
});

describe("AgentSessionManager - duplicate PR guards", () => {
	it("finds merged pull requests for the current issue", async () => {
		const manager = new AgentSessionManager();
		vi.spyOn(manager as any, "tryWorkspaceCommand").mockImplementation(
			async (_repoDir: string, command: string, args: string[]) => {
				if (command !== "gh" || !args.includes("list")) {
					return undefined;
				}
				if (args.includes("--head")) {
					return {
						stdout: JSON.stringify([
							{
								url: "https://github.com/funnelcockpit/funnelcockpit/pull/1",
								title: "FC-1234: closed but not merged",
								headRefName: "cyrus/fc-1234-old",
								state: "closed",
								mergedAt: null,
							},
						]),
						stderr: "",
					};
				}
				return {
					stdout: JSON.stringify([
						{
							url: "https://github.com/funnelcockpit/funnelcockpit/pull/2",
							title: "FC-4489: Fix duplicate UI state",
							body: "Linear issue: FC-4489",
							headRefName: "cyrus/fc-4489-fix-duplicate-ui-state",
							state: "merged",
							mergedAt: "2026-05-05T10:00:00Z",
						},
					]),
					stderr: "",
				};
			},
		);

		const pullRequest = await (
			manager as any
		).findMergedPullRequestForBranchOrIssue(
			"/repo",
			"cyrus/fc-4489-fix-duplicate-ui-state",
			"FC-4489",
		);

		expect(pullRequest?.url).toBe(
			"https://github.com/funnelcockpit/funnelcockpit/pull/2",
		);
	});

	it("does not treat closed unmerged pull requests as duplicate merged work", async () => {
		const manager = new AgentSessionManager();
		vi.spyOn(manager as any, "tryWorkspaceCommand").mockResolvedValue({
			stdout: JSON.stringify([
				{
					url: "https://github.com/funnelcockpit/funnelcockpit/pull/3",
					title: "FC-4489: abandoned attempt",
					body: "Linear issue: FC-4489",
					headRefName: "cyrus/fc-4489-abandoned",
					state: "closed",
					mergedAt: null,
				},
			]),
			stderr: "",
		});

		const pullRequest = await (
			manager as any
		).findMergedPullRequestForBranchOrIssue(
			"/repo",
			"cyrus/fc-4489-abandoned",
			"FC-4489",
		);

		expect(pullRequest).toBeUndefined();
	});
});
