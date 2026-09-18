// routes/admin.routes.js — audit log, database backups
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { runBackup, listBackups, BACKUP_DIR } = require('../backup');
const { sendJSON, sendError, requireAuth, asyncHandler } = require('../middleware');
const path = require('node:path');
const fs = require('node:fs');

const router = createRouter();

router.get('/api/audit', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const mr = url.searchParams.get('mr');
  const rows = mr
    ? db.prepare('SELECT * FROM audit_log WHERE mr_number = ? ORDER BY created_at DESC LIMIT 200').all(mr)
    : db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
  return sendJSON(res, 200, rows);
}));

router.get('/api/admin/backups', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  return sendJSON(res, 200, listBackups());
}));

router.post('/api/admin/backups/run', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const file = await runBackup();
  return sendJSON(res, 200, { ok: true, file: path.basename(file) });
}));

// Streams a backup .db file to the browser as a download — this is the "get it
// off this PC" step. The automated daily backup (above) only protects against
// database corruption or a bad write; it still lives on the same machine, so if
// that machine's disk fails entirely, the backup folder is lost with it. Saving
// this downloaded file to a USB drive, another computer, or cloud storage is
// what actually protects against that.
router.get(/^\/api\/admin\/backups\/([^/]+)\/download$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const filename = decodeURIComponent(match[1]);
  // Only a bare filename matching the backup naming convention is ever accepted
  // (never a path with separators), and the resolved path must still land
  // inside BACKUP_DIR — the same directory-traversal guard used for static file
  // serving elsewhere in this codebase.
  if (!/^clinic-[\w.-]+\.db$/.test(filename)) return sendError(res, 400, 'Invalid backup filename');
  const filePath = path.join(BACKUP_DIR, filename);
  if (!filePath.startsWith(BACKUP_DIR) || !fs.existsSync(filePath)) return sendError(res, 404, 'Backup not found');
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': stat.size
  });
  fs.createReadStream(filePath).pipe(res);
  logAudit(staff.staff_id, 'backup_downloaded', null, filename);
}));

module.exports = router;
