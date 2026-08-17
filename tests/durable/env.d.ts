import type { AccountRunnerScheduler } from "../../src/account-runner-scheduler";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    RUNNER_SCHEDULER: DurableObjectNamespace<AccountRunnerScheduler>;
  }
}
