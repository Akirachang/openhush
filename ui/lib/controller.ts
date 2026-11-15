// App behaviour: talks to the engine through the bridge and updates the store.
import { api, call, hasApi, toErr } from "./bridge";
import { basename } from "./format";
import { barsOf, player } from "./player";
import { get, isRunnable, restoreSettings, saveSettings, selectedFile, set, updateFile } from "./store";
import type { EngineErr, FileItem, Hello, HeavyStatus, PreviewResult, ProbeInfo } from "./types";

let seq = 0;
const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;
const BARS = 110;
const PEAK_BUCKETS = 800;

// ------------------------------------------------------------------ engine lifecycle

async function onHello(h: Hello) {
  set((s) => ({ engine: { ...s.engine, hello: h } }));
  if (!h.ffmpeg.ok) {
    set({ engine: { status: "error", hello: h, error: { message: h.ffmpeg.message, details: h.ffmpeg.details } } });
    return;
  }
  if (!h.engineReady) {
    set({ engine: { status: "setup", hello: h, setupFraction: 0 } });
    try {
      await call("setupEngine");
      return onHello(await call<Hello>("hello"));
    } catch (e) {
      set({ engine: { status: "error", hello: h, error: toErr(e), canRestart: true } });
      return;
    }
  }
  if (!h.heavy.gpu || !h.heavy.installed) set({ heavy: false });
  set({ engine: { status: "ready", hello: h } });
}

export async function checkEngine() {
  set((s) => ({ engine: { ...s.engine, status: "starting", error: undefined } }));
  try {
    await onHello(await call<Hello>("hello"));
  } catch (e) {
    set({ engine: { status: "error", error: toErr(e), canRestart: true } });
  }
}

export async function restartEngine() {
  set({ engine: { status: "starting" } });
  try {
    await api().restartEngine();
  } catch (e) {
    set({ engine: { status: "error", error: toErr(e), canRestart: true } });
  }
}

/** Wire engine events and menu commands. Returns a cleanup function. */
export function initApp(): () => void {
  restoreSettings();
  if (!hasApi()) {
    set({ engine: { status: "error", error: { message: "Open OpenHush from its app to use it." } } });
    return () => {};
  }
  const b = api();
  const offs = [
    b.on("engineReady", (h) => void onHello(h as Hello)),
    b.on("engineProgress", (d) => set((s) => ({ engine: { ...s.engine, setupFraction: (d as { fraction: number }).fraction } }))),
    b.on("engineExit", () => {
      set({ engine: { status: "error", error: { message: "The audio engine stopped unexpectedly. It's restarting…" }, canRestart: true } });
      const { batch } = get();
      if (batch.running) {
        for (const id of batch.ids) {
          const f = get().files.find((x) => x.id === id);
          if (f && (f.status === "running" || f.status === "queued")) updateFile(id, { status: "cancelled", message: "" });
        }
        set({ batch: { ...get().batch, running: false, cancelling: false, summary: "Stopped because the engine restarted." } });
      }
    }),
    b.on("jobStarted", (d) => {
      const { id } = d as { id: string };
      updateFile(id, { status: "running", progress: 0, message: "Starting…", jobStartedAt: Date.now() });
    }),
    b.on("jobProgress", (d) => {
      const { id, fraction, message } = d as { id: string; fraction: number; message: string };
      updateFile(id, { status: "running", progress: fraction, message });
    }),
    b.on("jobDone", (d) => {
      const { id, output } = d as { id: string; output: string };
      updateFile(id, { status: "done", progress: 1, output, message: "", error: undefined });
    }),
    b.on("jobFailed", (d) => {
      const { id, message, details } = d as { id: string; message: string; details: string };
      updateFile(id, { status: "failed", error: { message, details }, message: "" });
    }),
    b.on("jobCancelled", (d) => updateFile((d as { id: string }).id, { status: "cancelled", message: "" })),
    b.on("batchFinished", (d) => {
      const { cancelled } = d as { cancelled: boolean };
      const ids = get().batch.ids;
      const files = get().files.filter((f) => ids.includes(f.id));
      const done = files.filter((f) => f.status === "done").length;
      const failed = files.filter((f) => f.status === "failed").length;
      const summary = cancelled
        ? `Cancelled · ${done} of ${files.length} finished`
        : `${done} cleaned` + (failed ? ` · ${failed} failed` : "");
      set({ batch: { ...get().batch, running: false, cancelling: false, summary } });
    }),
    b.on("heavyProgress", (d) => {
      const { fraction, message } = d as { fraction: number; message: string };
      set((s) => ({ heavyInstall: { ...s.heavyInstall, fraction, message } }));
    }),
    b.onMenu((cmd) => {
      if (cmd === "add-files") void browse();
      else if (cmd === "clean") void startBatch();
      else if (cmd === "reveal") revealSelected();
      else if (cmd === "remove") removeSelected();
    }),
  ];
  void checkEngine();
  return () => offs.forEach((off) => off());
}

