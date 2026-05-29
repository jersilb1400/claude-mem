module.exports = {
  apps: [
    {
      name: "bible-render",
      script: "bun",
      args: "run server.ts",
      cwd: __dirname,
      env_file: ".env",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 20,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
    },
  ],
};
