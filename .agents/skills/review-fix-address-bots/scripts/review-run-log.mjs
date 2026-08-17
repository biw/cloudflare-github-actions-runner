#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

export const LOG_TEMPLATES = Object.freeze({
  configuration: Object.freeze({
    requestedReviewerCount: 5,
    reviewerCohortRequested: Object.freeze([
      Object.freeze({ model: "gpt-5.6-sol", count: 1 }),
      Object.freeze({ model: "gpt-5.6-terra", count: 1 }),
      Object.freeze({ model: "gpt-5.6-luna", count: 3 }),
    ]),
    reasoningRequested: "high",
    watcherIntervalMs: 30_000,
    softReviewerDeadlineMs: 600_000,
    hardReviewerDeadlineMs: 1_200_000,
    remediationRoundLimit: 3,
    reviewBotLoopLimit: 8,
  }),
  events: Object.freeze({
    targetIntegrated: Object.freeze({
      event: "target_integrated",
      data: Object.freeze({
        targetRef: "<target-remote>/<target-branch>",
        targetSha: "<sha>",
        method: "already_current",
      }),
    }),
    reviewerSessionStarted: Object.freeze({
      event: "reviewer_session_started",
      data: Object.freeze({
        reviewerId: "sol-1",
        launchMechanism: "native",
        sessionId: "<session-id>",
        modelRequested: "gpt-5.6-sol",
        modelApplied: "gpt-5.6-sol",
        reasoningRequested: "high",
        reasoningApplied: "high",
      }),
    }),
    reviewerSessionControlsVerified: Object.freeze({
      event: "reviewer_session_controls_verified",
      data: Object.freeze({
        reviewerId: "luna-1",
        sessionId: "<session-id>",
        modelApplied: "gpt-5.6-luna",
        reasoningApplied: "high",
      }),
    }),
    reviewerSessionObserved: Object.freeze({
      event: "reviewer_session_observed",
      data: Object.freeze({
        reviewerId: "luna-1",
        lifecycle: "active",
        lastActivityAt: "<timestamp>",
        quietForMs: 0,
      }),
    }),
    reviewerSessionCancelled: Object.freeze({
      event: "reviewer_session_cancelled",
      data: Object.freeze({
        reviewerId: "sol-1",
        sessionId: "<persisted-session-id>",
        nativeHandle: "/root/sol_1",
        phase: "initial",
        reason: "native reviewer exceeded the hard deadline",
        deadlineMs: 1_200_000,
      }),
    }),
    initialPass: Object.freeze({
      event: "reviewer_pass_completed",
      data: Object.freeze({ reviewerId: "sol-1", round: 1, findingIds: ["F1"], tokenUsage: null }),
    }),
    initialPassFailed: Object.freeze({
      event: "reviewer_pass_failed",
      data: Object.freeze({
        reviewerId: "luna-1",
        phase: "initial",
        reason: "persistent CLI session unavailable after bounded polling",
      }),
    }),
    continuity: Object.freeze({
      event: "reviewer_continuity_verified",
      data: Object.freeze({ reviewerId: "sol-1", round: 1, verified: true, tokenUsage: null }),
    }),
    remediationPass: Object.freeze({
      event: "remediation_reviewer_pass_completed",
      data: Object.freeze({ reviewerId: "sol-1", round: 1, findingIds: [], tokenUsage: null }),
    }),
    findingResolved: Object.freeze({
      event: "finding_resolved",
      data: Object.freeze({
        findingId: "F1",
        classification: "valid",
        reportedBy: Object.freeze(["sol-1"]),
        action: "fixed",
      }),
    }),
  }),
  finishSummary: Object.freeze({
    status: "complete",
    githubReviewBots: Object.freeze([]),
    reviewBotLoopCount: 0,
  }),
});

export const PRICING_SNAPSHOT = Object.freeze({
  currency: "USD",
  serviceTier: "standard",
  effectiveDate: "2026-07-09",
  source: "https://openai.com/index/gpt-5-6/",
  cachedInputDiscount: 0.9,
  ratesPerMillionTokens: Object.freeze({
    "gpt-5.6-sol": Object.freeze({ input: 5, cachedInput: 0.5, output: 30 }),
    "gpt-5.6-terra": Object.freeze({ input: 2.5, cachedInput: 0.25, output: 15 }),
    "gpt-5.6-luna": Object.freeze({ input: 1, cachedInput: 0.1, output: 6 }),
  }),
  limitations: Object.freeze([
    "API-equivalent estimate; Codex plan billing may differ.",
    "Treats cachedInputTokens as cache reads and cannot identify cache-write premiums.",
    "Excludes long-context and non-standard service-tier premiums.",
  ]),
});

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = dirname(dirname(scriptPath));

const fail = (message) => {
  throw new Error(message);
};

const expandHome = (value) => {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
};

const isoTimestamp = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) fail(`Invalid timestamp: ${value}`);
  return date.toISOString();
};

const runGit = (repoRoot, args) => {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

export const sanitizeRemote = (remote, fallback) => {
  if (!remote) return fallback;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const url = new URL(remote);
      const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      return [url.hostname, path].filter(Boolean).join("/") || fallback;
    } catch {
      return fallback;
    }
  }

  const scp = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;

  return fallback;
};

const discoverRepo = (requestedRoot) => {
  const candidate = resolve(expandHome(requestedRoot || process.cwd()));
  const root = runGit(candidate, ["rev-parse", "--show-toplevel"]) || candidate;
  const remotes = (runGit(root, ["remote"]) || "").split("\n").filter(Boolean);
  const remoteName = remotes.includes("origin") ? "origin" : remotes[0];
  const remote = remoteName ? runGit(root, ["remote", "get-url", remoteName]) : undefined;

  return {
    key: sanitizeRemote(remote, basename(root)),
    root,
    remoteName: remoteName || null,
  };
};

const discoverGitState = (repoRoot) => ({
  branch: runGit(repoRoot, ["branch", "--show-current"]) || null,
  head: runGit(repoRoot, ["rev-parse", "HEAD"]) || null,
});

const skillFingerprint = () => {
  const hash = createHash("sha256");
  for (const relativePath of [
    "SKILL.md",
    "references/review-guidelines.md",
    "references/run-logging.md",
    "scripts/review-run-log.mjs",
  ]) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(join(skillRoot, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const assertObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
};

const readEvents = (logPath) => {
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) fail(`Run log is empty: ${logPath}`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSON on line ${index + 1} of ${logPath}: ${error.message}`);
    }
  });
};

const runIdentity = (logPath) => {
  const events = readEvents(logPath);
  const first = events[0];
  if (first.event !== "run_started" || !first.runId) fail(`Missing run_started header: ${logPath}`);
  return { events, runId: first.runId };
};

const tokenUsageFromCodex = (usage) =>
  usage
    ? {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.cached_input_tokens,
        outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.reasoning_output_tokens,
        totalTokens: usage.total_tokens,
      }
    : null;

const readFirstJsonLine = (path) => {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return null;
    return JSON.parse(text.slice(0, newline));
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
};

const sessionFilesForWindow = (sessionsRoot, startedAt, endedAt) => {
  const files = [];
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 1);

  for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) {
    const directory = join(
      sessionsRoot,
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(directory, entry.name));
    }
  }
  return files;
};

const codexSessionUsage = (path) => {
  let totalTokenUsage = null;
  let invocationCount = 0;
  let completedInvocationCount = 0;
  let completedDurationCount = 0;
  let durationMs = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "event_msg") continue;
    if (record.payload?.type === "task_started") invocationCount += 1;
    if (record.payload?.type === "task_complete") {
      completedInvocationCount += 1;
      if (
        typeof record.payload.duration_ms === "number" &&
        Number.isFinite(record.payload.duration_ms) &&
        record.payload.duration_ms >= 0
      ) {
        completedDurationCount += 1;
        durationMs += record.payload.duration_ms;
      }
    }
    if (record.payload?.type === "token_count" && record.payload.info?.total_token_usage) {
      totalTokenUsage = record.payload.info.total_token_usage;
    }
  }
  return {
    invocationCount,
    completedInvocationCount,
    durationMs: completedDurationCount === completedInvocationCount ? durationMs : null,
    tokenUsage: tokenUsageFromCodex(totalTokenUsage),
  };
};

const expectedAgentName = (reviewerId) => reviewerId.replaceAll("-", "_");

const nativeCandidateMatchesReviewer = (candidate, reviewer, index = 0) => {
  const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`;
  const sessionHandle = reviewer.sessionId || reviewer.sessionIdentifier;
  if (sessionHandle) return candidate.sessionId === sessionHandle || candidate.agentPath === sessionHandle;
  return candidate.agentName === expectedAgentName(reviewerId);
};

const readJsonlRecords = (path) => {
  const records = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { records, malformedLine: index + 1 };
    }
  }
  return { records, malformedLine: null };
};

const sessionIdFromMeta = (record) => record?.payload?.id || record?.payload?.session_id || null;

const cliSessionCandidate = (path) => {
  const first = readFirstJsonLine(path);
  if (first?.type !== "session_meta" || first.payload?.source !== "exec") return null;
  return {
    path,
    cwd: first.payload.cwd || null,
    model: first.payload.model || null,
    sessionId: sessionIdFromMeta(first),
    timestamp: first.payload.timestamp || first.timestamp || null,
  };
};

const nativeSessionCandidate = (path) => {
  const first = readFirstJsonLine(path);
  const spawn = first?.payload?.source?.subagent?.thread_spawn;
  if (first?.type !== "session_meta" || !spawn) return null;
  const agentPath = spawn.agent_path || first.payload.agent_path || "";
  return {
    path,
    cwd: first.payload.cwd || null,
    model: first.payload.model || null,
    sessionId: sessionIdFromMeta(first),
    parentThreadId: spawn.parent_thread_id || first.payload.parent_thread_id || null,
    agentPath,
    agentName: basename(agentPath),
    timestamp: first.payload.timestamp || first.timestamp || null,
  };
};

