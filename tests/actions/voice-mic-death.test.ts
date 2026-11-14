import { expect, test } from "bun:test";

import { createVoiceActions, type VoiceMedia } from "../../src/actions/voice";
import { createStore, emptyState } from "../../src/store/store";
import type { VoiceSession, VoiceStatus } from "../../src/voice/session";

const GUILD = "100000000000000001";
const VOICE_A = "100000000000000003";
const ME = "100000000000000010";

/**
 * Harness mínimo (mismo shape que tests/actions/voice.test.ts): el fake de startCapture guarda el
 * `onError` que le pasa startMedia, para poder simular la muerte del helper a mitad de llamada (JD-A-001).
 */
function setup() {
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: {
      user: { id: ME, username: "gon" },
      guilds: [
        {
          id: GUILD,
          name: "g",
          roles: [],
          channels: [{ id: VOICE_A, type: 2, name: "Voz" }],
        },
      ],
    },
  });
  const statusListeners = new Set<(s: VoiceStatus, e?: string) => void>();
  const emit = (s: VoiceStatus, e?: string) => statusListeners.forEach((fn) => fn(s, e));
  const session: VoiceSession = {
    async join() {
      emit("joining");
      emit("connected");
    },
    setFlags() {},
    async leave() {
      emit("idle");
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    sendOpus() {},
    setSpeaking() {},
    onSpeaking: () => () => {},
    onOpus: () => () => {},
    privacyCode: () => "123451234512345",
  };
  let onError: ((message: string) => void) | undefined;
  const media: VoiceMedia = {
    async startCapture(opts) {
      onError = opts?.onError;
      return { onFrame: () => () => {}, stop: async () => {} };
    },
    async startPlayback() {
      return { write() {}, stop: async () => {}, dropped: () => 0 };
    },
    createCodec: () => ({ encode: (p) => p, decode: (o) => o }),
    createVad: () => ({ push: () => null, isOpen: false, thresholdDb: -45, levelDb: -96 }),
  };
  const voice = createVoiceActions({ store, session, media });
  return { store, voice, die: (message: string) => onError?.(message) };
}

test("a mid-call mic death surfaces voice/micError and a warning notice (spec S6)", async () => {
  const { store, voice, die } = setup();
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(5);
  expect(store.getState().voice.micError).toBeNull();

  die("el micrófono se cortó (/dist/native/audio-capture: cannot start audio engine)");
  await Bun.sleep(5);

  expect(store.getState().voice.micError).toContain("se cortó");
  expect(store.getState().voice.status).toBe("connected");
  const notices = Object.values(store.getState().notices)
    .map((n) => n.text)
    .join(" ");
  expect(notices).toContain("se cortó");
});

test("a death after leaving the call is ignored (stale generation)", async () => {
  const { store, voice, die } = setup();
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(5);
  await voice.leaveVoice();
  await Bun.sleep(5);

  die("el micrófono se cortó (pw-record: salió con código 1)");
  await Bun.sleep(5);

  expect(store.getState().voice.micError).toBeNull();
  expect(Object.values(store.getState().notices)).toHaveLength(0);
});
