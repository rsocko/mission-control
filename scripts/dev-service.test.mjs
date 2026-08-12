import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import os from "node:os";

import {
  loadConfig,
  pathsEqual,
  runPortable,
  stopService,
} from "./dev-service.mjs";

const scriptPath = resolve("scripts", "dev-service.mjs");

function fixture(command, overrides = {}) {
  const root = mkdtempSync(join(os.tmpdir(), "mc-dev-service-"));
  const stateHome = join(root, "state");
  const configPath = join(root, "services.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      retentionDays: 1,
      services: {
        fixture: {
          command,
          memoryMb: 128,
          cpuPercent: 75,
          ttlMinutes: 1,
          uncappedTtlMinutes: 1,
          ...overrides,
        },
      },
    }),
  );
  return {
    root,
    stateHome,
    configPath,
    env: {
      ...process.env,
      MC_DEV_SERVICE_ROOT: root,
      MC_DEV_SERVICE_HOME: stateHome,
      MC_DEV_SERVICE_CONFIG: configPath,
    },
  };
}

async function waitForState(stateHome, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let file;
    try {
      file = readdirSync(stateHome, { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.endsWith(".json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (file) {
      const state = JSON.parse(
        readFileSync(join(stateHome, file.name), "utf8").replace(/^\uFEFF/, ""),
      );
      if (predicate(state)) return state;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for service state");
}

test("loadConfig rejects unsafe or incomplete limits", () => {
  const { configPath } = fixture([process.execPath, "-e", "setTimeout(() => {}, 1000)"], {
    cpuPercent: 101,
  });
  assert.throws(() => loadConfig(configPath), /cannot exceed 100/);
});

test("path ownership comparison follows Windows case semantics", () => {
  assert.equal(pathsEqual("C:\\Dev\\Repo", "c:\\dev\\repo", "win32"), true);
  assert.equal(pathsEqual("/Dev/Repo", "/dev/repo", "linux"), false);
});

test("inventory remains available when the service config is missing", () => {
  const root = mkdtempSync(join(os.tmpdir(), "mc-dev-service-list-"));
  const result = spawnSync(process.execPath, [scriptPath, "list"], {
    env: {
      ...process.env,
      MC_DEV_SERVICE_HOME: join(root, "state"),
      MC_DEV_SERVICE_CONFIG: join(root, "missing.json"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No active development services/);
});

test("stop rejects a service that has not received a target process", () => {
  const root = mkdtempSync(join(os.tmpdir(), "mc-dev-service-starting-"));
  const previousHome = process.env.MC_DEV_SERVICE_HOME;
  process.env.MC_DEV_SERVICE_HOME = root;
  const id = "12345678-1234-1234-1234-123456789abc";
  writeFileSync(
    join(root, `${id}.json`),
    JSON.stringify({
      id,
      name: "fixture",
      status: "starting",
      platform: "linux",
      targetPid: null,
      supervisorPid: null,
      createdAt: new Date().toISOString(),
    }),
  );

  try {
    assert.throws(() => stopService(id.slice(0, 8)), /still starting/);
  } finally {
    if (previousHome === undefined) delete process.env.MC_DEV_SERVICE_HOME;
    else process.env.MC_DEV_SERVICE_HOME = previousHome;
  }
});

test("portable launch failures are recorded without an unhandled error", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "mc-dev-service-portable-"));
  const statePath = join(root, "state.json");
  const logPath = join(root, "state.log");
  appendFileSync(logPath, "");
  const state = {
    command: [join(root, "missing-executable")],
    worktree: root,
    logPath,
    ttlMinutes: 1,
    status: "starting",
  };

  const exitCode = await runPortable(state, statePath);
  const saved = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(exitCode, 1);
  assert.equal(saved.status, "failed");
  assert.ok(saved.endedAt);
  assert.match(readFileSync(logPath, "utf8"), /process start failed/);
});

test(
  "Windows Job Object bounds memory and records the stopped service",
  { skip: process.platform !== "win32", timeout: 30_000 },
  () => {
    const allocationScript =
      "const blocks=[];setInterval(()=>blocks.push(Buffer.alloc(8*1024*1024,1)),20)";
    const fixtureData = fixture([process.execPath, "-e", allocationScript], {
      memoryMb: 128,
    });
    const result = spawnSync(process.execPath, [scriptPath, "run", "fixture"], {
      env: fixtureData.env,
      encoding: "utf8",
      timeout: 20_000,
    });

    assert.equal(result.error?.code, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "the runaway process should be terminated by its job");
    const stateFile = readdirSync(fixtureData.stateHome)
      .find((name) => name.endsWith(".json"));
    const state = JSON.parse(
      readFileSync(join(fixtureData.stateHome, stateFile), "utf8").replace(/^\uFEFF/, ""),
    );
    assert.equal(state.boundary, "windows-job-object");
    assert.equal(state.memoryLimitMb, 128);
    assert.equal(state.status, "failed");
    assert.ok(state.targetPid > 0, "the bounded child must have started");
    assert.ok(state.peakMemoryMb > 0, "the supervisor must sample job memory");
    assert.ok(state.endedAt);
  },
);

test(
  "active inventory identifies ownership and stop terminates the whole job",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const fixtureData = fixture([
      process.execPath,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    const supervisor = spawn(process.execPath, [scriptPath, "run", "fixture"], {
      env: fixtureData.env,
      stdio: "ignore",
    });
    const running = await waitForState(
      fixtureData.stateHome,
      (state) => state.status === "running",
    );

    const inventory = spawnSync(process.execPath, [scriptPath, "list", "--json"], {
      env: fixtureData.env,
      encoding: "utf8",
    });
    assert.equal(inventory.status, 0, inventory.stderr);
    const [listed] = JSON.parse(inventory.stdout);
    assert.equal(listed.id, running.id);
    assert.equal(listed.worktree, fixtureData.root);
    assert.ok(listed.targetPid > 0);

    const stopped = spawnSync(
      process.execPath,
      [scriptPath, "stop", running.id.slice(0, 8)],
      { env: fixtureData.env, encoding: "utf8" },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    await waitForState(
      fixtureData.stateHome,
      (state) => state.status === "stopped",
    );
    if (supervisor.exitCode === null) {
      await new Promise((resolvePromise) => supervisor.once("exit", resolvePromise));
    }
    assert.equal(supervisor.exitCode, 0);
  },
);
