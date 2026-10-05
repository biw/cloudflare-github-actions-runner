import { spawnSync } from "node:child_process";

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log("Skipping agent skill installation in CI.");
  process.exit(0);
}

const result = spawnSync("pnpx", ["skills", "experimental_install"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
