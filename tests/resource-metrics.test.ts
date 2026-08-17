import { describe, expect, it } from "vite-plus/test";

import { metricsDatabaseId } from "../scripts/resource-metrics.ts";

describe("resource-trace query helper", () => {
  it("resolves the account-owned metrics database by name", () => {
    expect(
      metricsDatabaseId([
        { name: "another-database", uuid: "00000000-0000-0000-0000-000000000000" },
        { name: "cloudflare-github-actions-runner-metrics", uuid: "11111111-1111-1111-1111-111111111111" },
      ]),
    ).toBe("11111111-1111-1111-1111-111111111111");
  });
});
