import { describe, expect, it } from "vite-plus/test";

import { parseCustomRunnerLabel, RUNNER_PROFILES } from "../src/runner-profiles";
import {
  CAPACITY_UPSCALE_DEBOUNCE_MS,
  capacityDebounceDeadline,
  configuredCapacity,
  fitsAccountCapacity,
  planConfiguredCapacity,
  requiredMaxInstances,
  selectCustomSlot,
} from "../src/scheduler-policy";

const custom = parseCustomRunnerLabel("cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000");

describe("account runner scheduler policy", () => {
  it("admits only requests that fit every account resource dimension", () => {
    expect(
      fitsAccountCapacity(
        { vcpu: 1_499, memoryMib: 6 * 1_024 * 1_024 - 6_144, diskMb: 30_000_000 - 12_000 },
        RUNNER_PROFILES["standard-2"],
      ),
    ).toBe(true);
    expect(fitsAccountCapacity({ vcpu: 1_499.5, memoryMib: 0, diskMb: 0 }, RUNNER_PROFILES["standard-2"])).toBe(false);
  });

  it("grows an application's ceiling by exactly one accepted runner", () => {
    expect(requiredMaxInstances(0)).toBe(1);
    expect(requiredMaxInstances(1)).toBe(2);
    expect(requiredMaxInstances(19)).toBe(20);
  });

  it("uses a five-second trailing window before an application ceiling is updated", () => {
    expect(CAPACITY_UPSCALE_DEBOUNCE_MS).toBe(5_000);
    expect(capacityDebounceDeadline(10_000)).toBe(15_000);
    expect(capacityDebounceDeadline(12_000)).toBe(17_000);
  });

  it("accounts for retained application ceilings separately from active runner reservations", () => {
    expect(
      configuredCapacity([
        {
          slotId: "standard-3",
          resources: { vcpu: 2, memoryMib: 8_192, diskMb: 16_000 },
          appliedMaxInstances: 10,
          reservedCount: 0,
          configurationState: "ready",
          capacityUpdateInProgress: false,
          lastReleasedAt: 100,
        },
      ]),
    ).toEqual({ vcpu: 20, memoryMib: 81_920, diskMb: 160_000 });
  });

  it("retains idle ceilings and reclaims only the least-recently-used inactive profile when needed", () => {
    const plan = planConfiguredCapacity(
      [
        {
          slotId: "target",
          resources: { vcpu: 1, memoryMib: 1, diskMb: 1 },
          appliedMaxInstances: 1,
          reservedCount: 1,
          configurationState: "ready",
          capacityUpdateInProgress: false,
          lastReleasedAt: 0,
        },
        {
          slotId: "old-idle",
          resources: { vcpu: 2, memoryMib: 2, diskMb: 2 },
          appliedMaxInstances: 4,
          reservedCount: 0,
          configurationState: "ready",
          capacityUpdateInProgress: false,
          lastReleasedAt: 10,
        },
        {
          slotId: "new-idle",
          resources: { vcpu: 1, memoryMib: 1, diskMb: 1 },
          appliedMaxInstances: 2,
          reservedCount: 0,
          configurationState: "ready",
          capacityUpdateInProgress: false,
          lastReleasedAt: 20,
        },
        {
          slotId: "active",
          resources: { vcpu: 1, memoryMib: 1, diskMb: 1 },
          appliedMaxInstances: 1,
          reservedCount: 1,
          configurationState: "ready",
          capacityUpdateInProgress: false,
          lastReleasedAt: 0,
        },
      ],
      { slotId: "target", resources: { vcpu: 1, memoryMib: 1, diskMb: 1 }, maxInstances: 3 },
      { vcpu: 12, memoryMib: 12, diskMb: 12 },
    );

    expect(plan).toMatchObject({
      reductions: [{ slotId: "old-idle", targetMaxInstances: 3 }],
      configured: { vcpu: 12, memoryMib: 12, diskMb: 12 },
    });
  });

  it("does not reclaim a ceiling that has active work or a capacity mutation in flight", () => {
    expect(
      planConfiguredCapacity(
        [
          {
            slotId: "target",
            resources: { vcpu: 1, memoryMib: 1, diskMb: 1 },
            appliedMaxInstances: 1,
            reservedCount: 1,
            configurationState: "ready",
            capacityUpdateInProgress: false,
            lastReleasedAt: 0,
          },
          {
            slotId: "active",
            resources: { vcpu: 2, memoryMib: 2, diskMb: 2 },
            appliedMaxInstances: 2,
            reservedCount: 1,
            configurationState: "ready",
            capacityUpdateInProgress: false,
            lastReleasedAt: 0,
          },
          {
            slotId: "changing",
            resources: { vcpu: 2, memoryMib: 2, diskMb: 2 },
            appliedMaxInstances: 2,
            reservedCount: 0,
            configurationState: "ready",
            capacityUpdateInProgress: true,
            lastReleasedAt: 0,
          },
        ],
        { slotId: "target", resources: { vcpu: 1, memoryMib: 1, diskMb: 1 }, maxInstances: 2 },
        { vcpu: 9, memoryMib: 9, diskMb: 9 },
      ),
    ).toBeUndefined();
  });

  it("shares a ready custom slot for jobs with the same machine shape", () => {
    if (custom.kind !== "valid") {
      throw new Error("Test custom profile must be valid");
    }
    expect(
      selectCustomSlot(custom.profile, [
        { slotId: "custom:1", profileKey: custom.profile.key, configurationState: "ready", reservedCount: 1 },
        { slotId: "custom:2", profileKey: null, configurationState: "idle", reservedCount: 0 },
      ]),
    ).toEqual({ slotId: "custom:1", requiresConfiguration: false });
  });

  it("shares a custom slot while that same shape is still configuring", () => {
    if (custom.kind !== "valid") {
      throw new Error("Test custom profile must be valid");
    }
    expect(
      selectCustomSlot(custom.profile, [
        { slotId: "custom:1", profileKey: custom.profile.key, configurationState: "configuring", reservedCount: 1 },
        { slotId: "custom:2", profileKey: null, configurationState: "idle", reservedCount: 0 },
      ]),
    ).toEqual({ slotId: "custom:1", requiresConfiguration: false });
  });

  it("uses an idle custom slot rather than reconfiguring an active shape", () => {
    if (custom.kind !== "valid") {
      throw new Error("Test custom profile must be valid");
    }
    expect(
      selectCustomSlot(custom.profile, [
        { slotId: "custom:1", profileKey: "custom-v1-m3072-d6000", configurationState: "ready", reservedCount: 1 },
        { slotId: "custom:2", profileKey: null, configurationState: "idle", reservedCount: 0 },
      ]),
    ).toEqual({ slotId: "custom:2", requiresConfiguration: true });
  });

  it("queues a distinct custom shape when every custom slot is occupied or configuring", () => {
    if (custom.kind !== "valid") {
      throw new Error("Test custom profile must be valid");
    }
    expect(
      selectCustomSlot(custom.profile, [
        { slotId: "custom:1", profileKey: "custom-v1-m3072-d6000", configurationState: "ready", reservedCount: 1 },
        { slotId: "custom:2", profileKey: null, configurationState: "configuring", reservedCount: 0 },
      ]),
    ).toBeUndefined();
  });
});
