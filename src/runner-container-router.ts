import { getContainer } from "@cloudflare/containers";

import type { WorkerEnvironment } from "./environment";
import type { RunnerContainer } from "./provision";

export function runnerContainerFor(env: WorkerEnvironment, slotId: string, runnerName: string): RunnerContainer {
  switch (slotId) {
    case "validation":
      return getContainer(env.RUNNER_VALIDATION, runnerName);
    case "preset:lite":
      return getContainer(env.RUNNER_LITE, runnerName);
    case "preset:basic":
      return getContainer(env.RUNNER_BASIC, runnerName);
    case "preset:standard-1":
      return getContainer(env.RUNNER_STANDARD_1, runnerName);
    case "preset:standard-2":
      return getContainer(env.RUNNER_STANDARD_2, runnerName);
    case "preset:standard-3":
      return getContainer(env.RUNNER_STANDARD_3, runnerName);
    case "preset:standard-4":
      return getContainer(env.RUNNER_STANDARD_4, runnerName);
    case "custom:1":
      return getContainer(env.RUNNER_CUSTOM, runnerName);
    case "custom:2":
      return getContainer(env.RUNNER_CUSTOM_2, runnerName);
    case "custom:3":
      return getContainer(env.RUNNER_CUSTOM_3, runnerName);
    case "custom:4":
      return getContainer(env.RUNNER_CUSTOM_4, runnerName);
    case "custom:5":
      return getContainer(env.RUNNER_CUSTOM_5, runnerName);
    case "custom:6":
      return getContainer(env.RUNNER_CUSTOM_6, runnerName);
    case "custom:7":
      return getContainer(env.RUNNER_CUSTOM_7, runnerName);
    case "custom:8":
      return getContainer(env.RUNNER_CUSTOM_8, runnerName);
    case "custom:9":
      return getContainer(env.RUNNER_CUSTOM_9, runnerName);
    case "custom:10":
      return getContainer(env.RUNNER_CUSTOM_10, runnerName);
    default:
      throw new Error(`Unknown Cloudflare runner application slot: ${slotId}`);
  }
}
