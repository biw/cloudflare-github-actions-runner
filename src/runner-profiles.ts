import { z } from "zod";

export const RUNNER_PROFILE_KEYS = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;

export type RunnerProfileKey = (typeof RUNNER_PROFILE_KEYS)[number];

export interface RunnerResources {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

interface RunnerProfileBase extends RunnerResources {
  key: string;
  instanceType: string;
  labels: readonly string[];
  memoryGib: string;
  diskGb: string;
}

export interface PresetRunnerProfile extends RunnerProfileBase {
  kind: "preset";
  key: RunnerProfileKey;
  instanceType: RunnerProfileKey;
}

export interface CustomRunnerProfile extends RunnerProfileBase {
  kind: "custom";
}

export type RunnerProfile = PresetRunnerProfile | CustomRunnerProfile;

const runnerProfileBaseSchema = z.object({
  key: z.string().min(1),
  instanceType: z.string().min(1),
  labels: z.array(z.string()),
  vcpu: z.number().positive(),
  memoryMib: z.number().int().positive(),
  diskMb: z.number().int().positive(),
  memoryGib: z.string().min(1),
  diskGb: z.string().min(1),
});

export const runnerProfileSchema: z.ZodType<RunnerProfile> = z.discriminatedUnion("kind", [
  runnerProfileBaseSchema.extend({
    kind: z.literal("preset"),
    key: z.enum(RUNNER_PROFILE_KEYS),
    instanceType: z.enum(RUNNER_PROFILE_KEYS),
  }),
  runnerProfileBaseSchema.extend({ kind: z.literal("custom") }),
]);

export const RUNNER_PROFILES = {
  lite: {
    kind: "preset",
    key: "lite",
    instanceType: "lite",
    labels: ["cloudflare-lite"],
    vcpu: 1 / 16,
    memoryMib: 256,
    diskMb: 2_000,
    memoryGib: "0.25",
    diskGb: "2",
  },
  basic: {
    kind: "preset",
    key: "basic",
    instanceType: "basic",
    labels: ["cloudflare-basic"],
    vcpu: 1 / 4,
    memoryMib: 1_024,
    diskMb: 4_000,
    memoryGib: "1",
    diskGb: "4",
  },
  "standard-1": {
    kind: "preset",
    key: "standard-1",
    instanceType: "standard-1",
    labels: ["cloudflare-standard-1"],
    vcpu: 1 / 2,
    memoryMib: 4_096,
    diskMb: 8_000,
    memoryGib: "4",
    diskGb: "8",
  },
  "standard-2": {
    kind: "preset",
    key: "standard-2",
    instanceType: "standard-2",
    labels: ["cloudflare-standard-2"],
    vcpu: 1,
    memoryMib: 6_144,
    diskMb: 12_000,
    memoryGib: "6",
    diskGb: "12",
  },
  "standard-3": {
    kind: "preset",
    key: "standard-3",
    instanceType: "standard-3",
    labels: ["cloudflare-standard-3", "cloudflare-ubuntu-latest"],
    vcpu: 2,
    memoryMib: 8_192,
    diskMb: 16_000,
    memoryGib: "8",
    diskGb: "16",
  },
  "standard-4": {
    kind: "preset",
    key: "standard-4",
    instanceType: "standard-4",
    labels: ["cloudflare-standard-4"],
    vcpu: 4,
    memoryMib: 12_288,
    diskMb: 20_000,
    memoryGib: "12",
    diskGb: "20",
  },
} satisfies Readonly<Record<RunnerProfileKey, PresetRunnerProfile>>;

const PROFILE_BY_LABEL = new Map<string, PresetRunnerProfile>(
  RUNNER_PROFILE_KEYS.flatMap((key) =>
    RUNNER_PROFILES[key].labels.map((label) => [label, RUNNER_PROFILES[key]] as const),
  ),
);

const customLabelPattern = /^cloudflare-vcpu:(\d+)-memory_mib:(\d+)-disk_mb:(\d+)$/u;
const customLabelPrefix = "cloudflare-vcpu:";
export const CLOUDFLARE_RUNNER_LABEL_PREFIX = "cloudflare-";

export type CustomRunnerLabelResult =
  | { kind: "not-custom" }
  | { kind: "invalid"; errors: readonly string[] }
  | { kind: "valid"; profile: CustomRunnerProfile };

function safeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseCustomRunnerLabel(label: string): CustomRunnerLabelResult {
  const normalized = label.toLowerCase();
  if (!normalized.startsWith(customLabelPrefix)) {
    return { kind: "not-custom" };
  }

  const match = customLabelPattern.exec(normalized);
  if (match === null) {
    return {
      kind: "invalid",
      errors: ["Use the exact label format cloudflare-vcpu:<integer>-memory_mib:<integer>-disk_mb:<integer>."],
    };
  }

  const vcpu = safeInteger(match[1] ?? "");
  const memoryMib = safeInteger(match[2] ?? "");
  const diskMb = safeInteger(match[3] ?? "");
  const errors: string[] = [];
  if (vcpu === undefined || memoryMib === undefined || diskMb === undefined) {
    return {
      kind: "invalid",
      errors: ["vCPU, memory_mib, and disk_mb must each be safe whole numbers."],
    };
  }

  if (vcpu < 1 || vcpu > 4) {
    errors.push(`vCPU must be a whole number from 1 through 4; received ${vcpu}.`);
  }
  if (memoryMib < 1) {
    errors.push(`memory_mib must be a positive whole number; received ${memoryMib}.`);
  }
  if (memoryMib > 12_288) {
    errors.push(`memory_mib must be at most 12,288 MiB (12 GiB); received ${memoryMib} MiB.`);
  }
  if (memoryMib < vcpu * 3_072) {
    errors.push(
      `memory_mib must be at least 3,072 MiB per vCPU; ${memoryMib} MiB is below the ${vcpu * 3_072} MiB minimum for ${vcpu} vCPU.`,
    );
  }
  if (diskMb < 1) {
    errors.push(`disk_mb must be a positive whole number; received ${diskMb}.`);
  }
  if (diskMb > 20_000) {
    errors.push(`disk_mb must be at most 20,000 MB (20 GB); received ${diskMb} MB.`);
  }
  if (diskMb * 1_024 > memoryMib * 2_000) {
    const maximumDiskMb = Math.floor((memoryMib * 2_000) / 1_024);
    errors.push(
      `disk_mb must be no more than 2 GB per 1 GB memory; ${diskMb} MB exceeds the ${maximumDiskMb} MB maximum for ${memoryMib} MiB.`,
    );
  }
  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }

