import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractTokenCount,
  runCells,
  type CellExecutionRequest,
} from "./runner.js";
import type { BenchTask } from "./types.js";
describe("bench runner", () => {
  it("isolates fixture copies and never exceeds the concurrency cap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-"));
    const fixtureDir = path.join(root, "fixture");
    fs.mkdirSync(fixtureDir);
    fs.writeFileSync(path.join(fixtureDir, "seed.txt"), "seed");
    const task: BenchTask = {
      id: "isolation",
      prompt: "run",
      pass: [{ type: "exit_zero" }],
      fixtureDir,
      sourcePath: path.join(root, "task.json"),
    };
    let active = 0;
    let peak = 0;
    const seen = new Set<string>();
    const execute = async (request: CellExecutionRequest) => {
      active++;
      peak = Math.max(peak, active);
      seen.add(request.cwd);
      expect(fs.readFileSync(path.join(request.cwd, "seed.txt"), "utf8")).toBe(
        "seed",
      );
      fs.writeFileSync(
        path.join(request.cwd, `${request.agent}.txt`),
        request.agent,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return { exit: 0, stdout: request.agent, stderr: "" };
    };
    const result = await runCells({
      task,
      prompt: task.prompt,
      cells: ["a", "b", "c", "d"].map((agent) => ({ agent })),
      concurrency: 2,
      execute,
      tempRoot: root,
    });
    expect(peak).toBe(2);
    expect(seen.size).toBe(4);
    expect(result.cells.map((cell) => cell.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
  });
  it("captures cell failures without cancelling sibling cells", async () => {
    const result = await runCells({
      prompt: "x",
      cells: [{ agent: "custom-harness" }, { agent: "native" }],
      concurrency: 2,
      execute: async ({ agent }) =>
        agent === "custom-harness"
          ? { exit: 7, stdout: "", stderr: "failed" }
          : { exit: 0, stdout: "ok", stderr: "" },
    });
    expect(
      result.cells.map((cell) => [cell.agent, cell.status, cell.exit]),
    ).toEqual([
      ["custom-harness", "failed", 7],
      ["native", "passed", 0],
    ]);
  });
  it("captures token totals when a harness reports them", () => {
    expect(extractTokenCount("", "tokens used\n42,390")).toBe(42390);
    expect(extractTokenCount("plain output", "")).toBeUndefined();
  });
});