const appliedControlsForSession = (records, candidate) => {
  const context = records.find((record) => record.type === "turn_context")?.payload || {};
  return {
    model: context.model || candidate.model || null,
    reasoning: context.effort || context.collaboration_mode?.settings?.reasoning_effort || null,
  };
};

const exactCliSessionData = (
  { sessionId, modelApplied, reasoningApplied } = {},
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  if (!sessionId || !startedAt || !repoRoot) {
    return {
      status: "unavailable",
      reason: "sessionId, startedAt, and repoRoot are required",
    };
  }

  const candidates = sessionFilesForWindow(resolve(expandHome(sessionsRoot)), startedAt, endedAt)
    .map(cliSessionCandidate)
    .filter(Boolean)
    .filter((candidate) => candidate.sessionId === sessionId && resolve(candidate.cwd || "/") === resolve(repoRoot));

  if (candidates.length !== 1) {
    return {
      status: "unavailable",
      reason:
        candidates.length === 0
          ? "no exact persistent CLI session matched the reviewer session ID and repository"
          : "multiple persistent CLI sessions matched the reviewer session ID and repository",
      candidateCount: candidates.length,
    };
  }

  const candidate = candidates[0];
  const { records, malformedLine } = readJsonlRecords(candidate.path);
  if (malformedLine !== null) {
    return {
      status: "unavailable",
      reason: `persistent CLI session contains malformed JSON at line ${malformedLine}`,
      sessionId,
    };
  }

  const controls = appliedControlsForSession(records, candidate);
  if (
    (modelApplied && controls.model !== modelApplied) ||
    (reasoningApplied && controls.reasoning !== reasoningApplied)
  ) {
    return {
      status: "unavailable",
      reason: "persistent CLI session applied controls do not match the reviewer ledger",
      sessionId,
      controls,
    };
  }

  return { status: "available", candidate, controls, records, sessionId };
};

const exactNativeSessionData = (
  { sessionId, reviewerId, modelApplied, reasoningApplied } = {},
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  if (!reviewerId || !startedAt || !repoRoot) {
    return {
      status: "unavailable",
      reason: "reviewerId, startedAt, and repoRoot are required",
    };
  }

  const startTime = new Date(startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  const candidates = sessionFilesForWindow(resolve(expandHome(sessionsRoot)), startedAt, endedAt)
    .map(nativeSessionCandidate)
    .filter(Boolean)
    .filter((candidate) => {
      const timestamp = new Date(candidate.timestamp).getTime();
      const matchesHandle = sessionId && (candidate.sessionId === sessionId || candidate.agentPath === sessionId);
      return (
        (matchesHandle || (!sessionId && candidate.agentName === expectedAgentName(reviewerId))) &&
        resolve(candidate.cwd || "/") === resolve(repoRoot) &&
        timestamp >= startTime &&
        timestamp <= endTime
      );
    });

  if (candidates.length !== 1) {
    return {
      status: "unavailable",
      reason:
        candidates.length === 0
          ? "no exact native reviewer session matched the reviewer handle and repository"
          : "multiple native reviewer sessions matched the reviewer handle and repository",
      candidateCount: candidates.length,
    };
  }

  const candidate = candidates[0];
  const { records, malformedLine } = readJsonlRecords(candidate.path);
  if (malformedLine !== null) {
    return {
      status: "unavailable",
      reason: `native reviewer session contains malformed JSON at line ${malformedLine}`,
      sessionId: candidate.sessionId,
    };
  }

  const controls = appliedControlsForSession(records, candidate);
  if (
    (modelApplied && controls.model !== modelApplied) ||
    (reasoningApplied && controls.reasoning !== reasoningApplied)
  ) {
    return {
      status: "unavailable",
      reason: "native reviewer session applied controls do not match the reviewer ledger",
      sessionId: candidate.sessionId,
      controls,
    };
  }

  return { status: "available", candidate, controls, records, sessionId: candidate.sessionId };
};

const timestampForRecord = (record) => {
  const value = record?.timestamp || record?.payload?.timestamp || null;
  return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
};

const terminalFailureFor = (records) =>
  [...records].reverse().find((record) => {
    const type = record?.payload?.type || record?.type || "";
    return (
      typeof record?.payload?.error === "string" ||
      /(?:^|_)(?:error|failed|failure|aborted|cancelled)(?:$|_)/i.test(type)
    );
  }) || null;

const eventDescriptor = (record) =>
  record
    ? {
        recordedAt: timestampForRecord(record),
        recordType: record.type || null,
        eventType: record.payload?.type || null,
      }
    : null;

const latestReviewerSessionStart = (events, reviewerId, launchMechanism) =>
  [...events]
    .reverse()
    .find(
      (event) =>
        event.event === "reviewer_session_started" &&
        canonicalReviewerId(event.data) === reviewerId &&
        event.data?.launchMechanism === launchMechanism,
    ) || null;

const terminalResultFromSession = ({ sessionId, controls, records, sessionLabel }) => {
  const taskStarts = records.filter((record) => record.type === "event_msg" && record.payload?.type === "task_started");
  const taskCompletions = records.filter(
    (record) => record.type === "event_msg" && record.payload?.type === "task_complete",
  );
  if (taskCompletions.length > taskStarts.length) {
    return {
      status: "unavailable",
      reason: `${sessionLabel} has more completed tasks than task starts`,
      sessionId,
      controls,
      taskStartedCount: taskStarts.length,
      taskCompletedCount: taskCompletions.length,
    };
  }
  if (taskStarts.length > taskCompletions.length) {
    const lastTaskStartIndex = records.findLastIndex(
      (record) => record.type === "event_msg" && record.payload?.type === "task_started",
    );
    const failure = terminalFailureFor(records.slice(lastTaskStartIndex));
    if (failure) {
      return {
        status: "unavailable",
        reason: `${sessionLabel} recorded a terminal failure before task completion`,
        sessionId,
        controls,
        taskStartedCount: taskStarts.length,
        taskCompletedCount: taskCompletions.length,
        terminalFailure: eventDescriptor(failure),
      };
    }
    return {
      status: "in_progress",
      reason: `${sessionLabel} has an active task without a terminal response`,
      sessionId,
      controls,
      taskStartedCount: taskStarts.length,
      taskCompletedCount: taskCompletions.length,
    };
  }
  const terminal = taskCompletions.at(-1)?.payload;
  const lastAgentMessage = terminal?.last_agent_message;

  if (!terminal || typeof lastAgentMessage !== "string" || lastAgentMessage.length === 0) {
    const failure = terminalFailureFor(records);
    if (failure) {
      return {
        status: "unavailable",
        reason: `${sessionLabel} recorded a terminal failure before task completion`,
        sessionId,
        controls,
        taskStartedCount: taskStarts.length,
        taskCompletedCount: taskCompletions.length,
        terminalFailure: eventDescriptor(failure),
      };
    }
    return {
      status: "in_progress",
      reason: `${sessionLabel} has no completed task with a terminal response`,
      sessionId,
      controls,
      taskStartedCount: taskStarts.length,
      taskCompletedCount: taskCompletions.length,
    };
  }

  const hasMatchingFinalAnswer = records.some(
    (record) =>
      record.type === "event_msg" &&
      record.payload?.type === "agent_message" &&
      record.payload?.phase === "final_answer" &&
      record.payload?.message === lastAgentMessage,
  );
  if (!hasMatchingFinalAnswer) {
    return {
      status: "unavailable",
      reason: `${sessionLabel} terminal response does not have a matching final-answer event`,
      sessionId,
      controls,
      taskStartedCount: taskStarts.length,
      taskCompletedCount: taskCompletions.length,
    };
  }

  return {
    status: "complete",
    sessionId,
    controls,
    taskStartedCount: taskStarts.length,
    taskCompletedCount: taskCompletions.length,
    completedAt: terminal.completed_at ? new Date(terminal.completed_at * 1000).toISOString() : null,
    durationMs: typeof terminal.duration_ms === "number" ? terminal.duration_ms : null,
    lastAgentMessage,
  };
};

/**
 * Recovers a terminal response from an exact persistent `codex exec` session.
 *
 * This is deliberately separate from native usage collection: a CLI session is
 * identified by its captured thread ID, not by subagent metadata. The returned
 * response is for the parent to consume; callers must not add it to the JSONL
 * telemetry log because review bodies are intentionally not logged.
 */
export const collectCodexCliSessionResult = (
  { sessionId, modelApplied, reasoningApplied } = {},
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  const exact = exactCliSessionData(
    { sessionId, modelApplied, reasoningApplied },
    { sessionsRoot, startedAt, endedAt, repoRoot },
  );
  if (exact.status !== "available") return exact;

  return terminalResultFromSession({
    sessionId,
    controls: exact.controls,
    records: exact.records,
    sessionLabel: "persistent CLI session",
  });
};

/**
 * Recovers a terminal response from an exact native reviewer transcript. The
 * session handle is the native agent path (or its rollout ID when exposed).
 */
export const collectCodexNativeSessionResult = (
  { sessionId, reviewerId, modelApplied, reasoningApplied } = {},
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  const exact = exactNativeSessionData(
    { sessionId, reviewerId, modelApplied, reasoningApplied },
    { sessionsRoot, startedAt, endedAt, repoRoot },
  );
  if (exact.status !== "available") return exact;
  return terminalResultFromSession({
    sessionId: exact.sessionId,
    controls: exact.controls,
    records: exact.records,
    sessionLabel: "native reviewer session",
  });
};

const inspectExactSession = ({
  reviewerId,
  exact,
  recovered,
  observedAt,
  staleAfterMs,
  activeAction,
  stalledAction,
} = {}) => {
  const { candidate, controls, records } = exact;
  const taskStarts = records.filter((record) => record.type === "event_msg" && record.payload?.type === "task_started");
  const taskCompletions = records.filter(
    (record) => record.type === "event_msg" && record.payload?.type === "task_complete",
  );
  const lastRecord = records.at(-1) || null;
  const lastActivityAt = timestampForRecord(lastRecord);
  const quietForMs = lastActivityAt
    ? Math.max(0, new Date(observedAt).getTime() - new Date(lastActivityAt).getTime())
    : null;
  const activeTaskStartedAt = timestampForRecord(taskStarts.at(-1)) || candidate.timestamp || null;
  const timingBasis = taskStarts.length > 0 ? "task_started" : "session_started";
  const activeTaskElapsedMs = activeTaskStartedAt
    ? Math.max(0, new Date(observedAt).getTime() - new Date(activeTaskStartedAt).getTime())
    : null;
  const shared = {
    reviewerId,
    sessionLogPath: candidate.path,
    ...(candidate.agentPath ? { nativeHandle: candidate.agentPath } : {}),
    observedAt,
    lastActivityAt,
    lastEvent: eventDescriptor(lastRecord),
  };

  if (recovered.status === "complete") {
    return {
      ...shared,
      ...recovered,
      lifecycle: "complete",
      recommendedAction: "Use the recovered final answer and record the completed reviewer pass.",
    };
  }

  if (recovered.status === "unavailable") {
    return {
      ...shared,
      ...recovered,
      lifecycle: "unavailable",
      recommendedAction:
        "Record the diagnostic. Retry once with the same reviewer identity and controls only after confirming this session cannot produce a completed result.",
    };
  }

  const lifecycle = quietForMs !== null && quietForMs >= staleAfterMs ? "stalled" : "active";
  return {
    ...shared,
    ...recovered,
    controls,
    lifecycle,
    quietForMs,
    staleAfterMs,
    activeTaskStartedAt,
    activeTaskElapsedMs,
    timingBasis,
    taskStartedCount: taskStarts.length,
    taskCompletedCount: taskCompletions.length,
    recommendedAction: lifecycle === "active" ? activeAction : stalledAction,
  };
};

/**
 * Inspects an exact CLI reviewer session without resuming it. An in-progress
 * session is observationally active or stalled based on its last JSONL write;
 * neither state claims that the underlying service has stopped.
 */
export const inspectCodexCliReviewerSession = ({
  logPath,
  reviewerId,
  sessionsRoot,
  timestamp,
  staleAfterMs = 120_000,
} = {}) => {
  if (!logPath) fail("logPath is required");
  if (!reviewerId) fail("reviewerId is required");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) fail("staleAfterMs must be a non-negative finite number");

  const { events } = runIdentity(logPath);
  const start = latestReviewerSessionStart(events, reviewerId, "codex_cli");
  if (!start) {
    return {
      status: "unavailable",
      reason: "no codex_cli reviewer session start exists for this reviewer",
      reviewerId,
    };
  }

  const data = start.data;
  const observedAt = isoTimestamp(timestamp);
  const exact = exactCliSessionData(
    {
      sessionId: data.sessionId,
      modelApplied: data.modelApplied,
      reasoningApplied: data.reasoningApplied,
    },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      endedAt: observedAt,
      repoRoot: events[0].repo?.root,
    },
  );
  if (exact.status !== "available") return { reviewerId, ...exact };

  const recovered = collectCodexCliSessionResult(
    {
      sessionId: data.sessionId,
      modelApplied: data.modelApplied,
      reasoningApplied: data.reasoningApplied,
    },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      endedAt: observedAt,
      repoRoot: events[0].repo?.root,
    },
  );
  return inspectExactSession({
    reviewerId,
    exact,
    recovered,
    observedAt,
    staleAfterMs,
    activeAction: "Poll this exact session again after a bounded wait; do not resume or replace it.",
    stalledAction:
      "This session has been quiet past the threshold. Inspect its final events, record the diagnostic, then use the one permitted same-identity retry only if it remains unavailable.",
  });
};

