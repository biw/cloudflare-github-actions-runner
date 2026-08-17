CREATE TABLE IF NOT EXISTS resource_trace_samples (
  runner_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  sample_elapsed_seconds INTEGER NOT NULL,
  sample_timestamp TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  phase TEXT NOT NULL,
  cpu_total_usec INTEGER NOT NULL,
  cpu_delta_usec INTEGER NOT NULL,
  cpu_cores_avg REAL NOT NULL,
  memory_current_bytes INTEGER NOT NULL,
  memory_peak_bytes INTEGER NOT NULL,
  root_disk_used_bytes INTEGER NOT NULL,
  root_disk_delta_bytes INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (runner_name, sample_elapsed_seconds)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS resource_trace_samples_job
  ON resource_trace_samples (job_id, sample_elapsed_seconds);

CREATE INDEX IF NOT EXISTS resource_trace_samples_repository_received
  ON resource_trace_samples (repository, received_at DESC);

CREATE TABLE IF NOT EXISTS resource_trace_assignments (
  runner_name TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  assigned_at INTEGER NOT NULL
) WITHOUT ROWID;
