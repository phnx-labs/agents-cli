namespace ComputerHelperWin;

/// <summary>
/// Pure launch-target safety checks for <c>launch_app</c> (RUSH-1763).
/// Rejects UNC/remote shares and protocol/URL schemes before anything is
/// handed to <see cref="System.Diagnostics.ProcessStartInfo"/> / ShellExecute.
/// No Windows APIs — unit-testable on any host.
/// </summary>
public static class LaunchTarget
{
    /// <summary>
    /// Returns null when <paramref name="target"/> is safe to consider for
    /// launch; otherwise a stable human-readable rejection reason.
    /// </summary>
    public static string? RejectReason(string? target)
    {
        if (string.IsNullOrWhiteSpace(target))
            return "launch target is empty";

        string t = target.Trim();

        if (IsUncOrRemote(t))
            return "launch path must be a local path — UNC/remote paths are not allowed";

        if (IsProtocolOrUrl(t))
            return "launch path must be a local path — protocol/URL targets are not allowed";

        if (HasParentTraversalSegment(t))
            return "launch path must not contain '..' segments";

        return null;
    }

    /// <summary>
    /// True for absolute local Windows paths of the form <c>X:\...</c> or
    /// <c>X:/...</c>. UNC, schemes, and bare names return false.
    /// </summary>
    public static bool IsLocalRootedPath(string? target)
    {
        if (string.IsNullOrWhiteSpace(target)) return false;
        string t = target.Trim();
        if (IsUncOrRemote(t) || IsProtocolOrUrl(t)) return false;
        if (t.Length < 3) return false;
        if (!char.IsAsciiLetter(t[0])) return false;
        if (t[1] != ':') return false;
        return t[2] is '\\' or '/';
    }

    /// <summary>
    /// UNC / remote share forms: <c>\\server\share</c>, <c>//server/share</c>,
    /// <c>\\?\UNC\...</c>, and device namespaces <c>\\.\...</c>.
    /// </summary>
    public static bool IsUncOrRemote(string t)
    {
        if (t.Length < 2) return false;

        // Extended UNC: \\?\UNC\server\share
        if (t.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return true;
        if (t.StartsWith(@"//?/UNC/", StringComparison.OrdinalIgnoreCase)) return true;

        // Device namespace / local device path used as a remote-style prefix: \\.\PIPE\...
        if (t.StartsWith(@"\\.\", StringComparison.Ordinal) || t.StartsWith(@"//./", StringComparison.Ordinal))
            return true;

        // Standard UNC: \\server\... or //server/...
        // (\\?\C:\... long-path local form is NOT UNC — handled below.)
        if (t.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            // \\?\C:\Windows\... is a local long path — not remote.
            // Anything else under \\?\ that isn't a drive is treated as remote/device.
            string rest = t.Substring(4);
            return !(rest.Length >= 2 && char.IsAsciiLetter(rest[0]) && rest[1] == ':');
        }

        if (t.StartsWith(@"\\", StringComparison.Ordinal) || t.StartsWith("//", StringComparison.Ordinal))
            return true;

        return false;
    }

    /// <summary>
    /// Protocol / URL targets ShellExecute would hand to a registered handler
    /// (<c>http:</c>, <c>https:</c>, <c>file:</c>, <c>ms-settings:</c>, …).
    /// Drive-letter paths (<c>C:\...</c>) are not schemes.
    /// </summary>
    public static bool IsProtocolOrUrl(string t)
    {
        int colon = t.IndexOf(':');
        if (colon <= 0) return false;

        // Drive letter: single ASCII letter + ':' + separator (or end).
        if (colon == 1 && char.IsAsciiLetter(t[0]))
            return false;

        // Any other "scheme:" form is a protocol/URL target.
        // Require the scheme to look like a URI scheme (letters + digits + +.-).
        for (int i = 0; i < colon; i++)
        {
            char c = t[i];
            if (char.IsAsciiLetterOrDigit(c) || c is '+' or '-' or '.') continue;
            return false;
        }
        return true;
    }

    static bool HasParentTraversalSegment(string t)
    {
        // Strip a leading \\?\ long-path prefix so segments parse cleanly.
        string s = t;
        if (s.StartsWith(@"\\?\", StringComparison.Ordinal))
            s = s.Substring(4);

        foreach (string seg in s.Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (seg == "..") return true;
        }
        return false;
    }
}
