---
name: review-fix-address-bots
description: Integrate the PR base, run persistent read-only reviewers, fix and re-review findings, validate with repo-native commands, address review bots, and compare model quality.
---

# Review, Fix, and Address Bots

Execute these phases in order. The primary agent alone owns judgment, edits, commands that mutate the workspace, validation, Git, PR changes, and bot replies.

## Invariants

- Reviewers are advisory and strictly read-only. They may inspect files, diffs, history, tests, and existing output, but must not modify files or Git/PR state; run tests, builds, package scripts, generators, or arbitrary repository commands; or delegate implementation.
- Include this boundary in every reviewer prompt: “Operate in read-only mode. You are advisory only. Never modify the workspace or Git/PR state, and never commit or push. Return findings and critique to the primary agent, who makes the final decision.”
- Preserve unrelated user changes. Never use reset, automatic stashing, broad staging, history rewriting, or checkpoint commits to clear a dirty tree.
- Logging is observational. If it fails, report the failure and continue the safe workflow; never change code, judgment, Git/PR state, or loop limits for telemetry.
- Treat `scripts/review-run-log.mjs` as an opaque executable. Never read its source during this workflow. Invoke its documented commands and use `templates`, `--help`, and the Markdown references; inspect or change its source only when the user explicitly asks to debug or modify the helper.

## 1. Prepare the integrated target

1. Read repository instructions and applicable implementation skills. Record branch, status, target, remotes, upstream, PR state, and the initial dirty-state ownership boundary. Require a named non-target branch before pushing; never rename it or push the default branch without explicit authorization.
2. Use the user's review prompt. If a requested custom prompt is unavailable, stop for it. Only when none was requested, read [references/review-guidelines.md](references/review-guidelines.md).
3. Resolve this skill's directory and run `node <skill-dir>/scripts/review-run-log.mjs templates` for canonical payloads, then `start` with the resolved cohort and limits before review work. Keep its `logPath` in `.context`; append material transitions and every reviewer invocation. Read [references/run-logging.md](references/run-logging.md) only if the helper rejects a record, logging needs extension, or telemetry behavior must be diagnosed.
4. Inspect committed, staged, unstaged, and relevant untracked changes together. Prefer Conductor's workspace diff; otherwise inspect the merge-base-to-HEAD diff, `git diff HEAD`, `git status --short`, and relevant untracked files. Exclude unrelated user work from the implementation.
5. Resolve the PR's actual base branch and repository remote; without a PR use repository configuration. Fetch that base explicitly, record its ref and SHA, and do not use `git pull`. If the fetched SHA is not an ancestor of `HEAD`, integrate it before formal review with an explicit merge by default. Rebase only when required or requested, and never rewrite published history without authorization.
6. Do not let pre-existing staged changes enter a merge commit. If dirty work makes integration unsafe, stop. Resolve conflicts from both branches' intent, surrounding code, and tests; request input for material product, UX, public API, or architecture choices. The integrated tree, conflict resolutions included, is the review target. If integration happens after review starts, invalidate every report and rerun the cohort.
7. Before the first push, resolve authority to create a PR if none exists and the bot phase requires one. Stop before the remote mutation when authority is absent.

## Reviewer sessions

Use the reviewer count, model mix, and reasoning levels explicitly requested by the user. Otherwise use this default cohort for every initial and remediation pass:

| Reviewer ID | Model           | Reasoning |
| ----------- | --------------- | --------- |
| `sol-1`     | `gpt-5.6-sol`   | `high`    |
| `terra-1`   | `gpt-5.6-terra` | `high`    |
| `luna-1`    | `gpt-5.6-luna`  | `high`    |
| `luna-2`    | `gpt-5.6-luna`  | `high`    |
| `luna-3`    | `gpt-5.6-luna`  | `high`    |

For a count from one through five, use that order. For another explicit mix, assign stable IDs from model tier plus one-based ordinal. Ask for a mix when a count above five is otherwise underspecified. Normalize native task names from `sol-1` to `sol_1` for deterministic discovery. Keep the raw review prompt, target fingerprint, role boundary, reasoning, and service tier identical across the cohort. Queue over concurrency limits without editing the target.

### Packet

Do not send this skill, any reference, helper commands, run-log details, or the primary conversation to a reviewer. Give every reviewer the same self-contained packet containing only the review task: raw user prompt (or default criteria), target SHA and workspace fingerprint, relevant scope/diff or paths, conflict summary if applicable, read-only boundary, and required finding format (file, minimal line range, severity, scenario, rationale). Exclude other reviewers' findings, the primary's conclusions, remediation decisions, and telemetry instructions.

### Launch and verify

Prefer a native subagent only when it exposes the exact model, reasoning level, and a stable resumable handle. Launch every initial reviewer with `fork_turns: "none"` and its self-contained packet; do not fork the primary conversation. Verify applied settings from runtime evidence, not requested arguments alone.

