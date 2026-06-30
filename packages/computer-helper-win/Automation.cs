using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace ComputerHelperWin;

/// <summary>
/// Input + UIAutomation backend.
///
/// Two layers:
///   - Coordinate/input verbs (click x/y, type_text, key) via Win32 SendInput —
///     the universal fallback for canvas apps and anything off the UIA tree.
///   - UIAutomation tree verbs (describe -> id-addressable click / get_text /
///     set_focus / type) via System.Windows.Automation, the Windows analogue of
///     the macOS Accessibility (AXUIElement) backend in packages/computer-helper.
///
/// The result shapes mirror the macOS helper (AX.swift) so the single TS client
/// in src/lib/computer-rpc.ts drives both platforms unchanged:
///   describe -> { pid, tree, element_count, truncated }
///   node     -> { id, role, enabled, label?, value?, bounds:[x,y,w,h]?, children? }
/// Element ids are "@eN", reset on every describe (a stale id throws
/// element_stale, prompting a re-describe — same contract as macOS).
/// </summary>
public sealed class Automation
{
    private readonly ElementCache _cache = new();

    // ---- describe: UIAutomation tree walk -------------------------------
    public Dictionary<string, object?> Describe(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        int maxDepth = P.IntOr(p, "max_depth", MaxDepthDefault);

        var windows = TopLevelWindows(pid);
        if (windows.Count == 0) throw RpcError.AppMissing(pid);

        _cache.BeginDescribe(pid);
        int counter = 0;
        bool truncated = false;

        // Synthetic application root (depth 0, always emitted) carrying the
        // process's top-level windows — mirrors the macOS AXApplication root.
        var rootId = _cache.NextRefId(pid);
        var children = new List<Dictionary<string, object?>>();
        foreach (var w in windows)
        {
            var node = Walk(w, pid, depth: 1, maxDepth, ref counter, ref truncated);
            if (node != null) children.Add(node);
        }
        counter++;

        var tree = new Dictionary<string, object?>
        {
            ["id"] = rootId,
            ["role"] = "Application",
            ["enabled"] = true,
        };
        var procName = SafeProcessName(pid);
        if (procName != null) tree["label"] = procName;
        if (children.Count > 0) tree["children"] = children;

        return new()
        {
            ["pid"] = pid,
            ["tree"] = tree,
            ["element_count"] = counter,
            ["truncated"] = truncated,
        };
    }

    private Dictionary<string, object?>? Walk(
        AutomationElement el, int pid, int depth, int maxDepth, ref int counter, ref bool truncated)
    {
        if (counter >= MaxElements) { truncated = true; return null; }
        if (depth > maxDepth) return null;

        string role;
        string? label;
        bool enabled;
        int[]? bounds;
        try
        {
            var info = el.Current;
            role = ControlTypeName(info.ControlType);
            label = NullIfEmpty(info.Name);
            enabled = info.IsEnabled;
            bounds = RectToBounds(info.BoundingRectangle);
        }
        catch (ElementNotAvailableException)
        {
            return null; // element vanished mid-walk — skip it
        }
        string? value = TryReadValue(el);

        // Recurse via the ControlView walker (filters out raw/noise elements,
        // the closest UIA analogue to the macOS interesting-roles filter).
        var childNodes = new List<Dictionary<string, object?>>();
        try
        {
            var walker = TreeWalker.ControlViewWalker;
            for (var child = walker.GetFirstChild(el); child != null; child = walker.GetNextSibling(child))
            {
                var node = Walk(child, pid, depth + 1, maxDepth, ref counter, ref truncated);
                if (node != null) childNodes.Add(node);
                if (counter >= MaxElements) { truncated = true; break; }
            }
        }
        catch (ElementNotAvailableException) { /* subtree gone — emit what we have */ }

        bool isInteractable = InteractableRoles.Contains(role);
        bool isContent = ContentRoles.Contains(role) && (label != null || !string.IsNullOrEmpty(value));
        bool hasChildren = childNodes.Count > 0;
        bool isTextEntry = role is "Edit" or "Document";

        bool shouldEmit = isContent
            || (isInteractable && (label != null || isTextEntry || hasChildren));

        if (!shouldEmit)
        {
            // Flatten empty/unlabeled containers: pass children up.
            if (childNodes.Count == 1) return childNodes[0];
            if (childNodes.Count == 0) return null;
            return new Dictionary<string, object?> { ["role"] = "Group", ["children"] = childNodes };
        }

        counter++;
        var id = _cache.NextRefId(pid);
        _cache.Put(pid, id, el);

        var nodeOut = new Dictionary<string, object?>
        {
            ["id"] = id,
            ["role"] = role,
            ["enabled"] = enabled,
        };
        if (label != null) nodeOut["label"] = label;
        if (!string.IsNullOrEmpty(value) && value != label) nodeOut["value"] = TruncateForDisplay(value!);
        if (bounds != null) nodeOut["bounds"] = bounds;
        if (childNodes.Count > 0) nodeOut["children"] = childNodes;
        return nodeOut;
    }

