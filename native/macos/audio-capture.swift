import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox
import Darwin

// audio-capture: micrófono de macOS -> PCM crudo por stdout, en el formato de zcord
// (48 kHz, 2 canales, s16le entrelazado). Un frame de la app son 3840 bytes (20 ms).
//
// Regla que ordena todo el archivo: el callback de audio nunca escribe a stdout. Si lo hiciera, un lector lento
// o ausente lo bloquea, el motor de audio se congela y el proceso deja de responder a SIGTERM (medido: se colgaba
// más de 500 ms). Por eso el callback solo encola en un buffer acotado, y un hilo aparte es el único que escribe.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("audio-capture: \(message)\n".utf8))
    exit(1)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("audio-capture: \(message)\n".utf8))
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func devices() -> [(AudioDeviceID, String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { fail("cannot enumerate audio devices") }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { fail("cannot enumerate audio devices") }
    return ids.compactMap { id in
        var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var inputSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &input, 0, nil, &inputSize) == noErr, inputSize > 0,
              let maybeName = property(id, kAudioObjectPropertyName, nil as CFString?), let name = maybeName else { return nil }
        return (id, name as String)
    }
}

/// Cola acotada entre el callback de audio y el hilo que escribe, y el que marca el ritmo.
///
/// El tap de AVAudioEngine entrega el audio en ráfagas de ~100 ms aunque se le pida un frame de 20 ms (medido:
/// intervalos de 0.0 ms dentro de la ráfaga y 100.3 ms entre ráfagas). Eso rompe el framing de 20 ms de la app.
/// Por eso este hilo no escribe lo que llega: escribe un frame de 20 ms cada 20 ms, con un reloj monotónico como
/// ancla, y usa la cola solo como amortiguador. El costo es hasta ~100 ms de latencia en el arranque; el beneficio
/// es un stream parejo, que es lo que la app necesita para Opus y VAD.
final class OutputWriter {
    /// Un frame de la app: 20 ms de 48 kHz estéreo s16le.
    private static let frameBytes = 3840
    private static let frameNanos: UInt64 = 20_000_000
    /// 25 frames = 500 ms de audio en vuelo como máximo.
    private static let maxPending = 25
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private let queue = DispatchQueue(label: "audio-capture.writer")
    private var pending: [Data] = []
    private var leftover: [UInt8] = []

    func start() {
        queue.async { [self] in loop() }
    }

    /// Se llama desde el callback de audio: parte el audio en frames de 20 ms y vuelve. Nunca bloquea en I/O.
    func enqueue(_ chunk: Data) {
        lock.lock()
        leftover.append(contentsOf: chunk)
        while leftover.count >= Self.frameBytes {
            let frame = Data(leftover[0..<Self.frameBytes])
            leftover.removeFirst(Self.frameBytes)
            if pending.count >= Self.maxPending {
                let dropped = pending.removeFirst()
                log("dropping \(dropped.count) B: stdout is slower than realtime")
            }
            pending.append(frame)
        }
        lock.unlock()
        ready.signal()
    }

    private func next() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return pending.isEmpty ? nil : pending.removeFirst()
    }

    private func loop() {
        var anchor = DispatchTime.now().uptimeNanoseconds
        var index: UInt64 = 0
        while true {
            ready.wait()
            while let frame = next() {
                let target = anchor &+ index &* Self.frameNanos
                let now = DispatchTime.now().uptimeNanoseconds
                if target > now {
                    sleepNanos(target - now)
                } else if now &- target > 4 &* Self.frameNanos {
                    // Muy atrasados (arranque en frío o un stall del dispositivo): reanclar en vez de escribir a
                    // toda velocidad para "recuperar", que es lo que produciría otra ráfaga.
                    anchor = now
                    index = 0
                }
                writeAll(frame)
                index &+= 1
            }
        }
    }

    private func sleepNanos(_ nanos: UInt64) {
        var request = timespec(tv_sec: Int(nanos / 1_000_000_000), tv_nsec: Int(nanos % 1_000_000_000))
        while true {
            var remaining = timespec()
            if nanosleep(&request, &remaining) == 0 { return }
            if errno != EINTR { return }
            request = remaining
        }
    }

    private func writeAll(_ chunk: Data) {
        chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var written = 0
            while written < raw.count {
                let n = Darwin.write(STDOUT_FILENO, base.advanced(by: written), raw.count - written)
                if n < 0 {
                    if errno == EINTR { continue }
                    // El lector cerró el pipe: es el final normal del stream, no un error.
                    if errno == EPIPE { exit(0) }
                    fail("stdout write failed: \(String(cString: strerror(errno)))")
                }
                if n == 0 { exit(0) }
                written += n
            }
        }
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--list-devices"] {
    for (index, device) in devices().enumerated() { print("\(index)\t\(device.1)") }
    exit(0)
}
if !args.isEmpty && (args.count != 2 || args[0] != "--device") { fail("usage: audio-capture [--device <name> | --list-devices]") }
let available = devices()
let selected: (AudioDeviceID, String)
if args.count == 2 {
    guard let match = available.first(where: { $0.1 == args[1] }) else { fail("input device not found: \(args[1])") }
    selected = match
} else {
    guard let id = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, AudioDeviceID(0)),
          let match = available.first(where: { $0.0 == id }) else { fail("no default input device") }
    selected = match
}
let permission = AVCaptureDevice.authorizationStatus(for: .audio)
if permission == .notDetermined {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { allowed in granted = allowed; semaphore.signal() }
    semaphore.wait()
    if !granted { fail("microphone permission denied") }
} else if permission != .authorized { fail("microphone permission denied") }

