import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { currentPlatform, type Platform } from "../proc/platform";

export function audioHelperPath(): string {
  return resolve(process.env.ZCORD_HOME ?? resolve(import.meta.dir, "../.."), "dist/native/audio-capture");
}

/** Dónde dejan el ffmpeg los gestores de paquetes de macOS: una terminal GUI (Ghostty abierta con `open`)
 *  arranca sin /opt/homebrew/bin en el PATH, y el playback invoca ffmpeg por nombre. */
export const FFMPEG_FALLBACKS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"];

/** ffmpeg por ruta absoluta si se puede: ZCORD_FFMPEG explícito > PATH > fallbacks conocidos > "ffmpeg" pelado. */
export function ffmpegPath(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  which: (bin: string) => string | null = (bin) => Bun.which(bin) ?? null,
): string {
  const forced = env.ZCORD_FFMPEG;
  if (forced) return forced;
  const onPath = which("ffmpeg");
  if (onPath) return onPath;
  for (const candidate of FFMPEG_FALLBACKS) if (exists(candidate)) return candidate;
  return "ffmpeg";
}

export function audioBackend(platform: Platform = currentPlatform()) {
  return {
    needsHelper: platform === "darwin",
    capture(target?: string): string[] {
      if (platform === "darwin") return [audioHelperPath(), ...(target ? ["--device", target] : [])];
      return ["pw-record", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", "--latency", "20ms", ...(target ? ["--target", target] : []), "-"];
    },
    playback(target?: string | null): string[] {
      if (platform === "darwin") return [ffmpegPath(), "-hide_banner", "-nostdin", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-f", "audiotoolbox", "-"];
      return ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", ...(target ? ["--target", target] : []), "-"];
    },
  };
}
