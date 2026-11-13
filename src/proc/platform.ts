/**
 * Dónde corre la app. zcord nació en Linux (PipeWire, Wayland) y cada integración con el escritorio usa los
 * binarios de la plataforma: `wl-paste`/`wl-copy` contra `pbpaste`/`pbcopy`, `xdg-open` contra `open`, etc.
 * Este módulo es el único lugar que pregunta en qué sistema estamos; el resto recibe la plataforma por deps,
 * así los tests fijan la que quieren probar sin depender de la máquina que los corre.
 */
export type Platform = "linux" | "darwin";

export function currentPlatform(src: { platform?: string } = process): Platform {
  return src.platform === "darwin" ? "darwin" : "linux";
}
