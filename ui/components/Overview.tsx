"use client";
import { useEffect, useRef, useState } from "react";
import { setPreviewStart } from "@/lib/controller";
import { fmtTime } from "@/lib/format";
import type { FileItem } from "@/lib/types";
import { cssVar, roundedBar, useCanvas, useThemeVersion } from "./canvas";

/** Whole-file loudness strip; the highlighted window is the section that gets previewed. Drag it. */
export default function Overview({ file, windowSec }: { file: FileItem; windowSec: number }) {
  const duration = file.info?.duration ?? 0;
  const win = Math.min(windowSec, duration);
  const maxStart = Math.max(0, duration - win);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const start = Math.min(dragStart ?? file.previewStart, maxStart);
  const grab = useRef<number | null>(null);
  const theme = useThemeVersion();

  const { ref, size, paint } = useCanvas((ctx, w, h) => {
    const peaks = file.peaks ?? [];
    const on = cssVar("--ov-on");
    const off = cssVar("--ov-off");
    const step = 3;
    const n = Math.max(1, Math.floor(w / step));
    const a = duration ? start / duration : 0;
    const b = duration ? (start + win) / duration : 0;
    for (let i = 0; i < n; i++) {
      let v = 0.04;
      if (peaks.length) {
        const lo = Math.floor((i / n) * peaks.length);
        const hi = Math.max(lo + 1, Math.floor(((i + 1) / n) * peaks.length));
        for (let j = lo; j < hi; j++) v = Math.max(v, peaks[j]);
      }
      const t = (i + 0.5) / n;
      ctx.fillStyle = t >= a && t <= b ? on : off;
      const bh = Math.max(2, v * (h - 4));
      roundedBar(ctx, i * step, (h - bh) / 2, 2, bh, 1);
    }
  });

  useEffect(paint, [paint, size, file.peaks, start, win, theme]);

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };
  const clamp = (s: number) => Math.min(maxStart, Math.max(0, s));

  const onDown = (e: React.PointerEvent) => {
    if (!duration) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    if (t >= start && t <= start + win) grab.current = t - start;
    else grab.current = win / 2;
    setDragStart(clamp(t - grab.current));
  };
  const onMove = (e: React.PointerEvent) => {
    if (grab.current === null) return;
    setDragStart(clamp(timeAt(e.clientX) - grab.current));
  };
  const onUp = () => {
    if (grab.current === null) return;
    grab.current = null;
    if (dragStart !== null && Math.abs(dragStart - file.previewStart) > 0.05) setPreviewStart(file.id, dragStart);
    setDragStart(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    setPreviewStart(file.id, clamp(file.previewStart + d));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="label flex justify-between">
        <span>Whole file · drag to pick a section</span>
        <span>
          {fmtTime(start)} to {fmtTime(start + win)}
        </span>
      </div>
      <canvas
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Preview section"
        aria-valuemin={0}
        aria-valuemax={Math.round(maxStart)}
        aria-valuenow={Math.round(start)}
        aria-valuetext={`${fmtTime(start)} to ${fmtTime(start + win)}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        className={`h-8 w-full touch-none rounded ${duration ? "cursor-grab active:cursor-grabbing" : ""}`}
      />
    </div>
  );
}
