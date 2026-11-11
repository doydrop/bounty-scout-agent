import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fetchSessionStatus } from "./kpass.js";
import type { CommandRunner } from "./types.js";
import type { SessionCreateInfo } from "./parse.js";

export interface StoredSession {
  sessionId: string | null;
  requestId: string | null;
  approvalUrl: string | null;
  createdAt: string;
  dryRun?: boolean;
  note?: string;
}

export function sessionFilePath(dataDir: string): string {
  return path.join(dataDir, "session.json");
}

export function readStoredSession(dataDir: string): StoredSession | null {
  const file = sessionFilePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      sessionId: typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : null,
      requestId: typeof parsed.requestId === "string" && parsed.requestId.trim() ? parsed.requestId.trim() : null,
      approvalUrl: typeof parsed.approvalUrl === "string" && parsed.approvalUrl.trim() ? parsed.approvalUrl.trim() : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      dryRun: parsed.dryRun === true,
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

/** Writes only ids and the approval URL. Never a session key or API token. */
export function writeStoredSession(dataDir: string, session: StoredSession): void {
  mkdirSync(dataDir, { recursive: true });
  const payload = {
    sessionId: session.sessionId,
    requestId: session.requestId,
    approvalUrl: session.approvalUrl,
    createdAt: session.createdAt,
    ...(session.dryRun ? { dryRun: true } : {}),
    ...(session.note ? { note: session.note } : {}),
  };
  writeFileSync(sessionFilePath(dataDir), `${JSON.stringify(payload, null, 2)}\n`);
}

export interface ActivateResult {
  sessionId?: string;
  requestId?: string;
  activated: boolean;
}

/**
 * Run `kpass session status --request-id` once so kpass writes the per-session
 * key into `.kite-passport/sessions.json`, then save the session id.
 * Does not wait. A missing or pending approval leaves the request id in place.
 */
export async function activateStoredSession(opts: {
  dataDir: string;
  bin?: string;
  cwd?: string;
  runner?: CommandRunner;
  fallbackSessionId?: string;
}): Promise<ActivateResult> {
  const stored = readStoredSession(opts.dataDir);
  if (!stored?.requestId || stored.dryRun) {
    return { sessionId: opts.fallbackSessionId ?? stored?.sessionId ?? undefined, activated: false };
  }
  let info: SessionCreateInfo;
  try {
    info = await fetchSessionStatus({
      requestId: stored.requestId,
      bin: opts.bin,
      runner: opts.runner,
      cwd: opts.cwd,
      wait: false,
    });
  } catch {
    return { sessionId: opts.fallbackSessionId ?? stored.sessionId ?? undefined, requestId: stored.requestId, activated: false };
  }
  const sessionId = info.sessionId ?? stored.sessionId ?? undefined;
  if (info.sessionId) {
    writeStoredSession(opts.dataDir, {
      ...stored,
      sessionId: info.sessionId,
      requestId: info.requestId ?? stored.requestId,
      approvalUrl: info.approvalUrl ?? stored.approvalUrl,
    });
    return { sessionId: info.sessionId, requestId: stored.requestId, activated: true };
  }
  return { sessionId: sessionId ?? opts.fallbackSessionId, requestId: stored.requestId, activated: false };
}
