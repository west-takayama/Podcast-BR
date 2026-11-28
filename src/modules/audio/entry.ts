export const audioEntry = { module: "AUDIO", api: "1.0", delivery: "private-top-level" } as const;

export function parseAudioEntry(value: string, hostOrigin: string): string | null {
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.origin === hostOrigin || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}
