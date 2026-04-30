import { describe, expect, it } from "vitest";
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
