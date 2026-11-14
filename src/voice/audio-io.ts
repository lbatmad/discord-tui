import { accessSync, constants } from "node:fs";
import { cleanEnv } from "../proc/spawn";
import type { Platform } from "../proc/platform";
import { audioBackend } from "./backend";
import { createFramer } from "./pcm-framer";

export interface ProcLike {
  /** En Bun es un FileSink: `write` acumula en buffer y hace falta `flush` para que llegue al proceso. */
  stdin: { write(chunk: Uint8Array): unknown; flush?(): unknown; end?(): unknown } | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  killed: boolean;
  kill(signal?: number): void;
}

export type SpawnLike = (cmd: string[], opts: { stdin: "pipe" | "ignore"; stdout: "pipe" | "ignore" }) => ProcLike;

export class AudioDeviceError extends Error {}

function defaultSpawn(): SpawnLike {
  return (cmd, opts) =>
    Bun.spawn(cmd, {
      env: cleanEnv(),
      stdin: opts.stdin,
      stdout: opts.stdout,
      stderr: "pipe",
    }) as unknown as ProcLike;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function waitForEarlyExit(proc: ProcLike, label: string, binary: string): Promise<void> {
  const early = await Promise.race([
    proc.exited.then((code) => ({ exited: true as const, code })),
    Bun.sleep(30).then(() => ({ exited: false as const, code: 0 })),
  ]);
  if (early.exited && early.code !== 0) {
    const stderr = await readAll(proc.stderr);
    throw new AudioDeviceError(`${label} (${binary}: ${stderr.trim() || `salió con código ${early.code}`})`);
  }
}

export interface AudioCapture {
  onFrame(fn: (pcm: Uint8Array) => void): () => void;
  stop(): Promise<void>;
}

export async function startCapture(opts?: {
  target?: string;
  spawn?: SpawnLike;
  platform?: Platform;
  helperExecutable?: (path: string) => boolean;
  /**
   * Si el helper muere a mitad de llamada (permiso revocado, dispositivo desconectado, fallo del motor de
   * audio) se invoca UNA vez con el motivo. El kill propio de `stop()` jamás lo dispara (JD-A-001, spec S6).
   */
  onError?: (message: string) => void;
}): Promise<AudioCapture> {
  const spawn = opts?.spawn ?? defaultSpawn();
  const backend = audioBackend(opts?.platform);
  const cmd = backend.capture(opts?.target);
  const executable = opts?.helperExecutable ?? ((path: string) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  if (backend.needsHelper && !executable(cmd[0]!)) {
    throw new AudioDeviceError(`falta el ejecutable ${cmd[0]}; ejecutá sh scripts/build-audio-helper.sh`);
  }

  let proc: ProcLike;
  try {
    proc = spawn(cmd, { stdin: "ignore", stdout: "pipe" });
  } catch (error) {
    throw new AudioDeviceError(
      `no pude abrir el micrófono (${cmd[0]}: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await waitForEarlyExit(proc, "no pude abrir el micrófono", cmd[0]!);

  // Drenamos el stderr en continuo: si nadie lo lee, la tubería se llena (64 KB) y congela al helper, y el
  // último diagnóstico se pierde. Así sobrevive para avisar si el proceso muere sin que stop() lo pida.
  let stderrTail = "";
  let stderrDone: Promise<void> = Promise.resolve();
  const stderr = proc.stderr;
  if (stderr) {
    stderrDone = (async () => {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-400);
      }
    })();
  }

  // Muerte sin stop(): el micrófono queda mudo, no se transmite nada y nadie se enteraba (JD-A-001, S6).
  // stop() marca la bandera antes de matar al proceso, así el kill propio jamás dispara onError.
  let stopped = false;
  let errorFired = false;
  void proc.exited.then((code) => {
    if (stopped || errorFired) return;
    errorFired = true;
    void (async () => {
      // El exit puede llegar justo antes de que el drenaje lea la última línea de stderr: esperamos un poco.
      await Promise.race([stderrDone, Bun.sleep(100)]);
      if (stopped || !opts?.onError) return;
      const detail = stderrTail.trim() || `salió con código ${code}`;
      opts.onError(`el micrófono se cortó (${cmd[0]}: ${detail})`);
    })();
  });

  const framer = createFramer();
  const listeners = new Set<(pcm: Uint8Array) => void>();

  void (async () => {
    const stdout = proc.stdout;
    if (!stdout) return;
    const reader = stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const frame of framer.push(value)) {
        for (const listener of listeners) listener(frame);
      }
    }
  })();

  return {
    onFrame(fn: (pcm: Uint8Array) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async stop(): Promise<void> {
      stopped = true;
      proc.kill();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
      if (!exited) {
        proc.kill(9);
        await Promise.race([proc.exited, Bun.sleep(500)]);
      }
    },
  };
}

export interface AudioPlayback {
  write(pcm: Uint8Array): void;
  stop(): Promise<void>;
  dropped(): number;
}

/** Si la escritura devuelve una promesa (FileSink de Bun), sus rechazos (EPIPE) se tragan acá. */
function quiet(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).then === "function") (result as Promise<unknown>).catch(() => {});
}

export async function startPlayback(opts?: {
  target?: string;
  spawn?: SpawnLike;
  queuedFrames?: number;
  platform?: Platform;
}): Promise<AudioPlayback> {
  const spawn = opts?.spawn ?? defaultSpawn();
  const cmd = audioBackend(opts?.platform).playback(opts?.target);

  let proc: ProcLike;
  try {
    proc = spawn(cmd, { stdin: "pipe", stdout: "ignore" });
  } catch (error) {
    throw new AudioDeviceError(
      `no pude abrir la salida de audio (${cmd[0]}: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await waitForEarlyExit(proc, "no pude abrir la salida de audio", cmd[0]!);

  const maxQueued = opts?.queuedFrames ?? 10;
  const queue: Uint8Array[] = [];
  let droppedCount = 0;
  let pumping = false;
  let closed = false;
  // Si pw-cat ya salió (se cambia cada tanto por el reloj, o se cerró la salida), write/flush/end fallan con
  // EPIPE de forma asíncrona: sin esto el rechazo queda suelto y OpenTUI abre su consola con el error.
  proc.exited.then(() => (closed = true), () => (closed = true));

  // El drenaje corre en el próximo tick, imitando que `pw-cat` consume a su propio ritmo:
  // si entran frames más rápido de lo que se vacía la cola, se descarta el más viejo.
  function pump(): void {
    if (pumping) return;
    pumping = true;
    queueMicrotask(() => {
      pumping = false;
      if (closed) {
        queue.length = 0;
        return;
      }
      const frame = queue.shift();
      if (frame) {
        try {
          quiet(proc.stdin?.write(frame));
          quiet(proc.stdin?.flush?.());
        } catch {
          // pw-cat ya no está
        }
      }
      if (queue.length > 0) pump();
    });
  }

  return {
    write(pcm: Uint8Array): void {
      if (closed) return;
      if (queue.length >= maxQueued) {
        queue.shift();
        droppedCount += 1;
      }
      queue.push(pcm);
      pump();
    },
    dropped(): number {
      return droppedCount;
    },
    async stop(): Promise<void> {
      // pw-cat ignora SIGTERM mientras tiene la entrada abierta: se cierra stdin y, si no sale, SIGKILL.
      closed = true;
      queue.length = 0;
      try {
        quiet(proc.stdin?.end?.());
      } catch {
        // ya cerrado
      }
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
      if (!exited) {
        proc.kill(9);
        await Promise.race([proc.exited, Bun.sleep(500)]);
      }
    },
  };
}
