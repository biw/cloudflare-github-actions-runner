#!/usr/bin/env node

function usage(): void {
  console.log(`Cloudflare GitHub Actions runner

Usage:
  cloudflare-github-actions-runner
  cloudflare-github-actions-runner setup
  cloudflare-github-actions-runner teardown

Running without a command starts setup.
Set up or permanently remove a Cloudflare Containers-backed GitHub Actions runner pool.`);
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const [requestedCommand, ...commandArguments] = arguments_;
  if (requestedCommand === "--help" || requestedCommand === "-h") {
    usage();
    return;
  }
  const command = requestedCommand ?? "setup";
  if (command !== "setup" && command !== "teardown") {
    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  if (commandArguments.length > 0) {
    console.error(`The ${command} command does not accept arguments.\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`${command === "setup" ? "Setup" : "Teardown"} is interactive and must be run in a terminal`);
    }
    if (command === "setup") {
      const { main: setup } = await import("../scripts/setup.ts");
      await setup();
    } else {
      const { main: teardown } = await import("../scripts/teardown.ts");
      await teardown();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      console.error(`\n${command === "setup" ? "Setup" : "Teardown"} cancelled.`);
    } else {
      console.error(
        `\n${command === "setup" ? "Setup" : "Teardown"} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}

void main();
