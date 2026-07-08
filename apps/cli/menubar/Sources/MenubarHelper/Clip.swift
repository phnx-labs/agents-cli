import AppKit
import ApplicationServices
import UniformTypeIdentifiers

// Smart clip reference paste. When the clipboard holds a file, directory, or a
// screenshot and the user presses the hotkey while a terminal is focused, we do
// NOT paste raw bytes (which mangle a terminal / an SSH'd Claude Code session).
// Instead we type a NATIVE scp-style reference — `<host>:<abs-path>` — into the
// terminal. An agent already understands that token: if `host` is its own
// machine it Reads the path; otherwise it `scp`s it (`-r` for a directory). No
// invented syntax, no wrapper CLI (agents ssh natively).
//
// Handling by kind:
//   • screenshot bytes → written as PNG into the attachments dir (only lives on
//     the clipboard, so it must be persisted).
//   • a copied file (PDF, image, …) → copied into the attachments dir for a
//     stable snapshot that survives Desktop/Screenshots sweeps, scp-safe name.
//   • a copied directory → referenced IN PLACE (copying a whole tree is
//     unreasonable); the agent fetches it with `scp -r` / `rsync -a`. Its path
//     can't be renamed, so the token POSIX-quotes it when it isn't shell-safe.
enum Clip {
    // ~/.agents/.history/attachments — .history is gitignored (never pushed) and
    // DURABLE (unlike .cache, a cache-clear won't sweep an in-flight reference).
    // Non-private so the quick-issue panel can surface recent clips in its
    // attach strip (AgentsCLI.screenshotSourceDirs) — one canonical path.
    static var attachmentsDir: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".agents/.history/attachments", isDirectory: true)
    }

    // Entry point wired to the hotkey. Resolve the clipboard item to a path, then
    // inject the reference. Nothing referenceable on the clipboard → no-op.
    static func run() {
        guard let path = persistFromPasteboard() else { return }
        inject(referenceToken(for: path))
    }

    // Test/debug entry: resolve + print the token, no keystroke injection (so it
    // needs no Accessibility grant). Driven by MENUBAR_CLIP_TEST=1.
    static func printTokenAndExit() -> Never {
        guard let path = persistFromPasteboard() else {
            FileHandle.standardError.write(Data("no file, directory, or image on clipboard\n".utf8))
            exit(1)
        }
        print(referenceToken(for: path))
        exit(0)
    }

    // The `<host>:<path>` reference typed into the terminal. Copied files land on
    // a sanitized, space-free name, but a directory referenced in place keeps its
    // original path — which may contain spaces or shell metacharacters. Since the
    // token is typed into a live shell, POSIX-single-quote the path when it isn't
    // already shell-safe so `scp -r <token>` parses as one argument. Clean paths
    // stay unquoted.
    static func referenceToken(for url: URL) -> String {
        let path = url.path
        let safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-@/"
        let rendered = path.allSatisfy { safe.contains($0) }
            ? path
            : "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        return "\(localHostName()):\(rendered)"
    }

    // MARK: - pasteboard → reference path

    // Resolve whatever is on the clipboard to a path we can hand an agent.
    static func persistFromPasteboard() -> URL? {
        let pb = NSPasteboard.general
        try? FileManager.default.createDirectory(at: attachmentsDir, withIntermediateDirectories: true)

        // 1. A file or directory already on disk (Finder copy, CleanShot file, …).
        if let urls = pb.readObjects(
                forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]
            ) as? [URL], let src = urls.first(where: { $0.isFileURL }) {
            let isDir = (try? src.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                // Reference the tree in place — the agent fetches with `scp -r`.
                return src
            }
            // Copy the file for a stable, scp-safe snapshot; sidecar the metadata.
            let dst = attachmentsDir.appendingPathComponent(uniqueName(sanitize(src.lastPathComponent)))
            if (try? FileManager.default.copyItem(at: src, to: dst)) != nil {
                writeSidecar(for: dst, sourcePath: src.path, kind: uti(of: src))
                return dst
            }
        }

        // 2. Raw bitmap (a screenshot that lives only on the clipboard) → PNG.
        let dst = attachmentsDir.appendingPathComponent("clip-\(Int(Date().timeIntervalSince1970)).png")
        if let png = pb.data(forType: .png)
            ?? pngFrom(tiff: pb.data(forType: .tiff))
            ?? pngFrom(tiff: NSImage(pasteboard: pb)?.tiffRepresentation) {
            if (try? png.write(to: dst)) != nil {
                writeSidecar(for: dst, sourcePath: nil, kind: "public.png")
                return dst
            }
        }
        return nil
    }

    private static func pngFrom(tiff: Data?) -> Data? {
        guard let tiff, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    // scp-safe: `host:path` splits on spaces and chokes on shell metacharacters,
    // so map anything outside a conservative allowlist to '-'.
    private static func sanitize(_ name: String) -> String {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-@")
        return String(name.map { allowed.contains($0) ? $0 : "-" })
    }

    // Avoid clobbering an existing attachment of the same name.
    private static func uniqueName(_ preferred: String) -> String {
        let candidate = attachmentsDir.appendingPathComponent(preferred)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return preferred }
        let ext = (preferred as NSString).pathExtension
        let base = (preferred as NSString).deletingPathExtension
        let stamped = "\(base)-\(Int(Date().timeIntervalSince1970))"
        return ext.isEmpty ? stamped : "\(stamped).\(ext)"
    }

    private static func uti(of url: URL) -> String {
        (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.identifier ?? "public.data"
    }

    // Sidecar: a `<file>.json` next to the attachment recording where/when it came
    // from. Leaves the file itself byte-for-byte untouched; the agent can scp the
    // .json alongside for context. (Source app isn't on the pasteboard — omit it
    // rather than guess.)
    private static func writeSidecar(for file: URL, sourcePath: String?, kind: String) {
        var meta: [String: Any] = [
            "host": localHostName(),
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "kind": kind,
        ]
        if let sourcePath { meta["sourcePath"] = sourcePath }
        if let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int {
            meta["bytes"] = size
        }
        if let data = try? JSONSerialization.data(withJSONObject: meta,
                                                  options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: file.path + ".json"))
        }
    }

    // MARK: - hostname

    // The single-label LocalHostName ("zion") that Tailscale MagicDNS / ssh
    // aliases resolve — NOT ProcessInfo.hostName (may be "zion.local") or the
    // Computer Name ("Zion's MacBook"). Absolute /usr/sbin path: a GUI/launchd
    // process inherits a minimal PATH.
    static func localHostName() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/scutil")
        p.arguments = ["--get", "LocalHostName"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if p.terminationStatus == 0,
               let name = String(data: data, encoding: .utf8)?
                   .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                return name
            }
        }
        // Fallback: strip any DNS suffix from the Bonjour host name.
        return ProcessInfo.processInfo.hostName.components(separatedBy: ".").first
            ?? ProcessInfo.processInfo.hostName
    }

    // MARK: - inject

    // Put the token on the pasteboard and synthesize Cmd-V into the frontmost app
    // (the terminal — this .accessory app never becomes key). Mirrors the proven
    // pattern in computer-helper/AX.swift. Uses a .hidSystemState source so
    // terminals wrapped in Electron/webview accept the event.
    private static func inject(_ text: String) {
        guard ensureAccessibility() else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        usleep(20_000)

        let src = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false) else { return }
        down.flags = .maskCommand
        up.flags = .maskCommand
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            down.postToPid(pid)
            up.postToPid(pid)
        } else {
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    // Posting synthesized keystrokes needs Accessibility. Prompt once if missing.
    private static func ensureAccessibility() -> Bool {
        if AXIsProcessTrusted() { return true }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }
}
