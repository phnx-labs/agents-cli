import AppKit

// The agents-cli mark: the chunky lowercase `a` glyph from public/favicon.svg,
// drawn as a *template* image (black + alpha only) so macOS tints it for the
// light/dark menu bar, vibrancy, and selection states. The lime tile from the
// favicon is intentionally dropped — colored squares render as muddy boxes in
// the status bar and break dark-mode adaptation.
//
// Path coordinates are lifted verbatim from favicon.svg's 32x32 viewBox, with
// the y-axis flipped (SVG is y-down, AppKit is y-up) so the notch sits top-right.
enum Icon {
    // SVG viewBox is 32x32. Render into an 18pt status item with 1pt inset.
    private static let unit: CGFloat = 32

    static func make() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let inset: CGFloat = 1
            let drawable = rect.insetBy(dx: inset, dy: inset)
            let scale = min(drawable.width, drawable.height) / unit

            let t = NSAffineTransform()
            t.translateX(by: drawable.minX, yBy: drawable.minY)
            t.scaleX(by: scale, yBy: scale)
            t.concat()

            let path = glyphPath()
            NSColor.black.setFill()
            path.fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    // Outer `a` silhouette + inner counter (hole), even-odd filled.
    // Coordinates: y' = 32 - y_svg.
    private static func glyphPath() -> NSBezierPath {
        let path = NSBezierPath()
        path.windingRule = .evenOdd

        // Outer shape.
        path.move(to: NSPoint(x: 6, y: 22))
        path.line(to: NSPoint(x: 24, y: 22))
        path.line(to: NSPoint(x: 26, y: 20))
        path.line(to: NSPoint(x: 26, y: 6))
        path.line(to: NSPoint(x: 20, y: 6))
        path.line(to: NSPoint(x: 20, y: 10))
        path.line(to: NSPoint(x: 12, y: 10))
        path.line(to: NSPoint(x: 12, y: 6))
        path.line(to: NSPoint(x: 6, y: 6))
        path.close()

        // Inner counter — even-odd carves it out of the outer shape.
        path.move(to: NSPoint(x: 12, y: 16))
        path.line(to: NSPoint(x: 12, y: 14))
        path.line(to: NSPoint(x: 20, y: 14))
        path.line(to: NSPoint(x: 20, y: 16))
        path.close()

        return path
    }
}
