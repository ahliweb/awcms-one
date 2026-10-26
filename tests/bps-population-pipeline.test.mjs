/**
 * Unit tests for tools/bps-population/pipeline.ts. No network, no child process:
 * the step runner is an injected fake, and the saved state is kept in memory.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  MAX_ATTEMPTS,
  archiveStepArgv,
  emptyPipelineState,
  extractStepArgv,
  formatLogLine,
  nextProvince,
  parsePipelineState,
  parseProgressProvinces,
  pendingProvinces,
  provinceStateOf,
  recordArchive,
  recordExtract,
  runProvincePass
} from "../tools/bps-population/pipeline.ts";

const AT = "2026-10-26T03:00:00.000Z";

describe("PROVINCE-DONE parsing", () => {
  test("collects two-digit codes from PROVINCE-DONE lines, in order, without duplicates", () => {
    const log = [
      "2026-10-26T02:00:00.000Z PROVINCE-START 62",
      "2026-10-26T02:39:02.030Z PROVINCE-DONE 62 provincial[done=1] regencies[done=14] districts[done=134,missing=2]",
      "2026-10-26T02:39:02.059Z PROVINCE-START 11",
      "2026-10-26T03:10:00.000Z PROVINCE-DONE 11 provincial[done=1]",
      "2026-10-26T03:20:00.000Z PROVINCE-DONE 62 again"
    ].join("\n");
    assert.deepEqual(parseProgressProvinces(log), ["62", "11"]);
  });

  test("ignores START lines, unrelated text, and codes that are not two digits", () => {
    const log = "x PROVINCE-START 62\nnoise\nx PROVINCE-DONE 6 bad\nx PROVINCE-DONE 621 bad\nx PROVINCEDONE 62\n";
    assert.deepEqual(parseProgressProvinces(log), []);
    assert.deepEqual(parseProgressProvinces(""), []);
  });

  test("accepts CRLF line endings", () => {
    assert.deepEqual(parseProgressProvinces("a PROVINCE-DONE 14 x\r\nb PROVINCE-DONE 15 y\r\n"), ["14", "15"]);
  });
});

describe("pipeline state", () => {
  test("blank or missing state is empty; a valid state round-trips", () => {
    assert.deepEqual(parsePipelineState(null), emptyPipelineState());
    assert.deepEqual(parsePipelineState("  \n"), emptyPipelineState());
    const state = recordArchive(recordExtract(emptyPipelineState(), "62", 0, AT), "62", 0, AT);
    assert.deepEqual(parsePipelineState(JSON.stringify(state)), state);
  });

  test("a corrupt or foreign state throws rather than being reset", () => {
    assert.throws(() => parsePipelineState("{broken"), SyntaxError);
    assert.throws(() => parsePipelineState("[]"), /JSON object|unsupported version/);
    assert.throws(() => parsePipelineState(JSON.stringify({ version: 2, processed: {} })), /unsupported version/);
    assert.throws(() => parsePipelineState(JSON.stringify({ version: 1 })), /processed map/);
    assert.throws(
      () => parsePipelineState(JSON.stringify({ version: 1, processed: { 62: { status: "maybe", attempts: 0 } } })),
      /province 62 is malformed/
    );
  });
});

describe("deciding the next province", () => {
  test("pending provinces keep their progress.log order; finished and stuck ones are skipped", () => {
    let state = emptyPipelineState();
    state = recordArchive(recordExtract(state, "62", 0, AT), "62", 0, AT);
    for (let i = 0; i < MAX_ATTEMPTS; i++) state = recordExtract(state, "11", 1, AT);
    assert.equal(provinceStateOf(state, "11").status, "stuck");
    assert.deepEqual(pendingProvinces(["62", "11", "14", "15"], state), ["14", "15"]);
    assert.equal(nextProvince(["62", "11", "14"], state), "14");
  });

  test("nothing is pending when every done province is finished or stuck", () => {
    let state = recordArchive(recordExtract(emptyPipelineState(), "62", 0, AT), "62", 0, AT);
    assert.equal(nextProvince(["62"], state), null);
    assert.equal(nextProvince([], emptyPipelineState()), null);
  });

  test("a province never seen before is pending", () => {
    assert.equal(nextProvince(["62"], emptyPipelineState()), "62");
  });
});

describe("attempt counting", () => {
  test("a failed extract counts; the third failure marks the province stuck", () => {
    let state = emptyPipelineState();
    state = recordExtract(state, "62", 1, AT);
    assert.equal(provinceStateOf(state, "62").attempts, 1);
    assert.equal(provinceStateOf(state, "62").status, "pending");
    state = recordExtract(state, "62", 1, AT);
    state = recordExtract(state, "62", 1, AT);
    assert.equal(provinceStateOf(state, "62").attempts, MAX_ATTEMPTS);
    assert.equal(provinceStateOf(state, "62").status, "stuck");
  });

  test("a successful extract does not count, and a successful archive finishes the province", () => {
    let state = recordExtract(emptyPipelineState(), "62", 1, AT);
    state = recordExtract(state, "62", 0, AT);
    assert.equal(provinceStateOf(state, "62").attempts, 1);
    state = recordArchive(state, "62", 0, AT);
    const done = provinceStateOf(state, "62");
    assert.equal(done.status, "done");
    assert.equal(done.extractExit, 0);
    assert.equal(done.archiveExit, 0);
    assert.equal(done.archivedAt, AT);
  });

  test("a failed archive counts too, and is retried until stuck", () => {
    let state = recordExtract(emptyPipelineState(), "62", 0, AT);
    state = recordArchive(state, "62", 2, AT);
    assert.equal(provinceStateOf(state, "62").status, "pending");
    assert.equal(provinceStateOf(state, "62").archiveExit, 2);
    state = recordArchive(state, "62", 2, AT);
    state = recordArchive(state, "62", 2, AT);
    assert.equal(provinceStateOf(state, "62").status, "stuck");
  });
});

describe("argv and log lines", () => {
  test("child steps are argv arrays with the exact flags", () => {
    const extract = extractStepArgv("62");
    assert.equal(extract.slice(1).join(" ").endsWith("extract/run.ts --from-state --province 62"), true);
    assert.deepEqual(archiveStepArgv().slice(2), ["--commit", "--include-unextracted"]);
  });

  test("a log line names the step, province, exit code and the last output line", () => {
    const line = formatLogLine(AT, "extract", "62", { code: 0, stdout: "first\nlast line\n", stderr: "" });
    assert.equal(line, `${AT} extract 62 exit=0 last line`);
    const failed = formatLogLine(AT, "archive", "-", { code: 1, stdout: "", stderr: "boom\n" });
    assert.equal(failed, `${AT} archive - exit=1 boom`);
  });
});

describe("runProvincePass", () => {
  /** A fake runner that answers per call from a script: extract results keyed by province. */
  function fakeSteps({ extractExit = {}, archiveExit = 0 } = {}) {
    const calls = [];
    const runStep = async (argv) => {
      calls.push(argv.slice(1));
      if (argv.includes("--from-state")) {
        const code = argv[argv.indexOf("--province") + 1];
        const exit = extractExit[code] ?? 0;
        return { code: exit, stdout: `extracted ${code}`, stderr: exit ? "failed" : "" };
      }
      return { code: archiveExit, stdout: "archived", stderr: "" };
    };
    return { runStep, calls };
  }

  function harness(steps, { doneCodes, initialState = emptyPipelineState(), stop = () => false } = {}) {
    const saved = [];
    const lines = [];
    return {
      saved,
      lines,
      run: () =>
        runProvincePass({
          doneCodes,
          initialState,
          saveState: async (state) => {
            saved.push(structuredClone(state));
          },
          runStep: steps.runStep,
          log: async (line) => {
            lines.push(line);
          },
          now: () => AT,
          stopRequested: stop
        })
    };
  }

  test("extract then archive for each done province, in order; both exits recorded", async () => {
    const steps = fakeSteps();
    const h = harness(steps, { doneCodes: ["62", "11"] });
    const state = await h.run();
    assert.deepEqual(steps.calls, [
      extractStepArgv("62").slice(1),
      archiveStepArgv().slice(1),
      extractStepArgv("11").slice(1),
      archiveStepArgv().slice(1)
    ]);
    assert.equal(provinceStateOf(state, "62").status, "done");
    assert.equal(provinceStateOf(state, "11").status, "done");
    assert.equal(h.lines.length, 4);
    assert.match(h.lines[0], /extract 62 exit=0/);
    assert.match(h.lines[1], /archive 62 exit=0/);
  });

  test("a failed extract is not archived; the next province still runs", async () => {
    const steps = fakeSteps({ extractExit: { 62: 1 } });
    const h = harness(steps, { doneCodes: ["62", "11"] });
    const state = await h.run();
    const archiveCalls = steps.calls.filter((c) => c.includes("--commit"));
    assert.equal(archiveCalls.length, 1, "only province 11 is archived");
    assert.equal(provinceStateOf(state, "62").attempts, 1);
    assert.equal(provinceStateOf(state, "62").status, "pending");
    assert.equal(provinceStateOf(state, "11").status, "done");
  });

  test("state is saved after every step, so a restart resumes from the last recorded step", async () => {
    const steps = fakeSteps();
    const h = harness(steps, { doneCodes: ["62"] });
    await h.run();
    assert.equal(h.saved.length, 2);
    assert.equal(h.saved[0].processed["62"].status, "pending");
    assert.equal(h.saved[1].processed["62"].status, "done");
  });

  test("a stop request before a step runs nothing further and records nothing for the interrupted step", async () => {
    const steps = fakeSteps();
    const h = harness(steps, { doneCodes: ["62", "11"], stop: () => true });
    await h.run();
    assert.equal(steps.calls.length, 0);
    assert.equal(h.saved.length, 0);
  });

  test("a province already finished or stuck is not run again", async () => {
    let initial = recordArchive(recordExtract(emptyPipelineState(), "62", 0, AT), "62", 0, AT);
    for (let i = 0; i < MAX_ATTEMPTS; i++) initial = recordExtract(initial, "11", 1, AT);
    const steps = fakeSteps();
    const h = harness(steps, { doneCodes: ["62", "11"], initialState: initial });
    await h.run();
    assert.equal(steps.calls.length, 0);
  });
});
