import { describe, expect, it, vi } from "vite-plus/test";

import {
  assignResourceTraceRunner,
  createResourceTraceAuthorization,
  parseResourceTracePayload,
  persistResourceTraceSamples,
  verifyResourceTraceAuthorization,
} from "../src/resource-traces";

const sample = {
  timestamp: "2026-08-13T10:51:19Z",
  elapsedSeconds: 15,
  intervalSeconds: 1,
  phase: "Install dependencies",
  cpuTotalUsec: 12_345_678,
  cpuDeltaUsec: 883_906,
  cpuCoresAvg: 0.883906,
  memoryCurrentBytes: 642_449_408,
  memoryPeakBytes: 700_000_000,
  rootDiskUsedBytes: 131_059_712,
  rootDiskDeltaBytes: 12_000_000,
};

interface ResourceMetricsTestEnvironment {
  RESOURCE_METRICS: D1Database;
}

function d1Statement<const Statement extends object>(statement: Statement): D1PreparedStatement {
  // SAFETY: each statement double implements precisely the D1 methods exercised by the resource-trace operation.
  return statement as D1PreparedStatement;
}

function resourceMetricsEnvironment<const Database extends object>(database: Database): ResourceMetricsTestEnvironment {
  // SAFETY: each test double implements precisely the D1 methods exercised by the resource-trace operation under test.
  return { RESOURCE_METRICS: database as D1Database };
}

describe("runner resource traces", () => {
  it("accepts only a valid, unexpired runner-scoped upload capability", async () => {
    const authorization = await createResourceTraceAuthorization(
      "trace-signing-key",
      { runnerName: "cf-standard-3-job-42", jobId: "42", repository: "biw/example" },
      1_000,
    );

    await expect(
      verifyResourceTraceAuthorization("trace-signing-key", `Bearer ${authorization}`, 1_001),
    ).resolves.toEqual({
      version: 1,
      runnerName: "cf-standard-3-job-42",
      jobId: "42",
      repository: "biw/example",
      expiresAt: 1_801_000,
    });
    await expect(
      verifyResourceTraceAuthorization("different-key", `Bearer ${authorization}`, 1_001),
    ).resolves.toBeUndefined();
    await expect(
      verifyResourceTraceAuthorization("trace-signing-key", `Bearer ${authorization}`, 1_801_000),
    ).resolves.toBeUndefined();
  });

  it("parses bounded batches and rejects duplicate sample positions", () => {
    expect(parseResourceTracePayload({ samples: [sample] })).toEqual({ samples: [sample] });
    expect(parseResourceTracePayload({ samples: [sample, sample] })).toBeUndefined();
    expect(parseResourceTracePayload({ samples: [] })).toBeUndefined();
    expect(parseResourceTracePayload({ samples: [{ ...sample, phase: "bad\nphase" }] })).toBeUndefined();
  });

  it("writes accepted samples through one D1 batch with runner identity from the signed claim", async () => {
    const assignmentStatement = {
      bind: vi.fn<() => D1PreparedStatement>(),
      first: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    };
    assignmentStatement.bind.mockReturnValue(d1Statement(assignmentStatement));
    const sampleStatement = {
      bind: vi.fn<() => D1PreparedStatement>().mockReturnValue(d1Statement({ marker: "bound-statement" })),
    };
    const database = {
      prepare: vi
        .fn<(query: string) => typeof assignmentStatement | typeof sampleStatement>()
        .mockImplementation((query) => (query.startsWith("SELECT") ? assignmentStatement : sampleStatement)),
      batch: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    };

    await persistResourceTraceSamples(
      resourceMetricsEnvironment(database),
      { version: 1, runnerName: "cf-standard-3-job-42", jobId: "42", repository: "biw/example", expiresAt: 1_801_000 },
      [sample],
      5_000,
    );

    expect(database.batch).toHaveBeenCalledWith([expect.objectContaining({ marker: "bound-statement" })]);
    expect(sampleStatement.bind).toHaveBeenCalledWith(
      "cf-standard-3-job-42",
      "42",
      "biw/example",
      sample.elapsedSeconds,
      sample.timestamp,
      sample.intervalSeconds,
      sample.phase,
      sample.cpuTotalUsec,
      sample.cpuDeltaUsec,
      sample.cpuCoresAvg,
      sample.memoryCurrentBytes,
      sample.memoryPeakBytes,
      sample.rootDiskUsedBytes,
      sample.rootDiskDeltaBytes,
      5_000,
    );
  });

  it("attributes samples to GitHub's authoritative JIT runner assignment", async () => {
    const assignmentStatement = {
      bind: vi.fn<() => D1PreparedStatement>(),
      first: vi.fn<() => Promise<{ job_id: string; repository: string }>>().mockResolvedValue({
        job_id: "older-job",
        repository: "biw/example",
      }),
    };
    assignmentStatement.bind.mockReturnValue(d1Statement(assignmentStatement));
    const sampleStatement = {
      bind: vi.fn<() => D1PreparedStatement>().mockReturnValue(d1Statement({ marker: "bound-statement" })),
    };
    const database = {
      prepare: vi
        .fn<(query: string) => typeof assignmentStatement | typeof sampleStatement>()
        .mockImplementation((query) => (query.startsWith("SELECT") ? assignmentStatement : sampleStatement)),
      batch: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    };

    await persistResourceTraceSamples(
      resourceMetricsEnvironment(database),
      { version: 1, runnerName: "cf-standard-3-job-42", jobId: "42", repository: "biw/example", expiresAt: 1_801_000 },
      [sample],
      5_000,
    );

    expect(sampleStatement.bind).toHaveBeenCalledWith(
      "cf-standard-3-job-42",
      "older-job",
      "biw/example",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      5_000,
    );
  });

  it("persists a reassigned JIT runner identity", async () => {
    const statement = {
      bind: vi.fn<() => D1PreparedStatement>(),
      run: vi.fn<() => Promise<object>>().mockResolvedValue({}),
    };
    statement.bind.mockReturnValue(d1Statement(statement));
    const database = { prepare: vi.fn<(query: string) => typeof statement>().mockReturnValue(statement) };

    await assignResourceTraceRunner(
      resourceMetricsEnvironment(database),
      { runnerName: "cf-standard-3-job-42", jobId: "older-job", repository: "biw/example" },
      5_000,
    );

    expect(statement.bind).toHaveBeenCalledWith("cf-standard-3-job-42", "older-job", "biw/example", 5_000);
    expect(statement.run).toHaveBeenCalledOnce();
  });
});