// ------------------------------------------------------------------ files

export async function browse() {
  if (!hasApi()) return;
  const paths = await api().openFiles();
  if (paths.length) await addPaths(paths);
}

export async function addPaths(paths: string[]) {
  let expanded: string[];
  try {
    expanded = await call<string[]>("expandPaths", { paths });
  } catch {
    expanded = paths;
  }
  const known = new Set(get().files.map((f) => f.path));
  const fresh: FileItem[] = expanded
    .filter((p) => !known.has(p))
    .map((p) => ({ id: newId(), path: p, name: basename(p), status: "probing", previewStart: 0 }));
  if (!fresh.length) return;
  set((s) => ({ files: [...s.files, ...fresh], selectedId: s.selectedId ?? fresh[0].id }));
  if (get().selectedId === fresh[0].id) void onSelect();
  await Promise.all(
    fresh.map(async (f) => {
      try {
        const info = await call<ProbeInfo>("probe", { path: f.path });
        updateFile(f.id, { status: "ready", info });
        if (get().selectedId === f.id) void loadPeaks(f.id);
      } catch (e) {
        updateFile(f.id, { status: "invalid", error: toErr(e) });
      }
    }),
  );
}

export function select(id: string | null) {
  if (id === get().selectedId) return;
  set({ selectedId: id });
  void onSelect();
}

export function moveSelection(delta: number) {
  const { files, selectedId } = get();
  if (!files.length) return;
  const i = files.findIndex((f) => f.id === selectedId);
  const next = files[Math.min(files.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
  select(next.id);
}

async function onSelect() {
  resetPreview();
  const f = selectedFile();
  if (f?.info && !f.peaks) await loadPeaks(f.id);
}

async function loadPeaks(id: string) {
  const f = get().files.find((x) => x.id === id);
  if (!f?.info || f.peaks) return;
  try {
    const res = await call<{ peaks: number[] }>("peaks", { path: f.path, buckets: PEAK_BUCKETS });
    updateFile(id, { peaks: res.peaks });
  } catch {
    updateFile(id, { peaks: [] });
  }
}

export function remove(ids: string[]) {
  const { batch } = get();
  const removable = ids.filter((id) => {
    const f = get().files.find((x) => x.id === id);
    return f && !(batch.running && batch.ids.includes(id) && ["queued", "running"].includes(f.status));
  });
  if (!removable.length) return;
  const wasSelected = removable.includes(get().selectedId ?? "");
  set((s) => ({ files: s.files.filter((f) => !removable.includes(f.id)) }));
  if (wasSelected) {
    const first = get().files[0];
    set({ selectedId: first?.id ?? null });
    void onSelect();
  }
}

export function removeSelected() {
  const id = get().selectedId;
  if (id) remove([id]);
}

export function clearFinished() {
  remove(get().files.filter((f) => f.status === "done" || f.status === "invalid").map((f) => f.id));
}

export function reveal(f: FileItem) {
  if (!hasApi()) return;
  void api().reveal(f.output ?? f.path);
}

export function revealSelected() {
  const f = selectedFile();
  if (f) reveal(f);
}

// ------------------------------------------------------------------ settings

let rerenderTimer: ReturnType<typeof setTimeout> | undefined;
function rerenderSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    const p = get().preview;
    const f = selectedFile();
    if (f && p.fileId === f.id && p.status !== "idle") void renderPreview({ autoplay: p.playing, keepPosition: true });
  }, 350);
}

export function setStrength(v: number) {
  set({ strength: v });
  saveSettings();
  rerenderSoon();
}

export function setMix(v: number) {
  set({ mix: v });
  saveSettings();
  player.setMix(get().heavy ? 1 : v / 100);
}

export function setHeavy(on: boolean) {
  const hs = get().engine.hello?.heavy;
  if (on && hs && !hs.installed) {
    set((s) => ({ heavyInstall: { ...s.heavyInstall, asking: true, error: undefined } }));
    return;
  }
  set({ heavy: on });
  saveSettings();
  player.setMix(on ? 1 : get().mix / 100);
  rerenderSoon();
}

export function cancelHeavyInstall() {
  set((s) => ({ heavyInstall: { ...s.heavyInstall, asking: false } }));
}

export async function installHeavy() {
  set({ heavyInstall: { running: true, asking: false, fraction: 0, message: "Starting…" } });
  try {
    const status = await call<HeavyStatus>("installHeavy");
    set((s) => ({
      heavyInstall: { ...s.heavyInstall, running: false },
      engine: s.engine.hello ? { ...s.engine, hello: { ...s.engine.hello, heavy: status } } : s.engine,
    }));
    setHeavy(true);
  } catch (e) {
    set((s) => ({ heavyInstall: { ...s.heavyInstall, running: false, error: toErr(e) } }));
  }
}

