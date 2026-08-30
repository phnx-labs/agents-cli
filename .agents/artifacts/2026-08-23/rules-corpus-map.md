---
kind: visual
title: The Agent Rulebook — Two Layers, One Un-Cut Half
summary: The 38 rules injected into every agent session total 17,255 words (~23k tokens). The system layer was already cut 58%; the user layer — the bigger half at 11,040 words — was never slimmed. This maps every rule by size, category, and the merges/deletes that would finish the job.
status: draft
context: agent rules & subrules corpus
facts:
  - "17,255 words injected every session across 38 rules in 2 layers"
  - "System layer slimmed -58% (landed); user layer 11,040 words, still pre-slim"
  - "8 rules over 800 words; 4 under 80; 2 dead shadow-copies; 5 merge/delete candidates"
---

## Story

Every agent you run reads the same rulebook before it does anything: **38 rules, 17,255 words, ~23k tokens**, injected into the front of every session. The rules are good — F1–F5 plus tactics for finishing work, self-unblocking, not wasting your time, and not breaking things. The problem the Aug-20 review named is still half-true: **the point is buried in bulk.**

That review cut the corpus ~60% and **merged the system half** (commit `fcbd5bf`) — 14.7k words down to 6,215. But the **user layer never got the same cut.** It still carries 11,040 words across 21 files — five of them over 800 words each — exactly as it was before the review. So today's injected total is 17,255 words, not the ~10k the review targeted.

The green in every figure below is the slimmed system layer. The amber is the user layer that still needs the knife.

## Data

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-stat"><div class="artifact-stat-value">11,040</div><div class="artifact-stat-label">user-layer words never cut</div></article>
  <article class="artifact-stat"><div class="artifact-stat-value">-58%</div><div class="artifact-stat-label">system layer already slimmed</div></article>
  <article class="artifact-stat"><div class="artifact-stat-value">8</div><div class="artifact-stat-label">rules over 800 words</div></article>
  <article class="artifact-stat"><div class="artifact-stat-value">7</div><div class="artifact-stat-label">shadows + merge / delete candidates</div></article>
</section>

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 760 248" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" role="img" aria-label="System layer slimmed, user layer not"><text x="158" y="24" font-size="11" text-anchor="end" fill="#8a8a8a">layer</text><text x="170" y="24" font-size="11" fill="#8a8a8a">solid = today &#183; ghost = pre-slim size</text><text x="158" y="60" font-size="13" font-weight="700" text-anchor="end" fill="currentColor">System</text><rect x="170" y="46" width="509.4" height="26" rx="4" fill="#16a34a" opacity="0.16"/><rect x="170" y="46" width="509.4" height="26" rx="4" fill="none" stroke="#16a34a" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/><rect x="170" y="46" width="215.5" height="26" rx="4" fill="#16a34a" opacity="0.92"/><text x="393.5" y="64" font-size="12.5" font-weight="700" fill="currentColor">6,215 w</text><text x="752" y="64" font-size="11" fill="#16a34a" font-weight="700" text-anchor="end">slimmed &#10003;</text><text x="158" y="116" font-size="13" font-weight="700" text-anchor="end" fill="currentColor">User</text><rect x="170" y="102" width="382.7" height="26" rx="4" fill="#f59e0b" opacity="0.16"/><rect x="170" y="102" width="382.7" height="26" rx="4" fill="none" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/><rect x="170" y="102" width="382.7" height="26" rx="4" fill="#f59e0b" opacity="0.92"/><text x="560.7" y="120" font-size="12.5" font-weight="700" fill="currentColor">11,040 w</text><text x="752" y="120" font-size="11" fill="#dc2626" font-weight="700" text-anchor="end">NOT slimmed &#10007;</text><line x1="312.0" y1="96" x2="312.0" y2="136" stroke="#16a34a" stroke-width="1.6" stroke-dasharray="4 3"/><text x="312.0" y="150" font-size="10" fill="#16a34a" text-anchor="middle">slim target ~4.1k</text><text x="158" y="188" font-size="12" text-anchor="end" fill="currentColor" font-weight="700">Injected now</text><rect x="170" y="172" width="598.2" height="22" rx="4" fill="url(#g1)"/><defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#16a34a"/><stop offset="0.360" stop-color="#16a34a"/><stop offset="0.360" stop-color="#f59e0b"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><text x="776.2" y="188" font-size="12.5" font-weight="700" fill="currentColor">17,255 w &#8776; 23k+ tokens / session</text></svg>
<figcaption>The system layer (green) took its 58% cut. The user layer (amber) sits at full pre-slim size — about 2.7x over the slim target.</figcaption>
</figure>

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 760 92" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" role="img" aria-label="Share of corpus by category"><rect x="8.0" y="30" width="309.9" height="30" fill="#16a34a" opacity="0.88"><title>A · Finish the task end-to-end: 7,188 w</title></rect><text x="163.0" y="49" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">A</text><text x="163.0" y="74" font-size="9.5" fill="#8a8a8a" text-anchor="middle">41%</text><rect x="317.9" y="30" width="194.1" height="30" fill="#0891b2" opacity="0.88"><title>B · Know &amp; use your tools: 4,502 w</title></rect><text x="415.0" y="49" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">B</text><text x="415.0" y="74" font-size="9.5" fill="#8a8a8a" text-anchor="middle">26%</text><rect x="512.0" y="30" width="161.8" height="30" fill="#d97706" opacity="0.88"><title>C · Don't burn the operator's time: 3,752 w</title></rect><text x="592.9" y="49" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">C</text><text x="592.9" y="74" font-size="9.5" fill="#8a8a8a" text-anchor="middle">21%</text><rect x="673.8" y="30" width="62.7" height="30" fill="#7c3aed" opacity="0.88"><title>D · Protect what can't be undone: 1,455 w</title></rect><text x="705.2" y="49" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">D</text><text x="705.2" y="74" font-size="9.5" fill="#8a8a8a" text-anchor="middle">8%</text><rect x="736.6" y="30" width="15.4" height="30" fill="#64748b" opacity="0.88"><title>E · Housekeeping: 358 w</title></rect><text x="744.3" y="74" font-size="9.5" fill="#8a8a8a" text-anchor="middle">2%</text><text x="8" y="18" font-size="11" fill="#8a8a8a">Corpus share by category &#183; A finish &#183; B tools &#183; C operator &#183; D protect &#183; E housekeeping</text></svg>
<figcaption>Share of the injected corpus by category. "Finish the task" and "know your tools" are 68% of every session's rules.</figcaption>
</figure>

