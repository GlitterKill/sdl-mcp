import { indexRepo, IndexProgress, IndexResult } from '../src/indexer/indexer.js';
import { loadConfig } from '../src/config/loadConfig.js';
import { getRepo, createRepo } from '../src/db/queries.js';
import type { RepoRow } from '../src/db/schema.js';
import type { RepoConfig, AppConfig } from '../src/config/types.js';

interface CliArgs {
  repoId: string;
  mode: 'full' | 'incremental';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: tsx scripts/index-repo.ts <repoId> [--mode full|incremental]');
    process.exit(1);
  }

  const repoId = args[0];
  let mode: 'full' | 'incremental' = 'full';

  const modeIndex = args.findIndex(arg => arg === '--mode');
  if (modeIndex !== -1 && modeIndex + 1 < args.length) {
    const modeValue = args[modeIndex + 1];
    if (modeValue !== 'full' && modeValue !== 'incremental') {
      console.error('Mode must be either "full" or "incremental"');
      process.exit(1);
    }
    mode = modeValue;
  }

  return { repoId, mode };
}

async function registerRepoIfNotExists(repoId: string, repoConfig: RepoConfig): Promise<void> {
  const existingRepo = getRepo(repoId);
  
  if (!existingRepo) {
    const repoRow: RepoRow = {
      repo_id: repoId,
      root_path: repoConfig.rootPath,
      config_json: JSON.stringify(repoConfig),
      created_at: new Date().toISOString()
    };
    
    createRepo(repoRow);
    console.log(`Registered repository: ${repoId}`);
  }
}

function logProgress(progress: IndexProgress): void {
  const { stage, current, total, currentFile } = progress;
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  
  let message = `[${stage}] ${current}/${total} (${percentage}%)`;
  if (currentFile) {
    message += ` - ${currentFile}`;
  }
  
  console.log(message);
}

function reportResult(result: IndexResult): void {
  console.log('\n=== Indexing Complete ===');
  console.log(`Version ID: ${result.versionId}`);
  console.log(`Files processed: ${result.filesProcessed}`);
  console.log(`Files changed: ${result.changedFiles}`);
  console.log(`Files removed: ${result.removedFiles}`);
  console.log(`Symbols indexed: ${result.symbolsIndexed}`);
  console.log(`Edges created: ${result.edgesCreated}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
}

async function main(): Promise<void> {
  try {
    const { repoId, mode } = parseArgs();
    
    console.log(`Loading configuration...`);
    const config: AppConfig = loadConfig();
    
    const repoConfig = config.repos.find(r => r.repoId === repoId);
    if (!repoConfig) {
      console.error(`Repository "${repoId}" not found in configuration`);
      process.exit(1);
    }
    
    console.log(`Checking repository registration...`);
    await registerRepoIfNotExists(repoId, repoConfig);
    
    console.log(`Starting ${mode} index for repository: ${repoId}`);
    const result: IndexResult = await indexRepo(repoId, mode, logProgress);
    
    reportResult(result);
    process.exit(0);
  } catch (error) {
    console.error('Error during indexing:', error);
    process.exit(1);
  }
}

main();
