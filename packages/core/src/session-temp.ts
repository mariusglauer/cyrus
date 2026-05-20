import { mkdirSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const SESSION_TEMP_ROOT = "tmp";
const SESSION_TEMP_PREFIX = "session-";

export function sanitizeSessionTempSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	return sanitized || "unknown";
}

export function getSessionTempRoot(cyrusHome: string): string {
	return join(cyrusHome, SESSION_TEMP_ROOT);
}

export function getSessionTempDir(
	cyrusHome: string,
	sessionId: string,
): string {
	return join(
		getSessionTempRoot(cyrusHome),
		`${SESSION_TEMP_PREFIX}${sanitizeSessionTempSegment(sessionId)}`,
	);
}

export function isSessionTempDirName(name: string): boolean {
	return name.startsWith(SESSION_TEMP_PREFIX);
}

export function buildSessionTempEnv(
	sessionTempDir?: string,
): Record<string, string> {
	if (!sessionTempDir) {
		return {};
	}

	return {
		TMPDIR: sessionTempDir,
		TMP: sessionTempDir,
		TEMP: sessionTempDir,
		CYRUS_SESSION_TMPDIR: sessionTempDir,
	};
}

export function ensureSessionTempDir(sessionTempDir?: string): void {
	if (!sessionTempDir) {
		return;
	}

	mkdirSync(sessionTempDir, { recursive: true });
}

export function cleanupSessionTempDir(sessionTempDir?: string): void {
	if (!sessionTempDir || !isSafeSessionTempDir(sessionTempDir)) {
		return;
	}

	try {
		rmSync(sessionTempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup only. Stale directories are removed by Cyrus GC.
	}
}

function isSafeSessionTempDir(sessionTempDir: string): boolean {
	const resolved = resolve(sessionTempDir);
	const parent = basename(resolve(resolved, ".."));
	if (parent !== SESSION_TEMP_ROOT) {
		return false;
	}

	const name = basename(resolved);
	if (!isSessionTempDirName(name)) {
		return false;
	}

	const rel = relative(resolve(resolved, ".."), resolved);
	return Boolean(rel) && !rel.startsWith("..") && !rel.includes("..");
}
