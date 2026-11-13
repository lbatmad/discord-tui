import { resolve } from "node:path";
import { currentPlatform, type Platform } from "../proc/platform";

export function audioHelperPath(): string {
  return resolve(process.env.ZCORD_HOME ?? resolve(import.meta.dir, "../.."), "dist/native/audio-capture");
}

export function audioBackend(platform: Platform = currentPlatform()) {
  return {
    needsHelper: platform === "darwin",
    capture(target?: string): string[] {
      if (platform === "darwin") return [audioHelperPath(), ...(target ? ["--device", target] : [])];
      return ["pw-record", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", "--latency", "20ms", ...(target ? ["--target", target] : []), "-"];
    },
    playback(target?: string | null): string[] {
      if (platform === "darwin") return ["ffmpeg", "-hide_banner", "-nostdin", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-f", "audiotoolbox", "-"];
      return ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", ...(target ? ["--target", target] : []), "-"];
    },
  };
}
