"use client";
import { useEffect, useState } from "react";
import { setCleaned, togglePlay } from "@/lib/controller";
import { fmtTime } from "@/lib/format";
import { player } from "@/lib/player";
import { useStore } from "@/lib/store";
import { IconPause, IconPlay, Spinner } from "./icons";

function Clock({ start, duration, playing }: { start: number; duration: number; playing: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(id);
  }, [playing]);
  return (
    <span className="px-2.5 pl-1.5 font-mono text-[12px] tabular-nums">
      {fmtTime(start + player.position)} / {fmtTime(start + duration)}
    </span>
  );
}

/** Floating pill: play/pause, Original/Cleaned, time. */
export default function Transport() {
  const p = useStore((s) => s.preview);
  const disabled = useStore((s) => s.engine.status !== "ready");
  const rendering = p.status === "rendering";
  const seg = (on: boolean) =>
    `h-8 rounded-[14px] px-3.5 font-medium ${on ? "bg-seg-on shadow-lift" : "text-muted hover:text-ink"}`;

  return (
    <div className="absolute bottom-[22px] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-[22px] bg-pill p-1.5 shadow-pill">
      <button
        type="button"
        onClick={togglePlay}
        disabled={disabled}
        aria-label={p.playing ? "Pause" : "Play preview"}
        title="Play / pause (Space)"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-btn1 text-btn1-ink disabled:opacity-40"
      >
        {rendering ? <Spinner /> : p.playing ? <IconPause /> : <IconPlay />}
      </button>
      <div role="group" aria-label="Listen to" className="flex gap-0.5 rounded-2xl bg-seg-track p-0.5" title="Switch with Tab, or press A / B">
        <button type="button" aria-pressed={!p.cleaned} onClick={() => setCleaned(false)} className={seg(!p.cleaned)}>
          Original
        </button>
        <button type="button" aria-pressed={p.cleaned} onClick={() => setCleaned(true)} className={seg(p.cleaned)}>
          Cleaned
        </button>
      </div>
      {p.status === "ready" ? (
        <Clock start={p.start} duration={p.duration} playing={p.playing} />
      ) : (
        <span className="px-2.5 pl-1.5 font-mono text-[12px] text-muted">–:–– / –:––</span>
      )}
    </div>
  );
}