/**
 * Inspects a native Sol/Terra-style reviewer transcript without sending it a
 * follow-up. Native launch status can lag its persisted task completion.
 */
export const inspectCodexNativeReviewerSession = ({
  logPath,
  reviewerId,
  sessionsRoot,
  timestamp,
  staleAfterMs = 120_000,
} = {}) => {
  if (!logPath) fail("logPath is required");
  if (!reviewerId) fail("reviewerId is required");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) fail("staleAfterMs must be a non-negative finite number");

  const { events } = runIdentity(logPath);
  const start = latestReviewerSessionStart(events, reviewerId, "native");
  if (!start) {
    return {
      status: "unavailable",
      reason: "no native reviewer session start exists for this reviewer",
      reviewerId,
    };
  }

  const data = start.data;
  const observedAt = isoTimestamp(timestamp);
  const exact = exactNativeSessionData(
    {
      sessionId: data.sessionId,
      reviewerId,
      modelApplied: data.modelApplied,
      reasoningApplied: data.reasoningApplied,
    },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      endedAt: observedAt,
      repoRoot: events[0].repo?.root,
    },
  );
  if (exact.status !== "available") return { reviewerId, ...exact };

  const recovered = collectCodexNativeSessionResult(
    {
      sessionId: data.sessionId,
      reviewerId,
      modelApplied: data.modelApplied,
      reasoningApplied: data.reasoningApplied,
    },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      endedAt: observedAt,
      repoRoot: events[0].repo?.root,
    },
  );
  return inspectExactSession({
    reviewerId,
    exact,
    recovered,
    observedAt,
    staleAfterMs,
    activeAction:
      "Poll the same native reviewer handle after a bounded wait; do not send a follow-up or create a replacement reviewer.",
    stalledAction:
      "This native transcript has been quiet past the threshold. Compare the native handle status with this transcript, record the diagnostic, and retry once only after it is unavailable.",
  });
};

const deadlineStateFor = ({ inspection, softDeadlineMs, hardDeadlineMs }) => {
  if (inspection.lifecycle === "complete" || inspection.lifecycle === "unavailable")
    return { state: "terminal", elapsedMs: null };
  const elapsedMs = inspection.activeTaskElapsedMs;
  if (!Number.isFinite(elapsedMs)) return { state: "unknown", elapsedMs: null };
  if (elapsedMs >= hardDeadlineMs) return { state: "hard_exceeded", elapsedMs };
  if (elapsedMs >= softDeadlineMs) return { state: "soft_exceeded", elapsedMs };
  return { state: "within_budget", elapsedMs };
};

/**
 * Inspects every launched reviewer at one instant and applies only
 * observational soft/hard deadline states. It never interrupts a worker.
 */
export const inspectReviewerSessions = ({
  logPath,
  sessionsRoot,
  timestamp,
  staleAfterMs = 120_000,
  softDeadlineMs = 600_000,
  hardDeadlineMs = 1_200_000,
  recordObservations = false,
} = {}) => {
  if (!logPath) fail("logPath is required");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) fail("staleAfterMs must be a non-negative finite number");
  if (!Number.isFinite(softDeadlineMs) || softDeadlineMs < 0)
    fail("softDeadlineMs must be a non-negative finite number");
  if (!Number.isFinite(hardDeadlineMs) || hardDeadlineMs < softDeadlineMs)
    fail("hardDeadlineMs must be a finite number no smaller than softDeadlineMs");

  const { events } = runIdentity(logPath);
  const observedAt = isoTimestamp(timestamp);
  const latestStarts = new Map();
  for (const event of events) {
    if (event.event !== "reviewer_session_started") continue;
    const reviewerId = canonicalReviewerId(event.data);
    const launchMechanism = event.data?.launchMechanism;
    if (!reviewerId || !["native", "codex_cli"].includes(launchMechanism)) continue;
    latestStarts.set(reviewerId, launchMechanism);
  }

  const reviewers = [...latestStarts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reviewerId, launchMechanism]) => {
      const inspection =
        launchMechanism === "native"
          ? inspectCodexNativeReviewerSession({
              logPath,
              reviewerId,
              sessionsRoot,
              timestamp: observedAt,
              staleAfterMs,
            })
          : inspectCodexCliReviewerSession({
              logPath,
              reviewerId,
              sessionsRoot,
              timestamp: observedAt,
              staleAfterMs,
            });
      const { lastAgentMessage, ...diagnostic } = inspection;
      return {
        launchMechanism,
        ...diagnostic,
        ...(typeof lastAgentMessage === "string" ? { hasRecoveredFinalAnswer: true } : {}),
        deadline: deadlineStateFor({ inspection: diagnostic, softDeadlineMs, hardDeadlineMs }),
      };
    });
  if (recordObservations) {
    for (const reviewer of reviewers) {
      appendEvent({
        logPath,
        event: "reviewer_session_observed",
        data: {
          reviewerId: reviewer.reviewerId,
          sessionId: reviewer.sessionId,
          launchMechanism: reviewer.launchMechanism,
          lifecycle: reviewer.lifecycle,
          lastActivityAt: reviewer.lastActivityAt,
          quietForMs: reviewer.quietForMs,
          activeTaskElapsedMs: reviewer.activeTaskElapsedMs,
          timingBasis: reviewer.timingBasis,
          deadlineState: reviewer.deadline.state,
          deadlineMs:
            reviewer.deadline.state === "hard_exceeded"
              ? hardDeadlineMs
              : reviewer.deadline.state === "soft_exceeded"
                ? softDeadlineMs
                : null,
        },
      });
    }
  }
  const count = (predicate) => reviewers.filter(predicate).length;
  return {
    observedAt,
    staleAfterMs,
    softDeadlineMs,
    hardDeadlineMs,
    observationsRecorded: recordObservations ? reviewers.length : 0,
    reviewers,
    summary: {
      reviewerCount: reviewers.length,
      activeCount: count((reviewer) => reviewer.lifecycle === "active"),
      stalledCount: count((reviewer) => reviewer.lifecycle === "stalled"),
      completeCount: count((reviewer) => reviewer.lifecycle === "complete"),
      unavailableCount: count((reviewer) => reviewer.lifecycle === "unavailable"),
      softExceededReviewerIds: reviewers
        .filter((reviewer) => reviewer.deadline.state === "soft_exceeded")
        .map((reviewer) => reviewer.reviewerId),
      hardExceededReviewerIds: reviewers
        .filter((reviewer) => reviewer.deadline.state === "hard_exceeded")
        .map((reviewer) => reviewer.reviewerId),
    },
  };
};

