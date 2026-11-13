import { currentPlatform, type Platform } from "./platform";
import { spawnClean } from "./spawn";

/** Cómo se abre un link en el navegador del sistema en cada plataforma. */
export function openerFor(platform: Platform): string {
  return platform === "darwin" ? "open" : "xdg-open";
}

/**
 * Abre un link en el navegador: solo https, como argumento (nunca por shell), con env limpio.
 * En macOS usa `open` (el Lanzador), en Linux `xdg-open`.
 */
export function openUrl(
  url: string,
  deps: { spawn?: (cmd: string[]) => unknown; platform?: Platform } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const spawn = deps.spawn ?? ((cmd: string[]) => spawnClean(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  try {
    spawn([openerFor(deps.platform ?? currentPlatform()), parsed.toString()]);
    return true;
  } catch {
    return false;
  }
}
