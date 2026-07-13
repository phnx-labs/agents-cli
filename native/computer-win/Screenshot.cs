using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace ComputerHelperWin;

/// <summary>
/// Screen capture, scoped like the macOS helper (Screenshot.swift): the target
/// pid is required, and the same params pick the mode —
///   list=true        -> enumerate the pid's top-level windows (no image)
///   display=true     -> capture the whole display the target window is on
///   window_id=&lt;hwnd&gt; -> capture exactly that window
///   (default)        -> capture the pid's largest on-screen window
/// Result keys match what the CLI consumes from the macOS helper
/// (src/commands/computer.ts): image_data (base64 PNG), width, height,
/// origin [x,y], scale — plus mode/window_id/title for scoped captures, and
/// { pid, windows, window_count } for list. window_id is the Win32 HWND, the
/// same handle focus_window matches against NativeWindowHandle, so
/// `screenshot --list` ids feed both `--window-id` and `raise --window-id`.
/// </summary>
public static class Screenshot
{
    public static Dictionary<string, object?> Capture(JsonElement @params)
    {
        if (@params.ValueKind != JsonValueKind.Object)
            throw RpcError.Invalid("screenshot needs params");
        bool listOnly = P.BoolOr(@params, "list", false);
        bool display = P.BoolOr(@params, "display", false);
        int? windowId = @params.TryGetProperty("window_id", out var wv) && wv.ValueKind == JsonValueKind.Number
            ? wv.GetInt32() : null;
        // pid is optional for a full-display capture (mirrors the macOS
        // `screenshot --display` path, which needs no app). Every other mode
        // still requires it — enforced below once we know the mode.
        int? pidOpt = @params.TryGetProperty("pid", out var pv) && pv.ValueKind == JsonValueKind.Number
            ? pv.GetInt32() : null;

        // Whole-screen capture: with a pid, grab the monitor that pid's window
        // sits on; without one, grab the primary screen. No process needed.
        if (display)
        {
            Screen screen;
            if (pidOpt is int dpid)
            {
                var dwindows = TopLevelWindows(dpid);
                if (dwindows.Count == 0) throw RpcError.AppMissing(dpid);
                var anchor = dwindows.FirstOrDefault(w => !w.Minimized) ?? dwindows[0];
                screen = Screen.FromHandle(anchor.Hwnd);
            }
            else
            {
                screen = Screen.PrimaryScreen ?? Screen.AllScreens[0];
            }
            return Encode(screen.Bounds, new()
            {
                ["mode"] = "display",
                ["display_id"] = screen.DeviceName,
            });
        }

        // list + window capture operate on a specific process's windows.
        int pid = pidOpt ?? throw RpcError.Invalid("missing int param: pid");
        var windows = TopLevelWindows(pid);
        if (windows.Count == 0) throw RpcError.AppMissing(pid);

        if (listOnly)
        {
            // EnumWindows yields z-order top-to-bottom; keep that order. Windows
            // has no macOS-style window layers, so layer is a constant 0.
            var entries = windows.Select(w => new Dictionary<string, object?>
            {
                ["window_id"] = HwndId(w.Hwnd),
                ["title"] = w.Title,
                ["layer"] = 0,
                ["active"] = w.Foreground,
                ["on_screen"] = !w.Minimized,
                ["bounds"] = new[] { w.Bounds.X, w.Bounds.Y, w.Bounds.Width, w.Bounds.Height },
            }).ToList();
            return new()
            {
                ["pid"] = pid,
                ["windows"] = entries,
                ["window_count"] = entries.Count,
            };
        }

        WindowInfo target;
        if (windowId != null)
        {
            target = windows.FirstOrDefault(w => HwndId(w.Hwnd) == windowId.Value)
                ?? throw RpcError.NotFound($"no window with window_id={windowId} for pid {pid}");
            if (target.Minimized)
                throw new RpcError("window_offscreen",
                    $"window {windowId} is minimized — `raise --window-id {windowId}` first, then re-screenshot");
        }
        else
        {
            target = windows
                .Where(w => !w.Minimized && w.Bounds.Width > 0 && w.Bounds.Height > 0)
                .OrderByDescending(w => (long)w.Bounds.Width * w.Bounds.Height)
                .FirstOrDefault()
                ?? throw new RpcError("window_offscreen",
                    $"pid {pid} has no on-screen window to capture (all minimized?) — `raise` one first");
        }

        var extra = new Dictionary<string, object?>
        {
            ["mode"] = "window",
            ["window_id"] = HwndId(target.Hwnd),
        };
        if (target.Title.Length > 0) extra["title"] = target.Title;
        return Encode(target.Bounds, extra);
    }

    // Capture the given desktop rect (clamped to the virtual screen — a
    // partially offscreen window crops to its visible region) and build the
    // shared image result shape.
    private static Dictionary<string, object?> Encode(Rectangle bounds, Dictionary<string, object?> extra)
    {
        var rect = Rectangle.Intersect(bounds, SystemInformation.VirtualScreen);
        if (rect.Width <= 0 || rect.Height <= 0)
            throw new RpcError("window_offscreen", "target window has no visible on-screen area");

        using var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, bmp.Size, CopyPixelOperation.SourceCopy);
        }

        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);

        // origin lets the caller map screenshot pixels back to global coords:
        // global = origin + pixel/scale.
        var result = new Dictionary<string, object?>
        {
            ["image_data"] = Convert.ToBase64String(ms.ToArray()),
            ["width"] = rect.Width,
            ["height"] = rect.Height,
            ["origin"] = new[] { rect.Left, rect.Top },
            ["scale"] = 1.0,
        };
        foreach (var (k, v) in extra) result[k] = v;
        return result;
    }

    private sealed record WindowInfo(IntPtr Hwnd, string Title, Rectangle Bounds, bool Minimized, bool Foreground);

    // The pid's visible, non-cloaked top-level windows, z-order top-to-bottom.
    // Cloaked windows (DWM-hidden UWP frame ghosts) would list — and capture —
    // as phantom fullscreen entries, so they are skipped.
    private static List<WindowInfo> TopLevelWindows(int pid)
    {
        var result = new List<WindowInfo>();
        var foreground = GetForegroundWindow();
        EnumWindows((hwnd, _) =>
        {
            GetWindowThreadProcessId(hwnd, out uint wpid);
            if (wpid != (uint)pid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            if (IsCloaked(hwnd)) return true;
            result.Add(new WindowInfo(hwnd, WindowTitle(hwnd), FrameBounds(hwnd), IsIconic(hwnd), hwnd == foreground));
            return true;
        }, IntPtr.Zero);
        return result;
    }

    // HWNDs are guaranteed to fit in 32 bits for cross-bitness interop — the
    // same truncation UIA's NativeWindowHandle (int) applies.
    private static int HwndId(IntPtr hwnd) => unchecked((int)hwnd.ToInt64());

    private static string WindowTitle(IntPtr hwnd)
    {
        int len = GetWindowTextLengthW(hwnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // The window as the user sees it (DWM extended frame — excludes the
    // invisible resize borders GetWindowRect includes). Non-DWM window classes
    // reject the attribute; for those the raw window rect IS the visual rect.
    private static Rectangle FrameBounds(IntPtr hwnd)
    {
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT r, Marshal.SizeOf<RECT>()) == 0)
            return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        GetWindowRect(hwnd, out RECT raw);
        return Rectangle.FromLTRB(raw.Left, raw.Top, raw.Right, raw.Bottom);
    }

    private static bool IsCloaked(IntPtr hwnd)
        => DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0;

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int cb);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int cb);
}
