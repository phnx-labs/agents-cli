using System.Runtime.InteropServices;
using System.Text.Json;

namespace ComputerHelperWin;

/// <summary>
/// Input + UIAutomation backend. This first slice implements the
/// coordinate/input verbs (click x/y, type_text, key) via SendInput, which are
/// directly visually verifiable. The UIAutomation tree verbs (describe →
/// id-addressable click/get_text/set_focus/set value) are the next increment
/// and currently report action_unsupported so the contract stays explicit.
/// </summary>
public sealed class Automation
{
    // ---- click ----------------------------------------------------------
    public Dictionary<string, object?> Click(JsonElement p)
    {
        if (p.TryGetProperty("x", out var xe) && p.TryGetProperty("y", out var ye))
        {
            int x = xe.GetInt32(), y = ye.GetInt32();
            MoveCursor(x, y);
            SendMouse(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP);
            return new() { ["ok"] = true, ["x"] = x, ["y"] = y };
        }
        // id-based click needs the describe() element cache — not built yet.
        throw RpcError.Unsupported("click by element id (use --x/--y for now; describe-cache is the next increment)");
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

    // ---- not-yet-implemented (UIAutomation tree) ------------------------
    public Dictionary<string, object?> Describe(JsonElement p)
        => throw RpcError.Unsupported("describe (UIAutomation tree walk) is the next increment");
    public Dictionary<string, object?> SetValue(JsonElement p)
        => throw RpcError.Unsupported("type (set value via ValuePattern) is the next increment");
    public Dictionary<string, object?> SetFocus(JsonElement p)
        => throw RpcError.Unsupported("set_focus is the next increment");
    public Dictionary<string, object?> GetText(JsonElement p)
        => throw RpcError.Unsupported("get_text is the next increment");

    // ---- key name → virtual-key code ------------------------------------
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