`fork_turns: "none"` does not make an unavailable native model available. If native launch omits an assigned model such as Luna, do not silently substitute or call it unavailable: use the persistent CLI fallback below. If the native schema hides routing fields, check whether the user already configured this fresh-session-only workaround; never change it without explicit authorization:

```toml
[features.multi_agent_v2]
hide_spawn_agent_metadata = false
tool_namespace = "agents"
```

Use the helper for every CLI fallback; it captures the thread ID, keeps raw output in gitignored `.context`, and verifies persisted controls:

```bash
node scripts/review-run-log.mjs launch-cli-reviewer \
  --log "$REVIEW_RUN_LOG" \
  --reviewer-id "$REVIEWER_ID" \
  --model "$REVIEWER_MODEL" \
  --reasoning "$REVIEWER_REASONING" \
  --prompt-file ".context/$REVIEWER_ID.packet.txt" \
  --output-file ".context/$REVIEWER_ID.initial.jsonl"
```

Launch concurrently where the runtime permits. Never use `--ephemeral`. A failed control verification blocks editing and finishes `blocked`; never treat flags alone as verification. Record `reviewer_session_started` as soon as a handle is available and `reviewer_session_controls_verified` only after persisted verification. Record completed-task `durationMs` only when the runtime exposes it.

### Observe, recover, and clear stalled workers

After each bounded wait (30 seconds by default), run the cohort watcher. It is a maximum polling interval, not a runtime floor: handle completions immediately.

```bash
node scripts/review-run-log.mjs inspect-reviewers \
  --log "$REVIEW_RUN_LOG" \
  --stale-after-ms 120000 \
  --soft-deadline-ms 600000 \
  --hard-deadline-ms 1200000 \
  --record
```

The soft deadline is a warning. The hard deadline begins at the current `task_started` (or session start when absent). Before classifying any native or CLI reviewer as failed, inspect its exact persisted session. `active`, `stalled`, and one `in_progress` result are not failures. The watcher does not interrupt workers.

For a hard-exceeded native reviewer, immediately inspect the exact native session once more. If it remains non-terminal, call `agents.interrupt_agent` with the inspection's `nativeHandle`, never its persisted `sessionId`; confirm with `agents.list_agents` that it stopped; then append `reviewer_session_cancelled` with reviewer ID, persisted session ID, native handle, phase, reason, and deadline. Never use a broad kill, interrupt another reviewer, or probe an initial review with a follow-up. One fresh initial retry may use a distinct task name such as `sol_1_retry_1`, but retains reviewer ID `sol-1`; a second hard deadline finishes `partial` or `blocked`. A hard-exceeded continuity session follows the full-cohort restart rule after clearing the exact handle. A CLI session never consumes a native slot; end only its exact runtime wrapper when exposed, otherwise finish partial with its telemetry.

For a missing or unreadable CLI result, recover before retrying:

```bash
node scripts/review-run-log.mjs recover-cli-session \
  --log "$REVIEW_RUN_LOG" \
  --reviewer-id "$REVIEWER_ID"
```

The recovery must match exactly one captured thread, repository, applied controls, and completed final-answer event. Use its recovered answer but never log the review body. For `in_progress`, inspect the exact CLI session; for native UI lag, inspect the exact native session:

```bash
node scripts/review-run-log.mjs inspect-cli-session --log "$REVIEW_RUN_LOG" --reviewer-id "$REVIEWER_ID" --stale-after-ms 120000
node scripts/review-run-log.mjs inspect-native-session --log "$REVIEW_RUN_LOG" --reviewer-id "$REVIEWER_ID" --stale-after-ms 120000
```

CLI retries are allowed only after inspection says `unavailable`. Native retries additionally follow the hard-deadline cleanup above. Keep raw results outside the run log; record only concise observations and outcomes.

### Preserve session continuity

Before fixes, create a gitignored `.context/reviewer-sessions.json` ledger with stable reviewer ID, requested/applied controls, launch mechanism, native handle or CLI thread ID, initial fingerprint, and continuity state. Never store credentials, prompts, or review bodies. Before editing, resume every initial session with its original controls and read-only boundary; require only `SESSION_CONTINUITY_OK`. Record a completed-task duration when available. If any handshake fails, discard every report and restart the full cohort once against the unchanged target; a second failure blocks editing. Remediation uses only these verified handles.

## 2. Run independent initial reviews

1. Resolve the user-requested cohort or the default above and keep it fixed. Stop if the runtime cannot verify an exact requested/applied model, reasoning level, or persistent handle; never silently substitute.
2. Give each reviewer the same self-contained raw prompt, integrated target SHA and fingerprint, conflict summary, and role boundary. Do not expose another reviewer's findings or primary-agent conclusions. Require file, minimal line range, severity, scenario, and rationale for every finding.
3. Fingerprint `HEAD`, staged/unstaged diffs, status, and relevant untracked contents. Keep the target unchanged through all initial reports and continuity checks. Launch concurrently where possible and queue the rest unchanged. Apply the launch, watchdog, recovery, and hard-deadline cleanup rules above.
4. Log each launch, control verification, observation, cancellation, and completed or failed pass using the canonical fields above. Use stable reviewer and finding IDs. Record actual token usage and `durationMs` only when exposed.
5. Apply the continuity protocol above before editing.
6. Verify the target fingerprint after the handshakes. On unexpected mutation, inspect ownership and rerun the full cohort once against a stable target. Repeated instability is a blocker.

