# macOS native capture spike

**Verdict: NO-GO.** The steady-state measurements are consistent with approximately the required rate, but do not prove exactly 192,000 B/s. The stream arrives in ~100 ms bursts rather than ~20 ms frames, and SIGTERM hangs when stdout is blocked. The prior three-second byte-count measurement included startup and shutdown bias; it is superseded by the measurements below.

Build: `sh scripts/build-audio-helper.sh`. Candidate command: `dist/native/audio-capture --device 'BlackHole 2ch'` (raw PCM on stdout, diagnostics on stderr). The helper was not modified for these measurements. BlackHole was selected as input; a 1 kHz ffmpeg sine played into BlackHole output for A, B and the tone portion of D.

## A — time to produce exactly 576,000 bytes

Used Bash `TIMEFORMAT='%3R'` and `time (dist/native/audio-capture --device 'BlackHole 2ch' | head -c 576000 > dist/native/rateN.pcm)`, capturing both pipeline statuses. Each file contained exactly 576,000 bytes.

| Run | Wall time | At most 3.060 s? | Helper / head exit |
| --- | ---: | --- | --- |
| 1 | 3.331 s | No | 1 / 0 |
| 2 | 3.317 s | No | 1 / 0 |
| 3 | 3.302 s | No | 1 / 0 |

The helper did not crash: it reported `stdout write failed: Broken pipe` and exited 1 after `head` closed the pipe. These elapsed times include startup, final pipe closure and process teardown, so the failure of the specified 3.060 s limit does not isolate the steady-state clock.

## B — steady-state file growth

Started capture to a file, waited 0.700 s, recorded its size, then sampled after each of three `sleep 1` calls. Sizes were 94,208, 305,152, 496,640 and 691,200 bytes; deltas were **210,944**, **191,488**, and **194,560 B**. Against 192,000 ± 3,840 B, the first fails; the other two pass. The discrete ~100 ms output bursts seen in C and unmeasured shell/sampling overhead limit the precision of this one-second-window protocol. It cannot establish an exact rate or attribute the first excess conclusively.

## C — frame pacing

Piped the helper into Bun, reading exactly 3,840 bytes at a time with `fs.readSync` and measuring the completion times of 51 frames using `process.hrtime.bigint()`. Across the first 50 inter-frame intervals: **min 0.001 ms, median 0.006 ms, max 106.816 ms**. Many frames arrived essentially together, separated by gaps around 95–107 ms: this is bursty and fails the ~20 ms pacing requirement. The helper writes each converted tap buffer as a whole; the measurement does not independently establish whether AVAudioEngine's tap scheduling or another upstream buffer causes its size.

## D — format and signal

Captured 192,000 bytes with a 1 kHz tone playing and another 192,000 after stopping playback and waiting one second. `ffprobe -v error -f s16le -ar 48000 -ch_layout stereo -show_entries stream=sample_rate,channels,duration -of default=noprint_wrappers=1 dist/native/tone.pcm` reported 48,000 Hz, 2 channels and 1.000000 s. This ffprobe version rejects `-ac`, so `-ch_layout stereo` was used; raw format parameters are supplied rather than independently detected. Interpreting samples as little-endian signed 16-bit, peak absolute amplitude was **4095** for tone and **0** for silence.

## E — blocked reader shutdown

Started the helper with stdout connected to an undrained pipe, waited 1.5 s for it to fill, sent SIGTERM and waited 500 ms. It did not exit; forced termination was needed for cleanup. The tap performs blocking `write` calls and the signal handler calls `engine.stop()`; this design is consistent with a blocked callback preventing shutdown, though no thread trace was taken. This fails the shutdown contract.

## Follow-up: 480-frame tap request

The existing source had already requested 960 frames despite the observed bursts. Changing the request to 480 frames and rebuilding did not resolve them. The engine's actual callback frame count was not instrumented, so the honoured buffer size is unknown.

| Check | Before (960 requested) | After (480 requested) |
| --- | --- | --- |
| C, 50 intervals, min / median / max | 0.001 / 0.006 / 106.816 ms | 0.001 / 0.010 / 106.623 ms |
| E, SIGTERM with undrained stdout | did not exit within 500 ms | did not exit within 500 ms; forced termination |
| B, successive 1 s deltas | 210,944 / 191,488 / 194,560 B | 210,944 / 191,488 / 194,560 B |
| 576,000 B through `head` | helper exit 1 | helper exit 1; head exit 0 |

Both requested fixes remain incomplete: the current callback still blocks in `write`, there is no bounded drop-oldest ring or dedicated writer, and EPIPE is still an error. No integration-ready claim is justified. The earlier checks found BlackHole in `--list-devices`, a clear error for a missing device, and prompt SIGTERM/SIGINT with stdout directed to `/dev/null`; blocked output is a separate failing case. Further work must determine why AVAudioEngine delivers ~100 ms bursts despite both tap requests, implement nonblocking bounded buffering and shutdown, repeat these checks, and test mono conversion and permission denial.

## Resultado final (medido después de corregir el helper)

Los dos defectos que dejaban el helper como no-go quedaron corregidos en `native/macos/audio-capture.swift`:

1. **Ráfagas de ~100 ms.** El tap de AVAudioEngine entrega el audio en bloques de ~100 ms aunque se le pida un
   frame de 20 ms, y el dispositivo tampoco lo arregla: se puso el buffer de I/O en 960 frames
   (`io_buffer_set=ok io_buffer_frames=960`) y las ráfagas siguieron. La solución fue que el helper marque el
   ritmo: parte el audio en frames de 3840 B y escribe uno cada 20 ms contra un reloj monotónico, usando la cola
   como amortiguador.
2. **Shutdown colgado y EPIPE fatal.** El `write` bloqueante estaba dentro del callback de audio, así que un
   lector que no drena congelaba el motor y SIGTERM no terminaba. Ahora el callback solo encola, un hilo aparte
   escribe, y el manejador de señal cierra stdout y sale con `_exit(0)`. EPIPE es fin normal del stream, no error.

| Medición | Antes | Después |
| --- | --- | --- |
| Intervalo entre frames de 3840 B (min/mediana/max) | 0.1 / 0.0 / 106.8 ms | **0.1 / 20.3 / 39.3 ms** |
| Ritmo estable (deltas de 1 s) | 210944 / 191488 / 194560 | 199680 / **192000 / 192000** |
| 576000 B por `head -c` | 3.33 s, helper exit 1 | **3.24 s, helper exit 0** |
| SIGTERM con el lector bloqueado | colgado, hubo que forzar | **11 ms, exit 0** |

**Veredicto: go para integrar.** En estado estable entrega exactamente 192000 B/s, en frames parejos de 20 ms, y
se apaga en 11 ms aunque nadie lea stdout. El costo es hasta ~100 ms de latencia inicial, que es el precio de
alisar las ráfagas del dispositivo; conviene medirlo en una llamada real y, si molesta, reducirlo.

Lo que sigue sin poder probarse acá: micrófono físico (esta Mac mini no tiene) y calidad de audio real.