// ------------------------------------------------------------------ batch

export async function startBatch() {
  const { files, batch, engine, strength, mix, heavy } = get();
  if (batch.running || engine.status !== "ready") return;
  const jobs = files.filter(isRunnable);
  if (!jobs.length) return;
  const ids = jobs.map((f) => f.id);
  set((s) => ({
    files: s.files.map((f) => (ids.includes(f.id) ? { ...f, status: "queued", message: "Waiting…", error: undefined, progress: 0 } : f)),
    batch: {
      running: true, cancelling: false, ids, summary: "",
      settingsLabel: heavy ? `Heavy repair · ${strength} dB` : `${strength} dB · mix ${mix}%`,
    },
  }));
  try {
    await call("startBatch", { jobs: jobs.map((f) => ({ id: f.id, path: f.path })), settings: { strength, mix, heavy } });
  } catch (e) {
    const err = toErr(e);
    set((s) => ({
      files: s.files.map((f) => (ids.includes(f.id) ? { ...f, status: "failed", error: err, message: "" } : f)),
      batch: { ...s.batch, running: false, summary: err.message },
    }));
  }
}

export async function cancelBatch() {
  set((s) => ({ batch: { ...s.batch, cancelling: true } }));
  try {
    await call("cancelBatch");
  } catch {
    /* batchFinished will still arrive, or engineExit */
  }
}

// ------------------------------------------------------------------ preview

let previewReq = 0;
// "Start playing when the render is ready" survives a newer render replacing the one in flight
// (e.g. Strength or Heavy repair changed right after pressing Play).
let autoplayWanted = false;

function resetPreview() {
  previewReq++;
  autoplayWanted = false;
  player.unload();
  if (hasApi()) void call("cancelPreview").catch(() => {});
  set((s) => ({
    preview: { ...s.preview, fileId: get().selectedId, status: "idle", playing: false, origBars: [], wetBars: [], error: undefined },
  }));
}

export async function renderPreview(opts: { autoplay: boolean; keepPosition: boolean }) {
  const f = selectedFile();
  if (!f?.info || get().engine.status !== "ready") return;
  const req = ++previewReq;
  const inFlight = get().preview.status === "rendering" && get().preview.fileId === f.id;
  autoplayWanted = opts.autoplay || (inFlight && autoplayWanted);
  const { strength, heavy } = get();
  set((s) => ({ preview: { ...s.preview, fileId: f.id, status: "rendering", error: undefined } }));
  try {
    const res = await call<PreviewResult>("preview", { path: f.path, start: f.previewStart, strength, heavy });
    const [o, c] = await Promise.all([api().readPreview(res.original), api().readPreview(res.cleaned)]);
    const [ob, cb] = await Promise.all([player.decode(o), player.decode(c)]);
    if (req !== previewReq) return;
    player.setMix(heavy ? 1 : get().mix / 100);
    player.setCleaned(get().preview.cleaned);
    player.load(ob, cb, opts.keepPosition);
    if (autoplayWanted && !player.playing) player.play();
    autoplayWanted = false;
    set((s) => ({
      preview: {
        ...s.preview, fileId: f.id, status: "ready", start: res.start, duration: res.duration,
        playing: player.playing, origBars: barsOf(ob, BARS), wetBars: barsOf(cb, BARS),
        renderedStrength: res.strength, renderedHeavy: res.heavy,
      },
    }));
  } catch (e) {
    const err = toErr(e) as EngineErr;
    if (err.cancelled || req !== previewReq) return;
    set((s) => ({ preview: { ...s.preview, status: "error", error: err, playing: false } }));
  }
}

export function togglePlay() {
  const p = get().preview;
  const f = selectedFile();
  if (!f?.info) return;
  if (p.fileId !== f.id || p.status === "idle" || p.status === "error") {
    void renderPreview({ autoplay: true, keepPosition: false });
    return;
  }
  if (p.status === "rendering") return;
  if (player.playing) player.pause();
  else player.play();
  set((s) => ({ preview: { ...s.preview, playing: player.playing } }));
}

export function setCleaned(cleaned: boolean) {
  player.setCleaned(cleaned);
  set((s) => ({ preview: { ...s.preview, cleaned } }));
}

export function seekPreview(fraction: number) {
  player.seek(fraction * player.duration);
}

export function setPreviewStart(fileId: string, start: number) {
  updateFile(fileId, { previewStart: start });
  const p = get().preview;
  if (p.fileId === fileId && p.status !== "idle") void renderPreview({ autoplay: p.playing, keepPosition: false });
}
