"use client";
import { browse } from "@/lib/controller";
import { LogoMark } from "./Logo";

export default function EmptyState() {
  return (
    <div className="flex h-full flex-col justify-center gap-6 px-12">
      <LogoMark size={64} className="-ml-1.5" />
      <div className="flex flex-col gap-1.5">
        <span className="text-[20px] font-medium tracking-[-0.03em] text-muted">Remove background noise</span>
        <h1 className="m-0 text-[52px] font-semibold leading-none tracking-[-0.045em]">Drop audio or video.</h1>
        <div aria-hidden="true" className="mt-3 h-[2px] w-11 bg-red" />
      </div>
      <p className="max-w-[440px] text-[14px] leading-relaxed text-muted">
        Everything runs on this Mac. Cleaned copies are saved next to the originals as <span className="font-mono text-[12px] text-ink">name_clean</span> — originals are never touched.
      </p>
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => void browse()} className="h-10 rounded-[10px] bg-btn1 px-4 font-semibold text-btn1-ink">
          Add files
        </button>
        <span className="label">wav · mp3 · m4a · flac · mp4 · mov · mkv</span>
      </div>
    </div>
  );
}
