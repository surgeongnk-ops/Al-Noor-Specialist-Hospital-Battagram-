// backup.js — non-blocking SQLite snapshot backups.
// The actual copy runs in backup-worker.js, a completely separate OS process, so a
// large database being backed up never stalls the main server's event loop or
// blocks any station's request while it's happening.

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { DB_PATH } = require('./db');

const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const KEEP_BACKUPS = 30; // keep the most recent 30 backups, delete older ones
const WORKER_PATH = path.join(__dirname, 'backup-worker.js');

// Returns a Promise that resolves with the backup file path once the (fully
// non-blocking, separate-process) backup completes.
function runBackup() {
  return new Promise((resolve, reject) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `clinic-${stamp}.db`);
    execFile(process.execPath, [WORKER_PATH, DB_PATH, dest], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      cleanupOldBackups();
      resolve(dest);
    });
  });
}

// Fire-and-forget variant for the scheduled daily run.
function runBackupInBackground(onDone) {
  runBackup()
    .then(dest => { console.log(`[backup] completed: ${path.basename(dest)}`); onDone?.(null, dest); })
    .catch(err => { console.error('[backup] failed:', err.message); onDone?.(err); });
}

function cleanupOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('clinic-') && f.endsWith('.db'))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(KEEP_BACKUPS).forEach(({ f }) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('clinic-') && f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function scheduleDailyBackups() {
  setTimeout(() => runBackupInBackground(), 10_000);
  setInterval(() => runBackupInBackground(), 24 * 60 * 60 * 1000);
}

module.exports = { runBackup, runBackupInBackground, listBackups, scheduleDailyBackups, BACKUP_DIR };