/**
 * Starts one persistent, read-only CLI reviewer and records its thread ID as
 * soon as Codex emits it. The raw JSON stream stays outside the structured run
 * log so review bodies and diagnostics are not copied into telemetry.
 */
export const launchCodexCliReviewer = async ({
  logPath,
  reviewerId,
  model,
  reasoning,
  promptFile,
  outputFile,
  sessionsRoot,
  codexCommand = "codex",
} = {}) => {
  if (!logPath || !reviewerId || !model || !reasoning || !promptFile || !outputFile) {
    fail("logPath, reviewerId, model, reasoning, promptFile, and outputFile are required");
  }
  if (!existsSync(promptFile)) fail(`promptFile does not exist: ${promptFile}`);
  if (existsSync(outputFile)) fail(`outputFile already exists: ${outputFile}`);

  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, "", { encoding: "utf8", flag: "wx" });
  const prompt = readFileSync(promptFile);
  const args = [
    "exec",
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    "-c",
    'approval_policy="never"',
    "--strict-config",
    "--sandbox",
    "read-only",
    "--json",
    "-",
  ];
  const child = spawn(codexCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuffer = "";
  let sessionId = null;
  let launchRecorded = false;
  let stderrBytes = 0;

  const recordThreadStarted = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type !== "thread.started" || typeof message.thread_id !== "string" || launchRecorded) return;
    sessionId = message.thread_id;
    appendEvent({
      logPath,
      event: "reviewer_session_started",
      data: {
        reviewerId,
        launchMechanism: "codex_cli",
        sessionId,
        modelRequested: model,
        reasoningRequested: reasoning,
      },
    });
    launchRecorded = true;
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    appendFileSync(outputFile, text, "utf8");
    stdoutBuffer += text;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      recordThreadStarted(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  child.stdin.end(prompt);

  const close = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ exitCode: null, signal: null, errorMessage: error.message }));
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
  if (stdoutBuffer.length > 0) recordThreadStarted(stdoutBuffer);

  if (!sessionId) {
    const reason = close.errorMessage
      ? "codex CLI could not start before emitting thread.started"
      : "codex CLI exited without emitting thread.started";
    appendEvent({
      logPath,
      event: "reviewer_session_failed",
      data: {
        reviewerId,
        phase: "initial",
        reason,
        clientExitCode: close.exitCode,
        clientSignal: close.signal,
      },
    });
    return {
      reviewerId,
      status: "unavailable",
      reason,
      clientExitCode: close.exitCode,
      clientSignal: close.signal,
      outputFile,
      stderrBytes,
    };
  }

  const { events } = runIdentity(logPath);
  const exact = exactCliSessionData(
    { sessionId },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      repoRoot: events[0].repo?.root,
    },
  );
  if (exact.status === "available") {
    appendEvent({
      logPath,
      event: "reviewer_session_controls_verified",
      data: {
        reviewerId,
        sessionId,
        modelApplied: exact.controls.model,
        reasoningApplied: exact.controls.reasoning,
      },
    });
  } else {
    appendEvent({
      logPath,
      event: "reviewer_session_observed",
      data: {
        reviewerId,
        lifecycle: "unavailable",
        reason: exact.reason,
      },
    });
  }

  const inspection = inspectCodexCliReviewerSession({ logPath, reviewerId, sessionsRoot });
  return {
    reviewerId,
    sessionId,
    clientExitCode: close.exitCode,
    clientSignal: close.signal,
    outputFile,
    stderrBytes,
    inspection,
  };
};

export const recoverCodexCliReviewerResult = ({ logPath, reviewerId, sessionsRoot, timestamp } = {}) => {
  if (!logPath) fail("logPath is required");
  if (!reviewerId) fail("reviewerId is required");
  const { events } = runIdentity(logPath);
  const start = latestReviewerSessionStart(events, reviewerId, "codex_cli");
  if (!start) {
    return {
      status: "unavailable",
      reason: "no codex_cli reviewer session start exists for this reviewer",
      reviewerId,
    };
  }

  const data = start.data;
  return {
    reviewerId,
    ...collectCodexCliSessionResult(
      {
        sessionId: data.sessionId,
        modelApplied: data.modelApplied,
        reasoningApplied: data.reasoningApplied,
      },
      {
        sessionsRoot,
        startedAt: events[0].timestamp,
        endedAt: timestamp || new Date().toISOString(),
        repoRoot: events[0].repo?.root,
      },
    ),
  };
};

export const collectCodexSessionUsage = (
  summary,
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  assertObject(summary, "summary");
  const reviewers = Array.isArray(summary.reviewers) ? summary.reviewers : [];
  if (!startedAt || !repoRoot || reviewers.length === 0) {
    return {
      summary,
      collection: {
        status: "unavailable",
        reason: "startedAt, repoRoot, and reviewers are required",
      },
    };
  }

  const startTime = new Date(startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  const files = sessionFilesForWindow(resolve(expandHome(sessionsRoot)), startedAt, endedAt);
  const nativeReviewers = reviewers.filter(
    (reviewer) => reviewer.launchMechanism === "native" || (!reviewer.launchMechanism && !reviewer.expected),
  );
  const nativeCandidates = files
    .map((path) => ({ path, record: readFirstJsonLine(path) }))
    .filter(({ record }) => record?.type === "session_meta" && record.payload?.source?.subagent?.thread_spawn)
    .map(({ path, record }) => {
      const payload = record.payload;
      const spawn = payload.source.subagent.thread_spawn;
      return {
        path,
        sessionId: payload.id || null,
        parentThreadId: spawn.parent_thread_id || payload.parent_thread_id || null,
        agentPath: spawn.agent_path || payload.agent_path || "",
        agentName: basename(spawn.agent_path || payload.agent_path || ""),
        cwd: payload.cwd,
        timestamp: payload.timestamp || record.timestamp,
      };
    })
    .filter((candidate) => {
      const timestamp = new Date(candidate.timestamp).getTime();
      return (
        nativeReviewers.some((reviewer, index) => nativeCandidateMatchesReviewer(candidate, reviewer, index)) &&
        resolve(candidate.cwd || "/") === resolve(repoRoot) &&
        timestamp >= startTime &&
        timestamp <= endTime
      );
    });

  const groups = new Map();
  for (const candidate of nativeCandidates) {
    if (!groups.has(candidate.parentThreadId)) groups.set(candidate.parentThreadId, []);
    groups.get(candidate.parentThreadId).push(candidate);
  }

  const matchingGroups = nativeReviewers.length
    ? [...groups.entries()].filter(([, group]) =>
        nativeReviewers.every((reviewer, index) => {
          const matches = group.filter((candidate) => nativeCandidateMatchesReviewer(candidate, reviewer, index));
          return matches.length === 1;
        }),
      )
    : [];

  const nativeCandidatesByReviewer = new Map();
  let parentThreadId = null;
  let nativeReason = null;
  if (nativeReviewers.length > 0) {
    if (matchingGroups.length === 1) {
      [parentThreadId] = matchingGroups[0];
      for (const [index, reviewer] of nativeReviewers.entries()) {
        const reviewerId = reviewer.reviewerId;
        const candidate = matchingGroups[0][1].find((entry) => nativeCandidateMatchesReviewer(entry, reviewer, index));
        nativeCandidatesByReviewer.set(reviewerId, candidate);
      }
    } else {
      nativeReason =
        matchingGroups.length === 0
          ? "no unambiguous native reviewer session cohort matched the run"
          : "multiple native reviewer session cohorts matched the run";
    }
  }

  const cliCandidatesByReviewer = new Map();
  const cliReasonsByReviewer = new Map();
  for (const reviewer of reviewers.filter((entry) => entry.launchMechanism === "codex_cli")) {
    const exact = exactCliSessionData(
      {
        sessionId: reviewer.sessionId || reviewer.sessionIdentifier,
        modelApplied: reviewer.modelApplied,
        reasoningApplied: reviewer.reasoningApplied,
      },
      { sessionsRoot, startedAt, endedAt, repoRoot },
    );
    if (exact.status === "available") cliCandidatesByReviewer.set(reviewer.reviewerId, exact.candidate);
    else cliReasonsByReviewer.set(reviewer.reviewerId, exact.reason);
  }

  const enrichReviewer = (reviewer, index, candidate, source, reason) => {
    const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`;
    const expectedInvocationCount = invocationsFor(reviewer).length;
    if (!candidate) {
      return {
        reviewer,
        collected: {
          reviewerId,
          source,
          expectedInvocationCount,
          observedInvocationCount: null,
          completedInvocationCount: null,
          collected: false,
          durationCollected: false,
          reason: reason || "reviewer has no captured session",
        },
      };
    }
    const usage = codexSessionUsage(candidate.path);
    const valid =
      usage.tokenUsage &&
      expectedInvocationCount > 0 &&
      usage.invocationCount === expectedInvocationCount &&
      usage.completedInvocationCount === expectedInvocationCount;
    const durationValid =
      usage.durationMs !== null &&
      expectedInvocationCount > 0 &&
      usage.invocationCount === expectedInvocationCount &&
      usage.completedInvocationCount === expectedInvocationCount;
    return {
      reviewer: {
        ...reviewer,
        sessionId: candidate.sessionId || reviewer.sessionId,
        ...(valid
          ? {
              sessionTokenUsage: usage.tokenUsage,
              sessionTokenUsageSource: "codex_rollout_token_count",
            }
          : {}),
        ...(durationValid
          ? {
              sessionDurationMs: usage.durationMs,
              sessionDurationSource: "codex_rollout_task_duration",
            }
          : {}),
      },
      collected: {
        reviewerId,
        source,
        sessionId: candidate.sessionId || reviewer.sessionId || null,
        expectedInvocationCount,
        observedInvocationCount: usage.invocationCount,
        completedInvocationCount: usage.completedInvocationCount,
        collected: Boolean(valid),
        durationCollected: durationValid,
        ...(valid || durationValid
          ? {}
          : {
              reason:
                expectedInvocationCount === 0
                  ? "reviewer has no recorded completed or continuity invocation"
                  : "session invocation count does not match the reviewer ledger",
            }),
      },
    };
  };

  const enriched = reviewers.map((reviewer, index) => {
    const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`;
    if (reviewer.launchMechanism === "native" || (!reviewer.launchMechanism && !reviewer.expected)) {
      return enrichReviewer(reviewer, index, nativeCandidatesByReviewer.get(reviewerId), "native", nativeReason);
    }
    if (reviewer.launchMechanism === "codex_cli") {
      return enrichReviewer(
        reviewer,
        index,
        cliCandidatesByReviewer.get(reviewerId),
        "codex_cli",
        cliReasonsByReviewer.get(reviewerId),
      );
    }
    return enrichReviewer(
      reviewer,
      index,
      null,
      "unavailable",
      reviewer.expected ? "reviewer was expected but no reviewer_session_started event was recorded" : undefined,
    );
  });

  const enrichedReviewers = enriched.map((entry) => entry.reviewer);
  const collected = enriched.map((entry) => entry.collected);
  const collectedCount = collected.filter((reviewer) => reviewer.collected).length;
  return {
    summary: { ...summary, reviewers: enrichedReviewers },
    collection: {
      status: collectedCount === reviewers.length ? "complete" : collectedCount > 0 ? "partial" : "unavailable",
      ...(parentThreadId ? { parentThreadId } : {}),
      reviewerCount: reviewers.length,
      collectedCount,
      ...(nativeReason ? { nativeReason, nativeCandidateGroupCount: matchingGroups.length } : {}),
      reviewers: collected,
    },
  };
};

