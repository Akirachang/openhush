"use client";
import { useEffect, useRef } from "react";
import { cancelHeavyInstall, installHeavy } from "@/lib/controller";
import { useStore } from "@/lib/store";

/** Asks before the one-time Heavy repair download. */
export default function HeavyDialog() {
  const asking = useStore((s) => s.heavyInstall.asking);
  const gb = useStore((s) => s.engine.hello?.heavy.downloadGB ?? 1.6);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (asking && !d.open) d.showModal();
    if (!asking && d.open) d.close();
  }, [asking]);

  return (
    <dialog
      ref={ref}
      onCancel={cancelHeavyInstall}
      aria-labelledby="heavy-title"
      className="m-auto w-[420px] rounded-[14px] bg-panel p-6 text-ink shadow-pill backdrop:bg-black/30"
    >
      <h2 id="heavy-title" className="m-0 text-[22px] font-semibold tracking-[-0.03em]">Install Heavy repair?</h2>
      <p className="mb-0 mt-3 leading-relaxed text-muted">
        Heavy repair uses Resemble Enhance to rebuild badly damaged voices on your Mac&apos;s GPU. It needs a one-time
        download of about {gb.toFixed(1)} GB, is much slower than normal cleaning, and can make the voice sound slightly different.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={cancelHeavyInstall} className="h-10 rounded-[10px] bg-btn2 px-4 font-medium text-btn2-ink">
          Not now
        </button>
        <button type="button" onClick={() => void installHeavy()} className="h-10 rounded-[10px] bg-btn1 px-4 font-semibold text-btn1-ink">
          Download {gb.toFixed(1)} GB
        </button>
      </div>
    </dialog>
  );
}
