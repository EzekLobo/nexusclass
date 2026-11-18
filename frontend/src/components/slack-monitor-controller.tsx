"use client";

import { useEffect } from "react";
import { getFirebaseAuth } from "@/lib/firebase";

const LOCAL_MONITOR = "http://127.0.0.1:49321";

export function SlackMonitorController({ userId }: { userId: string }) {
  useEffect(() => {
    let active = true; let inFlight = false;
    const scan = async () => {
      if (!active || inFlight || document.visibilityState !== "visible" || !navigator.onLine) return;
      const user = getFirebaseAuth().currentUser;
      if (!user || user.uid !== userId) return;
      inFlight = true;
      try {
        const token = await user.getIdToken();
        const paired = await fetch("/api/slack-monitor/pairing", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!paired.ok || !(await paired.json()).connected) return;
        const local = await fetch(`${LOCAL_MONITOR}/health`, { signal: AbortSignal.timeout(3_000) });
        if (!local.ok || !(await local.json()).paired) return;
        const result = await fetch(`${LOCAL_MONITOR}/scan`, { method: "POST", signal: AbortSignal.timeout(90_000) });
        if (result.ok) window.dispatchEvent(new Event("nexusclass:slack-suggestions-updated"));
      } catch {
        // Local monitor is optional until configured; the integration settings show its status.
      } finally { inFlight = false; }
    };
    const refresh = () => { void scan(); };
    const timer = window.setInterval(refresh, 5 * 60_000);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
    window.addEventListener("nexusclass:slack-monitor-paired", refresh);
    document.addEventListener("visibilitychange", refresh);
    void scan();
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); window.removeEventListener("nexusclass:slack-monitor-paired", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [userId]);
  return null;
}
