import { describe, expect, it } from "vitest";
import { parseRunResult, parseTask } from "./schema.js";

describe("bench schemas", () => {
  it("parses the task contract shared with house tasks", () => {
    const task = parseTask(
      {
        id: "hello-repo",
        prompt: "Write the file",
        pass: [
          { type: "file_exists", path: "bench-out.txt" },
          { type: "exit_zero" },
          { type: "stdout_contains", value: "DONE" },
          { type: "command_succeeds", command: "node --check index.js" },
        ],
      },
      "/repo/apps/cli/bench/tasks/hello-repo/task.json",
    );
    expect(task.fixtureDir).toBe(
      "/repo/apps/cli/bench/tasks/hello-repo/fixture",
    );
    expect(task.pass).toHaveLength(4);
  });
  it("rejects unsupported criteria and malformed saved results", () => {
    expect(() =>
      parseTask(
        { id: "x", prompt: "x", pass: [{ type: "guess" }] },
        "/task.json",
      ),
    ).toThrow("unsupported");
    expect(() => parseRunResult({ schema_version: 2 })).toThrow(
      "schema_version",
    );
  });
});
