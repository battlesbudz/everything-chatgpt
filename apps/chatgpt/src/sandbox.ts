import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type SandboxResult = { ok: boolean; exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; truncated: boolean };

const MAX_OUTPUT = 32_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_COMMANDS = new Set((process.env.ECG_SANDBOX_ALLOWED_COMMANDS || "npm test,npm run check,npm run lint,pytest,go test ./...,cargo test").split(",").map((x) => x.trim()).filter(Boolean));

function commandKey(command: string, args: string[]): string { return [command, ...args].join(" ").trim(); }

export async function runSandboxedTest(input: { files: Array<{ path: string; content: string }>; command: string; args: string[]; timeoutMs?: number }): Promise<SandboxResult> {
  if (process.env.ECG_SANDBOX_ENABLED !== "true") throw new Error("Sandboxed execution is disabled. Set ECG_SANDBOX_ENABLED=true only on an isolated worker.");
  const key = commandKey(input.command, input.args);
  if (!ALLOWED_COMMANDS.has(key)) throw new Error(`Command is not allowlisted: ${key}`);
  const sandboxWrapper = process.env.ECG_SANDBOX_WRAPPER?.trim();
  if (!sandboxWrapper) throw new Error("ECG_SANDBOX_WRAPPER is required; refuse to run code without an isolation wrapper.");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ecg-sandbox-"));
  const started = Date.now();
  let output = "";
  let error = "";
  let truncated = false;
  try {
    for (const file of input.files) {
      const target = path.resolve(workspace, file.path);
      if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error("Sandbox file path escapes the workspace.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 1_000), MAX_TIMEOUT_MS);
    const child = spawn(sandboxWrapper, [workspace, input.command, ...input.args], { cwd: workspace, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = target === "stdout" ? output + chunk.toString("utf8") : error + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT) { truncated = true; if (target === "stdout") output = next.slice(0, MAX_OUTPUT); else error = next.slice(0, MAX_OUTPUT); }
      else if (target === "stdout") output = next; else error = next;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", reject);
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    return { ok: result.code === 0, exitCode: result.code, signal: result.signal, stdout: output, stderr: error, durationMs: Date.now() - started, truncated };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
