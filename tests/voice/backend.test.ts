import { describe, expect, test } from "bun:test";

import { FFMPEG_FALLBACKS, ffmpegPath } from "../../src/voice/backend";

describe("ffmpegPath", () => {
  test("ZCORD_FFMPEG wins over PATH and fallbacks", () => {
    expect(ffmpegPath({ ZCORD_FFMPEG: "/opt/local/bin/ffmpeg" }, () => true, () => "/usr/bin/ffmpeg")).toBe("/opt/local/bin/ffmpeg");
  });

  test("a PATH hit beats the fallback candidates", () => {
    expect(ffmpegPath({}, () => true, () => "/usr/bin/ffmpeg")).toBe("/usr/bin/ffmpeg");
  });

  test("without PATH, the first existing fallback wins (GUI terminals arrancan sin /opt/homebrew/bin)", () => {
    const winner = FFMPEG_FALLBACKS[1] ?? "/usr/local/bin/ffmpeg";
    expect(ffmpegPath({}, (path) => path === winner, () => null)).toBe(winner);
  });

  test("nothing resolves: bare ffmpeg, como hoy", () => {
    expect(ffmpegPath({}, () => false, () => null)).toBe("ffmpeg");
  });

  test("an empty ZCORD_FFMPEG counts as unset", () => {
    expect(ffmpegPath({ ZCORD_FFMPEG: "" }, () => false, () => "/usr/bin/ffmpeg")).toBe("/usr/bin/ffmpeg");
  });
});
