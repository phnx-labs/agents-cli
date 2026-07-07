import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// Per-window screenshot via ScreenCaptureKit. CGWindowListCreateImage was
// obsoleted in macOS 15 (Sequoia) and removed from the public SDK; the legacy
// shim still answers at runtime today but Apple has stopped guaranteeing it.
// SCK is the supported replacement, captures across Spaces, and accepts an
// SCWindow target by windowID without raising the window (focus-safe).
//
// Modes (params):
//   - list=true            → enumerate the app's windows (id/title/frame/layer/
//                            active), no image. Lets a caller see modal dialogs,
//                            popovers, and floating panels that the default
//                            largest-window capture hides.
//   - window_id=<n>        → capture exactly that window (use a window id from
//                            list=true). The way to screenshot a modal sheet or
//                            the contextual taskbar.
//   - display=true         → capture the whole display the app's main window is
//                            on, compositing every overlapping window. The way
//                            to see stacked modals + the editor together.
//   - (default)            → largest on-screen layer-0 window owned by pid.
//
// Every image response now also reports the captured region's global origin
// and the backing scale factor, so a caller can map screenshot pixels to
// global screen coordinates for click()/scroll(): global = origin + pixel/scale.
enum Screenshot {
    static func capture(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")
        let quality = max(1, min(100, Params.intOpt(params, "quality") ?? 85))

        // Hard floor + user allow list. Throws before SCK initializes.
        try ensurePidAllowed(pid)

        let listOnly = Params.bool(params, "list")
        let display = Params.bool(params, "display")
        let windowId = Params.intOpt(params, "window_id")

        let semaphore = DispatchSemaphore(value: 0)
        var captured: Result<[String: Any], Error>!

        Task {
            do {
                if listOnly {
                    captured = .success(try await listWindows(pid: pid))
                } else if display {
                    captured = .success(try await captureDisplay(pid: pid, quality: quality))
                } else if let wid = windowId {
                    captured = .success(try await captureWindowId(pid: pid, windowId: wid, quality: quality))
                } else {
                    captured = .success(try await captureLargest(pid: pid, quality: quality))
                }
            } catch {
                captured = .failure(error)
            }
            semaphore.signal()
        }

        let timedOut = semaphore.wait(timeout: .now() + 5.0) == .timedOut
        if timedOut {
            throw RPCError(code: "action_failed", message: "ScreenCaptureKit timed out after 5s (denied Screen Recording permission?)")
        }
        return try captured.get()
    }

    // MARK: - enumeration

    private static func shareable() async throws -> SCShareableContent {
        do {
            // onScreenWindowsOnly=false matches apps whose editor window is on a
            // different Space (or otherwise filtered by the on-screen check).
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw RPCError(code: "action_failed", message: "SCShareableContent failed: \(error.localizedDescription) (grant Screen Recording to ComputerHelper)")
        }
    }

    private static func listWindows(pid: Int) async throws -> [String: Any] {
        let content = try await shareable()
        let mine = content.windows.filter { $0.owningApplication?.processID == pid_t(pid) }
        // Largest layer-0 window first, then by descending area — the editor
        // surface leads, dialogs/panels follow.
        let sorted = mine.sorted { lhs, rhs in
            if lhs.windowLayer != rhs.windowLayer { return lhs.windowLayer < rhs.windowLayer }
            return area(lhs.frame) > area(rhs.frame)
        }
        let windows: [[String: Any]] = sorted.map { w in
            [
                "window_id": Int(w.windowID),
                "title": w.title ?? "",
                "layer": w.windowLayer,
                "active": w.isActive,
                "on_screen": w.isOnScreen,
                "bounds": [Int(w.frame.origin.x), Int(w.frame.origin.y), Int(w.frame.width), Int(w.frame.height)],
            ]
        }
        return ["pid": pid, "windows": windows, "window_count": windows.count]
    }

    // MARK: - capture variants

