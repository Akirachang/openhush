"use client";
import { useEffect, useState } from "react";
import { cancelBatch, clearFinished, setHeavy, setMix, setStrength, startBatch } from "@/lib/controller";
import { fmtEta, strengthFeel } from "@/lib/format";
import { isRunnable, useStore } from "@/lib/store";

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 rounded-[10px] bg-row px-3 pb-3 pt-2.5">{children}</div>;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Batch() {
  const files = useStore((s) => s.files);
  const batch = useStore((s) => s.batch);
  const ready = useStore((s) => s.engine.status === "ready");
  const now = useNow(batch.running);
  const todo = files.filter(isRunnable);
  const inBatch = files.filter((f) => batch.ids.includes(f.id));
  const current = inBatch.find((f) => f.status === "running");
  const finished = inBatch.filter((f) => ["done", "failed", "cancelled"].includes(f.status)).length;
  const overall = inBatch.length ? (finished + (current?.progress ?? 0)) / inBatch.length : 0;
  let eta = "";
  if (current?.jobStartedAt && (current.progress ?? 0) > 0.03) {
    const elapsed = (now - current.jobStartedAt) / 1000;
    eta = fmtEta((elapsed / current.progress!) * (1 - current.progress!));
  }
  const hasFinished = files.some((f) => f.status === "done" || f.status === "invalid");

  return (
    <div className="flex flex-col gap-2">
      <span className="label px-1 pt-2">Batch</span>
      {batch.running ? (
        <div className="flex flex-col gap-2 px-1 pb-1.5">
          <div className="flex justify-between gap-2">
            <span className="truncate">{batch.cancelling ? "Cancelling…" : current?.name ?? "Starting…"}</span>
            <span className="font-mono text-[12px] tabular-nums">{Math.round((current?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="h-[2px] overflow-hidden rounded bg-track">
            <div className="h-[2px] bg-ink transition-[width] duration-300" style={{ width: `${overall * 100}%` }} />
          </div>
          <div className="flex justify-between text-[12px] text-muted">
            <span>
              File {Math.min(inBatch.length, finished + 1)} of {inBatch.length}
            </span>
            <span>{eta}</span>
          </div>
          <span className="text-[12px] text-muted">{batch.settingsLabel}</span>
        </div>
      ) : (
        <p className="m-0 px-1 pb-1.5 text-[12px] text-muted">
          {batch.summary || (todo.length ? `${todo.length} file${todo.length === 1 ? "" : "s"} ready` : "Add files to clean them")}
          {hasFinished && (
            <>
              {" · "}
              <button type="button" onClick={clearFinished} className="underline underline-offset-2 hover:text-ink">
                Clear finished
              </button>
            </>
          )}
        </p>
      )}
      <div className="flex gap-1.5">
        <button type="button" onClick={() => void cancelBatch()} disabled={!batch.running || batch.cancelling}
          className="h-10 flex-1 rounded-[10px] bg-btn2 font-medium text-btn2-ink disabled:opacity-40">
          Cancel
        </button>
        <button type="button" onClick={() => void startBatch()} disabled={batch.running || !todo.length || !ready}
          className="h-10 flex-[1.4] rounded-[10px] bg-btn1 font-semibold text-btn1-ink disabled:opacity-40" title="⌘↩">
          {todo.length ? `Clean ${todo.length} file${todo.length === 1 ? "" : "s"}` : "Clean"}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPanel() {
  const strength = useStore((s) => s.strength);
  const mix = useStore((s) => s.mix);
  const heavy = useStore((s) => s.heavy);
  const hs = useStore((s) => s.engine.hello?.heavy);
  const install = useStore((s) => s.heavyInstall);
  const gpu = hs?.gpu ?? false;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-1.5 overflow-y-auto rounded-[14px] bg-panel p-3">
      <span className="label px-1 pb-2 pt-0.5">Settings</span>

      <Row>
        <div className="flex items-baseline justify-between">
          <label htmlFor="strength" className="font-medium">Strength</label>
          <span className="font-mono text-[12px]">{strength} dB</span>
        </div>
        <input id="strength" type="range" min={6} max={100} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
        <span className="text-[12px] text-muted">
          {heavy ? "How strongly Heavy repair denoises" : `${strengthFeel(strength)} — lower sounds more natural`}
        </span>
      </Row>

      <Row>
        <div className="flex items-baseline justify-between">
          <label htmlFor="mix" className={`font-medium ${heavy ? "text-muted" : ""}`}>Mix</label>
          <span className="font-mono text-[12px]">{heavy ? "100% (fixed)" : `${mix}%`}</span>
        </div>
        <input id="mix" type="range" min={0} max={100} value={heavy ? 100 : mix} disabled={heavy} onChange={(e) => setMix(Number(e.target.value))} />
        <span className="text-[12px] text-muted">
          {heavy ? "Heavy repair rebuilds the voice, so it can't be blended" : "Blend some original back in"}
        </span>
      </Row>

      <label className={`flex items-start gap-2.5 rounded-[10px] bg-row px-3 py-2.5 ${gpu && !install.running ? "cursor-pointer" : ""}`}>
        <span className="flex flex-1 flex-col gap-1">
          <span className={`font-medium ${gpu ? "" : "text-muted"}`}>Heavy repair</span>
          <span className="text-[12px] leading-snug text-muted">
            {!gpu
              ? hs?.reason ?? "Needs a compatible GPU."
              : "For badly damaged audio. Uses the GPU, is much slower, and can change the voice slightly."}
          </span>
          {install.running && (
            <span className="mt-1 flex flex-col gap-1.5">
              <span className="text-[12px]">{install.message}</span>
              <span className="block h-[2px] overflow-hidden rounded bg-track">
                <span className="block h-[2px] bg-ink" style={{ width: `${install.fraction * 100}%` }} />
              </span>
            </span>
          )}
          {install.error && <span className="selectable text-[12px] text-err">{install.error.message}</span>}
        </span>
        <input type="checkbox" checked={heavy} disabled={!gpu || install.running} onChange={(e) => setHeavy(e.target.checked)}
          className="mt-0.5 h-4 w-4" aria-label="Heavy repair" />
      </label>

      <div className="flex-1" />
      <Batch />
    </aside>
  );
}
