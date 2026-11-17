export type ReconcileProgress = {
  state: "running" | "complete" | "stopped";
  completed: number;
  total: number;
  active: number;
  succeeded: number;
  failed: number;
  elapsedSeconds: number;
  usersPerSecond: number;
  etaSeconds: number | null;
};

function duration(seconds: number) {
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  return `${Math.floor(rounded / 3600)}h ${Math.floor((rounded % 3600) / 60)}m`;
}

export function formatReconcileProgress(progress: ReconcileProgress) {
  const percent = progress.total ? (100 * progress.completed / progress.total).toFixed(1) : "100.0";
  const eta = progress.etaSeconds === null ? "--" : duration(progress.etaSeconds);
  return `[reconcile-csv] ${progress.state} | ${progress.completed}/${progress.total} (${percent}%)` +
    ` | ${progress.active} active | ${progress.succeeded} succeeded, ${progress.failed} failed` +
    ` | ${progress.usersPerSecond.toFixed(2)} users/s avg | elapsed ${duration(progress.elapsedSeconds)} | ETA ${eta}`;
}
