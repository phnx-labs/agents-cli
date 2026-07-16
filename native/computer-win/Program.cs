using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ComputerHelperWin;

// computer-helper-win — Windows computer-use daemon.
//
// Speaks newline-delimited JSON-RPC identical to the macOS Swift helper
// (packages/computer-helper). Listens on a loopback TCP port; the agents CLI
// reaches it over an `ssh -L` tunnel (so auth piggybacks on SSH keys). A
// shared-secret token in the first frame is defense-in-depth on top of that.
//
// Usage: computer-helper-win --port <n> [--token-file <path>]
//
// Lifecycle is NOT self-managed: the CLI installs this as a scheduled task at
// logon (so Task Scheduler owns it — it survives ssh disconnects and runs in
// the interactive session for real-desktop UIAutomation/screenshot access).

int port = 8765;
string? tokenFile = null;
for (int i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--port") port = int.Parse(args[i + 1]);
    else if (args[i] == "--token-file") tokenFile = args[i + 1];
}

string? expectedToken = null;
if (tokenFile != null && File.Exists(tokenFile))
    expectedToken = File.ReadAllText(tokenFile).Trim();

// Authentication is mandatory. Loopback TCP on Windows is NOT user/session
// scoped, so a token-less daemon hands full screen capture + input injection +
// program launch to ANY local process. Refuse to start unless a shared-secret
// token file was provided; the CLI (`agents computer setup --host`) provisions
// one and passes --token-file.
if (string.IsNullOrEmpty(expectedToken))
{
    Console.Error.WriteLine("computer-helper-win: refusing to start — a --token-file with a non-empty token is required (authentication is mandatory).");
    return 2;
}

var dispatcher = new Dispatcher();

// Bind loopback only — never expose the daemon to the network. The SSH tunnel
// is the sole ingress.
var listener = new TcpListener(IPAddress.Loopback, port);
listener.Start();
Console.Error.WriteLine($"computer-helper-win listening on 127.0.0.1:{port} (auth=token)");

while (true)
{
    var client = await listener.AcceptTcpClientAsync();
    _ = Task.Run(() => HandleConnection(client));
}

async Task HandleConnection(TcpClient client)
{
    using (client)
    using (var stream = client.GetStream())
    {
        var buffer = new List<byte>();
        var chunk = new byte[8192];
        bool authed = false; // token is mandatory (enforced at startup); require the auth frame

        while (true)
        {
            int n;
            try { n = await stream.ReadAsync(chunk); }
            catch { break; }
            if (n == 0) break;
            buffer.AddRange(chunk[..n]);

            int nl;
            while ((nl = buffer.IndexOf((byte)'\n')) >= 0)
            {
                var lineBytes = buffer.GetRange(0, nl).ToArray();
                buffer.RemoveRange(0, nl + 1);
                if (lineBytes.Length == 0) continue;

                var reply = HandleLine(lineBytes, ref authed);
                if (reply == null) { return; } // auth failure → drop the connection
                await stream.WriteAsync(reply);
            }
        }
    }
}

byte[]? HandleLine(byte[] lineBytes, ref bool authed)
{
    JsonElement root;
    try { root = JsonDocument.Parse(lineBytes).RootElement; }
    catch { return Encode(JsonNull(), Err("invalid_params", "malformed json line")); }

    JsonElement idEl = root.TryGetProperty("id", out var idv) ? idv.Clone() : default;
    string method = root.TryGetProperty("method", out var mEl) && mEl.ValueKind == JsonValueKind.String
        ? mEl.GetString()! : "";
    JsonElement @params = root.TryGetProperty("params", out var pEl) ? pEl : default;

    if (method.Length == 0)
        return Encode(idEl, Err("invalid_params", "missing method"));

    // Auth gate: until authed, only the `auth` method is accepted.
    if (!authed)
    {
        if (method != "auth")
            return null; // silently drop unauthenticated callers
        string? tok = @params.ValueKind == JsonValueKind.Object ? P.StringOpt(@params, "token") : null;
        if (tok != null && CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(tok), Encoding.UTF8.GetBytes(expectedToken)))
        {
            authed = true;
            return Encode(idEl, new Dictionary<string, object?> { ["ok"] = true });
        }
        return null; // bad token → drop
    }

    if (method == "auth")
        return Encode(idEl, new Dictionary<string, object?> { ["ok"] = true });

    try
    {
        var result = dispatcher.Dispatch(method, @params);
        return Encode(idEl, result);
    }
    catch (RpcError e)
    {
        return Encode(idEl, Err(e.Code, e.Message));
    }
    catch (Exception e)
    {
        return Encode(idEl, Err("internal", e.Message));
    }
}

// ---- response framing: {"id":..,"result":{..}} | {"id":..,"error":{..}} ----
static Dictionary<string, object?> Err(string code, string message)
    => new() { ["__error"] = new Dictionary<string, object?> { ["code"] = code, ["message"] = message } };

static JsonElement JsonNull() => JsonDocument.Parse("null").RootElement;

static byte[] Encode(JsonElement id, Dictionary<string, object?> payload)
{
    var obj = new Dictionary<string, object?>();
    obj["id"] = id.ValueKind == JsonValueKind.Undefined ? null : JsonValue(id);
    if (payload.TryGetValue("__error", out var errObj))
        obj["error"] = errObj;
    else
        obj["result"] = payload;

    string json = JsonSerializer.Serialize(obj);
    return Encoding.UTF8.GetBytes(json + "\n");
}

// Convert an echoed id JsonElement to a serializable primitive.
static object? JsonValue(JsonElement e) => e.ValueKind switch
{
    JsonValueKind.Number => e.TryGetInt64(out var l) ? l : e.GetDouble(),
    JsonValueKind.String => e.GetString(),
    JsonValueKind.True => true,
    JsonValueKind.False => false,
    _ => null,
};
