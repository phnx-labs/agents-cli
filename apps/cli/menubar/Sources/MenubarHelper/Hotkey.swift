import AppKit
import Carbon.HIToolbox

// Global hotkey via Carbon RegisterEventHotKey. Chosen over an NSEvent global
// monitor (passive, can't act cleanly) or a CGEvent tap (needs Input-Monitoring
// TCC and can be disabled under load): RegisterEventHotKey needs NO extra TCC to
// register, and because we use a DEDICATED chord (Cmd-Shift-V) we never hijack
// the OS Cmd-V. The Accessibility grant is only needed later, for the paste
// injection itself (Clip.inject).
final class HotkeyManager {
    // The InstallEventHandler callback is a bare C function pointer with no
    // captured context, so route through a static singleton.
    static var shared: HotkeyManager?

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let onFire: () -> Void

    init(onFire: @escaping () -> Void) { self.onFire = onFire }

    func register() {
        HotkeyManager.shared = self

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            HotkeyManager.shared?.onFire()
            return noErr
        }, 1, &spec, nil, &handlerRef)

        // 'AGCT' signature keeps our hotkey id namespaced from other apps'.
        let id = EventHotKeyID(signature: OSType(0x41474354), id: 1)
        let modifiers = UInt32(cmdKey | shiftKey)
        let registered = RegisterEventHotKey(UInt32(kVK_ANSI_V), modifiers, id,
                                             GetApplicationEventTarget(), 0, &hotKeyRef)

        // Registration fails if another app already owns the chord — surface it
        // rather than silently never firing.
        if installed != noErr || registered != noErr {
            FileHandle.standardError.write(Data(
                "clip: hotkey registration failed (install=\(installed) register=\(registered))\n".utf8))
        }
    }
}
