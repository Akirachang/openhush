"use client";
import { useEffect, useState } from "react";
import { api, hasApi } from "@/lib/bridge";
import { browse } from "@/lib/controller";
import { IconAuto, IconMoon, IconSun } from "./icons";
import { LogoMark } from "./Logo";

type Mode = "system" | "light" | "dark";
const NEXT: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Mode, string> = { system: "Appearance: match system", light: "Appearance: light", dark: "Appearance: dark" };

export default function TitleBar() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    if (hasApi()) void api().getTheme().then(setMode);
  }, []);
  const cycle = () => {
    const next = NEXT[mode];
    setMode(next);
    if (hasApi()) void api().setTheme(next);
  };
  return (
    <header className="drag flex h-10 shrink-0 items-center gap-3 pl-[84px] pr-3">
      <span className="flex items-center gap-1.5">
        <LogoMark size={22} simple />
        <span className="text-[15px] font-bold tracking-[-0.03em]">OpenHush</span>
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={cycle}
        title={LABEL[mode]}
        aria-label={LABEL[mode]}
        className="no-drag flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-chip hover:text-ink"
      >
        {mode === "system" ? <IconAuto /> : mode === "light" ? <IconSun /> : <IconMoon />}
      </button>
      <button type="button" onClick={() => void browse()} className="no-drag text-[13px] underline underline-offset-[3px]">
        Add files
      </button>
    </header>
  );
}
