import { create } from "zustand";
import type { EngineErr, FileItem, Hello } from "./types";

export type EngineState = {
  status: "starting" | "setup" | "ready" | "error";
  hello?: Hello;
  error?: EngineErr;
  setupFraction?: number;
  canRestart?: boolean;
};

export type PreviewState = {
  fileId: string | null;
  status: "idle" | "rendering" | "ready" | "error";
  error?: EngineErr;
  start: number;
  duration: number;
  playing: boolean;
  cleaned: boolean; // which side is audible (B = cleaned)
  origBars: number[];
  wetBars: number[];
  renderedStrength?: number;
  renderedHeavy?: boolean;
};

export type BatchState = {
  running: boolean;
  cancelling: boolean;
  ids: string[];
  settingsLabel: string;
  summary: string;
};

export type HeavyInstallState = { running: boolean; fraction: number; message: string; error?: EngineErr; asking: boolean };

type Store = {
  files: FileItem[];
  selectedId: string | null;
  strength: number;
  mix: number;
  heavy: boolean;
  engine: EngineState;
  preview: PreviewState;
  batch: BatchState;
  heavyInstall: HeavyInstallState;
  dragging: boolean;
};

const SETTINGS_KEY = "openhush.settings";

function loadSettings(): Pick<Store, "strength" | "mix" | "heavy"> {
  const fallback = { strength: 30, mix: 100, heavy: false };
  if (typeof window === "undefined") return fallback;
  try {
    const s = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return {
      strength: Number.isFinite(s.strength) ? Math.min(100, Math.max(6, s.strength)) : 30,
      mix: Number.isFinite(s.mix) ? Math.min(100, Math.max(0, s.mix)) : 100,
      heavy: !!s.heavy,
    };
  } catch {
    return fallback;
  }
}

export const useStore = create<Store>(() => ({
  files: [],
  selectedId: null,
  strength: 30,
  mix: 100,
  heavy: false,
  engine: { status: "starting" },
  preview: {
    fileId: null, status: "idle", start: 0, duration: 0, playing: false, cleaned: true, origBars: [], wetBars: [],
  },
  batch: { running: false, cancelling: false, ids: [], settingsLabel: "", summary: "" },
  heavyInstall: { running: false, fraction: 0, message: "", asking: false },
  dragging: false,
}));

export const set = useStore.setState;
export const get = useStore.getState;

export function restoreSettings() {
  set(loadSettings());
}

export function saveSettings() {
  const { strength, mix, heavy } = get();
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ strength, mix, heavy }));
  } catch {
    /* settings are a convenience; ignore storage errors */
  }
}

export function updateFile(id: string, patch: Partial<FileItem>) {
  set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
}

export function selectedFile(): FileItem | undefined {
  const s = get();
  return s.files.find((f) => f.id === s.selectedId);
}

export const isRunnable = (f: FileItem) => !!f.info && ["ready", "failed", "cancelled"].includes(f.status);
