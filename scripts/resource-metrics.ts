import { spawn, type StdioOptions } from "node:child_process";
import { z } from "zod";

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const databaseName = "cloudflare-github-actions-runner-metrics";
type CommandEnvironment = Record<string, string | undefined>;

function run(
  command: string,
  arguments_: string[],
  environment: CommandEnvironment,
  stdio: StdioOptions,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { env: { ...process.env, ...environment }, stdio });
    let stdout = "";
    if (child.stdout !== null) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`${command} ${arguments_.join(" ")} exited with status ${code ?? "unknown"}`));
      }
    });
  });
}

function wranglerArguments(arguments_: string[], profile: string | undefined): string[] {
  return ["wrangler", ...arguments_, ...(profile === undefined ? [] : ["--profile", profile])];
}

export function metricsDatabaseId(value: z.core.util.JSONType): string {
  const parsedList = z.array(z.json()).safeParse(value);
  if (!parsedList.success) {
    throw new Error("Wrangler returned an invalid D1 database list");
  }
  const database = parsedList.data.flatMap((candidate) => {
    const parsed = z.object({ name: z.literal(databaseName), uuid: z.string() }).safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  })[0];
  if (database === undefined) {
    throw new Error(`D1 database ${databaseName} does not exist. Run pnpm run deploy first.`);
  }
  return database.uuid;
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  if (
    !arguments_.some(
      (argument) => argument === "--command" || argument === "--file" || argument.startsWith("--command="),
    )
  ) {
    throw new Error("Usage: pnpm run resource-traces -- --command=<SQL>  (or --file=<path>)");
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId === undefined || accountId.trim() === "") {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  }
  const environment = { CLOUDFLARE_ACCOUNT_ID: accountId } satisfies CommandEnvironment;
  const profile = process.env.WRANGLER_PROFILE;
  const list = await run(npxCommand, wranglerArguments(["d1", "list", "--json"], profile), environment, [
    "ignore",
    "pipe",
    "inherit",
  ]);
  const parsedList = z.json().parse(JSON.parse(list));
  const databaseId = metricsDatabaseId(parsedList);
  await run(
    npxCommand,
    wranglerArguments(["d1", "execute", databaseId, "--remote", ...arguments_], profile),
    environment,
    "inherit",
  );
}

if (process.argv[1]?.endsWith("resource-metrics.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