    private static func captureLargest(pid: Int, quality: Int) async throws -> [String: Any] {
        let content = try await shareable()
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == pid_t(pid) && $0.windowLayer == 0
        }
        if let largest = candidates.max(by: { area($0.frame) < area($1.frame) }) {
            return try await snap(window: largest, quality: quality)
        }
        // Fall back to any-layer windows if no layer-0 candidate exists.
        let anyLayer = content.windows.filter { $0.owningApplication?.processID == pid_t(pid) }
        guard let largest = anyLayer.max(by: { area($0.frame) < area($1.frame) }) else {
            throw RPCError(code: "action_failed", message: "no visible windows for pid \(pid)")
        }
        return try await snap(window: largest, quality: quality)
    }

    private static func captureWindowId(pid: Int, windowId: Int, quality: Int) async throws -> [String: Any] {
        let content = try await shareable()
        guard let window = content.windows.first(where: {
            $0.owningApplication?.processID == pid_t(pid) && Int($0.windowID) == windowId
        }) else {
            throw RPCError(code: "element_not_found", message: "window_id \(windowId) not found for pid \(pid) — call screenshot with list=true to enumerate")
        }
        return try await snap(window: window, quality: quality)
    }

    // Capture the entire display the app's main window sits on, compositing all
    // windows (including modal sheets and the editor together).
    private static func captureDisplay(pid: Int, quality: Int) async throws -> [String: Any] {
        let content = try await shareable()
        let mine = content.windows.filter { $0.owningApplication?.processID == pid_t(pid) }
        guard let anchor = mine.max(by: { area($0.frame) < area($1.frame) }) else {
            throw RPCError(code: "action_failed", message: "no visible windows for pid \(pid)")
        }
        let anchorCenter = CGPoint(x: anchor.frame.midX, y: anchor.frame.midY)
        // SCDisplay.frame is in global points; pick the display containing the
        // app's main window center.
        guard let scDisplay = content.displays.first(where: { $0.frame.contains(anchorCenter) }) ?? content.displays.first else {
            throw RPCError(code: "action_failed", message: "no displays available")
        }

        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = max(Int(scDisplay.frame.width), 1)
        config.height = max(Int(scDisplay.frame.height), 1)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.capturesAudio = false

        let cgImage = try await captureImage(filter: filter, config: config)
        let scale = scDisplay.frame.width > 0 ? Double(cgImage.width) / Double(scDisplay.frame.width) : 1.0
        return try encode(cgImage: cgImage, quality: quality, regionOrigin: scDisplay.frame.origin, scale: scale, extra: [
            "mode": "display",
            "display_id": Int(scDisplay.displayID),
        ])
    }

    private static func area(_ r: CGRect) -> CGFloat { r.width * r.height }

    private static func snap(window: SCWindow, quality: Int) async throws -> [String: Any] {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        // sourceRect=CGRect.null tells SCK to use the window's natural bounds.
        config.width = max(Int(window.frame.width), 1)
        config.height = max(Int(window.frame.height), 1)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.capturesAudio = false

        // Off-Space capture works for plain windows (that's why shareable()
        // passes onScreenWindowsOnly=false) but SCK refuses windows on
        // inactive *fullscreen* Spaces with an opaque stream error. Don't
        // pre-block the attempt — convert the failure into an actionable
        // error instead.
        let cgImage: CGImage
        do {
            cgImage = try await captureImage(filter: filter, config: config)
        } catch {
            if !window.isOnScreen {
                throw RPCError(code: "window_offscreen", message: "window_id \(Int(window.windowID)) (\(window.title ?? "")) is not on the active Space and SCK could not capture it — run `agents computer raise --window-id \(Int(window.windowID))` first, then retry")
            }
            throw error
        }
        // SCK returns a backing-store image: on Retina it is ~2x the requested
        // point size. Report the scale so callers can map pixels -> points.
        let scale = window.frame.width > 0 ? Double(cgImage.width) / Double(window.frame.width) : 1.0
        return try encode(cgImage: cgImage, quality: quality, regionOrigin: window.frame.origin, scale: scale, extra: [
            "mode": "window",
            "window_id": Int(window.windowID),
            "title": window.title ?? "",
        ])
    }

    private static func captureImage(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> CGImage {
        do {
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            throw RPCError(code: "action_failed", message: "SCK captureImage failed: \(error.localizedDescription)")
        }
    }

    private static func encode(cgImage: CGImage, quality: Int, regionOrigin: CGPoint, scale: Double, extra: [String: Any]) throws -> [String: Any] {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: Double(quality) / 100.0]) else {
            throw RPCError(code: "action_failed", message: "JPEG encode failed")
        }
        var out: [String: Any] = [
            "image_data": data.base64EncodedString(),
            "mime_type": "image/jpeg",
            "width": cgImage.width,
            "height": cgImage.height,
            // Global point origin of the captured region + backing scale.
            // To click a feature at screenshot pixel (px,py):
            //   global_x = origin_x + px/scale ; global_y = origin_y + py/scale
            "origin": [Int(regionOrigin.x), Int(regionOrigin.y)],
            "scale": scale,
        ]
        for (k, v) in extra { out[k] = v }
        return out
    }
}
