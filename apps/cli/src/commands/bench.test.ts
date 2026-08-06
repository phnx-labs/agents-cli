import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBenchCommand } from "./bench.js";
describe("agents bench command", () => {
  it("registers list, results, and run with custom harness agent input", () => {
    const program = new Command();
    registerBenchCommand(program);
    const bench = program.commands.find(
      (command) => command.name() === "bench",
    );
    expect(bench?.commands.map((command) => command.name())).toEqual([
      "list",
      "results",
      "run",
    ]);
    expect(
      bench?.commands
        .find((command) => command.name() === "run")
        ?.options.some((option) => option.long === "--agent"),
    ).toBe(true);
  });
});