    // ---- click ----------------------------------------------------------
    public Dictionary<string, object?> Click(JsonElement p)
    {
        // id-addressable click: resolve the element, prefer a UIA pattern,
        // fall back to a synthetic click at its on-screen center.
        string? elementId = P.StringOpt(p, "element_id");
        if (elementId != null)
        {
            int pid = P.Int(p, "pid");
            var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();
            try
            {
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out var inv))
                {
                    ((InvokePattern)inv).Invoke();
                    return new() { ["ok"] = true, ["action"] = "invoke" };
                }
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var tog))
                {
                    ((TogglePattern)tog).Toggle();
                    return new() { ["ok"] = true, ["action"] = "toggle" };
                }
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sel))
                {
                    ((SelectionItemPattern)sel).Select();
                    return new() { ["ok"] = true, ["action"] = "select" };
                }
                // No actionable pattern — click the element's center physically.
                var b = RectToBounds(el.Current.BoundingRectangle)
                    ?? throw RpcError.Unsupported("element has no invoke/toggle/select pattern and no bounds");
                int cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
                MoveCursor(cx, cy);
                SendMouse(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP);
                return new() { ["ok"] = true, ["action"] = "click", ["at"] = new[] { cx, cy } };
            }
            catch (ElementNotAvailableException) { throw RpcError.Stale(); }
        }

        // Coordinate click (no element_id): the universal fallback.
        if (p.TryGetProperty("x", out var xe) && p.TryGetProperty("y", out var ye))
        {
            int x = xe.GetInt32(), y = ye.GetInt32();
            MoveCursor(x, y);
            SendMouse(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP);
            return new() { ["ok"] = true, ["action"] = "click", ["at"] = new[] { x, y } };
        }
        throw RpcError.Invalid("pass either element_id or x,y");
    }

    // ---- type / set value (ValuePattern, focus+type fallback) -----------
    public Dictionary<string, object?> SetValue(JsonElement p)
    {
        string text = P.StringOpt(p, "value") ?? P.StringOpt(p, "text")
            ?? throw RpcError.Invalid("type needs `value` (or `text`)");
        string elementId = P.StringOpt(p, "element_id")
            ?? throw RpcError.Invalid("type needs `element_id` (use type_text for the focused field)");
        int pid = P.Int(p, "pid");
        var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();

        try
        {
            if (IsSecureField(el) && !P.BoolOr(p, "allow_secure_field", false))
                throw RpcError.Denied("secure text field — set allow_secure_field=true to override");

            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var vp))
            {
                var value = (ValuePattern)vp;
                if (value.Current.IsReadOnly)
                    throw RpcError.Unsupported($"value is read-only on element {elementId}");
                value.SetValue(text);
                bool committedVp = false;
                if (P.BoolOr(p, "commit", false)) { el.SetFocus(); SendVirtualKey(VK_RETURN); committedVp = true; }
                return new() { ["ok"] = true, ["committed"] = committedVp };
            }

            // No ValuePattern — focus and type the characters.
            el.SetFocus();
            foreach (char ch in text) SendUnicode(ch);
            bool committed = false;
            if (P.BoolOr(p, "commit", false)) { SendVirtualKey(VK_RETURN); committed = true; }
            return new() { ["ok"] = true, ["committed"] = committed };
        }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }
    }

    // ---- set_focus ------------------------------------------------------
    public Dictionary<string, object?> SetFocus(JsonElement p)
    {
        string elementId = P.StringOpt(p, "element_id") ?? throw RpcError.Invalid("set_focus needs `element_id`");
        int pid = P.Int(p, "pid");
        var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();
        try { el.SetFocus(); return new() { ["ok"] = true }; }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }
        catch (Exception e) { throw new RpcError("action_failed", $"SetFocus failed: {e.Message}"); }
    }

    // ---- get_text -------------------------------------------------------
    public Dictionary<string, object?> GetText(JsonElement p)
    {
        string? elementId = P.StringOpt(p, "element_id");
        if (elementId == null) throw RpcError.Invalid("get_text needs `element_id`");
        int pid = P.Int(p, "pid");
        var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();
        try
        {
            // Prefer rich document text, then ValuePattern, then the Name.
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out var tp))
            {
                var text = ((TextPattern)tp).DocumentRange.GetText(MaxTextChars);
                return new() { ["text"] = text };
            }
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var vp))
                return new() { ["text"] = ((ValuePattern)vp).Current.Value ?? "" };
            return new() { ["text"] = el.Current.Name ?? "" };
        }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }
    }

    // ---- type_text: unicode characters into the focused control ----------
    public Dictionary<string, object?> TypeText(JsonElement p)
    {
        string text = P.StringOpt(p, "text") ?? throw RpcError.Invalid("type_text needs `text`");
        int delayMs = P.IntOr(p, "char_delay_ms", 0);
        foreach (char ch in text)
        {
            SendUnicode(ch);
            if (delayMs > 0) Thread.Sleep(delayMs);
        }
        if (P.BoolOr(p, "commit", false)) SendVirtualKey(VK_RETURN);
        return new() { ["ok"] = true, ["chars"] = text.Length };
    }

    // ---- key: a chord like "enter", "ctrl+a", "alt+f4" -------------------
    public Dictionary<string, object?> SendKey(JsonElement p)
    {
        string keys = P.StringOpt(p, "keys") ?? P.StringOpt(p, "key")
            ?? throw RpcError.Invalid("key needs `keys`");
        var parts = keys.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var mods = new List<ushort>();
        ushort? main = null;
        foreach (var raw in parts)
        {
            var tok = raw.ToLowerInvariant();
            switch (tok)
            {
                case "ctrl" or "control": mods.Add(VK_CONTROL); break;
                case "alt" or "option": mods.Add(VK_MENU); break;
                case "shift": mods.Add(VK_SHIFT); break;
                case "win" or "cmd" or "meta" or "super": mods.Add(VK_LWIN); break;
                default: main = ResolveKey(tok); break;
            }
        }
        if (main is null) throw RpcError.Invalid($"unrecognized key in chord: {keys}");
        foreach (var m in mods) SendKeyEvent(m, false);
        SendKeyEvent(main.Value, false);
        SendKeyEvent(main.Value, true);
        for (int i = mods.Count - 1; i >= 0; i--) SendKeyEvent(mods[i], true);
        return new() { ["ok"] = true };
    }

    // ---- describe/value tuning ------------------------------------------
    private const int MaxElements = 500;
    private const int MaxDepthDefault = 25;
    private const int MaxTextChars = 20_000;
    private const int MaxValueDisplayChars = 400;

    // Roles surfaced to the agent as interactable (UIA ControlType short names).
    private static readonly HashSet<string> InteractableRoles = new()
    {
        "Button", "CheckBox", "RadioButton", "ComboBox", "Edit", "Document",
        "Hyperlink", "MenuItem", "Tab", "TabItem", "ListItem", "TreeItem",
        "Slider", "SplitButton", "Spinner", "List", "Tree", "Table", "DataItem",
        "Menu", "ToolBar", "ScrollBar", "Thumb",
    };

    // Roles that carry content we surface when labeled/valued.
    private static readonly HashSet<string> ContentRoles = new() { "Text", "Image", "Header" };

    // ControlType.ProgrammaticName is "ControlType.Button"; strip the prefix for
    // a clean, locale-independent role string.
    private static string ControlTypeName(ControlType ct)
    {
        var name = ct?.ProgrammaticName ?? "Custom";
        int dot = name.LastIndexOf('.');
        return dot >= 0 ? name[(dot + 1)..] : name;
    }

    private static string? TryReadValue(AutomationElement el)
    {
        try
        {
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var vp))
                return NullIfEmpty(((ValuePattern)vp).Current.Value);
            if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out var rp))
                return ((RangeValuePattern)rp).Current.Value.ToString("0.###");
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
        return null;
    }

    private static bool IsSecureField(AutomationElement el)
    {
        try { return el.Current.IsPassword; }
        catch { return false; }
    }

    private static int[]? RectToBounds(Rect r)
    {
        if (r.IsEmpty) return null;
        if (double.IsInfinity(r.X) || double.IsInfinity(r.Y) ||
            double.IsInfinity(r.Width) || double.IsInfinity(r.Height)) return null;
        if (r.Width <= 0 || r.Height <= 0) return null;
        return new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height };
    }

    private static string TruncateForDisplay(string s)
        => s.Length <= MaxValueDisplayChars ? s : s[..MaxValueDisplayChars] + "...";

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private static List<AutomationElement> TopLevelWindows(int pid)
    {
        var result = new List<AutomationElement>();
        try
        {
            var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
            var found = AutomationElement.RootElement.FindAll(TreeScope.Children, cond);
            foreach (AutomationElement w in found) result.Add(w);
        }
        catch (ElementNotAvailableException) { }
        return result;
    }

    private static string? SafeProcessName(int pid)
    {
        try { using var proc = System.Diagnostics.Process.GetProcessById(pid); return proc.ProcessName; }
        catch { return null; }
    }

    // ---- key name -> virtual-key code -----------------------------------
    private static ushort ResolveKey(string k) => k switch
    {
        "enter" or "return" => VK_RETURN,
        "esc" or "escape" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "backspace" => VK_BACK,
        "delete" or "del" => VK_DELETE,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "home" => VK_HOME,
        "end" => VK_END,
        _ when k.Length == 1 => (ushort)char.ToUpperInvariant(k[0]),
        _ => throw RpcError.Invalid($"unknown key: {k}"),
    };

    // ---- SendInput interop ----------------------------------------------
    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_BACK = 0x08, VK_TAB = 0x09, VK_RETURN = 0x0D, VK_SHIFT = 0x10,
        VK_CONTROL = 0x11, VK_MENU = 0x12, VK_ESCAPE = 0x1B, VK_SPACE = 0x20,
        VK_END = 0x23, VK_HOME = 0x24, VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27,
        VK_DOWN = 0x28, VK_DELETE = 0x2E, VK_LWIN = 0x5B;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int n);

    private static void MoveCursor(int x, int y) => SetCursorPos(x, y);

    private static void SendMouse(uint flags)
    {
        var inp = new INPUT[]
        {
            new() { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags } } },
        };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }

    private static void SendKeyEvent(ushort vk, bool keyUp)
    {
        var inp = new INPUT[]
        {
            new() { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = keyUp ? KEYEVENTF_KEYUP : 0 } } },
        };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }

    private static void SendVirtualKey(ushort vk) { SendKeyEvent(vk, false); SendKeyEvent(vk, true); }

    private static void SendUnicode(char ch)
    {
        var down = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE } } };
        var up = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
        var inp = new[] { down, up };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }
}
