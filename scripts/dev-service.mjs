#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_ROOT, "..");
const DEFAULT_CONFIG_PATH = join(DEFAULT_PROJECT_ROOT, "config", "dev-services.json");
const WINDOWS_HOST_PATH = join(SCRIPT_ROOT, "windows-job-host.ps1");

function stateHome() {
  if (process.env.MC_DEV_SERVICE_HOME) {
    return resolve(process.env.MC_DEV_SERVICE_HOME);
  }
  const base = process.env.LOCALAPPDATA || join(os.homedir(), ".local", "state");
  return join(base, "MissionControl", "dev-services");
}

function projectRoot() {
  return resolve(process.env.MC_DEV_SERVICE_ROOT || DEFAULT_PROJECT_ROOT);
}

function configPath() {
  return resolve(process.env.MC_DEV_SERVICE_CONFIG || DEFAULT_CONFIG_PATH);
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function loadConfig(filePath = configPath()) {
  const config = readJson(filePath);
  if (!config.services || typeof config.services !== "object") {
    throw new Error(`${filePath} must define a services object`);
  }

  for (const [name, service] of Object.entries(config.services)) {
    if (!Array.isArray(service.command) || service.command.length === 0) {
      throw new Error(`Service "${name}" must define a non-empty command array`);
    }
    for (const field of ["memoryMb", "cpuPercent", "ttlMinutes", "uncappedTtlMinutes"]) {
      if (!Number.isFinite(service[field]) || service[field] <= 0) {
        throw new Error(`Service "${name}" must define a positive ${field}`);
      }
    }
    if (service.cpuPercent > 100) {
      throw new Error(`Service "${name}" cpuPercent cannot exceed 100`);
    }
  }
  return config;
}

function readStates({ includeFinished = false } = {}) {
  const home = stateHome();
  mkdirSync(home, { recursive: true });
  const states = [];

  for (const name of readdirSync(home)) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(home, name);
    try {
      const state = readJson(filePath);
      const startingWithoutSupervisor =
        state.status === "starting" &&
        !state.supervisorPid &&
        Date.now() - Date.parse(state.createdAt) > 30_000;
      if (
        startingWithoutSupervisor ||
        (["starting", "running", "stopping"].includes(state.status) &&
          state.supervisorPid &&
          !isProcessRunning(state.supervisorPid))
      ) {
        state.status = "orphaned";
        state.endedAt = new Date().toISOString();
        state.updatedAt = state.endedAt;
        atomicWriteJson(filePath, state);
      }
      if (includeFinished || ["starting", "running", "stopping"].includes(state.status)) {
        states.push({ ...state, statePath: filePath });
      }
    } catch (error) {
      console.error(`Ignoring unreadable service state ${filePath}: ${error.message}`);
    }
  }
  return states.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function pruneFinished(retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const state of readStates({ includeFinished: true })) {
    if (
      !["starting", "running", "stopping"].includes(state.status) &&
      Date.parse(state.endedAt || state.updatedAt || state.createdAt) < cutoff
    ) {
      rmSync(state.statePath, { force: true });
      if (state.logPath) rmSync(state.logPath, { force: true });
    }
  }
}

function parseRunArguments(arguments_) {
  let serviceName = "mission-control";
  let uncapped = false;
  let port;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--uncapped") {
      uncapped = true;
    } else if (argument === "--port") {
      port = Number(arguments_[index + 1]);
      index += 1;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
    } else if (!argument.startsWith("-")) {
      serviceName = argument;
    } else {
      throw new Error(`Unknown run option: ${argument}`);
    }
  }
  return { serviceName, uncapped, port };
}

function expandedCommand(command) {
  return command.map((part) => part.replaceAll("${node}", process.execPath));
}

function replacePort(command, portArgument, port) {
  if (!portArgument) return command;
  const index = command.indexOf(portArgument);
  if (index === -1 || index === command.length - 1) {
    throw new Error(`Configured port argument "${portArgument}" is missing a value`);
  }
  const result = [...command];
  result[index + 1] = String(port);
  return result;
}

