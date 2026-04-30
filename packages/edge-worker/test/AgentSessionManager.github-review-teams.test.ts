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

	it("extracts GitHub owners from SSH and HTTPS remotes", () => {
		expect(
			(manager as any).extractGitHubOwnerFromRemote(
				"git@github.com:funnelcockpit/funnelcockpit.git",
			),
		).toBe("funnelcockpit");
		expect(
			(manager as any).extractGitHubOwnerFromRemote(
				"https://github.com/funnelcockpit/funnelcockpit.git",
			),
		).toBe("funnelcockpit");
	});

	it("uses the configured GitHub URL to resolve the owner", () => {
		expect(
			(manager as any).getConfiguredGitHubReviewOwner({
				repositories: [
					{
						repositoryId: "funnelcockpit",
						githubUrl: "https://github.com/funnelcockpit/funnelcockpit",
						githubReviewTeams: ["engineering"],
					},
				],
			}),
		).toBe("funnelcockpit");
	});
});
