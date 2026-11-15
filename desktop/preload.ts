// The only bridge between the web UI and the rest of the app. Exposes a small, typed API on window.openhush.
import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  /** Call an engine method (probe, peaks, preview, startBatch, ...). Rejects with {message, details}. */
  call: (method: string, params?: Record<string, unknown>) => ipcRenderer.invoke("engine:call", method, params ?? {}),
  /** Subscribe to engine events (jobProgress, jobDone, ...). Returns an unsubscribe function. */
  on: (event: string, cb: (data: unknown) => void) => {
    const listener = (_e: unknown, name: string, data: unknown) => {
      if (name === event) cb(data);
    };
    ipcRenderer.on("engine:event", listener);
    return () => ipcRenderer.removeListener("engine:event", listener);
  },
  /** Real filesystem path of a dropped file. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:openFiles"),
  reveal: (p: string) => ipcRenderer.invoke("shell:reveal", p),
  readPreview: (p: string): Promise<ArrayBuffer> => ipcRenderer.invoke("preview:read", p),
  getTheme: (): Promise<"system" | "light" | "dark"> => ipcRenderer.invoke("theme:get"),
  setTheme: (mode: "system" | "light" | "dark") => ipcRenderer.invoke("theme:set", mode),
  restartEngine: () => ipcRenderer.invoke("engine:restart"),
  /** In-app updates from GitHub Releases. */
  updates: {
    get: () => ipcRenderer.invoke("update:get"),
    download: () => ipcRenderer.invoke("update:download"),
    /** Quits, swaps the app and relaunches. Resolves to a reason string if it can't right now. */
    install: (): Promise<string | null> => ipcRenderer.invoke("update:install"),
    onState: (cb: (state: unknown) => void) => {
      const listener = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },
  onMenu: (cb: (command: string) => void) => {
    const listener = (_e: unknown, command: string) => cb(command);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.removeListener("menu", listener);
  },
};

contextBridge.exposeInMainWorld("openhush", api);
export type OpenHushApi = typeof api;
