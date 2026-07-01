using System.Text.Json;

namespace ComputerHelperWin;

/// <summary>
/// An RPC error carrying a stable string code, mirroring the macOS helper's
/// RPCError (RPC.swift). The code vocabulary is part of the wire contract the
/// TS client (src/lib/computer-rpc.ts) and CLI rely on.
/// </summary>
public sealed class RpcError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public static RpcError NotFound(string what) => new("element_not_found", what);
    public static RpcError Stale() => new("element_stale", "element handle expired, re-describe");
    public static RpcError Unsupported(string action) => new("action_unsupported", action);
    public static RpcError Denied(string reason) => new("permission_denied", reason);
    public static RpcError AppMissing(int pid) => new("app_not_found", $"pid {pid}");
    public static RpcError Invalid(string msg) => new("invalid_params", msg);
    public static RpcError MethodNotFound(string method) => new("method_not_found", method);
}

/// <summary>
/// Routes a JSON-RPC method + params to its handler. Method names, param keys,
/// and result shapes are kept identical to the macOS dispatcher
/// (packages/computer-helper/Sources/ComputerHelper/RPC.swift:76-127) so a
/// single TS client drives both platforms.
/// </summary>
public sealed class Dispatcher
{
    private readonly Automation _automation = new();

    public Dictionary<string, object?> Dispatch(string method, JsonElement @params)
    {
        return method switch
        {
            "ping" => new() { ["pong"] = true },
            "trust_status" => TrustStatus(),
            "list_apps" => Apps.ListApps(),
            "launch_app" => Apps.LaunchApp(@params),
            "screenshot" => Screenshot.Capture(@params),
            "describe" => _automation.Describe(@params),
            "click" => _automation.Click(@params),
            "type" => _automation.SetValue(@params),
            "type_text" => _automation.TypeText(@params),
            "key" => _automation.SendKey(@params),
            "set_focus" => _automation.SetFocus(@params),
            "get_text" => _automation.GetText(@params),
            "scroll" => _automation.Scroll(@params),
            "drag" => _automation.Drag(@params),
            "right_click" => _automation.RightClick(@params),
            "focus_window" => _automation.FocusWindow(@params),
            "ax_action" => _automation.AxAction(@params),
            "wait" => _automation.Wait(@params),
            "notify" => _automation.Notify(@params),
            _ => throw RpcError.MethodNotFound(method),
        };
    }

    private static Dictionary<string, object?> TrustStatus()
    {
        // Windows UIAutomation needs no per-process trust grant (unlike macOS
        // Accessibility/TCC), so we are always "trusted". Report pid/path for
        // the same diagnostic shape the CLI prints.
        using var proc = System.Diagnostics.Process.GetCurrentProcess();
        return new()
        {
            ["trusted"] = true,
            ["pid"] = proc.Id,
            ["path"] = Environment.ProcessPath ?? "",
        };
    }
}

/// <summary>Helpers for reading untyped JSON-RPC params (mirrors Params in main.swift).</summary>
public static class P
{
    public static int Int(JsonElement p, string key)
    {
        if (!p.TryGetProperty(key, out var v)) throw RpcError.Invalid($"missing int param: {key}");
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetInt32(),
            JsonValueKind.String when int.TryParse(v.GetString(), out var n) => n,
            _ => throw RpcError.Invalid($"param {key} is not an int"),
        };
    }

    public static int IntOr(JsonElement p, string key, int fallback)
        => p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

    public static string? StringOpt(JsonElement p, string key)
        => p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static bool BoolOr(JsonElement p, string key, bool fallback)
        => p.TryGetProperty(key, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
            ? v.GetBoolean() : fallback;
}