export const startRun = ({ repoRoot, outputRoot, configuration = {}, timestamp, runId = randomUUID() } = {}) => {
  assertObject(configuration, "configuration");
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail("runId may contain only letters, numbers, dots, underscores, and hyphens");

  const createdAt = isoTimestamp(timestamp);
  const date = new Date(createdAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const root = resolve(
    expandHome(
      outputRoot || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "log", "review-fix-address-bots"),
    ),
  );
  const directory = join(root, year, month, day);
  const filenameTimestamp = createdAt.replace(/[:.]/g, "-");
  const logPath = join(directory, `review-run-${filenameTimestamp}-${runId}.jsonl`);
  const repo = discoverRepo(repoRoot);

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    logPath,
    `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      runId,
      timestamp: createdAt,
      event: "run_started",
      skill: {
        name: "review-fix-address-bots",
        fingerprintSha256: skillFingerprint(),
      },
      repo,
      git: discoverGitState(repo.root),
      configuration,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  return { logPath, runId };
};

export const appendEvent = ({ logPath, event, data = {}, timestamp } = {}) => {
  if (!logPath) fail("logPath is required");
  if (!event || !/^[a-z][a-z0-9_]*$/.test(event)) fail("event must be lower_snake_case");
  if (event === "run_started" || event === "run_finished") fail(`Use the dedicated command for ${event}`);
  assertObject(data, "data");

  const { events, runId } = runIdentity(logPath);
  if (events.some((item) => item.event === "run_finished")) fail(`Run is already finished: ${logPath}`);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    timestamp: isoTimestamp(timestamp),
    event,
    data,
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
};

const findingIdsFor = (reviewer, phase) => {
  const rounds = Array.isArray(reviewer.rounds) ? reviewer.rounds : [];
  const ids = rounds
    .filter((round) => !phase || round.phase === phase)
    .flatMap((round) => (Array.isArray(round.findingIds) ? round.findingIds : []))
    .filter((id) => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
};

const overlapFor = (reviewers, phase) => {
  const entries = reviewers.map((reviewer, index) => ({
    reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
    findingIds: findingIdsFor(reviewer, phase),
  }));
  const frequency = new Map();
  for (const entry of entries) {
    for (const findingId of entry.findingIds) frequency.set(findingId, (frequency.get(findingId) || 0) + 1);
  }

  const pairs = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      const leftSet = new Set(left.findingIds);
      const rightSet = new Set(right.findingIds);
      const sharedFindingIds = left.findingIds.filter((id) => rightSet.has(id));
      const onlyLeftFindingIds = left.findingIds.filter((id) => !rightSet.has(id));
      const onlyRightFindingIds = right.findingIds.filter((id) => !leftSet.has(id));
      const unionSize = new Set([...left.findingIds, ...right.findingIds]).size;
      pairs.push({
        leftReviewerId: left.reviewerId,
        rightReviewerId: right.reviewerId,
        sharedFindingIds,
        onlyLeftFindingIds,
        onlyRightFindingIds,
        jaccard: unionSize === 0 ? null : Number((sharedFindingIds.length / unionSize).toFixed(4)),
      });
    }
  }

  const uniqueFindingIds = [...frequency.keys()].sort();
  return {
    basis: phase ? `${phase} rounds` : "all rounds",
    uniqueFindingIds,
    allReviewersSharedFindingIds:
      entries.length === 0 ? [] : uniqueFindingIds.filter((findingId) => frequency.get(findingId) === entries.length),
    uniqueByReviewer: entries.map((entry) => ({
      reviewerId: entry.reviewerId,
      findingIds: entry.findingIds.filter((findingId) => frequency.get(findingId) === 1),
    })),
    pairs,
  };
};

const invocationsFor = (reviewer) => {
  const rounds = Array.isArray(reviewer.rounds) ? reviewer.rounds : [];
  const continuityChecks = Array.isArray(reviewer.continuityChecks)
    ? reviewer.continuityChecks.map((check) => ({ ...check, phase: "continuity" }))
    : [];
  return [...rounds, ...continuityChecks];
};

const stringArray = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];

const canonicalReviewerId = (value) =>
  typeof value?.reviewerId === "string"
    ? value.reviewerId
    : typeof value?.reviewer === "string"
      ? value.reviewer
      : null;

const durationFrom = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? { durationMs: value } : {};

const canonicalFinding = (finding) => {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return null;
  const findingId =
    typeof finding.findingId === "string" ? finding.findingId : typeof finding.id === "string" ? finding.id : null;
  return findingId ? { ...finding, findingId } : null;
};

export const canonicalSummaryFromEvents = (events, summary) => {
  const suppliedReviewers = Array.isArray(summary.reviewers) ? summary.reviewers : [];
  const reviewerById = new Map();

  for (const reviewer of suppliedReviewers) {
    const reviewerId = canonicalReviewerId(reviewer);
    if (!reviewerId) continue;
    reviewerById.set(reviewerId, {
      ...reviewer,
      reviewerId,
      continuityChecks: Array.isArray(reviewer.continuityChecks) ? [...reviewer.continuityChecks] : [],
      rounds: Array.isArray(reviewer.rounds) ? [...reviewer.rounds] : [],
      ...(reviewer.modelApplied === undefined && typeof reviewer.model === "string"
        ? { modelApplied: reviewer.model }
        : {}),
      ...(reviewer.reasoningApplied === undefined && typeof reviewer.reasoning === "string"
        ? { reasoningApplied: reviewer.reasoning }
        : {}),
    });
  }

  const ensureReviewer = (reviewerId) => {
    const existing = reviewerById.get(reviewerId);
    if (existing) return existing;
    const reviewer = { reviewerId, continuityChecks: [], rounds: [] };
    reviewerById.set(reviewerId, reviewer);
    return reviewer;
  };

  const addRound = (reviewer, round) => {
    const existing = reviewer.rounds.find((entry) => entry.phase === round.phase && entry.round === round.round);
    if (!existing) {
      reviewer.rounds.push(round);
      return;
    }
    if (round.findingIds.length > 0 || existing.findingIds.length === 0) existing.findingIds = round.findingIds;
    if (round.tokenUsage !== null) existing.tokenUsage = round.tokenUsage;
    if (round.durationMs !== undefined) existing.durationMs = round.durationMs;
  };

  for (const event of events) {
    const data = event.data || {};
    const reviewerId = canonicalReviewerId(data);
    if (!reviewerId) continue;
    const reviewer = ensureReviewer(reviewerId);

    if (event.event === "reviewer_session_started") {
      Object.assign(reviewer, {
        ...(typeof data.launchMechanism === "string" ? { launchMechanism: data.launchMechanism } : {}),
        ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
        ...(typeof data.modelRequested === "string" ? { modelRequested: data.modelRequested } : {}),
        ...(typeof data.modelApplied === "string" ? { modelApplied: data.modelApplied } : {}),
        ...(typeof data.reasoningRequested === "string" ? { reasoningRequested: data.reasoningRequested } : {}),
        ...(typeof data.reasoningApplied === "string" ? { reasoningApplied: data.reasoningApplied } : {}),
      });
      continue;
    }

    if (event.event === "reviewer_session_controls_verified") {
      Object.assign(reviewer, {
        ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
        ...(typeof data.modelApplied === "string" ? { modelApplied: data.modelApplied } : {}),
        ...(typeof data.reasoningApplied === "string" ? { reasoningApplied: data.reasoningApplied } : {}),
      });
      continue;
    }

    if (event.event === "reviewer_pass_completed" || event.event === "remediation_reviewer_pass_completed") {
      addRound(reviewer, {
        phase: event.event === "reviewer_pass_completed" ? "initial" : "remediation",
        round: typeof data.round === "number" ? data.round : 1,
        findingIds: stringArray(data.findingIds ?? data.finding_ids),
        tokenUsage: data.tokenUsage ?? null,
        ...durationFrom(data.durationMs),
      });
      continue;
    }

    if (event.event === "reviewer_continuity_verified") {
      reviewer.continuityVerified = true;
      const round = typeof data.round === "number" ? data.round : 1;
      const existing = reviewer.continuityChecks.find((entry) => entry.round === round);
      if (!existing) {
        reviewer.continuityChecks.push({
          round,
          verified: true,
          tokenUsage: data.tokenUsage ?? null,
          ...durationFrom(data.durationMs),
        });
      } else {
        existing.verified = true;
        if (data.tokenUsage !== null && data.tokenUsage !== undefined) existing.tokenUsage = data.tokenUsage;
        if (typeof data.durationMs === "number") existing.durationMs = data.durationMs;
      }
      continue;
    }

    if (
      event.event === "reviewer_pass_failed" ||
      event.event === "reviewer_continuity_failed" ||
      event.event === "reviewer_session_failed" ||
      event.event === "reviewer_session_cancelled"
    ) {
      reviewer.failure = {
        phase:
          typeof data.phase === "string"
            ? data.phase
            : event.event === "reviewer_continuity_failed"
              ? "continuity"
              : "initial",
        reason:
          typeof data.reason === "string"
            ? data.reason
            : typeof data.failureReason === "string"
              ? data.failureReason
              : "reviewer invocation failed",
      };
      if (event.event === "reviewer_session_cancelled") reviewer.sessionLifecycle = "cancelled";
      continue;
    }

    if (event.event === "reviewer_session_observed" && typeof data.lifecycle === "string") {
      reviewer.sessionLifecycle = data.lifecycle;
    }
  }

  const findingsById = new Map();
  for (const finding of Array.isArray(summary.findings) ? summary.findings : []) {
    const canonical = canonicalFinding(finding);
    if (canonical) findingsById.set(canonical.findingId, canonical);
  }
  for (const event of events) {
    if (event.event !== "finding_resolved") continue;
    const finding = canonicalFinding({
      ...event.data,
      findingId: event.data?.findingId ?? event.data?.finding_id,
      reportedBy: event.data?.reportedBy ?? event.data?.reporters,
      action: event.data?.action ?? "fixed",
    });
    if (finding && !findingsById.has(finding.findingId)) findingsById.set(finding.findingId, finding);
  }

  return {
    ...summary,
    reviewers: [...reviewerById.values()].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId)),
    findings: [...findingsById.values()],
  };
};

const reviewerIdBaseForModel = (model) => {
  const normalized = typeof model === "string" ? model.replace(/^gpt-[\d.]+-/, "") : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(normalized) ? normalized : "reviewer";
};

const expectedReviewersFromConfiguration = (configuration = {}) => {
  const requestedCohort = Array.isArray(configuration.reviewerCohortRequested)
    ? configuration.reviewerCohortRequested
    : [];
  const expected = [];
  const ordinals = new Map();
  for (const entry of requestedCohort) {
    if (!entry || typeof entry.model !== "string") continue;
    const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 0;
    const base = reviewerIdBaseForModel(entry.model);
    const ordinal = ordinals.get(base) || 0;
    for (let index = 1; index <= count; index += 1) {
      expected.push({ reviewerId: `${base}-${ordinal + index}`, modelRequested: entry.model });
    }
    ordinals.set(base, ordinal + count);
  }
  if (expected.length > 0) return expected;

  const count =
    Number.isInteger(configuration.requestedReviewerCount) && configuration.requestedReviewerCount > 0
      ? configuration.requestedReviewerCount
      : 0;
  return Array.from({ length: count }, (_, index) => ({ reviewerId: `reviewer-${index + 1}` }));
};

const includeExpectedReviewers = (summary, configuration) => {
  const reviewers = Array.isArray(summary.reviewers) ? [...summary.reviewers] : [];
  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer.reviewerId, reviewer]));
  for (const expected of expectedReviewersFromConfiguration(configuration)) {
    const existing = reviewerById.get(expected.reviewerId);
    if (existing) {
      if (!existing.launchMechanism) {
        existing.expected = true;
        if (!existing.modelRequested) existing.modelRequested = expected.modelRequested;
        if (!existing.reasoningRequested && typeof configuration.reasoningRequested === "string")
          existing.reasoningRequested = configuration.reasoningRequested;
      }
      continue;
    }
    reviewers.push({
      ...expected,
      expected: true,
      ...(typeof configuration.reasoningRequested === "string"
        ? { reasoningRequested: configuration.reasoningRequested }
        : {}),
      continuityChecks: [],
      rounds: [],
    });
  }
  return {
    ...summary,
    reviewers: reviewers.sort((left, right) => left.reviewerId.localeCompare(right.reviewerId)),
  };
};

export const validateFinishSummary = (summary) => {
  const status = summary.status || "complete";
  if (!new Set(["complete", "partial", "blocked", "failed"]).has(status)) {
    fail("finish summary status must be complete, partial, blocked, or failed");
  }
  const reviewers = Array.isArray(summary.reviewers) ? summary.reviewers : [];
  if (reviewers.length === 0) fail("finish summary must include at least one reviewer");

  for (const reviewer of reviewers) {
    if (typeof reviewer.reviewerId !== "string" || reviewer.reviewerId.length === 0) {
      fail("finish summary reviewer is missing reviewerId");
    }
    if (status !== "complete") continue;
    const requiredFields = [
      "launchMechanism",
      "sessionId",
      "modelRequested",
      "modelApplied",
      "reasoningRequested",
      "reasoningApplied",
    ];
    const missing = requiredFields.filter(
      (field) => typeof reviewer[field] !== "string" || reviewer[field].length === 0,
    );
    if (missing.length > 0) {
      fail(`finish summary reviewer ${reviewer.reviewerId || "<unknown>"} is missing ${missing.join(", ")}`);
    }
    if (!Array.isArray(reviewer.rounds) || reviewer.rounds.length === 0) {
      fail(`finish summary reviewer ${reviewer.reviewerId} has no recorded review rounds`);
    }
    if (!Array.isArray(reviewer.continuityChecks) || reviewer.continuityChecks.length === 0) {
      fail(`finish summary reviewer ${reviewer.reviewerId} has no continuity check`);
    }
  }
};

const tokenMetrics = (reviewers, phase) => {
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  const fieldCoverage = Object.fromEntries(fields.map((field) => [field, 0]));
  let invocationCount = 0;
  let invocationsWithUsage = 0;

  for (const reviewer of reviewers) {
    for (const round of invocationsFor(reviewer)) {
      if (phase && round.phase !== phase) continue;
      invocationCount += 1;
      const usage = round.tokenUsage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
      let foundValue = false;
      for (const field of fields) {
        if (typeof usage[field] === "number" && Number.isFinite(usage[field])) {
          totals[field] += usage[field];
          fieldCoverage[field] += 1;
          foundValue = true;
        }
      }
      if (foundValue) invocationsWithUsage += 1;
    }
  }

  return {
    invocationCount,
    invocationsWithUsage,
    complete: invocationCount > 0 && invocationCount === invocationsWithUsage,
    fieldCoverage,
    totals:
      invocationsWithUsage > 0
        ? Object.fromEntries(fields.filter((field) => fieldCoverage[field] > 0).map((field) => [field, totals[field]]))
        : null,
  };
};

const metricsForSessionUsage = (usage) => {
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  const fieldCoverage = Object.fromEntries(fields.map((field) => [field, typeof usage?.[field] === "number" ? 1 : 0]));
  const totals = Object.fromEntries(
    fields.filter((field) => fieldCoverage[field]).map((field) => [field, usage[field]]),
  );
  return {
    invocationCount: 1,
    invocationsWithUsage: Object.keys(totals).length > 0 ? 1 : 0,
    complete: fields.every((field) => fieldCoverage[field] === 1),
    fieldCoverage,
    totals: Object.keys(totals).length > 0 ? totals : null,
    source: "session",
  };
};

const reviewerDurationMs = (reviewer) => {
  if (
    typeof reviewer.sessionDurationMs === "number" &&
    Number.isFinite(reviewer.sessionDurationMs) &&
    reviewer.sessionDurationMs >= 0
  ) {
    return reviewer.sessionDurationMs;
  }

  const invocations = invocationsFor(reviewer);
  if (invocations.length === 0) return null;
  let durationMs = 0;
  for (const invocation of invocations) {
    if (
      typeof invocation.durationMs !== "number" ||
      !Number.isFinite(invocation.durationMs) ||
      invocation.durationMs < 0
    ) {
      return null;
    }
    durationMs += invocation.durationMs;
  }
  return durationMs;
};

const durationMetrics = (reviewers) => {
  let invocationCount = 0;
  let reviewersWithDuration = 0;
  let durationMs = 0;

  for (const reviewer of reviewers) {
    invocationCount += invocationsFor(reviewer).length;
    const reviewerDuration = reviewerDurationMs(reviewer);
    if (reviewerDuration !== null) {
      reviewersWithDuration += 1;
      durationMs += reviewerDuration;
    }
  }

  return {
    invocationCount,
    reviewersWithDuration,
    complete: reviewers.length > 0 && reviewersWithDuration === reviewers.length,
    durationMs: reviewersWithDuration > 0 ? durationMs : null,
  };
};

export const estimateTokenCost = (model, metrics) => {
  const rates = PRICING_SNAPSHOT.ratesPerMillionTokens[model];
  const totals = metrics?.totals;
  if (!rates || !totals || !metrics || metrics.invocationCount === 0) return null;

  const requiredFields = ["inputTokens", "cachedInputTokens", "outputTokens"];
  if (requiredFields.some((field) => metrics.fieldCoverage?.[field] !== metrics.invocationCount)) return null;

  const { inputTokens, cachedInputTokens, outputTokens } = totals;
  if (
    ![inputTokens, cachedInputTokens, outputTokens].every((value) => Number.isFinite(value) && value >= 0) ||
    cachedInputTokens > inputTokens
  ) {
    return null;
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const estimatedUsd =
    (uncachedInputTokens * rates.input + cachedInputTokens * rates.cachedInput + outputTokens * rates.output) /
    1_000_000;

  return Number(estimatedUsd.toFixed(6));
};

const reviewerUsage = (reviewers) =>
  reviewers.map((reviewer, index) => {
    const model = reviewer.modelApplied || "unknown";
    const tokenUsage = reviewer.sessionTokenUsage
      ? metricsForSessionUsage(reviewer.sessionTokenUsage)
      : tokenMetrics([reviewer]);
    const duration = reviewerDurationMs(reviewer);
    return {
      reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
      model,
      reasoning: reviewer.reasoningApplied || "unknown",
      tokenUsage,
      estimatedCostUsd: estimateTokenCost(model, tokenUsage),
      durationMs: duration,
    };
  });

const costMetrics = (usageByReviewer) => {
  const estimates = usageByReviewer.filter((reviewer) => reviewer.estimatedCostUsd !== null);
  const complete = usageByReviewer.length > 0 && estimates.length === usageByReviewer.length;
  const estimatedKnownUsd =
    estimates.length > 0
      ? Number(estimates.reduce((total, reviewer) => total + reviewer.estimatedCostUsd, 0).toFixed(6))
      : null;
  return {
    currency: PRICING_SNAPSHOT.currency,
    pricing: PRICING_SNAPSHOT,
    reviewerCount: usageByReviewer.length,
    reviewersWithEstimate: estimates.length,
    complete,
    estimatedKnownUsd,
    estimatedTotalUsd: complete ? estimatedKnownUsd : null,
  };
};

const formatInteger = (value) => (Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : "n/a");
const formatCost = (value) => (Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a");
const formatDuration = (value) => {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  const seconds = Math.round(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
};
const reviewerLabel = (reviewerId, reasoning) => {
  const parts = reviewerId.split("-");
  if (parts.length > 1 && /^\d+$/.test(parts.at(-1))) {
    parts.splice(-2, 2, `${parts.at(-2)}${parts.at(-1)}`);
  }
  const name = parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
  return `${name} (${reasoning || "unknown"})`;
};

export const reviewersMissingTelemetry = (derived) =>
  (() => {
    const reviewers = Array.isArray(derived?.reviewerUsage) ? derived.reviewerUsage : [];
    if (reviewers.length === 0) return ["no-reviewers"];
    return reviewers
      .filter((reviewer) => {
        const usage = reviewer.tokenUsage?.totals || {};
        const hasTokens = [
          "inputTokens",
          "cachedInputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "totalTokens",
        ].some((field) => Number.isFinite(usage[field]));
        const hasDuration = Number.isFinite(reviewer.durationMs) && reviewer.durationMs >= 0;
        return !hasTokens && !hasDuration;
      })
      .map((reviewer) => reviewer.reviewerId || "unknown-reviewer");
  })();

export const renderUsageTable = (derived) => {
  const reviewers = Array.isArray(derived?.reviewerUsage) ? derived.reviewerUsage : [];
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  if (reviewersMissingTelemetry(derived).length > 0) return "";
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  const coverage = Object.fromEntries(fields.map((field) => [field, 0]));
  let totalDurationMs = 0;
  let durationCoverage = 0;

  const rows = reviewers.map((reviewer) => {
    const usage = reviewer.tokenUsage?.totals || {};
    for (const field of fields) {
      if (Number.isFinite(usage[field])) {
        totals[field] += usage[field];
        coverage[field] += 1;
      }
    }
    if (Number.isFinite(reviewer.durationMs) && reviewer.durationMs >= 0) {
      totalDurationMs += reviewer.durationMs;
      durationCoverage += 1;
    }
    return `| ${reviewerLabel(reviewer.reviewerId, reviewer.reasoning)} | ${formatInteger(usage.inputTokens)} | ${formatInteger(usage.cachedInputTokens)} | ${formatInteger(usage.outputTokens)} | ${formatInteger(usage.reasoningOutputTokens)} | ${formatInteger(usage.totalTokens)} | ${formatCost(reviewer.estimatedCostUsd)} | ${formatDuration(reviewer.durationMs)} |`;
  });

  const totalCells = fields.map((field) =>
    formatInteger(reviewers.length > 0 && coverage[field] === reviewers.length ? totals[field] : null),
  );
  return [
    "| Reviewer | Input | Cached input | Output | Reasoning | Total | Estimated cost | Agent time |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    `| **Total** | **${totalCells[0]}** | **${totalCells[1]}** | **${totalCells[2]}** | **${totalCells[3]}** | **${totalCells[4]}** | **${formatCost(derived?.estimatedCost?.estimatedTotalUsd)}** | **${formatDuration(durationCoverage === reviewers.length && reviewers.length > 0 ? totalDurationMs : null)}** |`,
  ].join("\n");
};

const classificationCountsFor = (findingIds, findingsById) => {
  const counts = {};
  for (const findingId of findingIds) {
    const classification = findingsById.get(findingId)?.classification || "unclassified";
    counts[classification] = (counts[classification] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
};

const modelComparison = (reviewers, findings) => {
  const groups = new Map();
  reviewers.forEach((reviewer, index) => {
    const model = reviewer.modelApplied || "unknown";
    const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`;
    if (!groups.has(model)) groups.set(model, { model, reviewerIds: [], reviewers: [] });
    const group = groups.get(model);
    group.reviewerIds.push(reviewerId);
    group.reviewers.push(reviewer);
  });

  const findingsById = new Map(
    findings
      .filter((finding) => finding && typeof finding.findingId === "string" && finding.findingId.length > 0)
      .map((finding) => [finding.findingId, finding]),
  );
  const entries = [...groups.values()].map((group) => {
    const initialFindingIds = [
      ...new Set(group.reviewers.flatMap((reviewer) => findingIdsFor(reviewer, "initial"))),
    ].sort();
    const cumulativeFindingIds = [...new Set(group.reviewers.flatMap((reviewer) => findingIdsFor(reviewer)))].sort();
    return {
      ...group,
      initialFindingIds,
      cumulativeFindingIds,
      initialValidFindingIds: initialFindingIds.filter(
        (findingId) => findingsById.get(findingId)?.classification === "valid",
      ),
    };
  });

  const initialFrequency = new Map();
  for (const entry of entries) {
    for (const findingId of entry.initialFindingIds) {
      initialFrequency.set(findingId, (initialFrequency.get(findingId) || 0) + 1);
    }
  }

  const syntheticReviewers = entries.map((entry) => ({
    reviewerId: entry.model,
    rounds: [
      { phase: "initial", findingIds: entry.initialFindingIds },
      { phase: "remediation", findingIds: entry.cumulativeFindingIds },
    ],
  }));

  return {
    byModel: entries.map((entry) => {
      const initialTokenUsage = tokenMetrics(entry.reviewers, "initial");
      const cumulativeTokenUsage = tokenMetrics(entry.reviewers);
      return {
        model: entry.model,
        reviewerIds: entry.reviewerIds,
        reviewerCount: entry.reviewers.length,
        invocationCount: entry.reviewers.reduce((count, reviewer) => count + invocationsFor(reviewer).length, 0),
        initialFindingIds: entry.initialFindingIds,
        initialClassificationCounts: classificationCountsFor(entry.initialFindingIds, findingsById),
        initialValidFindingIds: entry.initialValidFindingIds,
        initialUniqueToModelFindingIds: entry.initialFindingIds.filter(
          (findingId) => initialFrequency.get(findingId) === 1,
        ),
        initialUniqueValidFindingIds: entry.initialValidFindingIds.filter(
          (findingId) => initialFrequency.get(findingId) === 1,
        ),
        cumulativeFindingIds: entry.cumulativeFindingIds,
        initialTokenUsage,
        cumulativeTokenUsage,
        initialEstimatedCostUsd: estimateTokenCost(entry.model, initialTokenUsage),
        cumulativeEstimatedCostUsd: estimateTokenCost(entry.model, cumulativeTokenUsage),
      };
    }),
    initialOverlap: overlapFor(syntheticReviewers, "initial"),
    cumulativeOverlap: overlapFor(syntheticReviewers),
  };
};

