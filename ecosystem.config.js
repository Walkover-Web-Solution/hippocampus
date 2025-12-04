module.exports = {
  apps: [{
    name: "api-server",
    script: "./dist/server.js",
    instances: "max",
    exec_mode: "cluster",
  },
  {
    name: "rag-sync-job",
    script: "./dist/job/index.js",
    args: "--job=rag-sync",
    instances: 1,
    exec_mode: "fork",
    autorestart: true
  },
  {
    name: "storage-consumer",
    script: "./dist/consumer/index.js",
    args: "--consumer=storage",
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "500M",
  },
  {
    name: "rag-consumer",
    script: "./dist/consumer/index.js",
    args: "--consumer=rag",
    instances: 1,
    exec_mode: "fork",
    max_memory_restart: "500M",
  },
  {
    name: "embedding-server",
    cwd: "./fastembed",
    script: "./venv/bin/uvicorn main:app"
  }
  ]
}
