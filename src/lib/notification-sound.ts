/**
 * Plays a pleasant two-tone notification chime using the Web Audio API.
 * No audio file required — generated entirely in-browser.
 * Silently no-ops if AudioContext is unavailable (e.g. in SSR).
 */
export function playNotificationSound(volume = 0.25): void {
    if (typeof window === "undefined") return;

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
        if (!AudioCtx) return;

        const ctx = new AudioCtx() as AudioContext;

        /** Play a single sine tone with a fast attack and exponential decay */
        function tone(freq: number, start: number, duration: number, gain: number) {
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();
            osc.connect(gainNode);
            gainNode.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = freq;
            gainNode.gain.setValueAtTime(0, start);
            gainNode.gain.linearRampToValueAtTime(gain, start + 0.018);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            osc.start(start);
            osc.stop(start + duration);
        }

        const t = ctx.currentTime;

        // Two-tone notification chime: D5 → A5
        tone(587.33, t,        0.38, volume);        // D5 — first note
        tone(880.00, t + 0.18, 0.42, volume * 0.80); // A5 — second note (slightly softer)

        // Close AudioContext after the sound finishes to free resources
        setTimeout(() => ctx.close().catch(() => {}), 700);
    } catch {
        // AudioContext not available or blocked — silently skip
    }
}
