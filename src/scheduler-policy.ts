import type { RunnerProfile } from "./runner-profiles";

export interface ResourceVector {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

export interface CustomSlotCandidate {
  slotId: string;
  profileKey: string | null;
  configurationState: "ready" | "configuring" | "idle";
  reservedCount: number;
}

/**
 * The capacity Cloudflare validates for a Container application is distinct
 * from the resources consumed by runners that are currently executing.  The
 * scheduler keeps this persisted view so it can retain useful ceilings and
 * reclaim only idle capacity when a different profile needs it.
 */
export interface ConfiguredCapacitySlot {
  slotId: string;
  resources: ResourceVector | null;
  appliedMaxInstances: number;
  reservedCount: number;
  configurationState: "ready" | "configuring" | "idle";
  capacityUpdateInProgress: boolean;
  lastReleasedAt: number;
}

export interface ConfiguredCapacityTarget {
  slotId: string;
  resources: ResourceVector;
  maxInstances: number;
}

export interface CapacityReduction {
  slotId: string;
  targetMaxInstances: number;
}

export interface ConfiguredCapacityPlan {
  configured: ResourceVector;
  target: ConfiguredCapacityTarget;
  reductions: CapacityReduction[];
}

/**
 * A short trailing window coalesces a burst of GitHub webhook deliveries into
 * one Containers API capacity update for the final requested ceiling.
 */
export const CAPACITY_UPSCALE_DEBOUNCE_MS = 5_000;

export function capacityDebounceDeadline(timestamp: number): number {
  return timestamp + CAPACITY_UPSCALE_DEBOUNCE_MS;
}

export const DEFAULT_ACCOUNT_CAPACITY: Readonly<ResourceVector> = {
  vcpu: 1_500,
  memoryMib: 6 * 1_024 * 1_024,
  diskMb: 30_000_000,
};

export function fitsAccountCapacity(
  reserved: ResourceVector,
  requested: ResourceVector,
  limit: ResourceVector = DEFAULT_ACCOUNT_CAPACITY,
): boolean {
  return (
    reserved.vcpu + requested.vcpu <= limit.vcpu &&
    reserved.memoryMib + requested.memoryMib <= limit.memoryMib &&
    reserved.diskMb + requested.diskMb <= limit.diskMb
  );
}

function addResources(left: ResourceVector, right: ResourceVector): ResourceVector {
  return {
    vcpu: left.vcpu + right.vcpu,
    memoryMib: left.memoryMib + right.memoryMib,
    diskMb: left.diskMb + right.diskMb,
  };
}

function subtractResources(left: ResourceVector, right: ResourceVector): ResourceVector {
  return {
    vcpu: left.vcpu - right.vcpu,
    memoryMib: left.memoryMib - right.memoryMib,
    diskMb: left.diskMb - right.diskMb,
  };
}

function multiplyResources(resources: ResourceVector, instances: number): ResourceVector {
  return {
    vcpu: resources.vcpu * instances,
    memoryMib: resources.memoryMib * instances,
    diskMb: resources.diskMb * instances,
  };
}

function zeroResources(): ResourceVector {
  return { vcpu: 0, memoryMib: 0, diskMb: 0 };
}

export function fitsConfiguredCapacity(
  configured: ResourceVector,
  limit: ResourceVector = DEFAULT_ACCOUNT_CAPACITY,
): boolean {
  return configured.vcpu <= limit.vcpu && configured.memoryMib <= limit.memoryMib && configured.diskMb <= limit.diskMb;
}

export function configuredCapacity(slots: readonly ConfiguredCapacitySlot[]): ResourceVector {
  return slots.reduce(
    (total, slot) =>
      slot.resources === null
        ? total
        : addResources(total, multiplyResources(slot.resources, slot.appliedMaxInstances)),
    zeroResources(),
  );
}

function reductionUnitsNeeded(deficit: ResourceVector, resources: ResourceVector): number {
  const dimensions: Array<[number, number]> = [
    [deficit.vcpu, resources.vcpu],
    [deficit.memoryMib, resources.memoryMib],
    [deficit.diskMb, resources.diskMb],
  ];
  return Math.max(
    0,
    ...dimensions.map(([needed, perInstance]) =>
      needed <= 0 || perInstance <= 0 ? 0 : Math.ceil((needed - Number.EPSILON) / perInstance),
    ),
  );
}

/**
 * Finds the smallest least-recently-used set of idle ceilings that must be
 * released before applying a new application ceiling or machine shape.  A
 * running or reserved slot is never a reclamation candidate.
 */
export function planConfiguredCapacity(
  slots: readonly ConfiguredCapacitySlot[],
  target: ConfiguredCapacityTarget,
  limit: ResourceVector = DEFAULT_ACCOUNT_CAPACITY,
): ConfiguredCapacityPlan | undefined {
  const targetSlot = slots.find((slot) => slot.slotId === target.slotId);
  if (targetSlot === undefined || target.maxInstances < 1) {
    return undefined;
  }

  let configured = configuredCapacity(slots);
  if (targetSlot.resources !== null) {
    configured = subtractResources(configured, multiplyResources(targetSlot.resources, targetSlot.appliedMaxInstances));
  }
  configured = addResources(configured, multiplyResources(target.resources, target.maxInstances));

  const reductions: CapacityReduction[] = [];
  const donors = slots
    .filter(
      (slot) =>
        slot.slotId !== target.slotId &&
        slot.configurationState === "ready" &&
        slot.reservedCount === 0 &&
        !slot.capacityUpdateInProgress &&
        slot.appliedMaxInstances > 1 &&
        slot.resources !== null,
    )
    .sort((left, right) => left.lastReleasedAt - right.lastReleasedAt || left.slotId.localeCompare(right.slotId));

  for (const donor of donors) {
    if (fitsConfiguredCapacity(configured, limit)) {
      break;
    }
    const resources = donor.resources;
    if (resources === null) {
      continue;
    }
    const maximumReduction = donor.appliedMaxInstances - 1;
    const needed = reductionUnitsNeeded(subtractResources(configured, limit), resources);
    const reduction = Math.min(maximumReduction, needed);
    if (reduction === 0) {
      continue;
    }
    configured = subtractResources(configured, multiplyResources(resources, reduction));
    reductions.push({ slotId: donor.slotId, targetMaxInstances: donor.appliedMaxInstances - reduction });
  }

  return fitsConfiguredCapacity(configured, limit) ? { configured, target, reductions } : undefined;
}

export function requiredMaxInstances(reservedCount: number): number {
  return Math.max(1, reservedCount + 1);
}

export function selectCustomSlot(
  profile: RunnerProfile,
  slots: readonly CustomSlotCandidate[],
): { slotId: string; requiresConfiguration: boolean } | undefined {
  if (profile.kind !== "custom") {
    return undefined;
  }

  const matching = slots
    .filter(
      (slot) =>
        slot.profileKey === profile.key &&
        (slot.configurationState === "ready" || slot.configurationState === "configuring"),
    )
    .sort((left, right) => left.reservedCount - right.reservedCount || left.slotId.localeCompare(right.slotId))[0];
  if (matching !== undefined) {
    return { slotId: matching.slotId, requiresConfiguration: false };
  }

  const idle = slots
    .filter((slot) => slot.reservedCount === 0 && slot.configurationState !== "configuring")
    .sort((left, right) => left.slotId.localeCompare(right.slotId))[0];
  return idle === undefined ? undefined : { slotId: idle.slotId, requiresConfiguration: true };
}
