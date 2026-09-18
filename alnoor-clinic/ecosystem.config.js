// ecosystem.config.js — PM2 process configuration for the Al Noor Clinic System.
//
// Run with:  pm2 start ecosystem.config.js
// Persist across reboots:  pm2 save  &&  pm2 startup   (follow the printed instructions)
//
// ---------------------------------------------------------------------------
// A NOTE ON CLUSTERING — read before changing `instances` below.
//
// PM2 can run multiple copies of a Node app across CPU cores ("cluster mode").
// This app deliberately does NOT use it, and `instances` is set to 1. Here's why:
//
// SQLite allows exactly one writer to a database file at a time, even in WAL
// mode. Running this server as multiple OS processes would mean every one of
// them opens its own connection to the SAME clinic.db file and they'd all
// serialize their writes against each other anyway — so clustering buys zero
// extra write throughput, only extra memory use and extra complexity. Worse,
// a few code paths here (receipt numbering, MR-number generation, FEFO stock
// deduction) do a read-then-write in two steps; those are safe with one writer
// process, but running several processes increases the odds of two of them
// interleaving on the same counter row in a way a single process never would.
//
// At the actual scale this runs at (~1,000 patients/day on a handful of LAN
// terminals), a single Node process comfortably keeps up — the bottleneck was
// never CPU. If usage ever grows enough that this stops being true, the right
// fix is moving off SQLite to a real client/server database, not clustering
// this app in front of a file-based one.
// ---------------------------------------------------------------------------

module.exports = {
  apps: [
    {
      name: 'alnoor-clinic',
      script: './server.js',
      cwd: __dirname,

      instances: 1,           // see note above — do not raise without switching databases first
      exec_mode: 'fork',      // NOT 'cluster' — see note above

      autorestart: true,      // restart automatically if the process crashes
      max_restarts: 10,       // stop trying after 10 rapid crashes (avoids a restart loop masking a real bug)
      min_uptime: '10s',      // a restart only "counts" toward max_restarts if the process died within 10s
      restart_delay: 2000,    // wait 2s between restart attempts

      watch: false,           // no file-watching in a clinical system — restarts should be deliberate, not accidental
      max_memory_restart: '300M', // safety net against a memory leak slowly degrading the server

      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },

      // Logs — kept locally, no external log shipping (offline deployment).
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      kill_timeout: 10000,    // matches server.js's own 10s graceful-shutdown timeout
      listen_timeout: 5000
    }
  ]
};
