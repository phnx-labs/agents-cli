using System.Windows.Automation;

namespace ComputerHelperWin;

/// <summary>
/// Per-process element handle cache, mirroring the macOS ElementCache.
///
/// describe() assigns each emitted element a short id ("@e1", "@e2", ...) and
/// stashes the live AutomationElement here so a follow-up click/get_text/type
/// can resolve the id back to the element. BeginDescribe(pid) clears the prior
/// generation, so ids only live until the next describe of that pid — a later
/// click with a stale id misses the lookup and the caller gets element_stale.
///
/// Connections are served on thread-pool threads (Program.HandleConnection), so
/// every operation is guarded by a lock.
/// </summary>
public sealed class ElementCache
{
    private readonly object _gate = new();
    private readonly Dictionary<int, Dictionary<string, AutomationElement>> _byPid = new();
    private readonly Dictionary<int, int> _counter = new();

    /// <summary>Drop the prior generation for this pid and reset its id counter.</summary>
    public void BeginDescribe(int pid)
    {
        lock (_gate)
        {
            _byPid[pid] = new Dictionary<string, AutomationElement>();
            _counter[pid] = 0;
        }
    }

    /// <summary>Allocate the next "@eN" id for this pid.</summary>
    public string NextRefId(int pid)
    {
        lock (_gate)
        {
            int n = _counter.TryGetValue(pid, out var c) ? c + 1 : 1;
            _counter[pid] = n;
            return $"@e{n}";
        }
    }

    public void Put(int pid, string id, AutomationElement element)
    {
        lock (_gate)
        {
            if (!_byPid.TryGetValue(pid, out var map))
            {
                map = new Dictionary<string, AutomationElement>();
                _byPid[pid] = map;
            }
            map[id] = element;
        }
    }

    public AutomationElement? Get(int pid, string id)
    {
        lock (_gate)
        {
            return _byPid.TryGetValue(pid, out var map) && map.TryGetValue(id, out var el) ? el : null;
        }
    }
}