## Figure

Every rule, grouped by what it makes an agent do. Bar length = word count; **green = system (slimmed), amber = user (not slimmed)**. Red triangle = over 800 words; faded / dot = under 80; dashed red outline = fold into another rule; solid red outline = dead shadow-copy (a same-named user file wins, so the system copy never renders on your machines).

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 900 1009" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Rule corpus inventory by category and size" font-family="Inter, system-ui, sans-serif">
<rect x="0" y="0" width="900" height="1009" fill="none"/>
<text x="8" y="28" font-size="12.5" font-weight="700" fill="currentColor" letter-spacing="0.3">A · Finish the task end-to-end</text>
<text x="892" y="28" font-size="10.5" text-anchor="end" fill="#8a8a8a" opacity="0.75">7,188 w</text>
<rect x="240" y="38" width="470.0" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="48.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="700">foundations (F1–F5)</text>
<text x="716.0" y="48.5" font-size="10" fill="#8a8a8a">1397 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="59" width="408.8" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="69.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">release-to-fleet</text>
<text x="654.8" y="69.5" font-size="10" fill="#8a8a8a">1215 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="80" width="359.6" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="90.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">parallel-teams</text>
<text x="605.6" y="90.5" font-size="10" fill="#8a8a8a">1069 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="101" width="362.3" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="111.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">session-handoff-summary</text>
<text x="608.3" y="111.5" font-size="10" fill="#8a8a8a">1077 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="122" width="296.4" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="132.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">truly-agentic-git</text>
<text x="542.4" y="132.5" font-size="10" fill="#8a8a8a">881 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="143" width="128.5" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="153.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">unattended-verification</text>
<text x="374.5" y="153.5" font-size="10" fill="#8a8a8a">382</text>
<rect x="240" y="164" width="107.3" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="174.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">demonstrate-on-ship</text>
<text x="353.3" y="174.5" font-size="10" fill="#8a8a8a">319</text>
<rect x="240" y="185" width="99.9" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="184" width="101.9" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3" stroke-dasharray="3 2"/>
<text x="232" y="195.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">own-the-request-thru-build</text>
<text x="345.9" y="195.5" font-size="10" fill="#8a8a8a">297</text>
<rect x="240" y="206" width="63.2" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="205" width="65.2" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3" stroke-dasharray="3 2"/>
<text x="232" y="216.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">automated-pr-review</text>
<text x="309.2" y="216.5" font-size="10" fill="#8a8a8a">188</text>
<rect x="240" y="227" width="50.1" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="237.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">task-checklists</text>
<text x="296.1" y="237.5" font-size="10" fill="#8a8a8a">149</text>
<rect x="240" y="248" width="46.4" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="258.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">gh-merge-guard</text>
<text x="292.4" y="258.5" font-size="10" fill="#8a8a8a">138</text>
<rect x="240" y="269" width="25.6" height="13" rx="2.5" fill="#f59e0b" opacity="0.34"/>
<rect x="239" y="268" width="27.6" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3" stroke-dasharray="3 2"/>
<text x="232" y="279.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">deployment-and-waiting</text>
<text x="271.6" y="279.5" font-size="10" fill="#8a8a8a">76 <tspan fill="#8a8a8a">&#183;</tspan></text>
<text x="8" y="317" font-size="12.5" font-weight="700" fill="currentColor" letter-spacing="0.3">B · Know &amp; use your tools</text>
<text x="892" y="317" font-size="10.5" text-anchor="end" fill="#8a8a8a" opacity="0.75">4,502 w</text>
<rect x="240" y="327" width="393.3" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="337.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">exhaust-self-serve</text>
<text x="639.3" y="337.5" font-size="10" fill="#8a8a8a">1169 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="348" width="363.0" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="358.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">dispatch-ops</text>
<text x="609.0" y="358.5" font-size="10" fill="#8a8a8a">1079 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="369" width="180.7" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="368" width="182.7" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3" stroke-dasharray="3 2"/>
<text x="232" y="379.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">remote-dispatch-safety</text>
<text x="426.7" y="379.5" font-size="10" fill="#8a8a8a">537</text>
<rect x="240" y="390" width="124.8" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="389" width="126.8" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3" stroke-dasharray="3 2"/>
<text x="232" y="400.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">distributed-teams</text>
<text x="370.8" y="400.5" font-size="10" fill="#8a8a8a">371</text>
<rect x="240" y="411" width="91.5" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="421.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">remote-fleet-dispatch</text>
<text x="337.5" y="421.5" font-size="10" fill="#8a8a8a">272</text>
<rect x="240" y="432" width="72.0" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="442.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">fleet-delegation</text>
<text x="318.0" y="442.5" font-size="10" fill="#8a8a8a">214</text>
<rect x="240" y="453" width="71.3" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="463.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">tech-stack (tool map)</text>
<text x="317.3" y="463.5" font-size="10" fill="#8a8a8a">212</text>
<rect x="240" y="474" width="102.9" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="484.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">github-api-rate-limits</text>
<text x="348.9" y="484.5" font-size="10" fill="#8a8a8a">306</text>
<rect x="240" y="495" width="61.6" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="505.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">research-discipline</text>
<text x="307.6" y="505.5" font-size="10" fill="#8a8a8a">183</text>
<rect x="240" y="516" width="53.5" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="526.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">clip-references</text>
<text x="299.5" y="526.5" font-size="10" fill="#8a8a8a">159</text>
<text x="8" y="564" font-size="12.5" font-weight="700" fill="currentColor" letter-spacing="0.3">C · Don't burn the operator's time</text>
<text x="892" y="564" font-size="10.5" text-anchor="end" fill="#8a8a8a" opacity="0.75">3,752 w</text>
<rect x="240" y="574" width="331.1" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="584.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">notify-owner</text>
<text x="577.1" y="584.5" font-size="10" fill="#8a8a8a">984 <tspan fill="#dc2626" font-weight="700">&#9650;</tspan></text>
<rect x="240" y="595" width="268.8" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="594" width="270.8" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3"/>
<text x="232" y="605.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">feed-status-posts</text>
<text x="514.8" y="605.5" font-size="10" fill="#8a8a8a">799</text>
<rect x="240" y="616" width="234.5" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<rect x="239" y="615" width="236.5" height="15" rx="3" fill="none" stroke="#dc2626" stroke-width="1.3"/>
<text x="232" y="626.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">ui-work-discipline</text>
<text x="480.5" y="626.5" font-size="10" fill="#8a8a8a">697</text>
<rect x="240" y="637" width="160.8" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="647.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">plan-artifacts+tickets</text>
<text x="406.8" y="647.5" font-size="10" fill="#8a8a8a">478</text>
<rect x="240" y="658" width="152.7" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="668.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">plan-presentation</text>
<text x="398.7" y="668.5" font-size="10" fill="#8a8a8a">454</text>
<rect x="240" y="679" width="114.4" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="689.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">no-telegram</text>
<text x="360.4" y="689.5" font-size="10" fill="#8a8a8a">340</text>
<text x="8" y="727" font-size="12.5" font-weight="700" fill="currentColor" letter-spacing="0.3">D · Protect what can't be undone</text>
<text x="892" y="727" font-size="10.5" text-anchor="end" fill="#8a8a8a" opacity="0.75">1,455 w</text>
<rect x="240" y="737" width="151.7" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="747.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">operational</text>
<text x="397.7" y="747.5" font-size="10" fill="#8a8a8a">451</text>
<rect x="240" y="758" width="131.9" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="768.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">watchdog-disabled</text>
<text x="377.9" y="768.5" font-size="10" fill="#8a8a8a">392</text>
<rect x="240" y="779" width="117.8" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="789.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">skill-authorship-restraint</text>
<text x="363.8" y="789.5" font-size="10" fill="#8a8a8a">350</text>
<rect x="240" y="800" width="41.0" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="810.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">code-quality</text>
<text x="287.0" y="810.5" font-size="10" fill="#8a8a8a">122</text>
<rect x="240" y="821" width="24.2" height="13" rx="2.5" fill="#16a34a" opacity="0.34"/>
<text x="232" y="831.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">testing-strict</text>
<text x="270.2" y="831.5" font-size="10" fill="#8a8a8a">72 <tspan fill="#8a8a8a">&#183;</tspan></text>
<rect x="240" y="842" width="22.9" height="13" rx="2.5" fill="#16a34a" opacity="0.34"/>
<text x="232" y="852.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">no-pr-footer</text>
<text x="268.9" y="852.5" font-size="10" fill="#8a8a8a">68 <tspan fill="#8a8a8a">&#183;</tspan></text>
<text x="8" y="890" font-size="12.5" font-weight="700" fill="currentColor" letter-spacing="0.3">E · Housekeeping</text>
<text x="892" y="890" font-size="10.5" text-anchor="end" fill="#8a8a8a" opacity="0.75">358 w</text>
<rect x="240" y="900" width="41.4" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="910.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">rush-conventions</text>
<text x="287.4" y="910.5" font-size="10" fill="#8a8a8a">123</text>
<rect x="240" y="921" width="33.0" height="13" rx="2.5" fill="#16a34a" opacity="0.9"/>
<text x="232" y="931.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">conventions</text>
<text x="279.0" y="931.5" font-size="10" fill="#8a8a8a">98</text>
<rect x="240" y="942" width="28.3" height="13" rx="2.5" fill="#f59e0b" opacity="0.9"/>
<text x="232" y="952.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">personal-stack</text>
<text x="274.3" y="952.5" font-size="10" fill="#8a8a8a">84</text>
<rect x="240" y="963" width="17.8" height="13" rx="2.5" fill="#16a34a" opacity="0.34"/>
<text x="232" y="973.5" font-size="11" text-anchor="end" fill="currentColor" font-weight="400">agents-cli</text>
<text x="263.8" y="973.5" font-size="10" fill="#8a8a8a">53 <tspan fill="#8a8a8a">&#183;</tspan></text>
</svg>