export function pathsEqual(left, right, platform = process.platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function initialState({ id, name, service, command, port, uncapped, statePath, logPath }) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    repository: basename(projectRoot()),
    worktree: projectRoot(),
    port: port ?? null,
    command,
    status: "starting",
    platform: process.platform,
    boundary: process.platform === "win32" ? "windows-job-object" : "process-group",
    memoryLimitMb: uncapped ? null : service.memoryMb,
    cpuLimitPercent: uncapped ? null : service.cpuPercent,
    ttlMinutes: uncapped ? service.uncappedTtlMinutes : service.ttlMinutes,
    uncapped,
    supervisorPid: null,
    targetPid: null,
    processIds: [],
    currentMemoryMb: 0,
    peakMemoryMb: 0,
    cpuSeconds: 0,
    exitCode: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    endedAt: null,
    stopRequestedAt: null,
    statePath,
    logPath,
  };
}

function runWindows(state, statePath) {
  const commandBase64 = Buffer.from(JSON.stringify(state.command), "utf8").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_HOST_PATH,
      "-Action",
      "run",
      "-StatePath",
      statePath,
      "-JobName",
      `Local\\MCDev-${state.id}`,
      "-WorkingDirectory",
      state.worktree,
      "-CommandBase64",
      commandBase64,
      "-MemoryBytes",
      String((state.memoryLimitMb || 0) * 1024 * 1024),
      "-CpuPercent",
      String(state.cpuLimitPercent || 0),
      "-TtlSeconds",
      String(state.ttlMinutes * 60),
    ],
    { cwd: state.worktree, stdio: "inherit", windowsHide: false },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runPortable(state, statePath) {
  appendFileSync(
    state.logPath,
    `${new Date().toISOString()} platform does not support Job Object limits; using a TTL process group\n`,
  );
  const child = spawn(state.command[0], state.command.slice(1), {
    cwd: state.worktree,
    detached: true,
    stdio: "inherit",
  });
  state.supervisorPid = process.pid;
  state.targetPid = child.pid;
  state.processIds = [child.pid];
  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.updatedAt = state.startedAt;
  atomicWriteJson(statePath, state);

  let finished = false;
  let timer;
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const finalize = (status, exitCode) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    state.status = status;
    state.exitCode = exitCode;
    state.endedAt = new Date().toISOString();
    state.updatedAt = state.endedAt;
    atomicWriteJson(statePath, state);
  };

  return new Promise((resolvePromise) => {
    const finish = (status, exitCode) => {
      finalize(status, exitCode);
      resolvePromise(exitCode ?? 1);
    };
    child.once("error", (error) => {
      appendFileSync(
        state.logPath,
        `${new Date().toISOString()} process start failed: ${error.message}\n`,
      );
      finish("failed", 1);
    });
    child.once("exit", (code, signal) => {
      finish(signal ? "stopped" : code === 0 ? "stopped" : "failed", code);
    });
    timer = setTimeout(stop, state.ttlMinutes * 60 * 1000);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runService(arguments_) {
  const config = loadConfig();
  pruneFinished(config.retentionDays || 7);
  const { serviceName, uncapped, port: requestedPort } = parseRunArguments(arguments_);
  const service = config.services[serviceName];
  if (!service) {
    throw new Error(
      `Unknown service "${serviceName}". Available services: ${Object.keys(config.services).join(", ")}`,
    );
  }

  const port = requestedPort ?? service.port;
  const root = projectRoot();
  const conflicts = readStates().filter(
    (state) =>
      (pathsEqual(state.worktree, root) &&
        state.name === serviceName) ||
      (port && state.port === port),
  );
  if (conflicts.length > 0) {
    const conflict = conflicts[0];
    throw new Error(
      `Service ${conflict.id.slice(0, 8)} already owns ${conflict.name} on port ${conflict.port}`,
    );
  }

  const id = randomUUID();
  const home = stateHome();
  mkdirSync(home, { recursive: true });
  const statePath = join(home, `${id}.json`);
  const logPath = join(home, `${id}.log`);
  const command = replacePort(
    expandedCommand(service.command),
    service.portArgument,
    port,
  );
  const state = initialState({
    id,
    name: serviceName,
    service,
    command,
    port,
    uncapped,
    statePath,
    logPath,
  });
  atomicWriteJson(statePath, state);
  appendFileSync(
    logPath,
    `${state.createdAt} registered ${serviceName} worktree=${state.worktree} port=${port ?? "none"}\n`,
  );

  const limitDescription = uncapped
    ? `uncapped, TTL ${state.ttlMinutes}m`
    : `${state.memoryLimitMb} MB, ${state.cpuLimitPercent}% CPU, TTL ${state.ttlMinutes}m`;
  console.log(`Starting ${serviceName} (${id.slice(0, 8)}) on port ${port}; ${limitDescription}`);
  console.log(`Lifecycle log: ${logPath}`);
  return process.platform === "win32"
    ? runWindows(state, statePath)
    : runPortable(state, statePath);
}

function formatAge(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function printStates(states) {
  if (states.length === 0) {
    console.log("No active development services.");
    return;
  }
  const rows = states.map((state) => ({
    ID: state.id.slice(0, 8),
    SERVICE: state.name,
    PORT: state.port ?? "-",
    PID: state.targetPid ?? "-",
    UPTIME: formatAge(state.startedAt || state.createdAt),
    MEMORY: `${state.currentMemoryMb || 0}/${state.memoryLimitMb || "uncapped"} MB`,
    CPU: state.cpuLimitPercent ? `${state.cpuLimitPercent}% cap` : "uncapped",
    WORKTREE: state.worktree,
  }));
  console.table(rows);
}

function findState(identifier) {
  const matches = readStates().filter(
    (state) => state.id.startsWith(identifier) || state.name === identifier,
  );
  if (matches.length === 0) throw new Error(`No active service matches "${identifier}"`);
  if (matches.length > 1) {
    throw new Error(`"${identifier}" matches multiple services; use the ID shown by list`);
  }
  return matches[0];
}

export function stopService(identifier) {
  if (!identifier) throw new Error("stop requires a service ID or unique service name");
  const state = findState(identifier);
  if (!Number.isInteger(state.targetPid) || state.targetPid <= 0) {
    throw new Error(`Service ${state.id.slice(0, 8)} is still starting; try again`);
  }
  if (state.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_HOST_PATH,
        "-Action",
        "terminate",
        "-StatePath",
        state.statePath,
        "-JobName",
        `Local\\MCDev-${state.id}`,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Failed to stop ${state.id.slice(0, 8)}`);
  } else {
    process.kill(-state.targetPid, "SIGTERM");
  }
  console.log(`Stop requested for ${state.name} (${state.id.slice(0, 8)}).`);
}

function showLogs(identifier) {
  if (!identifier) throw new Error("logs requires a service ID or unique service name");
  const states = readStates({ includeFinished: true }).filter(
    (state) => state.id.startsWith(identifier) || state.name === identifier,
  );
  if (states.length !== 1) {
    throw new Error(
      states.length === 0
        ? `No service matches "${identifier}"`
        : `"${identifier}" matches multiple services; use a service ID`,
    );
  }
  console.log(readFileSync(states[0].logPath, "utf8").trimEnd());
}

function usage() {
  console.log(`Usage:
  node scripts/dev-service.mjs run [service] [--port PORT] [--uncapped]
  node scripts/dev-service.mjs list [--json]
  node scripts/dev-service.mjs stop <id|service>
  node scripts/dev-service.mjs logs <id|service>`);
}

export async function main(arguments_ = process.argv.slice(2)) {
  const [action = "list", ...rest] = arguments_;

  if (action === "run") return runService(rest);
  pruneFinished(7);
  if (action === "list") {
    const states = readStates();
    if (rest.includes("--json")) console.log(JSON.stringify(states, null, 2));
    else printStates(states);
    return 0;
  }
  if (action === "stop") {
    stopService(rest[0]);
    return 0;
  }
  if (action === "logs") {
    showLogs(rest[0]);
    return 0;
  }
  usage();
  throw new Error(`Unknown action: ${action}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`dev-service: ${error.message}`);
    process.exitCode = 1;
  }
}
