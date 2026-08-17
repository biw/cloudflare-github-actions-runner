# Account-level runner scheduler: remaining operations work

The account-aware scheduler is implemented: it serializes admission with a
Durable Object, queues jobs against account capacity, manages preset and custom
Container slots, records reservations, and builds one reusable runner image.

The following operational work remains before treating it as production-ready:

1. Expose queue state and reservation transitions through an authenticated
   operator status endpoint, structured logs, and GitHub job summaries.
2. Validate an account-usage or analytics source with sufficient granularity
   before showing any per-job cost estimate.
3. Write runbooks for stalled rollouts, stale reservations, Container failures,
   and account-capacity exhaustion.

The acceptance bar is unchanged: a supported preset or custom `runs-on` label
must either run safely or remain visibly queued, without overcommitting account
resources, interrupting an active custom slot, creating duplicate runner
images, or leaking a reservation after a job finishes.