export const deriveMetrics = (summary = {}) => {
  assertObject(summary, "summary");
  const reviewers = Array.isArray(summary.reviewers) ? summary.reviewers : [];
  const findings = Array.isArray(summary.findings) ? summary.findings : [];
  const initialOverlap = overlapFor(reviewers, "initial");
  const cumulativeOverlap = overlapFor(reviewers);
  const githubReviewBots = Array.isArray(summary.githubReviewBots) ? summary.githubReviewBots : [];
  const usageByReviewer = reviewerUsage(reviewers);

  return {
    runStatus: typeof summary.status === "string" ? summary.status : "complete",
    reviewerSessionCount: reviewers.length,
    reviewerInvocationCount: reviewers.reduce((count, reviewer) => count + invocationsFor(reviewer).length, 0),
    continuityInvocationCount: reviewers.reduce(
      (count, reviewer) => count + (Array.isArray(reviewer.continuityChecks) ? reviewer.continuityChecks.length : 0),
      0,
    ),
    roundsByReviewer: reviewers.map((reviewer, index) => ({
      reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
      roundCount: Array.isArray(reviewer.rounds) ? reviewer.rounds.length : 0,
      continuityInvocationCount: Array.isArray(reviewer.continuityChecks) ? reviewer.continuityChecks.length : 0,
      invocationCount: invocationsFor(reviewer).length,
    })),
    reviewersWhoFoundIssues: reviewers
      .map((reviewer, index) => ({
        reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
        foundIssues: findingIdsFor(reviewer).length > 0,
      }))
      .filter((reviewer) => reviewer.foundIssues)
      .map((reviewer) => reviewer.reviewerId),
    initialUniqueFindingCount: initialOverlap.uniqueFindingIds.length,
    cumulativeUniqueFindingCount: cumulativeOverlap.uniqueFindingIds.length,
    initialOverlap,
    cumulativeOverlap,
    modelComparison: modelComparison(reviewers, findings),
    reviewerUsage: usageByReviewer,
    tokenUsage: tokenMetrics(reviewers),
    duration: durationMetrics(reviewers),
    estimatedCost: costMetrics(usageByReviewer),
    githubReviewBotCount: githubReviewBots.length,
    reviewBotLoopCount:
      typeof summary.reviewBotLoopCount === "number" && Number.isFinite(summary.reviewBotLoopCount)
        ? summary.reviewBotLoopCount
        : null,
  };
};

