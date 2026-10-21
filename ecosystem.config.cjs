module.exports = {
  apps: [{
    name: 'hymenia-server',
    script: 'server.js',
    cwd: '/home/dotun/televa/server',
    interpreter: 'node',
    node_args: '--env-file=.env',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    min_uptime: '5s',
    max_restarts: 5,
    env: { NODE_ENV: 'production' }
  }]
};