// El tamaño del tap es solo una sugerencia: quien manda es el buffer de I/O del dispositivo. Si el dispositivo
// entrega bloques de 100 ms, el audio llega en ráfagas de 100 ms aunque se pida un frame de 20 ms. Por eso se pide
// explícitamente el buffer de I/O del dispositivo en 960 frames (20 ms a 48 kHz) y se reporta el valor real.
var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyBufferFrameSize,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
)
var requested: UInt32 = 960
let setStatus = AudioObjectSetPropertyData(selected.0, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &requested)
var honoured: UInt32 = 0
var honouredSize = UInt32(MemoryLayout<UInt32>.size)
let getStatus = AudioObjectGetPropertyData(selected.0, &address, 0, nil, &honouredSize, &honoured)

let engine = AVAudioEngine()
let input = engine.inputNode
guard let unit = input.audioUnit else { fail("input audio unit unavailable") }
var deviceID = selected.0
let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size))
if status != noErr { fail("cannot select input device \(selected.1): \(status)") }
let hardware = input.outputFormat(forBus: 0)
guard hardware.sampleRate > 0, hardware.channelCount > 0 else { fail("invalid input format") }
guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 2, interleaved: true),
      let converter = AVAudioConverter(from: hardware, to: output) else { fail("cannot create audio converter") }
// Mono -> estéreo: duplicar el canal 0 en los dos.
if hardware.channelCount == 1 { converter.channelMap = [0, 0] }
log("device=\(selected.1) hardware_rate=\(hardware.sampleRate) hardware_channels=\(hardware.channelCount) output=s16le/48000/2 io_buffer_set=\(setStatus == noErr ? "ok" : "status \(setStatus)") io_buffer_frames=\(getStatus == noErr ? String(honoured) : "unknown")")

let writer = OutputWriter()
writer.start()
signal(SIGPIPE, SIG_IGN)

input.installTap(onBus: 0, bufferSize: 960, format: hardware) { buffer, _ in
    // Acá adentro no se hace I/O: solo convertir y encolar.
    let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 48000 / hardware.sampleRate)) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    let result = converter.convert(to: converted, error: &error) { _, inputStatus in
        if supplied { inputStatus.pointee = .noDataNow; return nil }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
    }
    if result == .error {
        log("audio conversion failed: \(error?.localizedDescription ?? "unknown error")")
        return
    }
    let count = Int(converted.frameLength) * 4
    guard count > 0, let samples = converted.int16ChannelData else { return }
    writer.enqueue(Data(bytes: samples[0], count: count))
}

do { try engine.start() } catch { fail("cannot start audio engine: \(error.localizedDescription)") }

var signalSources: [DispatchSourceSignal] = []
for number in [SIGINT, SIGTERM] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler {
        // Salir ya. Cerrar stdout primero desbloquea al hilo que escribe si quedó esperando a un lector que no
        // drena; esperar a que termine dejaría el proceso colgado justo cuando lo están matando.
        Darwin.close(STDOUT_FILENO)
        _exit(0)
    }
    source.resume()
    signalSources.append(source)
}
dispatchMain()
