# Review Run Logging

For ordinary runs, resolve this skill's directory and use `node <skill-dir>/scripts/review-run-log.mjs templates` instead of loading this reference. Use the details below to diagnose rejected records, extend telemetry, or interpret derived metrics.

Write one append-only JSONL file per skill run under:

```text
${CODEX_HOME:-~/.codex}/log/review-fix-address-bots/YYYY/MM/DD/
```

This mirrors Codex's session date layout while keeping repository identity inside each run. The default `~/.codex/log/` directory is runtime state and should remain ignored by any repository containing `CODEX_HOME`.

## Start and Events

Resolve the directory containing the skill's `SKILL.md`, then start the log before review work:

```bash
node scripts/review-run-log.mjs start \
  --repo-root "$PWD" \
  --data-json '{"requestedReviewerCount":5,"reviewerCohortRequested":[{"model":"gpt-5.6-sol","count":1},{"model":"gpt-5.6-terra","count":1},{"model":"gpt-5.6-luna","count":3}],"reasoningRequested":"high","watcherIntervalMs":30000,"softReviewerDeadlineMs":600000,"hardReviewerDeadlineMs":1200000,"remediationRoundLimit":3,"reviewBotLoopLimit":8}'
```

Keep the returned `logPath` in `.context`. Append an event immediately after each reviewer pass so partial runs remain useful if later work stops:

```bash
node scripts/review-run-log.mjs append \
  --log "$REVIEW_RUN_LOG" \
  --event reviewer_pass_completed \
  --data-file .context/reviewer-pass.json
```

Useful events include `target_integrated`, `reviewer_session_started`, `reviewer_session_controls_verified`, `reviewer_session_observed`, `reviewer_session_cancelled`, `reviewer_pass_completed`, `reviewer_pass_failed`, `reviewer_continuity_verified`, `reviewer_continuity_failed`, `finding_classified`, `validation_completed`, `push_completed`, `review_bot_loop_completed`, and `run_blocked`. Events may evolve; keep names lower snake case.

Record experimental inputs when they become known: custom-versus-bundled review prompt source and SHA-256 fingerprint, target/base/head SHAs, diff size, the requested reviewer cohort, round limits, requested reasoning, launch mechanisms, retries, and relevant skill options. The helper fingerprints the skill instructions and logger automatically. Hash custom prompts instead of storing their contents. The `start` example shows the default cohort; replace its configuration with the resolved user override when applicable.

For every reviewer pass, record:

- stable `reviewerId`, phase (`initial` or `remediation`), and one-based round,
- invocation start/completion order, launch mechanism, and session identifier when available,
- requested and actually applied model and reasoning level separately,
- continuity-handshake result for every persistent session,
- stable deduplicated `findingIds` once available,
- whether the pass found any issue and whether findings were new, repeated, or overlapping,
- actual token usage when the runtime exposes it; otherwise use `null`, never an estimate,
- the exact `durationMs` from the runtime's completed task when it exposes one, otherwise omit it, plus any failure or retry.

Use these exact event keys: `reviewerId`, `findingIds`, `sessionId`, `tokenUsage`, and `durationMs` when available.
The finish helper reconstructs the canonical reviewer rounds and continuity checks from these
events. This is the source of truth; do not hand-write aliases such as `reviewer`,
`finding_ids`, `id`, `model`, or `initialFindingIds` in the finish summary.

If a persistent CLI reviewer finishes but its command output is unavailable, recover it before
retrying with:

```bash
node scripts/review-run-log.mjs recover-cli-session \
  --log "$REVIEW_RUN_LOG" \
  --reviewer-id "$REVIEWER_ID"
```

The command validates the exact `codex exec` session ID, repository, applied model, applied
reasoning, and completed final answer. It emits the recovered result on stdout but does not write
the review body to the run log. Record a concise recovery outcome and then the normal pass event.

If recovery is `in_progress`, use `inspect-cli-session` before deciding what happened. For a native
reviewer that appears in progress, use `inspect-native-session` with the same log and reviewer ID.
Both commands verify the exact persisted session and report a lifecycle, last activity/event, quiet
duration, and recommended action. Record only that concise diagnostic in `reviewer_session_observed`;
do not copy raw output or review text. `active` and `stalled` sessions must be polled again on the
same handle. `stalled` is observational, not a failure. A CLI retry is allowed only after inspection
is `unavailable`. A native retry is also allowed after its hard deadline, but only after the parent
re-inspects, interrupts, and confirms clear the exact native handle.

During every bounded wait, run `inspect-reviewers --record` with the configured stale, soft, and hard
deadline values. It writes one concise `reviewer_session_observed` event per launched reviewer and
returns the IDs that crossed each deadline. The command never interrupts anything. On a hard-exceeded
native reviewer, repeat the exact native inspection, then use the agent runtime's exact-handle interrupt
and post-interrupt status check before appending `reviewer_session_cancelled`. Treat an interrupt as a
terminal event for that handle; never reuse it for continuity. Keep a retry's stable reviewer ID but log
its fresh session handle so collection and the final partial report remain accurate.

Do not log full prompts, full review bodies, code contents, credentials, environment variables, or auth material. Finding IDs and concise summaries are enough for later analysis.

## Finish Schema

Always attempt `finish`, including for blocked or failed runs. Pass a summary with this shape:

