# macos-voice — voz en macOS

Puerto de la voz (captura de micrófono, reproducción, dispositivos) de PipeWire/Linux a macOS.
Chat, login, portapapeles, notificaciones y abrir links ya funcionan en macOS (ver `src/proc/platform.ts`).

## Specs

S1. En macOS la voz tiene que funcionar de punta a punta: capturar del micrófono, codificar Opus, mandar por
   Discord, recibir, decodificar y reproducir.
   Hoy `src/voice/audio-io.ts:58` spawnea `pw-record` y `src/voice/audio-io.ts:123` spawnea `pw-cat`; en macOS no
   existen.
S2. El contrato PCM no cambia: 48 kHz, 2 canales, s16le, frames de 960 muestras por canal (3840 bytes, 20 ms).
   Lo fija `src/voice/constants.ts`.
S3. Linux no cambia: mismo argv de PipeWire y mismos tests que hoy.
S4. La selección de dispositivo de entrada y salida sigue funcionando: lista de dispositivos y elección por nombre
   (`src/settings/settings.ts`, `src/ui/screens/SettingsScreen.tsx`).
S5. Los sonidos de la UI y el audio de adjuntos y notas de voz siguen sonando en macOS
   (`src/sounds/player.ts`, `src/media/audio-player.ts`).
S6. Si falta el binario o el permiso de micrófono, la app degrada con un mensaje claro y no se cae.

## Tasks

| ID | Specs | Route | Qué | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2 | inline | Spike: medir si ffmpeg (avfoundation + audiotoolbox) sirve, con qué latencia | — |
| T2 | S1, S2, S3 | inline | Seam de audio por plataforma (`src/proc/platform.ts` ya existe) | — |
| T3 | S1, S2 | inline | Captura en macOS (micrófono → s16le 48k estéreo) | — |
| T4 | S1, S5 | inline | Reproducción en macOS (PCM → salida) | — |
| T5 | S4 | inline | ✅ Enumeración de dispositivos en macOS (salida solo predeterminada) | — |
| T6 | S5 | inline | ✅ Adjuntos y sonidos contra el backend nuevo | — |
| T7 | S6 | inline | ✅ Permisos de macOS y degradación con mensaje (permiso denegado real sin verificar) | — |
| T8 | S1-S6 | — | Verificación final + docs | — |

## Log

L1. El usuario pidió, textual: "a ver si puedo entrar a mi cuenta" y después "ya pude entrar a la cuenta, sigamos
   con el porteo" (2026-11-13).
L2. Mapa del pipeline (exploración): contrato PCM 48 kHz / 2 canales / s16le / 960 muestras por frame (20 ms).
   Seams: `startCapture`, `startPlayback` (`src/voice/audio-io.ts:56,117`) y `listAudioDevices`
   (`src/voice/devices.ts:13`), todos con patrón `deps.spawn` inyectable.
L3. Capacidad del sistema (macOS 15.8, ffmpeg 9.0.2): tiene entrada `avfoundation` y salida `audiotoolbox`.
   `ffplay` y el encoder `pcm_s16le` están. O sea: hay un backend posible sin agregar dependencias.
L4. Riesgo abierto antes de comprometerse: la latencia de ida y vuelta con ffmpeg. El código ya presupone
   jitter buffer de 60 ms inicial y preroll de 100 ms (`src/voice/rx.ts`, `src/actions/voice.ts`); sumarle
   100-200 ms por lado haría la conversación incómoda.
L5. Evidencia informada: resolución de argv del backend, 192000 B/s en estado estable con frames de 20 ms,
   cierre en 11 ms, suite con 879 tests aprobados y 2 fallas preexistentes, typecheck limpio. No hay micrófono
   físico en esta máquina: captura real, comportamiento ante permiso denegado y calidad de audio no se probaron.
   En macOS la selección de salida usa solo el dispositivo predeterminado. Tampoco se verificó una llamada real
   de Discord.
