using Xunit;

namespace ComputerHelperWin.Tests;

/// <summary>
/// 1:1 tests for <see cref="LaunchTarget"/> (RUSH-1763). Pure string checks —
/// no process launch, no mocking. These fail if UNC/protocol rejection is removed.
/// </summary>
public class LaunchTargetTests
{
    [Theory]
    [InlineData(@"\\evil\share\payload.exe")]
    [InlineData("//evil/share/payload.exe")]
    [InlineData(@"\\?\UNC\evil\share\payload.exe")]
    [InlineData(@"//?/UNC/evil/share/payload.exe")]
    [InlineData(@"\\.\PIPE\malicious")]
    [InlineData(@"//./PIPE/malicious")]
    public void RejectReason_rejects_unc_and_remote(string target)
    {
        string? reason = LaunchTarget.RejectReason(target);
        Assert.NotNull(reason);
        Assert.Contains("UNC/remote", reason, StringComparison.Ordinal);
        Assert.False(LaunchTarget.IsLocalRootedPath(target));
    }

    [Theory]
    [InlineData("http://evil.example/payload.exe")]
    [InlineData("https://evil.example/payload.exe")]
    [InlineData("file:///C:/Windows/System32/cmd.exe")]
    [InlineData("file://server/share/payload.exe")]
    [InlineData("ms-settings:privacy")]
    [InlineData("shell:AppsFolder\\Something")]
    [InlineData("javascript:alert(1)")]
    [InlineData("ftp://evil.example/payload.exe")]
    public void RejectReason_rejects_protocol_and_url(string target)
    {
        string? reason = LaunchTarget.RejectReason(target);
        Assert.NotNull(reason);
        Assert.Contains("protocol/URL", reason, StringComparison.Ordinal);
        Assert.False(LaunchTarget.IsLocalRootedPath(target));
    }

    [Theory]
    [InlineData(@"C:\Windows\System32\..\..\Users\Public\evil.exe")]
    [InlineData(@"C:/Windows/System32/../../Users/Public/evil.exe")]
    [InlineData(@"C:\foo\..\bar\..\baz.exe")]
    public void RejectReason_rejects_parent_traversal(string target)
    {
        string? reason = LaunchTarget.RejectReason(target);
        Assert.NotNull(reason);
        Assert.Contains("..", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(@"C:\Windows\System32\notepad.exe")]
    [InlineData(@"C:/Windows/System32/notepad.exe")]
    [InlineData(@"c:\Program Files\App\app.exe")]
    [InlineData(@"D:\Tools\myapp.exe")]
    [InlineData(@"\\?\C:\Windows\System32\notepad.exe")]
    public void RejectReason_allows_local_drive_paths(string target)
    {
        Assert.Null(LaunchTarget.RejectReason(target));
    }

    [Theory]
    [InlineData(@"C:\Windows\System32\notepad.exe")]
    [InlineData(@"C:/Windows/System32/notepad.exe")]
    [InlineData(@"d:\app\bin\tool.exe")]
    public void IsLocalRootedPath_true_for_drive_paths(string target)
    {
        Assert.True(LaunchTarget.IsLocalRootedPath(target));
    }

    [Theory]
    [InlineData("notepad")]
    [InlineData("msedge")]
    [InlineData("notepad.exe")]
    [InlineData(@"\\evil\share\x.exe")]
    [InlineData("http://evil.example/x")]
    [InlineData(@"\Windows\System32\notepad.exe")]
    [InlineData("")]
    [InlineData(null)]
    public void IsLocalRootedPath_false_for_non_drive_targets(string? target)
    {
        Assert.False(LaunchTarget.IsLocalRootedPath(target));
    }

    [Theory]
    [InlineData("notepad")]
    [InlineData("msedge")]
    [InlineData("notepad.exe")]
    public void RejectReason_allows_short_app_names(string target)
    {
        // name/bundle_id resolution path — bare names are not UNC/protocol.
        Assert.Null(LaunchTarget.RejectReason(target));
        Assert.False(LaunchTarget.IsLocalRootedPath(target));
    }

    [Fact]
    public void RejectReason_rejects_empty()
    {
        Assert.Equal("launch target is empty", LaunchTarget.RejectReason(""));
        Assert.Equal("launch target is empty", LaunchTarget.RejectReason("   "));
        Assert.Equal("launch target is empty", LaunchTarget.RejectReason(null));
    }
}
