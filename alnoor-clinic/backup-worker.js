// backup-worker.js — runs as a separate OS process so a backup never blocks the
// main server's event loop, no matter how large the database gets.
// Usage: node backup-worker.js <sourceDbPath> <destPath>

const { DatabaseSync } = require('node:sqlite');

const [, , sourcePath, destPath] = process.argv;
if (!sourcePath || !destPath) {
  console.error('Usage: node backup-worker.js <sourceDbPath> <destPath>');
  process.exit(1);
}

try {
  // Opening a second connection to the same WAL-mode file is safe — WAL explicitly
  // supports concurrent readers while the main process keeps writing.
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  db.close();
  process.exit(0);
} catch (err) {
  console.error('Backup worker failed:', err.message);
  process.exit(1);
}
