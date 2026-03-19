import { useEffect, useMemo, useState } from "react";

export interface CountdownResult {
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

function clampNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function useCountdown(targetIso?: string | null, tickMs = 1000): CountdownResult {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!targetIso) return;
    const interval = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(interval);
  }, [targetIso, tickMs]);

  return useMemo(() => {
    if (!targetIso) {
      return { totalMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
    }
    const target = new Date(targetIso).getTime();
    const diff = clampNumber(target - now);
    const totalSeconds = Math.floor(diff / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return {
      totalMs: diff,
      days,
      hours,
      minutes,
      seconds,
      expired: diff <= 0,
    };
  }, [targetIso, now]);
}
