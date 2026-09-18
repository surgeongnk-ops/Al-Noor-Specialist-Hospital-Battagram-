'use strict';

/**
 * PM2 process manager configuration for Al Noor Specialist Hospital:
 * runs the Python serial LIMS daemon and the Node.js clinical app as two
 * managed processes sharing the al_noor_clinical.db SQLite file.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs
 *   pm2 status
 *   pm2 stop ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: 'lims-daemon',
      script: 'python3',
      args: '-m lims_daemon.main --port /dev/ttyUSB0 --baud 9600',
      cwd: __dirname,
      interpreter: 'none', // "script" is the python3 executable itself, not a JS file
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '200M',
      out_file: './logs/lims-daemon.log',
      error_file: './logs/lims-daemon.log',
      merge_logs: true,
      time: true,
      env: {
        LIMS_DB_PATH: './al_noor_clinical.db',
        LIMS_LOG_LEVEL: 'INFO',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      },
    },
    {
      name: 'clinical-app',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      out_file: './logs/clinical-app.log',
      error_file: './logs/clinical-app.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        LIMS_DB_PATH: './al_noor_clinical.db',
        LIMS_POLL_INTERVAL_MS: 2000,
      },
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
