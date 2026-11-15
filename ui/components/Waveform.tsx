"use client";
import { useEffect } from "react";
import { seekPreview } from "@/lib/controller";
import { player } from "@/lib/player";
import { useStore } from "@/lib/store";
import { cssVar, roundedBar, useCanvas, useThemeVersion } from "./canvas";
import { Spinner } from "./icons";

/** The 15-second section: cleaned (ink) or original (grey) bars, red playhead, click to seek. */
export default function Waveform({ idleText, renderingText }: { idleText: string; renderingText: string }) {
  const preview = useStore((s) => s.preview);
  const mix = useStore((s) => (s.heavy ? 100 : s.mix));
  const theme = useThemeVersion();
  const ready = preview.status === "ready" && preview.origBars.length > 0;

  const { ref, size, paint } = useCanvas((ctx, w, h) => {
    if (!ready) return;
    const { origBars, wetBars, cleaned } = preview;
    const m = mix / 100;
    const shown = cleaned ? wetBars.map((v, i) => m * v + (1 - m) * origBars[i]) : origBars;
    const peak = Math.max(1e-6, ...origBars, ...wetBars);
    const n = shown.length;
    const gap = 2;
    const bw = Math.max(1, (w - gap * (n - 1)) / n);
    ctx.fillStyle = cssVar(cleaned ? "--wave-on" : "--wave-off");
    for (let i = 0; i < n; i++) {
      const bh = Math.max(3, Math.pow(shown[i] / peak, 0.75) * (h - 8));
      roundedBar(ctx, i * (bw + gap), (h - bh) / 2, bw, bh, 1.5);
    }
    if (player.duration) {
      const x = (player.position / player.duration) * w;
      ctx.fillStyle = cssVar("--red");
      ctx.fillRect(Math.round(x), 0, 1.5, h);
    }
  });

  useEffect(paint, [paint, size, preview, mix, theme]);

  // Animate the playhead while playing.
  useEffect(() => {
    if (!preview.playing || !ready) return;
    let raf = 0;
    const tick = () => {
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preview.playing, ready, paint]);

  const onClick = (e: React.MouseEvent) => {
    if (!ready) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    seekPreview((e.clientX - r.left) / r.width);
    paint();
  };

  return (
    <div className="relative min-h-[190px] flex-1 rounded-xl bg-card p-[18px]">
      <canvas ref={ref} onClick={onClick} aria-label="Preview waveform" className={`h-full w-full ${ready ? "cursor-pointer" : ""}`} />
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted">
          {preview.status === "rendering" ? (
            <>
              <Spinner size={18} />
              <span>{renderingText}</span>
            </>
          ) : preview.status === "error" ? (
            <>
              <span className="font-medium text-err">{preview.error?.message}</span>
              {preview.error?.details && <span className="selectable max-w-[80%] font-mono text-[11px]">{preview.error.details}</span>}
            </>
          ) : (
            <span>{idleText}</span>
          )}
        </div>
      )}
    </div>
  );
}
