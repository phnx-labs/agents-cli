// Foreman audio pipeline that lives in the extension host (Node) because
// VS Code webviews block getUserMedia in their sandbox.
//
// Data flow, both directions raw 24kHz mono PCM16:
//
//   mic  -> ffmpeg -> stdout -> WS append -> OpenAI Realtime
//                                                       |
//                                                       v
//   speaker <- ffplay <- stdin <- WS delta <- response
//
// The realtime model handles turn detection (semantic_vad) so we simply keep
// streaming mic bytes until the session ends.

import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import { FOREMAN_MODEL, FOREMAN_VOICE, FOREMAN_SYSTEM_PROMPT, FOREMAN_TOOLS } from '../core/foreman.config';
import { resolveExecutable } from '../core/binResolve';

export const REALTIME_WS = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(FOREMAN_MODEL)}`;
export const SAMPLE_RATE = 24000;

// Playback clock for the mic gate. Each PCM chunk queued into ffplay plays
// for exactly bytes/(SAMPLE_RATE*2) seconds; the clock accumulates those
// durations from "now or the current end of queue, whichever is later".
// Deltas arrive several times faster than realtime, so anchoring the gate to
// arrival time instead of this clock reopens the mic mid-speech and the
// assistant answers its own playback in a loop.
export function advancePlaybackClock(nowMs: number, playbackEndsAtMs: number, pcmBytes: number): number {
  const durationMs = (pcmBytes / (SAMPLE_RATE * 2)) * 1000;
  return Math.max(nowMs, playbackEndsAtMs) + durationMs;
}

// Exact mic capture command. Exported so the e2e test spawns the SAME args
// production uses — a flag the installed ffmpeg rejects (the avfoundation
// "-sample_rate"/"-channels" regression) fails the suite, not the orb tap.
export const MIC_FFMPEG_ARGS = [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'avfoundation',
  '-i', ':default',
  '-ac', '1', '-ar', String(SAMPLE_RATE),
  '-f', 's16le', 'pipe:1',
] as const;

// Exact playback command, exported for the same reason as MIC_FFMPEG_ARGS.
// -nostats is load-bearing: ffplay prints its playback clock to stderr even
// at -loglevel error (an ESC[2K erase-line escape every refresh), and the
// stderr reporter below treats ANY output as an error — without -nostats
// every spoken reply flashed a red "ffplay: [2K" in the orb.
export const SPEAKER_FFPLAY_ARGS = [
  '-hide_banner', '-loglevel', 'error', '-nostats',
  '-autoexit', '-nodisp',
  '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'mono',
  '-probesize', '32', '-fflags', 'nobuffer',
  '-i', 'pipe:0',
] as const;

// GA Realtime session.update payload. Exported so the e2e WS handshake test
// can exercise the exact same shape production sends — schema drift caught
// at test time, not at "tap the orb" time.
export function buildForemanSessionUpdate() {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: FOREMAN_MODEL,
      output_modalities: ['audio'],
      instructions: FOREMAN_SYSTEM_PROMPT,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          // near_field: laptop/desktop mic within ~arm's reach. Cleans steady
          // background noise before VAD so the model doesn't false-trigger on
          // fan/keyboard hum.
          noise_reduction: { type: 'near_field' },
          // gpt-4o-mini-transcribe: lower latency + better accuracy than the
          // legacy whisper-1 the beta shipped with, at a fraction of the cost.
          transcription: { model: 'gpt-4o-mini-transcribe' },
          // semantic_vad (the Agents-SDK default) uses a model to decide the
          // user actually finished, not just a silence timer — fewer premature
          // cut-ins on a coordinator who pauses mid-question.
          turn_detection: { type: 'semantic_vad', eagerness: 'medium' },
        },
        output: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          voice: FOREMAN_VOICE,
        },
      },
      tools: FOREMAN_TOOLS,
      tool_choice: 'auto',
    },
  } as const;
}

export interface ForemanAudioEvents {
  onStatus?: (status: 'connecting' | 'connected' | 'closed' | 'error', detail?: string) => void;
  /**
   * itemId is the OpenAI conversation item id carrying this utterance —
   * the handle deleteItem() needs to remove it from the model's context
   * (e.g. a Whisper mis-transcription that derailed the conversation).
   */
  onTranscript?: (role: 'user' | 'assistant', text: string, final: boolean, itemId?: string) => void;
  onToolCall?: (callId: string, name: string, args: unknown) => void;
  /**
   * Debug callback fired on EVERY inbound WS event from OpenAI plus synthetic
   * events for mic/speaker errors. Used to diagnose orb-listens-but-no-reply
   * type bugs where the missing event is invisible to the user.
   */
  onEvent?: (type: string, summary: string) => void;
}

export interface ForemanAudioSession {
  sendToolResult(callId: string, result: unknown): void;
  /**
   * Silent mode: when muted, assistant PCM is dropped instead of written to
   * ffplay — the transcript keeps streaming, so the orb answers in text only.
   * Togglable mid-session with zero latency cost (playback is the last hop).
   */
  setSpeakerMuted(muted: boolean): void;
  /**
   * Remove a conversation item from the model's context server-side
   * (conversation.item.delete). The transcript UI uses this to excise a
   * bad utterance so it stops steering follow-up answers.
   */
  deleteItem(itemId: string): void;
  close(): void;
}

export async function startForemanAudio(
  apiKey: string,
  events: ForemanAudioEvents,
  opts?: { speakerMuted?: boolean }
): Promise<ForemanAudioSession> {
  events.onStatus?.('connecting');

  // Resolve ffmpeg/ffplay to absolute paths BEFORE anything else. The extension
  // host is launched from the Dock, so it inherits a minimal PATH that omits
  // Homebrew — a bare spawn('ffmpeg') ENOENTs in production even though the
  // user's terminal finds it. Fail loud here instead of hanging the orb on a
  // silent mic. (This was the root cause of "the orb listens but never replies".)
  const ffmpegPath = resolveExecutable('ffmpeg');
  const ffplayPath = resolveExecutable('ffplay');
  if (!ffmpegPath || !ffplayPath) {
    const missing = [!ffmpegPath && 'ffmpeg', !ffplayPath && 'ffplay'].filter(Boolean).join(' and ');
    const msg = `${missing} not found on PATH. Install it: brew install ffmpeg`;
    events.onEvent?.('ffmpeg.missing', msg);
    events.onStatus?.('error', msg);
    throw new Error(msg);
  }

  // GA Realtime API (post-2026-05-07): no OpenAI-Beta header.
  // The beta header would route to the removed beta interface and OpenAI
  // returns "Realtime Beta API is no longer supported".
  const ws = new WebSocket(REALTIME_WS, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // ffmpeg reads from the macOS DEFAULT audio input (avfoundation ":default")
  // and emits raw PCM16 little-endian at 24kHz mono on stdout.
  //
  // ":default" follows whatever input device macOS currently routes to —
  // AirPods, USB mic, built-in — so connecting headphones Just Works and we
  // never capture the wrong device. Numeric indices (":0") are unstable: the
  // avfoundation device list reorders whenever a device (iPhone Continuity
  // mic, AirPods) appears, so a hardcoded index silently picks the wrong mic.
  //
  // avfoundation has NO -sample_rate / -channels input options (ffmpeg 8
  // rejects them with "Unrecognized option" and exits before capturing a
  // byte). The device captures at its native rate and the output-side
  // `-ac 1 -ar 24000` resample produces the 24kHz mono PCM the API expects.
  const mic: ChildProcess = spawn(ffmpegPath, [...MIC_FFMPEG_ARGS], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // ffplay reads raw PCM16 from stdin and plays to the default output.
  // -probesize / -fflags nobuffer minimize playback buffering so the
  // foreman's voice lands close to realtime.
  const speaker: ChildProcess = spawn(ffplayPath, [...SPEAKER_FFPLAY_ARGS], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let open = false;
  let closed = false;
  // Mic gate: while the assistant's voice is PLAYING, stop forwarding mic
  // bytes to OpenAI so playback doesn't loop back through the microphone as
  // "user input" and make the assistant answer itself repeatedly.
  //
  // The gate must run on the playback clock, not the delta-arrival clock.
  // OpenAI streams a 10s answer in ~2s of deltas; a gate keyed to "600ms
  // after the last delta" expires while ffplay still has most of the answer
  // queued, so the mic reopened mid-speech and the tail of every long answer
  // leaked back in. Queued PCM has an exact play time (bytes / 48000 per
  // second at 24kHz PCM16 mono) — extend the gate by each chunk's duration.
  const ASSISTANT_TAIL_MS = 600;
  let playbackEndsAt = 0;
  const notePlayback = (pcmBytes: number) => {
    playbackEndsAt = advancePlaybackClock(Date.now(), playbackEndsAt, pcmBytes);
  };
  const micMuted = () => Date.now() < playbackEndsAt + ASSISTANT_TAIL_MS;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { mic.kill('SIGTERM'); } catch { /* noop */ }
    try { speaker.stdin?.end(); } catch { /* noop */ }
    try { speaker.kill('SIGTERM'); } catch { /* noop */ }
    try { ws.close(); } catch { /* noop */ }
  };

  // After cleanup() we deliberately kill ffplay/ffmpeg. The resulting exit
  // events and "write EPIPE" errors are expected — suppress them so the UI
  // doesn't flash "FFplayError" when the user taps the orb to stop.
  mic.on('error', (err) => {
    events.onEvent?.('mic.error', err.message.slice(0, 120));
    if (!closed) events.onStatus?.('error', `ffmpeg: ${err.message}`);
  });
  mic.on('exit', (code, signal) => {
    if (closed) return;
    events.onEvent?.('mic.exit', `code=${code} signal=${signal ?? ''}`);
    if (code !== 0 && code !== null) {
      events.onStatus?.('error', `ffmpeg exited with code ${code} — mic capture dead`);
    }
  });
  speaker.on('spawn', () => {
    events.onEvent?.('speaker.spawn', `ffplay pid=${speaker.pid}`);
  });
  speaker.on('error', (err) => {
    events.onEvent?.('speaker.error', err.message.slice(0, 120));
    if (!closed) events.onStatus?.('error', `ffplay: ${err.message}`);
  });
  speaker.on('exit', (code, signal) => {
    console.warn(`[foreman] ffplay exited code=${code} signal=${signal}`);
    if (closed) return;
    events.onEvent?.('speaker.exit', `code=${code} signal=${signal ?? ''}`);
    if (code !== 0 && code !== null) {
      events.onStatus?.('error', `ffplay exited with code ${code}`);
    }
  });
  // ffmpeg runs at -loglevel error, so ANY stderr output is a real problem.
  // Report it verbatim — keyword-filtering here once swallowed a fatal
  // "Unrecognized option" startup failure and the orb showed nothing.
  mic.stderr?.on('data', (buf: Buffer) => {
    if (closed) return;
    const line = buf.toString().trim().split('\n')[0];
    if (!line) return;
    events.onEvent?.('mic.stderr', line.slice(0, 120));
    events.onStatus?.('error', `ffmpeg: ${line.slice(0, 120)}`);
  });
  // ffplay also runs at -loglevel error: any stderr is a real problem.
  // Mirror every line into the event overlay — keyword filters hid the
  // fatal mic failure once already; don't repeat that for the speaker.
  speaker.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString().trim();
    if (text) console.warn('[foreman ffplay]', text.slice(0, 400));
    if (closed) return;
    const firstLine = text.split('\n')[0];
    if (!firstLine) return;
    events.onEvent?.('speaker.stderr', firstLine.slice(0, 120));
    events.onStatus?.('error', `ffplay: ${firstLine.slice(0, 160)}`);
  });

  // Mic byte accounting so the debug overlay can show "still sending audio"
  // vs "mic went silent" without bombing the log with every 24kHz chunk.
  // We also track the peak PCM16 amplitude in each 2-second window so the
  // overlay reveals silent-mic bugs (peak=0.00 = "ffmpeg sending zeros").
  let micBytesSent = 0;
  let lastMicEventAt = 0;
  let windowPeak = 0;
  const reportMicProgress = () => {
    const now = Date.now();
    if (now - lastMicEventAt < 2000) return;
    lastMicEventAt = now;
    events.onEvent?.(
      'mic.progress',
      `${(micBytesSent / 1024).toFixed(1)} KiB sent  peak=${windowPeak.toFixed(2)}`
    );
    windowPeak = 0;
  };
  const updatePeak = (buf: Buffer) => {
    // PCM16 LE: read as signed 16-bit samples; peak amplitude normalized to [0, 1].
    const len = buf.length & ~1;
    for (let i = 0; i < len; i += 2) {
      const sample = buf.readInt16LE(i);
      const abs = sample < 0 ? -sample : sample;
      if (abs > windowPeak * 32768) windowPeak = abs / 32768;
    }
  };

  ws.on('open', () => {
    open = true;
    events.onStatus?.('connected');
    events.onEvent?.('ws.open', REALTIME_WS);

    ws.send(JSON.stringify(buildForemanSessionUpdate()));

    // Start streaming mic bytes to OpenAI as base64 PCM16 chunks. Skip the
    // upload while the assistant is speaking so its own playback doesn't
    // loop back through the mic.
    mic.stdout?.on('data', (buf: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (micMuted()) {
        events.onEvent?.('mic.muted', 'gated by assistant tail');
        return;
      }
      micBytesSent += buf.length;
      updatePeak(buf);
      reportMicProgress();
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: buf.toString('base64'),
      }));
    });
  });

  // Per-session speaker accounting (session-scoped on purpose: the old
  // module-level counters bled across sessions and corrupted diagnostics).
  let speakerMuted = opts?.speakerMuted ?? false;
  let audioBytesReceived = 0;
  let audioChunksLogged = 0;

  // One response at a time. The Realtime API rejects response.create while a
  // response is in flight, and firing one per tool result made the model
  // narrate the same ground twice when a single question triggered two tool
  // calls. Track the active response and defer creates until response.done;
  // one deferred create covers every tool output added in the meantime.
  let responseActive = false;
  let responseCreatePending = false;
  const requestResponse = () => {
    if (responseActive) {
      responseCreatePending = true;
      return;
    }
    responseActive = true;
    ws.send(JSON.stringify({ type: 'response.create' }));
  };

  const route = (msg: any) => {
    const type: string = msg?.type ?? '';
    events.onEvent?.(type, summarizeEvent(type, msg));

    if (type === 'response.created') {
      responseActive = true;
      return;
    }
    if (type === 'response.done') {
      responseActive = false;
      if (responseCreatePending) {
        responseCreatePending = false;
        requestResponse();
      }
      return;
    }

    if (type === 'response.output_audio.delta' && typeof msg.delta === 'string') {
      const pcm = Buffer.from(msg.delta, 'base64');
      audioBytesReceived += pcm.length;
      // Silent mode: drop playback, keep the transcript streaming. Skipping
      // notePlayback too — nothing plays, so there is no echo to gate and
      // the user can interrupt mid-response.
      if (speakerMuted) return;
      notePlayback(pcm.length);
      if (audioChunksLogged < 3) {
        events.onEvent?.(
          'speaker.write',
          `${pcm.length}B -> ffplay pid=${speaker.pid} writable=${speaker.stdin?.writable}`
        );
        audioChunksLogged++;
      }
      try {
        const ok = speaker.stdin?.write(pcm);
        if (ok === false && audioChunksLogged <= 3) events.onEvent?.('speaker.write', 'stdin backpressure');
      } catch (err: any) {
        events.onEvent?.('speaker.error', `stdin.write: ${err?.message ?? err}`.slice(0, 120));
        console.warn('[foreman] speaker.stdin.write threw:', err);
      }
      return;
    }

    if (type === 'response.output_audio.done') {
      // No gate bump needed: notePlayback already accounted for every queued
      // chunk's real play time, so micMuted() holds until playback drains.
      events.onEvent?.(
        'speaker.written',
        `${(audioBytesReceived / 1024).toFixed(1)} KiB total  muted=${speakerMuted}`
      );
      audioBytesReceived = 0;
      audioChunksLogged = 0;
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      events.onTranscript?.('user', msg.transcript ?? '', true, msg.item_id);
      return;
    }

    if (type === 'response.output_audio_transcript.delta') {
      events.onTranscript?.('assistant', msg.delta ?? '', false, msg.item_id);
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      events.onTranscript?.('assistant', msg.transcript ?? '', true, msg.item_id);
      return;
    }

    if (type === 'response.function_call_arguments.done') {
      const callId: string = msg.call_id ?? msg.id ?? '';
      const name: string = msg.name ?? '';
      let args: unknown = {};
      try { args = msg.arguments ? JSON.parse(msg.arguments) : {}; } catch { args = {}; }
      events.onToolCall?.(callId, name, args);
      return;
    }

    if (type === 'error') {
      events.onStatus?.('error', msg.error?.message ?? 'realtime error');
    }
  };

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    route(msg);
  });

  ws.on('close', (code, reason) => {
    open = false;
    events.onStatus?.('closed');
    events.onEvent?.('ws.close', `code=${code} reason=${reason?.toString() || ''}`);
    cleanup();
  });

  ws.on('error', (err) => {
    if (!closed) events.onStatus?.('error', err.message);
    events.onEvent?.('ws.error', err.message);
    cleanup();
  });

  return {
    sendToolResult(callId, result) {
      if (!open) return;
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }));
      requestResponse();
    },
    setSpeakerMuted(muted) {
      speakerMuted = muted;
      events.onEvent?.('speaker.muted', String(muted));
    },
    deleteItem(itemId) {
      if (!open || !itemId) return;
      ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId }));
    },
    close: cleanup,
  };
}

// Compact one-line summary per event type for the debug overlay. Keep these
// VERY short — they have to fit in a narrow panel and the user is scanning
// for "did transcript event arrive? did response.done arrive?".
function summarizeEvent(type: string, msg: any): string {
  switch (type) {
    case 'session.created': return `id=${(msg.session?.id ?? '').slice(0, 8)}`;
    case 'session.updated': return 'ok';
    case 'input_audio_buffer.speech_started': return '';
    case 'input_audio_buffer.speech_stopped': return '';
    case 'input_audio_buffer.committed': return `item=${(msg.item_id ?? '').slice(0, 8)}`;
    case 'conversation.item.created': return `${msg.item?.role ?? msg.item?.type ?? ''}`;
    // GA names for item lifecycle (beta said conversation.item.created).
    case 'conversation.item.added': return `${msg.item?.role ?? msg.item?.type ?? ''}`;
    case 'conversation.item.done': return `${msg.item?.role ?? msg.item?.type ?? ''}`;
    case 'conversation.item.deleted': return `item=${(msg.item_id ?? '').slice(0, 12)}`;
    case 'conversation.item.input_audio_transcription.completed':
      return JSON.stringify(msg.transcript ?? '').slice(0, 80);
    case 'conversation.item.input_audio_transcription.failed':
      return `FAIL: ${msg.error?.message ?? '?'}`.slice(0, 100);
    case 'response.created': return '';
    case 'response.done':
      return `status=${msg.response?.status ?? '?'}${msg.response?.status_details ? ` ${JSON.stringify(msg.response.status_details).slice(0, 60)}` : ''}`;
    case 'response.output_item.added': return msg.item?.type ?? '';
    case 'response.output_audio.delta': return `${msg.delta?.length ?? 0}c`;
    case 'response.output_audio.done': return '';
    case 'response.output_audio_transcript.delta':
      return JSON.stringify(msg.delta ?? '').slice(0, 60);
    case 'response.output_audio_transcript.done':
      return JSON.stringify(msg.transcript ?? '').slice(0, 80);
    case 'response.function_call_arguments.done':
      return `${msg.name ?? '?'}(${(msg.arguments ?? '').slice(0, 50)})`;
    case 'rate_limits.updated': return '';
    case 'error': return JSON.stringify(msg.error?.message ?? msg.error ?? msg).slice(0, 120);
    default: return '';
  }
}