<figcaption>All 38 rendered rules by category and size. The five amber bars above 800 words are the un-cut user layer.</figcaption>
</figure>

## Data

**The cleanup the map points to — finish the user-layer cut the review started:**

| Action | Rules | Why | Saves |
|---|---|---|---|
| **Slim (biggest lever)** | release-to-fleet · exhaust-self-serve · dispatch-ops · session-handoff-summary · notify-owner | 5 user files >800 w, still pre-slim; the review already drafted ~350 w versions | ~4,000 w |
| **Delete shadow-copies** | feed-status-posts · ui-work-discipline | User copy shadows the system one; two files to maintain, one dead on your fleet — fold fleet specifics down, delete the shadow | ~1,000 w |
| **Merge away** | distributed-teams + remote-dispatch-safety -> dispatch-ops · deployment-and-waiting -> demonstrate-on-ship · own-the-request -> F1 | Same topic split across files; the review verified no dangling refs | ~1,280 w |
| **Delete redundant** | automated-pr-review | gh-merge-guard + git-workflow already carry the `prix-cloud` non-author-review rule | ~190 w |
| **Merge up (too small)** | agents-cli · no-pr-footer · deployment-and-waiting · personal-stack · testing-strict | <80 w each; fold into their nearest home rather than stand alone | trivial |

Net: the user layer drops from 11,040 to roughly 4.1k words, and the injected corpus lands near **~10.3k words (~14k tokens)** — the review's original target, without dropping a single hard rule, recipe, or guard name.
