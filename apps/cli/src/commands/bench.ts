import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { detectSignedInRuntimes } from "../lib/crabbox/runtimes.js";
import {
  listRuns,
  loadRun,
  loadTask,
  runCells,
  saveRun,
  type BenchCell,
  type BenchRunResult,
} from "../lib/bench/index.js";
import { setHelpSections } from "../lib/help.js";

const TASKS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bench/tasks",
);
function csv(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
function taskIds(root = TASKS_ROOT): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(root, entry.name, "task.json")),
    )
    .map((entry) => entry.name)
    .sort();
}
function renderResult(result: BenchRunResult): void {
  console.log(
    `Run ${result.run_id}${result.task_id ? ` · ${result.task_id}` : ""}`,
  );
  for (const cell of result.cells)
    console.log(
      `${cell.status === "passed" ? "PASS" : "FAIL"}  ${cell.agent}${cell.model ? `/${cell.model}` : ""}  ${cell.wall_ms} ms  exit ${cell.exit ?? "spawn-error"}`,
    );
}

export function registerBenchCommand(program: Command): void {
  const bench = program
    .command("bench")
    .description(
      "Run the same task across agent and model cells, with isolated fixtures and durable JSON results.",
    );
  setHelpSections(bench, {
    examples: `agents bench list\nagents bench run hello-repo --agent claude,codex --model cheap,default\nagents bench results --json`,
    notes: `Task definitions live under apps/cli/bench/tasks/<id>/task.json. Custom harness names accepted by agents run are valid --agent values.`,
  });
  bench
    .command("list")
    .description("List available benchmark tasks.")
    .option("--json", "Emit JSON.")
    .action((options: { json?: boolean }) => {
      const tasks = taskIds();
      if (options.json) console.log(JSON.stringify(tasks, null, 2));
      else if (tasks.length === 0) console.log("No benchmark tasks installed.");
      else tasks.forEach((id) => console.log(id));
    });
  bench
    .command("results [run-id]")
    .description("Show one saved run, or list saved runs newest first.")
    .option("--json", "Emit JSON.")
    .action((runId: string | undefined, options: { json?: boolean }) => {
      const value = runId ? loadRun(runId) : listRuns();
      if (options.json) console.log(JSON.stringify(value, null, 2));
      else if (Array.isArray(value)) {
        if (value.length === 0) console.log("No benchmark results yet.");
        else value.forEach(renderResult);
      } else renderResult(value);
    });
  bench
    .command("run [task-id]")
    .description("Run one task or prompt across an agent × model matrix.")
    .option("--prompt <text>", "Prompt to benchmark instead of a house task.")
    .option(
      "--agent <names>",
      "Comma-separated native agents or custom harness names. Defaults to signed-in native agents.",
    )
    .option(
      "--model <models>",
      "Comma-separated model tiers or concrete model ids.",
    )
    .option("--concurrency <n>", "Maximum cells running at once.", "3")
    .option("--json", "Emit the saved JSON result.")
    .action(
      async (
        taskId: string | undefined,
        options: {
          prompt?: string;
          agent?: string;
          model?: string;
          concurrency: string;
          json?: boolean;
        },
      ) => {
        if (!!taskId === !!options.prompt)
          throw new Error("Pass exactly one of <task-id> or --prompt.");
        const task = taskId ? loadTask(taskId, TASKS_ROOT) : undefined;
        const prompt = options.prompt ?? task!.prompt;
        let agents = csv(options.agent);
        if (agents.length === 0)
          agents = (await detectSignedInRuntimes())
            .filter((runtime) => runtime.signedIn)
            .map((runtime) => runtime.id);
        if (agents.length === 0)
          throw new Error(
            "No signed-in native agents found. Pass --agent <name>.",
          );
        const models = csv(options.model);
        const cells: BenchCell[] = agents.flatMap((agent) =>
          models.length > 0
            ? models.map((model) => ({ agent, model }))
            : [{ agent }],
        );
        const concurrency = Number(options.concurrency);
        const result = await runCells({ task, prompt, cells, concurrency });
        saveRun(result);
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else renderResult(result);
        if (result.cells.some((cell) => cell.status === "failed"))
          process.exitCode = 1;
      },
    );
}
