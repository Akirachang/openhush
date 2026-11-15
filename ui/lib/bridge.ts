// Typed access to window.openhush (exposed by desktop/preload.ts).
import type { EngineErr } from "./types";

type ThemeMode = "system" | "light" | "dark";

export interface OpenHushApi {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, cb: (data: unknown) => void): () => void;
  pathForFile(file: File): string;
  openFiles(): Promise<string[]>;
  reveal(path: string): Promise<void>;
  readPreview(path: string): Promise<ArrayBuffer>;
  getTheme(): Promise<ThemeMode>;
  setTheme(mode: ThemeMode): Promise<void>;
  restartEngine(): Promise<void>;
  onMenu(cb: (command: string) => void): () => void;
}

declare global {
  interface Window {
    openhush?: OpenHushApi;
  }
}

export function api(): OpenHushApi {
  if (typeof window === "undefined" || !window.openhush) {
    throw { message: "OpenHush must run inside its desktop app." } satisfies EngineErr;
  }
  return window.openhush;
}

export function hasApi(): boolean {
  return typeof window !== "undefined" && !!window.openhush;
}

/** Electron wraps errors from the main process as "Error invoking remote method …: Error: {json}". */
export function toErr(e: unknown): EngineErr {
  if (e && typeof e === "object" && "message" in e) {
    const msg = String((e as { message: unknown }).message);
    const i = msg.indexOf("{");
    if (i >= 0) {
      try {
        return JSON.parse(msg.slice(i)) as EngineErr;
      } catch {
        /* fall through */
      }
    }
    return { message: msg, details: (e as { details?: string }).details };
  }
  return { message: String(e) };
}

export async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await api().call(method, params)) as T;
  } catch (e) {
    throw toErr(e);
  }
}