## 3. Verify findings and fix

1. Deduplicate by defect while preserving reporting reviewers/models. Independently check every claim against current code, tests, and conventions.
2. Classify each finding as `valid`, `duplicate`, `already_fixed_or_stale`, `false_positive`, `out_of_scope_user_change`, or `needs_user_decision`; log its stable ID and disposition.
3. Fix every valid in-scope issue, add focused regression coverage when practical, run narrow checks, and self-review the entire resulting diff. Request input rather than inventing material product, UX, public API, or architecture decisions.

## 4. Resume reviewers on the fixes

Resume every continuity-verified session with its original controls and read-only boundary. Never use an ephemeral or replacement session without user authorization.

1. Freeze and fingerprint the workspace. Give every reviewer the updated diff plus a cumulative ledger of all findings, classifications, evidence, changes or rejection reasons, tests, and prior pushback.
2. Ask whether root causes are fixed, regressions or related cases remain, a materially simpler bounded solution exists, tests cover the failure, or rejected findings merit reconsideration. Actionable pushback must identify a concrete failure mode, affected code, or demonstrably better bounded alternative.
3. Judge each response independently. Run at most three remediation rounds, stopping when all reviewers find the fixes adequate or remaining objections have evidence-backed dispositions. Increase scope after valid pushback: focused fix/call sites in round 1, related module boundaries/integration in round 2, and subsystem invariants/design alternatives/coverage gaps in round 3.
4. Log every pass, including no-finding passes and retries. After each pass, verify the fingerprint. If a reviewer mutated state, the primary agent safely restores only that effect, discards the report, and retries once read-only; a second mutation is a blocker.

## 5. Validate, commit, and push

1. Stage only owned files or hunks and inspect the staged diff.
2. Resolve final validation in this order: explicit user command; repository/CI instruction; otherwise the changed workspace's scripts using the package manager named by `packageManager` or its lockfile. Run `precommit` when present, else each available `lint` and `test`. For non-JavaScript projects use documented CI-equivalent checks; report unavailable coverage instead of inventing commands.
3. Commit with the repository workflow, then run final validation against the exact post-commit tree before every push. Incorporate intended tool-generated changes and rerun after any mutation. Diagnose branch-caused failures without modifying unrelated work; do not push a failing tree.
4. Confirm ownership boundaries. Immediately before pushing, record PR number, UTC review-window timestamp, and commit SHA in `.context`; refresh after a failed attempt. Push without renaming the branch and confirm the PR head equals the verified SHA.

## 6. Close the review-bot loop

1. Resolve and read the repository's `address-review-bots` skill; do not hard-code another workspace's path. Confirm the PR still targets the recorded branch and SHA and pass the push timestamp when supported.
2. Wait for every requested bot on that SHA. Missing review or timeout is unknown, not clean; an unexpected head change requires ownership reconciliation.
3. Classify every substantive observation, fix valid actionable and low-risk cleanup findings, self-review, commit, rerun final validation, and push. Repeat per `address-review-bots` until clean, a decision is needed, its loop limit is reached, or checks time out.

## Finish and report

Always attempt `finish`, even for a blocked/failed run, using event-derived reviewers/findings plus actual bot, validation, status, and SHA outcomes. Use `partial`, `blocked`, or `failed` instead of `complete` when the cohort cannot finish. For native and CLI Codex reviewers use `--collect-codex-usage`; collection is per reviewer, so completed sessions still contribute real tokens, cost, and duration when another worker is unavailable. Do not report while any reviewer lacks both tokens and an exact duration. Run `diagnose-codex-usage`, resolve its per-reviewer session/ledger cause (including an allowed relaunch when needed), then run `finish --collect-codex-usage` again. Generate the usage section with `report` only after that gate passes; do not manually calculate or reformat it. Treat model comparisons as one-run observations.

Report the applied cohort/controls, persistent sessions and continuity/retries, log path and derived invocation/round/usage coverage, shared/unique findings and model comparison, base SHA/integration/conflicts, all finding dispositions, remediation rounds and disagreements, validation per push, commits/PR, bot-loop outcomes, and remaining blockers. `report` refuses an incomplete-telemetry cohort, so append its table verbatim only after it succeeds. Do not add pricing or telemetry caveats. Keep `Estimated cost` immediately after `Total` and `Agent time` last; put nothing after it.

## Resources

- [references/review-guidelines.md](references/review-guidelines.md): default review criteria.
- [references/run-logging.md](references/run-logging.md): logger troubleshooting, extension, and metric semantics.
- `scripts/review-run-log.mjs`: canonical payloads, append-only log, metrics, and final report.
