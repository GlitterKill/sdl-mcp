#!/usr/bin/env node
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logFile = createWriteStream(join(__dirname, 'debug.log'), { flags: 'a' });

const log = (msg) => {
  const timestamp = new Date().toISOString();
  logFile.write(`[${timestamp}] ${msg}\n`);
};

log('=== Debug wrapper starting ===');
log(`CWD: ${process.cwd()}`);
log(`ENV SDL_CONFIG_PATH: ${process.env.SDL_CONFIG_PATH}`);
log(`Node version: ${process.version}`);

// Spawn the actual server
const server = spawn('node', [join(__dirname, 'dist/main.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

// Pipe stdin to server
process.stdin.pipe(server.stdin);

// Pipe server stdout to our stdout (for MCP protocol)
server.stdout.on('data', (data) => {
  log(`STDOUT: ${data.toString().substring(0, 200)}`);
  process.stdout.write(data);
});

// Log server stderr
server.stderr.on('data', (data) => {
  log(`STDERR: ${data.toString()}`);
  process.stderr.write(data);
});

server.on('error', (err) => {
  log(`SPAWN ERROR: ${err.message}`);
  log(`Stack: ${err.stack}`);
});

server.on('exit', (code, signal) => {
  log(`SERVER EXITED: code=${code}, signal=${signal}`);
  process.exit(code ?? 1);
});

process.on('SIGINT', () => {
  log('Received SIGINT');
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  log('Received SIGTERM');
  server.kill('SIGTERM');
});
