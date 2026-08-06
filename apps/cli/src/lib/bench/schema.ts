import * as fs from "fs";
import * as path from "path";
import type { BenchPassCriterion, BenchRunResult, BenchTask } from "./types.js";
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
export function parseTask(raw: unknown, sourcePath: string): BenchTask {
  const value = object(raw, "task.json");
  const id = string(value.id, "task.id");
  const prompt = string(value.prompt, "task.prompt");
  if (!Array.isArray(value.pass) || value.pass.length === 0)
    throw new Error("task.pass must be a non-empty array");
  const pass = value.pass.map((item, index): BenchPassCriterion => {
    const criterion = object(item, `task.pass[${index}]`);
    const type = string(criterion.type, `task.pass[${index}].type`);
    if (type === "exit_zero") return { type };
    if (type === "file_exists")
      return { type, path: string(criterion.path, `task.pass[${index}].path`) };
    if (type === "stdout_contains")
      return {
        type,
        value: string(criterion.value, `task.pass[${index}].value`),
      };
    if (type === "command_succeeds")
      return {
        type,
        command: string(criterion.command, `task.pass[${index}].command`),
      };
    throw new Error(`task.pass[${index}].type is unsupported: ${type}`);
  });
  const taskDir = path.dirname(sourcePath);
  return {
    id,
    prompt,
    pass,
    fixtureDir: path.join(taskDir, "fixture"),
    sourcePath,
  };
}
export function parseRunResult(raw: unknown): BenchRunResult {
  const value = object(raw, "bench result");
  if (value.schema_version !== 1)
    throw new Error("bench result schema_version must be 1");
  string(value.run_id, "bench result run_id");
  string(value.prompt, "bench result prompt");
  string(value.started_at, "bench result started_at");
  string(value.finished_at, "bench result finished_at");
  if (!Array.isArray(value.cells))
    throw new Error("bench result cells must be an array");
  return value as unknown as BenchRunResult;
}
export function loadTask(taskId: string, tasksRoot: string): BenchTask {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId))
    throw new Error(`Invalid task id: ${taskId}`);
  const sourcePath = path.join(tasksRoot, taskId, "task.json");
  return parseTask(JSON.parse(fs.readFileSync(sourcePath, "utf8")), sourcePath);
}
