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
            SendUnicodeString(text);
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
                // GetText(maxLength > 0) makes the provider compute an endpoint at
                // start+maxLength; the Windows 11 Notepad UIA provider rejects that as
                // "Start or end specified is past the end of the text range" when the
                // document is shorter than maxLength. GetText(-1) returns the whole
                // range with no endpoint arithmetic; clamp the length in managed code.
                var text = ((TextPattern)tp).DocumentRange.GetText(-1) ?? "";
                if (text.Length > MaxTextChars) text = text.Substring(0, MaxTextChars);
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
        SendUnicodeString(text, delayMs);
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

    // ---- scroll ---------------------------------------------------------
    // element_id -> UIA ScrollItemPattern.ScrollIntoView(); else a synthesized
    // wheel event at (x,y) or the current cursor. Mirrors the macOS scroll
    // (AX.swift:392-441): { ok, method, at? }.
    public Dictionary<string, object?> Scroll(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        string? elementId = P.StringOpt(p, "element_id");
        if (elementId != null)
        {
            var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();
            try
            {
                if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var sip))
                {
                    ((ScrollItemPattern)sip).ScrollIntoView();
                    return new() { ["ok"] = true, ["method"] = "ScrollIntoView" };
                }
            }
            catch (ElementNotAvailableException) { throw RpcError.Stale(); }
            // No ScrollItemPattern — fall through to a wheel event (needs dx/dy).
        }

        int dx = P.IntOr(p, "dx", 0);
        int dy = P.IntOr(p, "dy", 0);
        if (dx == 0 && dy == 0) throw RpcError.Invalid("either element_id or dx/dy required");

        int[]? at = null;
        if (p.TryGetProperty("x", out var xe) && xe.ValueKind == JsonValueKind.Number &&
            p.TryGetProperty("y", out var ye) && ye.ValueKind == JsonValueKind.Number)
        {
            int x = xe.GetInt32(), y = ye.GetInt32();
            MoveCursor(x, y);
            at = new[] { x, y };
        }
        if (dy != 0) SendWheelNotches(MOUSEEVENTF_WHEEL, dy);
        if (dx != 0) SendWheelNotches(MOUSEEVENTF_HWHEEL, dx);

        var result = new Dictionary<string, object?> { ["ok"] = true, ["method"] = "wheel" };
        if (at != null) result["at"] = at;
        return result;
    }

    // ---- drag -----------------------------------------------------------
    // MoveCursor(from) -> LEFTDOWN -> interpolated MOVE steps -> MoveCursor(to)
    // -> LEFTUP. Endpoints come from element_id/to_element_id or from/to=[x,y].
    // Mirrors the macOS drag (Mouse.swift:20-58): { ok, method }.
    public Dictionary<string, object?> Drag(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        var from = ResolvePoint(p, pid, "element_id", "from");
        var to = ResolvePoint(p, pid, "to_element_id", "to");

        MoveCursor(from[0], from[1]);
        SendMouse(MOUSEEVENTF_LEFTDOWN);
        const int steps = 20;
        for (int i = 1; i <= steps; i++)
        {
            int x = from[0] + (to[0] - from[0]) * i / steps;
            int y = from[1] + (to[1] - from[1]) * i / steps;
            MoveCursor(x, y);
            Thread.Sleep(8);
        }
        MoveCursor(to[0], to[1]);
        SendMouse(MOUSEEVENTF_LEFTUP);
        return new() { ["ok"] = true, ["method"] = "drag" };
    }

    // ---- right_click ----------------------------------------------------
    // RIGHTDOWN/RIGHTUP at coords or the resolved element center. Mirrors the
    // macOS right-click (Mouse.swift:63-106): { ok, method, at? }.
    public Dictionary<string, object?> RightClick(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        string? elementId = P.StringOpt(p, "element_id");
        if (elementId == null)
        {
            if (p.TryGetProperty("x", out var xe) && p.TryGetProperty("y", out var ye))
            {
                int x = xe.GetInt32(), y = ye.GetInt32();
                MoveCursor(x, y);
                SendMouse(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP);
                return new() { ["ok"] = true, ["method"] = "right_click", ["at"] = new[] { x, y } };
            }
            throw RpcError.Invalid("pass either element_id or x,y");
        }

        var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();
        try
        {
            var center = CenterOf(el) ?? throw new RpcError("action_failed", "element has no frame");
            MoveCursor(center[0], center[1]);
            SendMouse(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP);
            return new() { ["ok"] = true, ["method"] = "right_click", ["at"] = center };
        }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }
    }

    // ---- focus_window ---------------------------------------------------
    // Resolve a top-level window (optionally by window_id=HWND or title),
    // restore it if minimized (WindowPattern), then SetForegroundWindow.
    // Mirrors the macOS focusWindow (Mouse.swift:120-194):
    //   { ok, was_minimized, focus_elapsed_ms, raised_window, window_id?, title?, method? }.
    public Dictionary<string, object?> FocusWindow(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        var windows = TopLevelWindows(pid);
        if (windows.Count == 0) throw RpcError.AppMissing(pid);

        int? windowId = null;
        if (p.TryGetProperty("window_id", out var wv) && wv.ValueKind == JsonValueKind.Number)
            windowId = wv.GetInt32();
        string? title = P.StringOpt(p, "title");

        var target = windows[0];
        bool raisedWindow = false;
        if (windowId != null || title != null)
        {
            AutomationElement? match = null;
            foreach (var w in windows)
            {
                try
                {
                    if (windowId != null && w.Current.NativeWindowHandle == windowId.Value) { match = w; break; }
                    if (title != null && (w.Current.Name ?? "").Contains(title, StringComparison.OrdinalIgnoreCase)) { match = w; break; }
                }
                catch (ElementNotAvailableException) { }
            }
            target = match ?? throw RpcError.NotFound(
                $"no window matching window_id={windowId?.ToString() ?? "-"} title={title ?? "-"} for pid {pid}");
            raisedWindow = true;
        }

        bool wasMinimized = false;
        try
        {
            if (target.TryGetCurrentPattern(WindowPattern.Pattern, out var wp))
            {
                var win = (WindowPattern)wp;
                if (win.Current.WindowVisualState == WindowVisualState.Minimized)
                {
                    wasMinimized = true;
                    win.SetWindowVisualState(WindowVisualState.Normal);
                }
            }
        }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }

        var hwnd = new IntPtr(target.Current.NativeWindowHandle);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        SetForegroundWindow(hwnd);
        // Poll until the window server actually promotes it (SetForegroundWindow
        // is asynchronous and rate-limited). Cap at 600ms like the macOS poll.
        while (sw.ElapsedMilliseconds < 600)
        {
            if (GetForegroundWindow() == hwnd) break;
            Thread.Sleep(20);
        }
        sw.Stop();

        // Match the macOS error contract (Mouse.swift:194): Win32 foreground-lock
        // can silently deny SetForegroundWindow, leaving a different window
        // frontmost. Surface that instead of a false ok so a caller that
        // screenshots/describes next doesn't act on the wrong window.
        if (GetForegroundWindow() != hwnd)
            throw new RpcError("focus_timeout",
                $"app pid={pid} did not become frontmost within 600ms");

        var result = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["was_minimized"] = wasMinimized,
            ["focus_elapsed_ms"] = (int)sw.ElapsedMilliseconds,
            ["raised_window"] = raisedWindow,
        };
        if (raisedWindow)
        {
            result["window_id"] = target.Current.NativeWindowHandle;
            var t = NullIfEmpty(target.Current.Name);
            if (t != null) result["title"] = t;
            result["method"] = "set_foreground";
        }
        return result;
    }

    // ---- ax_action ------------------------------------------------------
    // Map an action name to the UIA pattern the element advertises and invoke
    // it. Mirrors the macOS axAction (AX.swift:237-256): { ok, action }; on an
    // unknown action, throws action_unsupported with the available list.
    public Dictionary<string, object?> AxAction(JsonElement p)
    {
        int pid = P.Int(p, "pid");
        string elementId = P.StringOpt(p, "element_id") ?? throw RpcError.Invalid("ax_action needs `element_id`");
        string action = P.StringOpt(p, "action") ?? throw RpcError.Invalid("ax_action needs `action`");
        var el = _cache.Get(pid, elementId) ?? throw RpcError.Stale();

        try
        {
            switch (action)
            {
                case "Invoke":
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out var iv))
                    { ((InvokePattern)iv).Invoke(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
                case "Toggle":
                    if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var tg))
                    { ((TogglePattern)tg).Toggle(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
                case "Expand":
                    if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ex))
                    { ((ExpandCollapsePattern)ex).Expand(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
                case "Collapse":
                    if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var co))
                    { ((ExpandCollapsePattern)co).Collapse(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
                case "Select":
                    if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var se))
                    { ((SelectionItemPattern)se).Select(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
                case "ScrollIntoView":
                    if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var sc))
                    { ((ScrollItemPattern)sc).ScrollIntoView(); return new() { ["ok"] = true, ["action"] = action }; }
                    break;
            }
            var available = AvailableActions(el);
            throw RpcError.Unsupported(
                $"element does not support {action}; available: {string.Join(", ", available)}");
        }
        catch (ElementNotAvailableException) { throw RpcError.Stale(); }
    }

    // Enumerate the action verbs an element's supported patterns expose, for the
    // ax_action error path (matches the Swift "available: ..." list).
    private static List<string> AvailableActions(AutomationElement el)
    {
        var available = new List<string>();
        var supported = new HashSet<AutomationPattern>(el.GetSupportedPatterns());
        if (supported.Contains(InvokePattern.Pattern)) available.Add("Invoke");
        if (supported.Contains(TogglePattern.Pattern)) available.Add("Toggle");
        if (supported.Contains(ExpandCollapsePattern.Pattern)) { available.Add("Expand"); available.Add("Collapse"); }
        if (supported.Contains(SelectionItemPattern.Pattern)) available.Add("Select");
        if (supported.Contains(ScrollItemPattern.Pattern)) available.Add("ScrollIntoView");
        return available;
    }

    // ---- wait -----------------------------------------------------------
    // Three modes, mirroring the macOS Wait.run (Wait.swift:22-84):
    //   1. duration_ms  -> unconditional sleep (clamped [50, 30000]).
    //   2. element_id   -> poll the cached handle for until=exists|enabled|disappears.
    //   3. locator      -> re-walk the live UIA tree each tick for until=exists|enabled.
    // Returns { ok, waited_ms, satisfied, element_id? }.
    public Dictionary<string, object?> Wait(JsonElement p)
    {
        if (p.TryGetProperty("duration_ms", out var dv) && dv.ValueKind == JsonValueKind.Number)
        {
            int duration = Math.Clamp(dv.GetInt32(), WaitMinMs, WaitMaxMs);
            Thread.Sleep(duration);
            return new() { ["ok"] = true, ["waited_ms"] = duration, ["satisfied"] = true };
        }

        int pid = P.Int(p, "pid");
        string until = P.StringOpt(p, "until") ?? "exists";
        if (until is not ("exists" or "enabled" or "disappears"))
            throw RpcError.Invalid("until must be 'exists', 'enabled', or 'disappears'");

        string? elementId = P.StringOpt(p, "element_id");
        bool hasLocator = p.TryGetProperty("locator", out var locator) && locator.ValueKind == JsonValueKind.Object;
        if (elementId == null && !hasLocator)
            throw RpcError.Invalid("pass either duration_ms, or pid + (element_id or locator) + until");
        if (hasLocator && until == "disappears")
            throw RpcError.Invalid("locator mode supports until='exists' or 'enabled' only");

        string? role = null, label = null, identifier = null;
        if (hasLocator)
        {
            role = P.StringOpt(locator, "role");
            label = P.StringOpt(locator, "label");
            identifier = P.StringOpt(locator, "identifier");
            if (role == null && label == null && identifier == null)
                throw RpcError.Invalid("locator needs role, label, or identifier");
        }

        int timeoutMs = P.IntOr(p, "timeout_ms", WaitDefaultTimeoutMs);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        bool satisfied = false;
        string? foundId = null;

        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (hasLocator)
            {
                foreach (var w in TopLevelWindows(pid))
                {
                    var found = SearchLocator(w, 0, role, label, identifier, until);
                    if (found != null)
                    {
                        foundId = _cache.NextRefId(pid);
                        _cache.Put(pid, foundId, found);
                        satisfied = true;
                        break;
                    }
                }
                if (satisfied) break;
            }
            else if (ElementSatisfies(pid, elementId!, until))
            {
                satisfied = true;
                break;
            }
            Thread.Sleep(WaitPollMs);
        }
        sw.Stop();

        var result = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["waited_ms"] = (int)sw.ElapsedMilliseconds,
            ["satisfied"] = satisfied,
        };
        if (foundId != null) result["element_id"] = foundId;
        return result;
    }

    // Probe a cached element handle against the until condition.
    private bool ElementSatisfies(int pid, string elementId, string until)
    {
        var el = _cache.Get(pid, elementId);
        switch (until)
        {
            case "disappears":
                if (el == null) return true;
                try { _ = el.Current.ControlType; return false; }
                catch (ElementNotAvailableException) { return true; }
            case "exists":
                if (el == null) return false;
                try { _ = el.Current.ControlType; return true; }
                catch (ElementNotAvailableException) { return false; }
            case "enabled":
                if (el == null) return false;
                try { return el.Current.IsEnabled; }
                catch (ElementNotAvailableException) { return false; }
            default:
                return false;
        }
    }

    // Depth-bounded walk of the live UIA tree matching a locator (role = UIA
    // ControlType short name, label = Name, identifier = AutomationId). For
    // until="enabled", a matched-but-disabled element keeps the search going.
    private AutomationElement? SearchLocator(
        AutomationElement el, int depth, string? role, string? label, string? identifier, string until)
    {
        if (depth > WaitLocatorMaxDepth) return null;

        if (LocatorMatches(el, role, label, identifier))
        {
            if (until != "enabled") return el;
            bool enabled;
            try { enabled = el.Current.IsEnabled; }
            catch (ElementNotAvailableException) { enabled = false; }
            if (enabled) return el;
            // matched but not yet enabled — fall through and keep searching
        }

        try
        {
            var walker = TreeWalker.ControlViewWalker;
            for (var child = walker.GetFirstChild(el); child != null; child = walker.GetNextSibling(child))
            {
                var found = SearchLocator(child, depth + 1, role, label, identifier, until);
                if (found != null) return found;
            }
        }
        catch (ElementNotAvailableException) { }
        return null;
    }

    private static bool LocatorMatches(AutomationElement el, string? role, string? label, string? identifier)
    {
        try
        {
            var info = el.Current;
            if (role != null && ControlTypeName(info.ControlType) != role) return false;
            if (identifier != null && (info.AutomationId ?? "") != identifier) return false;
            if (label != null && (info.Name ?? "") != label) return false;
            return true;
        }
        catch (ElementNotAvailableException) { return false; }
    }

    // ---- notify ---------------------------------------------------------
    // PASS-THROUGH ONLY. No Windows Toast/notification API — the Rush
    // computer-manager intercepts the return value. Mirrors Notify.swift:13-26.
    public Dictionary<string, object?> Notify(JsonElement p)
    {
        string message = P.StringOpt(p, "message") ?? throw RpcError.Invalid("notify needs `message`");
        int pid = P.IntOr(p, "pid", 0);
        var result = new Dictionary<string, object?> { ["notified"] = true, ["message"] = message };
        if (pid > 0) result["pid"] = pid;
        return result;
    }

    // ---- describe/value tuning ------------------------------------------
    private const int MaxElements = 500;
    private const int MaxDepthDefault = 25;
    private const int MaxTextChars = 20_000;
    private const int MaxValueDisplayChars = 400;

    // ---- wait tuning ----------------------------------------------------
    private const int WaitMinMs = 50;
    private const int WaitMaxMs = 30_000;
    private const int WaitDefaultTimeoutMs = 5_000;
    private const int WaitPollMs = 100;
    private const int WaitLocatorMaxDepth = 40;

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
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    private const int WheelDelta = 120; // one wheel notch (WHEEL_DELTA)
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
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    private static void MoveCursor(int x, int y) => SetCursorPos(x, y);

    private static void SendMouse(uint flags)
    {
        var inp = new INPUT[]
        {
            new() { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags } } },
        };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }

    // A wheel event (vertical MOUSEEVENTF_WHEEL or horizontal MOUSEEVENTF_HWHEEL)
    // carries its rotation amount in mouseData: +/-WheelDelta per notch.
    private static void SendMouseWheel(uint flags, int mouseData)
    {
        var inp = new INPUT[]
        {
            new() { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = unchecked((uint)mouseData) } } },
        };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }

    // Convert a (pixel-ish) delta to whole wheel notches — rounding away from
    // zero so a small delta still moves one notch — and emit one WHEEL event per
    // notch at +/-WheelDelta, matching the macOS scroll cadence.
    private static void SendWheelNotches(uint flags, int delta)
    {
        int notches = delta / WheelDelta;
        if (notches == 0) notches = delta > 0 ? 1 : -1;
        int step = notches > 0 ? WheelDelta : -WheelDelta;
        for (int i = 0; i < Math.Abs(notches); i++) SendMouseWheel(flags, step);
    }

    // On-screen center of an element from its bounding rectangle, or null when
    // it has no usable frame. Mirrors the id-addressable click center math.
    private static int[]? CenterOf(AutomationElement el)
    {
        var b = RectToBounds(el.Current.BoundingRectangle);
        if (b == null) return null;
        return new[] { b[0] + b[2] / 2, b[1] + b[3] / 2 };
    }

    // Resolve a drag endpoint: an element id's center, or a [x, y] JSON pair.
    private int[] ResolvePoint(JsonElement p, int pid, string elemKey, string coordKey)
    {
        string? eid = P.StringOpt(p, elemKey);
        if (eid != null)
        {
            var el = _cache.Get(pid, eid) ?? throw RpcError.Stale();
            return CenterOf(el) ?? throw new RpcError("action_failed", $"{elemKey} element has no frame");
        }
        if (p.TryGetProperty(coordKey, out var arr) && arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() == 2)
            return new[] { (int)arr[0].GetDouble(), (int)arr[1].GetDouble() };
        throw RpcError.Invalid($"pass either {elemKey} or {coordKey}=[x, y]");
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

    private static INPUT UnicodeDown(char ch) =>
        new() { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE } } };
    private static INPUT UnicodeUp(char ch) =>
        new() { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };

    private static void SendUnicode(char ch)
    {
        var inp = new[] { UnicodeDown(ch), UnicodeUp(ch) };
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }

    // Type an arbitrary string as KEYEVENTF_UNICODE key events. Every character
    // is delivered by its own down/up pair carrying the literal UTF-16 code unit
    // in wScan (with wVk = 0), so SendKeys metacharacters (+ ^ % ~ ( ) { }) and
    // spaces land byte-for-byte — there is no SendKeys operator layer to escape.
    //
    // Fidelity depends on a SINGLE SendInput call for the whole string: it
    // enqueues all events atomically and in order. The previous one-SendInput-
    // per-char loop injected with no inter-key settle, which races the target's
    // input-processing thread and can collapse the tail of the string onto the
    // last character — issue #554: "reliability probe 12345" landed as
    // "reliability 55555555555" (same length, tail stuck on the final '5').
    //
    // When char_delay_ms > 0 the caller explicitly wants pacing (slow inputs for
    // laggy fields), so fall back to per-char calls with a real sleep between
    // them — the sleep provides the settle the batched path gets for free.
    private static void SendUnicodeString(string text, int delayMs = 0)
    {
        if (text.Length == 0) return;
        if (delayMs > 0)
        {
            foreach (char ch in text) { SendUnicode(ch); Thread.Sleep(delayMs); }
            return;
        }
        var inp = new INPUT[text.Length * 2];
        int i = 0;
        foreach (char ch in text)
        {
            inp[i++] = UnicodeDown(ch);
            inp[i++] = UnicodeUp(ch);
        }
        SendInput((uint)inp.Length, inp, Marshal.SizeOf<INPUT>());
    }
}
