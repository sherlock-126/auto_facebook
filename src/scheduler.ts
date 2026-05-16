/**
 * Standalone scheduler. Spawns fresh tsx subprocesses for each tick so a
 * crashed run never poisons the daemon.
 *
 * Single-run guard: uses a Postgres advisory lock so 2 cron ticks racing
 * are atomically resolved (unlike an in-memory boolean).
 */
import 'dotenv/config';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { pool } from './db.js';

const LOCK_KEY = 0x46420000; // arbitrary 32-bit int = "FB\0\0"

async function tryLock(): Promise<boolean> {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  return rows[0].locked === true;
}
async function unlock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
}

function runCli(cmd: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['tsx', 'src/cli.ts', cmd], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    p.on('exit', (code) => resolve(code ?? -1));
  });
}

async function tick(cmd: string, label: string) {
  if (!(await tryLock())) {
    console.log(`[${label}] skipped — another run in progress`);
    return;
  }
  console.log(`[${label}] starting…`);
  try {
    const code = await runCli(cmd);
    console.log(`[${label}] exit ${code}`);
  } finally {
    await unlock();
  }
}

const INCR = process.env.CRON_INCR ?? '*/30 * * * *';
const FULL = process.env.CRON_FULL ?? '0 3 * * *';

cron.schedule(INCR, () => void tick('facts:all:incr', 'incr'));
cron.schedule(FULL, () => void tick('facts:all:full', 'full'));

console.log(`scheduler running: incr="${INCR}", full="${FULL}"`);

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`scheduler shutting down (${sig})…`);
  await unlock();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
