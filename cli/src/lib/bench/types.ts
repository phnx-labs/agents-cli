export type BenchPassCriterion =
  | { type: "file_exists"; path: string }
  | { type: "exit_zero" }
  | { type: "stdout_contains"; value: string }
  | { type: "command_succeeds"; command: string };

export interface BenchTask {
  id: string;
  prompt: string;
  pass: BenchPassCriterion[];
  fixtureDir: string;
  sourcePath: string;
}
export interface BenchCell {
  agent: string;
  model?: string;
}
export interface BenchCellResult extends BenchCell {
  status: "passed" | "failed";
  exit: number | null;
  wall_ms: number;
  tokens?: number;
  stdout: string;
  stderr: string;
}
export interface BenchRunResult {
  schema_version: 1;
  run_id: string;
  task_id?: string;
  prompt: string;
  started_at: string;
  finished_at: string;
  cells: BenchCellResult[];
}