export const finishRun = ({ logPath, summary = {}, timestamp, collectCodexUsage = false, sessionsRoot } = {}) => {
  if (!logPath) fail("logPath is required");
  assertObject(summary, "summary");
  const { events, runId } = runIdentity(logPath);
  if (events.some((item) => item.event === "run_finished")) fail(`Run is already finished: ${logPath}`);
  let finalSummary = canonicalSummaryFromEvents(events, summary);
  finalSummary = includeExpectedReviewers(finalSummary, events[0].configuration);
  validateFinishSummary(finalSummary);
  let tokenUsageCollection = null;
  if (collectCodexUsage) {
    const first = events[0];
    const result = collectCodexSessionUsage(finalSummary, {
      sessionsRoot,
      startedAt: first.timestamp,
      endedAt: timestamp || new Date().toISOString(),
      repoRoot: first.repo?.root,
    });
    finalSummary = result.summary;
    tokenUsageCollection = result.collection;
  }
  const derived = deriveMetrics(finalSummary);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    timestamp: isoTimestamp(timestamp),
    event: "run_finished",
    data: { ...finalSummary, ...(tokenUsageCollection ? { tokenUsageCollection } : {}), derived },
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
};

export const diagnoseCodexUsage = ({ logPath, sessionsRoot, timestamp } = {}) => {
  if (!logPath) fail("logPath is required");
  const { events } = runIdentity(logPath);
  const finished = [...events].reverse().find((event) => event.event === "run_finished");
  if (!finished) fail(`Run is not finished: ${logPath}`);
  const result = collectCodexSessionUsage(
    { reviewers: finished.data?.reviewers || [] },
    {
      sessionsRoot,
      startedAt: events[0].timestamp,
      endedAt: timestamp || new Date().toISOString(),
      repoRoot: events[0].repo?.root,
    },
  );
  const missingReviewerIds = reviewersMissingTelemetry(deriveMetrics(result.summary));
  return {
    status: missingReviewerIds.length === 0 ? "complete" : "incomplete",
    missingReviewerIds,
    collection: result.collection,
  };
};

