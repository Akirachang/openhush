export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export function fmtEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 45) return "less than a minute left";
  const m = Math.round(seconds / 60);
  return m < 60 ? `about ${m} min left` : `about ${(seconds / 3600).toFixed(1)} h left`;
}

export function strengthFeel(db: number): string {
  return db < 15 ? "Gentle" : db <= 40 ? "Natural" : db <= 70 ? "Strong" : "Maximum";
}
