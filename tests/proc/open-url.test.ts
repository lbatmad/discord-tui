import { expect, test } from "bun:test";

import { openUrl } from "../../src/proc/open-url";

test("openUrl only opens https links, as an argv (no shell)", () => {
  const calls: string[][] = [];
  const spawn = (cmd: string[]) => void calls.push(cmd);
  const platform = "linux" as const;
  expect(openUrl("https://cdn.discordapp.com/x.png", { spawn, platform })).toBe(true);
  expect(openUrl("http://example.com", { spawn, platform })).toBe(false);
  expect(openUrl("file:///etc/passwd", { spawn, platform })).toBe(false);
  expect(openUrl("javascript:alert(1)", { spawn, platform })).toBe(false);
  expect(openUrl("no es un link", { spawn, platform })).toBe(false);
  expect(calls).toEqual([["xdg-open", "https://cdn.discordapp.com/x.png"]]);
});

test("openUrl en macOS abre con `open`, también como argv y solo con https", () => {
  const calls: string[][] = [];
  const spawn = (cmd: string[]) => void calls.push(cmd);
  const platform = "darwin" as const;
  expect(openUrl("https://cdn.discordapp.com/x.png", { spawn, platform })).toBe(true);
  expect(openUrl("file:///etc/passwd", { spawn, platform })).toBe(false);
  expect(openUrl("javascript:alert(1)", { spawn, platform })).toBe(false);
  expect(calls).toEqual([["open", "https://cdn.discordapp.com/x.png"]]);
});

test("children never write to the terminal by default (a browser opened via xdg-open spammed the TUI)", async () => {
  const { spawnClean } = await import("../../src/proc/spawn");
  const proc = spawnClean(["sh", "-c", "echo ruido-del-navegador >&2"], { stdout: "ignore" });
  await proc.exited;
  expect(proc.stderr == null).toBe(true);
  const piped = spawnClean(["sh", "-c", "echo visible >&2"], { stdout: "ignore", stderr: "pipe" });
  expect(await new Response(piped.stderr as ReadableStream).text()).toBe("visible\n");
});