const parseOptions = (args) => {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) fail(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
};

const readDataOption = (options, label) => {
  if (options["data-json"] && options["data-file"]) fail("Use only one of --data-json or --data-file");
  let raw = "{}";
  if (options["data-json"]) raw = options["data-json"];
  if (options["data-file"]) raw = readFileSync(options["data-file"] === "-" ? 0 : options["data-file"], "utf8");
  try {
    return assertObject(JSON.parse(raw), label);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
};

const help = `Usage:
  review-run-log.mjs templates
  review-run-log.mjs start [--repo-root <path>] [--output-root <path>] [--data-json <object>]
  review-run-log.mjs append --log <path> --event <lower_snake_case> [--data-json <object>]
  review-run-log.mjs launch-cli-reviewer --log <path> --reviewer-id <id> --model <model> --reasoning <level> --prompt-file <path> --output-file <path> [--sessions-root <path>]
  review-run-log.mjs recover-cli-session --log <path> --reviewer-id <id> [--sessions-root <path>]
  review-run-log.mjs inspect-cli-session --log <path> --reviewer-id <id> [--sessions-root <path>] [--stale-after-ms <ms>]
  review-run-log.mjs inspect-native-session --log <path> --reviewer-id <id> [--sessions-root <path>] [--stale-after-ms <ms>]
  review-run-log.mjs inspect-reviewers --log <path> [--sessions-root <path>] [--stale-after-ms <ms>] [--soft-deadline-ms <ms>] [--hard-deadline-ms <ms>] [--record]
  review-run-log.mjs finish --log <path> [--collect-codex-usage] [--sessions-root <path>] [--data-json <summary>]
  review-run-log.mjs diagnose-codex-usage --log <path> [--sessions-root <path>]
  review-run-log.mjs report --log <path>

Use --data-file <path> instead of --data-json, or --data-file - to read JSON from stdin.
Each command prints JSON. templates prints canonical start, event, and finish payloads;
start prints logPath and runId; finish prints the derived metrics.`;

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (command === "templates") {
    process.stdout.write(`${JSON.stringify(LOG_TEMPLATES, null, 2)}\n`);
    return;
  }
  const options = parseOptions(args);
  if (command === "start") {
    const result = startRun({
      repoRoot: options["repo-root"],
      outputRoot: options["output-root"],
      configuration: readDataOption(options, "configuration"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "append") {
    const result = appendEvent({
      logPath: options.log,
      event: options.event,
      data: readDataOption(options, "data"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "launch-cli-reviewer") {
    const result = await launchCodexCliReviewer({
      logPath: options.log,
      reviewerId: options["reviewer-id"],
      model: options.model,
      reasoning: options.reasoning,
      promptFile: options["prompt-file"],
      outputFile: options["output-file"],
      sessionsRoot: options["sessions-root"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "recover-cli-session") {
    const result = recoverCodexCliReviewerResult({
      logPath: options.log,
      reviewerId: options["reviewer-id"],
      sessionsRoot: options["sessions-root"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "inspect-cli-session") {
    const staleAfterMs = options["stale-after-ms"] === undefined ? undefined : Number(options["stale-after-ms"]);
    const result = inspectCodexCliReviewerSession({
      logPath: options.log,
      reviewerId: options["reviewer-id"],
      sessionsRoot: options["sessions-root"],
      staleAfterMs,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "inspect-native-session") {
    const staleAfterMs = options["stale-after-ms"] === undefined ? undefined : Number(options["stale-after-ms"]);
    const result = inspectCodexNativeReviewerSession({
      logPath: options.log,
      reviewerId: options["reviewer-id"],
      sessionsRoot: options["sessions-root"],
      staleAfterMs,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "inspect-reviewers") {
    const numberOption = (name) => (options[name] === undefined ? undefined : Number(options[name]));
    const result = inspectReviewerSessions({
      logPath: options.log,
      sessionsRoot: options["sessions-root"],
      staleAfterMs: numberOption("stale-after-ms"),
      softDeadlineMs: numberOption("soft-deadline-ms"),
      hardDeadlineMs: numberOption("hard-deadline-ms"),
      recordObservations: Boolean(options.record),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "finish") {
    const result = finishRun({
      logPath: options.log,
      summary: readDataOption(options, "summary"),
      collectCodexUsage: Boolean(options["collect-codex-usage"]),
      sessionsRoot: options["sessions-root"],
    });
    process.stdout.write(
      `${JSON.stringify({
        logPath: resolve(options.log),
        derived: result.data.derived,
        tokenUsageCollection: result.data.tokenUsageCollection || null,
      })}\n`,
    );
    return;
  }
  if (command === "diagnose-codex-usage") {
    const result = diagnoseCodexUsage({
      logPath: options.log,
      sessionsRoot: options["sessions-root"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "report") {
    const events = readEvents(options.log);
    const finished = [...events].reverse().find((event) => event.event === "run_finished");
    if (!finished) fail(`Run is not finished: ${options.log}`);
    const missingReviewerIds = reviewersMissingTelemetry(finished.data?.derived);
    if (missingReviewerIds.length > 0) {
      fail(
        `Reviewer telemetry is missing for ${missingReviewerIds.join(", ")}. ` +
          `Run diagnose-codex-usage, repair the ledger or session collection, then finish with --collect-codex-usage again before reporting.`,
      );
    }
    process.stdout.write(`${renderUsageTable(finished.data?.derived)}\n`);
    return;
  }
  fail(`Unknown command: ${command}`);
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`review-run-log: ${error.message}\n`);
    process.exitCode = 1;
  });
}
