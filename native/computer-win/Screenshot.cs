using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text.Json;
using System.Windows.Forms;

namespace ComputerHelperWin;

/// <summary>
/// Screen capture. Returns the same keys the CLI consumes from the macOS
/// helper (src/commands/computer.ts:169-190): image_data (base64 PNG), width,
/// height, origin [x,y], scale. We capture the whole virtual desktop; per-pid
/// window capture is a future refinement (the macOS backend scopes by pid).
/// </summary>
public static class Screenshot
{
    public static Dictionary<string, object?> Capture(JsonElement @params)
    {
        // The virtual screen spans all monitors and can have a negative origin
        // (a monitor left of / above the primary). origin lets the caller map
        // screenshot pixels back to global coords: global = origin + pixel/scale.
        Rectangle b = SystemInformation.VirtualScreen;
        if (b.Width <= 0 || b.Height <= 0)
            throw new RpcError("action_failed", "virtual screen has zero area");

        using var bmp = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(b.Left, b.Top, 0, 0, bmp.Size, CopyPixelOperation.SourceCopy);
        }

        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        string b64 = Convert.ToBase64String(ms.ToArray());

        return new()
        {
            ["image_data"] = b64,
            ["width"] = b.Width,
            ["height"] = b.Height,
            ["origin"] = new[] { b.Left, b.Top },
            ["scale"] = 1.0,
        };
    }
}
