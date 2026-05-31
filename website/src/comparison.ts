export const COMPARISON_HTML = `<section class="cmp-wrap">
  <p class="cmp-lede">Most tools give you one piece. <strong>agents</strong> gives you all of them.</p>

  <div class="cmp-table-scroll">
    <table class="cmp-table">
      <thead>
        <tr>
          <th class="cmp-row-label" scope="col">Capability</th>
          <th class="cmp-col-hot" scope="col">agents-cli</th>
          <th scope="col">Claude Code alone</th>
          <th scope="col">Cursor</th>
          <th scope="col">Run CLIs by hand</th>
          <th scope="col">OpenCode</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th class="cmp-row-label" scope="row">Pin versions per project (.nvmrc-style)</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Run multiple agents (Claude + Codex + Gemini) from one CLI</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-partial">~</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Swap underlying model (Kimi, GLM, DeepSeek via OpenRouter)</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-partial">~</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-yes">✓</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Rotate across multiple accounts to dodge rate limits</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Parallel teams with DAG dependencies</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Local browser via CDP (drive any site)</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Cross-agent session search &amp; replay</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-partial">~</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-partial">~</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Cron / scheduled routines</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-partial">~</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Keychain-backed secrets (no .env files)</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">Sync skills/MCP/commands across all installed agents</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-partial">~</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-partial">~</span></td>
        </tr>
        <tr>
          <th class="cmp-row-label" scope="row">100% local, open-source, no cloud SaaS</th>
          <td class="cmp-col-hot"><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-no">—</span></td>
          <td><span class="cmp-yes">✓</span></td>
          <td><span class="cmp-yes">✓</span></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="cmp-cards" aria-hidden="false">
    <div class="cmp-card">
      <div class="cmp-card-title">Pin versions per project (.nvmrc-style)</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Run multiple agents (Claude + Codex + Gemini) from one CLI</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-partial">~</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Swap underlying model (Kimi, GLM, DeepSeek via OpenRouter)</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-partial">~</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-yes">✓</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Rotate across multiple accounts to dodge rate limits</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Parallel teams with DAG dependencies</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Local browser via CDP (drive any site)</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Cross-agent session search &amp; replay</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-partial">~</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-partial">~</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Cron / scheduled routines</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-partial">~</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Keychain-backed secrets (no .env files)</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-no">—</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">Sync skills/MCP/commands across all installed agents</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-partial">~</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-partial">~</span></li>
      </ul>
    </div>
    <div class="cmp-card">
      <div class="cmp-card-title">100% local, open-source, no cloud SaaS</div>
      <ul class="cmp-card-list">
        <li><span class="cmp-card-tool cmp-card-tool-hot">agents-cli</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">Claude Code alone</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Cursor</span><span class="cmp-no">—</span></li>
        <li><span class="cmp-card-tool">Run CLIs by hand</span><span class="cmp-yes">✓</span></li>
        <li><span class="cmp-card-tool">OpenCode</span><span class="cmp-yes">✓</span></li>
      </ul>
    </div>
  </div>

  <style>
    .cmp-wrap {
      margin: 2.5rem 0;
      color: #e8e8e8;
    }
    .cmp-lede {
      color: #888;
      margin: 0 0 1.25rem;
      font-size: 0.95rem;
    }
    .cmp-lede strong {
      color: #a3e635;
      font-weight: 600;
    }
    .cmp-table-scroll {
      overflow-x: auto;
      border: 1px solid #1a1a1a;
      background: #0f0f0f;
    }
    .cmp-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      min-width: 720px;
    }
    .cmp-table th,
    .cmp-table td {
      padding: 0.65rem 0.85rem;
      text-align: center;
      border-bottom: 1px solid #1a1a1a;
      border-right: 1px solid #222;
      vertical-align: middle;
    }
    .cmp-table th:last-child,
    .cmp-table td:last-child {
      border-right: none;
    }
    .cmp-table tbody tr:last-child th,
    .cmp-table tbody tr:last-child td {
      border-bottom: none;
    }
    .cmp-table thead th {
      color: #888;
      font-weight: 500;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: #0a0a0a;
    }
    .cmp-table th.cmp-row-label {
      text-align: left;
      color: #e8e8e8;
      font-weight: 400;
      background: #0a0a0a;
    }
    .cmp-table tbody th.cmp-row-label {
      font-size: 0.85rem;
      text-transform: none;
      letter-spacing: 0;
      color: #ccc;
    }
    .cmp-table .cmp-col-hot {
      background: #a3e6350a;
      border-left: 1px solid #a3e63533;
      border-right: 1px solid #a3e63533;
    }
    .cmp-table thead th.cmp-col-hot {
      color: #a3e635;
    }
    .cmp-yes {
      color: #555;
      font-weight: 600;
    }
    .cmp-col-hot .cmp-yes {
      color: #a3e635;
    }
    .cmp-no {
      color: #333;
    }
    .cmp-partial {
      color: #666;
    }

    .cmp-cards {
      display: none;
    }
    .cmp-card {
      border: 1px solid #1a1a1a;
      background: #0f0f0f;
      padding: 0.85rem 1rem;
      margin-bottom: 0.65rem;
    }
    .cmp-card-title {
      font-size: 0.85rem;
      color: #e8e8e8;
      margin-bottom: 0.5rem;
    }
    .cmp-card-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .cmp-card-list li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.3rem 0;
      border-bottom: 1px solid #1a1a1a;
      font-size: 0.8rem;
    }
    .cmp-card-list li:last-child {
      border-bottom: none;
    }
    .cmp-card-tool {
      color: #888;
    }
    .cmp-card-tool-hot {
      color: #a3e635;
    }

    @media (max-width: 760px) {
      .cmp-table-scroll {
        display: none;
      }
      .cmp-cards {
        display: block;
      }
    }
  </style>
</section>`;