```json
{
  "status": "complete",
  "reviewers": [
    {
      "reviewerId": "sol-1",
      "launchMechanism": "native",
      "sessionId": "opaque-session-id",
      "modelRequested": "gpt-5.6-sol",
      "modelApplied": "gpt-5.6-sol",
      "reasoningRequested": "high",
      "reasoningApplied": "high",
      "continuityVerified": true,
      "continuityChecks": [
        {
          "round": 1,
          "verified": true,
          "tokenUsage": null
        }
      ],
      "rounds": [
        {
          "phase": "initial",
          "round": 1,
          "findingIds": ["F1"],
          "tokenUsage": null
        }
      ]
    }
  ],
  "findings": [
    {
      "findingId": "F1",
      "classification": "valid",
      "reportedBy": ["sol-1"],
      "action": "fixed"
    }
  ],
  "githubReviewBots": [{ "login": "claude[bot]", "model": null, "findingIds": ["B1"] }],
  "reviewBotLoopCount": 1
}
```

Include one reviewer object for every configured reviewer, even when it found no issues. Preserve applied model and reasoning fields so comparisons and labels reflect what actually ran rather than what was merely requested; leave an unavailable `modelApplied` or `reasoningApplied` unset so the helper reports it as `unknown`. Record every continuity attempt in `continuityChecks`, including retries and `tokenUsage: null` when the runtime exposes no accounting.

Use `complete` only when every reviewer has a verified session, review round, and continuity check.
For an incomplete cohort, finish with `partial`, `blocked`, or `failed`; the helper retains its
events and every completed worker's telemetry. Before generating the user-facing report, however,
repair every reviewer that lacks both token usage and an exact duration rather than rendering it as
`n/a` or omitting the table.

```bash
node scripts/review-run-log.mjs finish \
  --log "$REVIEW_RUN_LOG" \
  --collect-codex-usage \
  --data-file .context/review-run-summary.json
```

For native Codex reviewers, `--collect-codex-usage` deterministically discovers the native cohort under `${CODEX_HOME:-~/.codex}/sessions`, matches the run window, repository root, parent thread, and reviewer IDs, verifies that each session's completed task count equals its recorded review-plus-continuity invocation count, and copies the final cumulative `token_count` values into the finished log. For persistent CLI reviewers it instead matches each exact captured thread ID, repository, and verified controls. Collection is independent per reviewer: a mixed native/CLI cohort or unavailable worker produces `partial` collection while retaining verified usage for every completed session. It refuses ambiguous sessions or mismatched invocation counts instead of guessing. Record exact session IDs in the summary whenever the runtime exposes them; they further constrain discovery.

Inspect the collection returned by `finish`. If any reviewer has neither tokens nor duration, diagnose before calling `report`:

```bash
node scripts/review-run-log.mjs diagnose-codex-usage \
  --log "$REVIEW_RUN_LOG"
```

Its per-reviewer reason distinguishes an absent/ambiguous session, a still-active session, and a
reviewer-ledger invocation mismatch. Inspect or wait for an active exact session; repair the missing
launch/pass/continuity ledger event or exact handle for a mismatch; use the allowed same-identity
relaunch path when no session exists. Re-run `finish --collect-codex-usage` after the repair. Do not
call `report` until the diagnostic returns `complete`.

The helper derives reviewer session and invocation counts, continuity-invocation counts, rounds per reviewer, initial and cumulative unique findings, pairwise shared/unique finding IDs with Jaccard overlap, reviewers that found issues, GitHub bot counts, token totals with per-field coverage, and exact completed-task duration when available. Invocation and cumulative token and duration metrics include both review rounds and continuity checks; initial token metrics remain limited to the initial review pass. The helper also groups reviewers only by applied model and derives initial finding classifications, valid and model-unique valid finding IDs, cross-model overlap, per-reviewer usage, and estimated costs.

Cost is an API-equivalent estimate based on the embedded, dated standard-service GPT-5.6 pricing snapshot. The helper prices `cachedInputTokens` as cache reads, prices the remaining input as uncached, and prices all output tokens at the output rate; reasoning tokens are already included in output and are not added again. It returns `null` rather than estimating when the applied model or any required token field is missing. The estimate is not an invoice: Codex plan billing may differ, cache-write premiums cannot be identified from the aggregate counters, and long-context or non-standard service-tier premiums are excluded.

After `finish`, generate the final usage section deterministically:

```bash
node scripts/review-run-log.mjs report --log "$REVIEW_RUN_LOG" \
  > .context/reviewer-usage-report.md
```

Append `.context/reviewer-usage-report.md` verbatim as the final content of the user-facing workflow summary only after `report` succeeds. Do not manually recompute, reorder, reformat, or add prose around it. `report` fails rather than rendering a table when any reviewer has neither tokens nor duration; diagnose and repair that reviewer first. A successful report renders this exact Markdown column order, with `Estimated cost` immediately after `Total` and runtime-derived cumulative `Agent time` last:

```markdown
| Reviewer    |   Input | Cached input | Output | Reasoning |   Total | Estimated cost | Agent time |
| ----------- | ------: | -----------: | -----: | --------: | ------: | -------------: | ---------: |
| Sol1 (high) | 100,000 |       90,000 |  2,000 |     1,200 | 102,000 |        $0.1550 |     1m 42s |
```

The generated table uses `n/a` only for an unavailable field in a reviewer row that otherwise has real telemetry. `Agent time` is the sum of completed-task runtime across a reviewer's review, continuity, and remediation turns; concurrent reviewers can therefore have a total greater than elapsed wall time. Keep collection failures in the run log; do not add their reason, pricing notes, or replacement values to the user-facing summary. Preserve the raw reviewer/round/continuity/finding arrays so future analyses can compute different metrics without changing old logs. Treat these metrics as observations from one run, not a general model ranking.

If logging fails, do not hide the failure or fabricate a record. Report it, but do not let telemetry failure cause unsafe Git, PR, or code mutations.
