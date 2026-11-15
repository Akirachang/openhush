"use client";
import { checkEngine, restartEngine } from "@/lib/controller";
import { useStore } from "@/lib/store";
import { Spinner } from "./icons";

/** Engine status: first-run download, ffmpeg missing, crashes. Hidden when everything is fine. */
export default function Banner() {
  const engine = useStore((s) => s.engine);
  if (engine.status === "ready") return null;

  if (engine.status === "starting") {
    return (
      <div className="mx-2 mb-2 flex items-center gap-2 rounded-[10px] bg-panel px-3 py-2 text-muted">
        <Spinner /> Starting the audio engine…
      </div>
    );
  }
  if (engine.status === "setup") {
    const pct = Math.round((engine.setupFraction ?? 0) * 100);
    return (
      <div className="mx-2 mb-2 flex flex-col gap-2 rounded-[10px] bg-panel px-3 py-2">
        <div className="flex justify-between">
          <span>Downloading the noise-removal engine (one time, about 28 MB)</span>
          <span className="font-mono text-[12px]">{pct}%</span>
        </div>
        <div className="h-[2px] overflow-hidden rounded bg-track">
          <div className="h-[2px] bg-ink" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  const ffmpeg = engine.hello && !engine.hello.ffmpeg.ok;
  return (
    <div role="alert" className="mx-2 mb-2 flex items-start gap-3 rounded-[10px] bg-panel px-3 py-2">
      <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full bg-red" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">{engine.error?.message ?? "Something went wrong."}</span>
        {engine.error?.details && <span className="selectable font-mono text-[12px] text-muted">{engine.error.details}</span>}
      </div>
      {ffmpeg ? (
        <button type="button" onClick={() => void checkEngine()} className="h-8 shrink-0 rounded-lg bg-btn2 px-3 text-btn2-ink">
          Check again
        </button>
      ) : engine.canRestart ? (
        <button type="button" onClick={() => void restartEngine()} className="h-8 shrink-0 rounded-lg bg-btn2 px-3 text-btn2-ink">
          Restart engine
        </button>
      ) : null}
    </div>
  );
}
