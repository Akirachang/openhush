// Spawns the Python engine and speaks its newline-delimited JSON protocol (see engine/openhush_engine/server.py).
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

export type EngineError = { message: string; details?: string; cancelled?: boolean };

type Pending = { resolve: (v: unknown) => void; reject: (e: EngineError) => void };

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin"), path.join(homedir(), ".cargo/bin")];

function findUv(): string | null {
  for (const dir of [...(process.env.PATH ?? "").split(":"), ...EXTRA_PATH]) {
    const candidate = path.join(dir, "uv");
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}

export type EngineCommand = { command: string; args: string[]; cwd?: string; env?: Record<string, string> };

/** The packaged app ships a frozen engine binary; in development we run the Python package through uv. */
export function resolveEngineCommand(opts: { packaged: boolean; resourcesPath: string; repoRoot: string }): EngineCommand {
  if (opts.packaged) {
    const uv = path.join(opts.resourcesPath, "bin", "uv"); // bundled, for installing Heavy repair
    return {
      command: path.join(opts.resourcesPath, "engine", "openhush-engine", "openhush-engine"),
      args: [],
      env: existsSync(uv) ? { UV: uv } : {},
    };
  }
  const uv = findUv();
  if (!uv) throw new Error("uv not found. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh");
  const project = path.join(opts.repoRoot, "engine");
  return { command: uv, args: ["run", "--quiet", "--project", project, "python", "-m", "openhush_engine.server"], cwd: project };
}

export class EngineBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private cmd: EngineCommand, private log: (line: string) => void) {
    super();
  }

  start(): Promise<void> {
    this.stopping = false;
    const env = {
      ...process.env,
      ...this.cmd.env,
      PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(":"),
      PYTHONUNBUFFERED: "1",
    };
    const proc = spawn(this.cmd.command, this.cmd.args, { cwd: this.cmd.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.readyPromise = new Promise((resolve, reject) => {
      const onReady = () => resolve();
      this.once("ready", onReady);
      proc.once("error", (err) => {
        this.off("ready", onReady);
        reject(err);
      });
      proc.once("exit", (code) => {
        this.off("ready", onReady);
        reject(new Error(`engine exited during startup (code ${code})`));
      });
    });

    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => this.log(`[engine] ${line}`));
    proc.on("exit", (code, signal) => {
      this.proc = null;
      for (const p of this.pending.values()) p.reject({ message: "The audio engine stopped unexpectedly.", details: `exit ${code ?? signal}` });
      this.pending.clear();
      if (!this.stopping) this.emit("engineExit", { code, signal });
    });
    return this.readyPromise;
  }

  private onLine(line: string) {
    let msg: { id?: number | null; result?: unknown; error?: EngineError; event?: string; data?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[engine] unparsable: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.event) {
      this.emit(msg.event, msg.data);
      this.emit("*", msg.event, msg.data);
      return;
    }
    const p = msg.id != null ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.readyPromise;
    if (!this.proc) throw { message: "The audio engine isn't running.", details: "" } satisfies EngineError;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Closing stdin makes the engine cancel all work and exit; kill it if it doesn't. */
  async stop(timeoutMs = 8000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin.end();
    });
  }
}
