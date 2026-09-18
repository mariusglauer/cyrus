import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("EdgeWorker conflict rebase workspace preparation", () => {
	let testRoot: string | undefined;

	afterEach(() => {
		if (testRoot) {
			rmSync(testRoot, { recursive: true, force: true });
			testRoot = undefined;
		}
	});

	it("synchronizes a clean reused worktree to the exact remote PR head", () => {
		testRoot = mkdtempSync(join(tmpdir(), "cyrus-conflict-workspace-"));
		const remotePath = join(testRoot, "remote.git");
		const repositoryPath = join(testRoot, "repository");
		const updaterPath = join(testRoot, "updater");
		const workspacePath = join(testRoot, "workspace");

		git(testRoot, ["init", "--bare", remotePath]);
		git(testRoot, ["clone", remotePath, repositoryPath]);
		configureGitUser(repositoryPath);
		git(repositoryPath, ["checkout", "-b", "main"]);
		writeFileSync(join(repositoryPath, "file.txt"), "base\n");
		git(repositoryPath, ["add", "file.txt"]);
		git(repositoryPath, ["commit", "-m", "base"]);
		git(repositoryPath, ["push", "-u", "origin", "main"]);
		git(repositoryPath, ["checkout", "-b", "feature/pr"]);
		writeFileSync(join(repositoryPath, "file.txt"), "feature one\n");
		git(repositoryPath, ["commit", "-am", "feature one"]);
		git(repositoryPath, ["push", "-u", "origin", "feature/pr"]);
		git(repositoryPath, ["checkout", "main"]);
		git(repositoryPath, ["worktree", "add", workspacePath, "feature/pr"]);

		git(testRoot, ["clone", remotePath, updaterPath]);
		configureGitUser(updaterPath);
		git(updaterPath, ["checkout", "feature/pr"]);
		writeFileSync(join(updaterPath, "file.txt"), "feature two\n");
		git(updaterPath, ["commit", "-am", "feature two"]);
		git(updaterPath, ["push", "origin", "feature/pr"]);
		const expectedHeadSha = git(updaterPath, ["rev-parse", "HEAD"]).trim();

		const edgeWorker = Object.create(EdgeWorker.prototype) as EdgeWorker;
		(edgeWorker as any).prepareGitHubConflictRebaseWorkspace(workspacePath, {
			head: { ref: "feature/pr", sha: expectedHeadSha },
			base: { ref: "main" },
		});

		expect(git(workspacePath, ["rev-parse", "HEAD"]).trim()).toBe(
			expectedHeadSha,
		);
		expect(
			git(workspacePath, ["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(),
		).toBe("origin/feature/pr");
	});

	it("refuses to replace uncommitted worktree changes", () => {
		testRoot = mkdtempSync(join(tmpdir(), "cyrus-conflict-workspace-"));
		const repositoryPath = join(testRoot, "repository");
		git(testRoot, ["init", repositoryPath]);
		configureGitUser(repositoryPath);
		git(repositoryPath, ["checkout", "-b", "feature/pr"]);
		writeFileSync(join(repositoryPath, "file.txt"), "committed\n");
		git(repositoryPath, ["add", "file.txt"]);
		git(repositoryPath, ["commit", "-m", "initial"]);
		writeFileSync(join(repositoryPath, "file.txt"), "local change\n");
		const headSha = git(repositoryPath, ["rev-parse", "HEAD"]).trim();

		const edgeWorker = Object.create(EdgeWorker.prototype) as EdgeWorker;
		expect(() =>
			(edgeWorker as any).prepareGitHubConflictRebaseWorkspace(repositoryPath, {
				head: { ref: "feature/pr", sha: headSha },
				base: { ref: "main" },
			}),
		).toThrow("has uncommitted changes");
		expect(readFileSync(join(repositoryPath, "file.txt"), "utf8")).toBe(
			"local change\n",
		);
	});
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function configureGitUser(cwd: string): void {
	git(cwd, ["config", "user.name", "Cyrus Test"]);
	git(cwd, ["config", "user.email", "cyrus-test@example.com"]);
}