  const canonicalLabel = `cloudflare-vcpu:${vcpu}-memory_mib:${memoryMib}-disk_mb:${diskMb}`;
  return {
    kind: "valid",
    profile: {
      kind: "custom",
      key: `custom-v${vcpu}-m${memoryMib}-d${diskMb}`,
      instanceType: canonicalLabel,
      labels: [canonicalLabel],
      vcpu,
      memoryMib,
      diskMb,
      memoryGib: String(memoryMib / 1_024),
      diskGb: String(diskMb / 1_000),
    },
  };
}

export type RunnerProfileSelection =
  | { kind: "none" }
  | { kind: "invalid"; errors: readonly string[] }
  | { kind: "conflicting"; errors: readonly string[] }
  | { kind: "selected"; profile: RunnerProfile };

export function hasCloudflareRunnerIntent(labels: readonly unknown[]): boolean {
  return labels.some((label) => {
    const parsed = z.string().safeParse(label);
    return parsed.success && parsed.data.startsWith(CLOUDFLARE_RUNNER_LABEL_PREFIX);
  });
}

export function selectRunnerProfile(labels: readonly unknown[]): RunnerProfileSelection {
  const selectedProfiles = new Map<string, RunnerProfile>();
  const errors: string[] = [];

  for (const label of labels) {
    const parsedLabel = z.string().safeParse(label);
    if (!parsedLabel.success) {
      continue;
    }

    const normalized = parsedLabel.data.toLowerCase();
    const preset = PROFILE_BY_LABEL.get(normalized);
    if (preset !== undefined) {
      selectedProfiles.set(preset.key, preset);
      continue;
    }

    const custom = parseCustomRunnerLabel(normalized);
    if (custom.kind === "invalid") {
      errors.push(...custom.errors);
      continue;
    }
    if (custom.kind === "valid") {
      selectedProfiles.set(custom.profile.key, custom.profile);
      continue;
    }
    if (parsedLabel.data.startsWith(CLOUDFLARE_RUNNER_LABEL_PREFIX)) {
      errors.push(
        `Unknown Cloudflare runner label "${parsedLabel.data}". Use a documented preset or custom-machine label.`,
      );
    }
  }

  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }
  if (selectedProfiles.size === 0) {
    return { kind: "none" };
  }
  if (selectedProfiles.size > 1) {
    return {
      kind: "conflicting",
      errors: ["Select exactly one Cloudflare runner profile. A job cannot request multiple machine profiles."],
    };
  }

  const profile = selectedProfiles.values().next().value;
  return profile === undefined ? { kind: "none" } : { kind: "selected", profile };
}
