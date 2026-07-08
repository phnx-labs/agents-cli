using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace ComputerHelperWin;

/// <summary>
/// App enumeration + launch. Windows has no bundle ids, so we use the process
/// image name as the `bundle_id` analog. Result shapes mirror Apps.swift:
/// list_apps → {apps:[{pid,name,bundle_id,active,hidden,excluded}]},
/// launch_app → {pid,name,bundle_id}.
/// </summary>
public static class Apps
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    public static Dictionary<string, object?> ListApps()
    {
        IntPtr fg = GetForegroundWindow();
        var apps = new List<Dictionary<string, object?>>();

        foreach (var p in Process.GetProcesses())
        {
            try
            {
                IntPtr hwnd = p.MainWindowHandle;
                if (hwnd == IntPtr.Zero) continue; // only windowed apps, like the macOS list
                string title = p.MainWindowTitle;
                apps.Add(new()
                {
                    ["pid"] = p.Id,
                    ["name"] = string.IsNullOrEmpty(title) ? p.ProcessName : title,
                    ["bundle_id"] = p.ProcessName, // no bundle ids on Windows
                    ["active"] = hwnd == fg,
                    ["hidden"] = !IsWindowVisible(hwnd),
                    ["excluded"] = false,
                });
            }
            catch
            {
                // Process exited or access denied mid-enumeration — skip it.
            }
            finally
            {
                p.Dispose();
            }
        }

        return new() { ["apps"] = apps };
    }

    public static Dictionary<string, object?> LaunchApp(JsonElement @params)
    {
        string? bundleId = P.StringOpt(@params, "bundle_id");
        string? path = P.StringOpt(@params, "path");
        string? name = P.StringOpt(@params, "name");

        // The launch target: an explicit path, else the name/bundle_id which
        // ShellExecute resolves via PATH + the App Paths registry (so "msedge"
        // / "notepad" work without a full path).
        string target = path ?? name ?? bundleId
            ?? throw RpcError.Invalid("pass one of: bundle_id, path, name");

        if ((name ?? "").Contains("..") || (name ?? "").Contains('/'))
            throw RpcError.Invalid("name must not contain '/' or '..' — use path instead");

        try
        {
            var psi = new ProcessStartInfo(target) { UseShellExecute = true };
            var proc = Process.Start(psi)
                ?? throw new RpcError("action_failed", $"failed to launch: {target}");
            // ShellExecute may return a launcher that hands off to an existing
            // instance; pid/name are best-effort in that case.
            return new()
            {
                ["pid"] = proc.HasExited ? 0 : proc.Id,
                ["name"] = target,
                ["bundle_id"] = System.IO.Path.GetFileNameWithoutExtension(target),
            };
        }
        catch (RpcError) { throw; }
        catch (Exception e)
        {
            throw new RpcError("action_failed", $"launch failed for {target}: {e.Message}");
        }
    }
}
