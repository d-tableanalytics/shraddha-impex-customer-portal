// PM2 process definition for the Shraddha Impex customer portal.
//
// Only the backend runs as a process. The frontend is a Vite SPA that compiles
// to static files, which nginx serves directly from frontend/dist — there is no
// node process to keep alive for it.
//
// .cjs, not .js: backend/package.json sets "type": "module", and PM2 loads this
// file with require().
module.exports = {
  apps: [
    {
      name: 'shraddha-backend',
      cwd: '/var/www/shraddha-impex/backend',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      // The box runs ~15 other apps on 3.7 GB with no swap. Capping the heap
      // means a leak in this app restarts this app, instead of the OOM killer
      // picking a victim among the neighbours.
      max_memory_restart: '400M',
      node_args: '--max-old-space-size=384',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      error_file: '/var/log/pm2/shraddha-backend.error.log',
      out_file: '/var/log/pm2/shraddha-backend.out.log',
      merge_logs: true,
      time: true,
      // server.js exits the process on uncaughtException; let PM2 bring it back,
      // but back off so a crash loop does not spin the CPU.
      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
    },
  ],
};
