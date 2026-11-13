import { spawnClean } from "../proc/spawn";
import { currentPlatform, type Platform } from "../proc/platform";
import { log } from "../log/logger";
import { isChannelMuted } from "../store/selectors";
import type { AppState, Message } from "../store/types";

export function shouldNotify(state: AppState, message: Message, viewingChannelId: string | null): boolean {
  if (state.me !== null && message.authorId === state.me.id) return false;
  if (message.channelId === viewingChannelId) return false;

  const channel = state.channels[message.channelId];
  const guildId = channel?.guildId ?? null;
  if (isChannelMuted(state, guildId, message.channelId)) return false;

  const isDm = guildId === null;
  return isDm || message.mentionsMe;
}

export function notificationTitle(state: AppState, message: Message): string {
  const author = state.users[message.authorId]?.globalName ?? state.users[message.authorId]?.username ?? message.authorId;
  const channel = state.channels[message.channelId];
  if (channel?.guildId === null) {
    if (channel.type === 3) return `${author} (${channel.name ?? message.channelId})`;
    return `${author} (DM)`;
  }
  const channelName = channel?.name ?? message.channelId;
  const guildName = channel?.guildId ? state.guilds[channel.guildId]?.name : null;
  return guildName ? `${author} en #${channelName} (${guildName})` : `${author} en #${channelName}`;
}

// AppleScript que recibe título y cuerpo por argv. Los datos NUNCA se interpolan en el script: el contenido de un
// mensaje de Discord es de un tercero y `do shell script` convertiría una notificación en ejecución de código.
const APPLESCRIPT_NOTIFY = [
  "on run argv",
  "display notification (item 1 of argv) with title (item 2 of argv)",
  "end run",
];

/** El comando de notificación de escritorio de cada plataforma, con título y cuerpo como argv. */
export function notifyCommand(platform: Platform, title: string, body: string): string[] {
  if (platform === "darwin") {
    return ["osascript", ...APPLESCRIPT_NOTIFY.flatMap((line) => ["-e", line]), body, title];
  }
  return ["notify-send", "-a", "zcord", title, body];
}

export function notify(
  title: string,
  body: string,
  deps?: { spawn?: typeof spawnClean; platform?: Platform },
): void {
  const spawn = deps?.spawn ?? spawnClean;
  try {
    const child = spawn(notifyCommand(deps?.platform ?? currentPlatform(), title, body), { stdout: "ignore" });
    child.exited?.catch(() => {});
  } catch (error) {
    // Un fallo de la notificación no debe romper el dispatch del gateway que lo disparó.
    log.warn("notify.failed", { error_name: error instanceof Error ? error.name : "unknown" });
  }
}
