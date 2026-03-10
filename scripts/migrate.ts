import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { initGraphDb } from "../src/db/initGraphDb.js";
import { getLadybugConn } from "../src/db/ladybug.js";
import * as ladybugDb from "../src/db/ladybug-queries.js";

interface CliArgs {
  status: boolean;
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { status: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--status") {
      args.status = true;
    } else if (arg === "--config") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        args.config = nextArg;
        i++;
      }
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const configPath = resolveCliConfigPath(args.config, "read");
  const config = loadConfig(configPath);

  const graphDbPath = await initGraphDb(config, configPath);
  console.log(`Graph database: ${graphDbPath}`);

  if (args.status) {
    const conn = await getLadybugConn();
    const repos = await ladybugDb.listRepos(conn, 1000);
    console.log(`Repos: ${repos.length}`);

    const repoId = repos[0]?.repoId;
    if (repoId) {
      const [files, symbols, edges] = await Promise.all([
        ladybugDb.getFileCount(conn, repoId),
        ladybugDb.getSymbolCount(conn, repoId),
        ladybugDb.getEdgeCount(conn, repoId),
      ]);

      console.log(
        `Repo ${repoId}: files=${files}, symbols=${symbols}, edges=${edges}`,
      );
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});

