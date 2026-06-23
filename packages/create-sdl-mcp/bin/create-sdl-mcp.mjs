#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

function parseArgs(argv) {
  const options = {
    packageSpec: process.env.CREATE_SDL_MCP_PACKAGE || "sdl-mcp@latest",
    yes: false,
    dryRun: false,
    skipInstall: false,
    update: false,
    initArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.initArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "-y" || arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--skip-install") {
      options.skipInstall = true;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--sdl-package") {
      options.packageSpec = argv[index + 1];
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.packageSpec) {
    throw new Error("--sdl-package requires a value");
  }
  return options;
}

function commandName(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function npmCliPath() {
  if (process.env.npm_execpath) {
    return process.env.npm_execpath;
  }
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(bundled) ? bundled : null;
}

function npmCommand(args) {
  const cliPath = npmCliPath();
  if (cliPath) {
    return {
      command: process.execPath,
      args: [cliPath, ...args],
      display: `${commandName("npm")} ${args.join(" ")}`,
    };
  }
  return {
    command: commandName("npm"),
    args,
    display: `${commandName("npm")} ${args.join(" ")}`,
  };
}

function formatCommand(command, args) {
  const quote = (value) =>
    /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return [quote(command), ...args.map(quote)].join(" ");
}

function usage() {
  console.log(`Usage: create-sdl-mcp [options] [-- <sdl-mcp init args>]

Options:
  --sdl-package <spec>  Package to install, defaults to sdl-mcp@latest
  --skip-install       Run sdl-mcp init without installing first
  --update             Install binaries only and print setup commands
  -y, --yes            Do not prompt before installing
  --dry-run            Print commands without running them
  -h, --help           Show this help
`);
}

async function confirmInstall(packageSpec) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Install ${packageSpec} globally now? [Y/n] `);
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    const verbose = process.env.CREATE_SDL_MCP_VERBOSE === "1";
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: verbose || options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    if (!verbose && !options.inherit) {
      child.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.trim() ? `\n${output.trim()}` : "";
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}${detail}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    let stdoutText = "";
    let stderrText = "";
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      stdoutText += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderrText += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdoutText.trim());
        return;
      }
      reject(new Error(stderrText.trim() || `${command} ${args.join(" ")} failed`));
    });
  });
}

async function globalSdlMcpCliPath() {
  const command = npmCommand(["root", "-g"]);
  const root = await capture(command.command, command.args);
  return join(root, "sdl-mcp", "dist", "cli", "index.js");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const installArgs = [
    "install",
    "-g",
    options.packageSpec,
    "--foreground-scripts=false",
    "--loglevel=error",
    "--no-fund",
    "--no-audit",
  ];
  const initArgs = ["init", ...options.initArgs];
  const installEnv = options.update
    ? { ...process.env, SDL_MCP_UPDATE: "1" }
    : process.env;

  if (options.dryRun) {
    if (!options.skipInstall) {
      console.log(`[dry-run] ${npmCommand(installArgs).display}`);
    }
    if (options.update) {
      printUpdateCommands();
      return;
    }
    const cliPath = await globalSdlMcpCliPath();
    console.log(`[dry-run] ${formatCommand(process.execPath, [cliPath, ...initArgs])}`);
    return;
  }

  if (!options.skipInstall) {
    const shouldInstall =
      options.update || options.yes || (await confirmInstall(options.packageSpec));
    if (!shouldInstall) {
      console.log("Install skipped. Run later with:");
      console.log(`  npm install -g ${options.packageSpec}`);
      return;
    }
    process.stdout.write("Installing SDL-MCP... ");
    const installCommand = npmCommand(installArgs);
    await run(installCommand.command, installCommand.args, { env: installEnv });
    console.log("done");
  }

  if (options.update) {
    printUpdateCommands();
    return;
  }

  await run(process.execPath, [await globalSdlMcpCliPath(), ...initArgs], { inherit: true });
}

function printUpdateCommands() {
  console.log("SDL-MCP update install complete.");
  console.log("Repository setup commands:");
  console.log("  cd <repo>");
  console.log("  sdl-mcp init");
  console.log('  sdl-mcp init --repo-path "<repo>"');
  console.log('  sdl-mcp init --repo-path "<repo>" --client codex --enforce-agent-tools');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
