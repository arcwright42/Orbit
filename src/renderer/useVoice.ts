import { useEffect, useRef, useState } from 'react';
export function useVoice(onChanged: () => void) {
  const [state, setState] = useState('off');
  const [error, setError] = useState('');
  const [lines, setLines] = useState<{ role: string; text: string }[]>([]);
  const ctx = useRef<AudioContext | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const node = useRef<AudioWorkletNode | null>(null);
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const next = useRef(0);
  const generation = useRef(0);
  const changed = useRef(onChanged); changed.current = onChanged;
  function silence() { for (const source of sources.current) { source.onended = null; source.stop(); source.disconnect(); } sources.current.clear(); next.current = 0; }
  function release() { generation.current++; mic.current?.getTracks().forEach(track => track.stop()); mic.current = null; node.current?.disconnect(); node.current = null; silence(); void ctx.current?.close(); ctx.current = null; }
  async function stop() { release(); setState('off'); await window.orbit.voiceStop(); }
  useEffect(() => {
    const unsubscribe = window.orbit.onVoice(event => {
      if (event.type === 'state') { setState(event.state); if (event.state === 'off') release(); }
      if (event.type === 'error') { setError(event.text); release(); setState('off'); }
      if (event.type === 'interrupt') silence();
      if (event.type === 'transcript') { setLines(lines => [...lines.slice(-19), { role: event.role, text: event.text }]); changed.current(); }
      if (event.type === 'audio' && ctx.current) {
        const context = ctx.current;
        const binary = atob(event.data); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const view = new DataView(bytes.buffer); const buffer = context.createBuffer(1, bytes.length / 2, 24000);
        const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
        sources.current.add(source); source.onended = () => { sources.current.delete(source); source.disconnect(); };
        next.current = Math.max(next.current, context.currentTime + 0.02); source.start(next.current); next.current += buffer.duration;
      }
    });
    return () => { unsubscribe(); release(); void window.orbit.voiceStop(); };
  }, []);
  async function start(wake: boolean) {
    release(); setError(''); setState('connecting');
    const gen = generation.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (gen !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      mic.current = stream;
      const context = new AudioContext({ sampleRate: 16000 }); ctx.current = context;
      await context.audioWorklet.addModule(new URL('../../public/voice-capture.js', import.meta.url));
      await context.resume();
      if (gen !== generation.current) return;
      const capture = new AudioWorkletNode(context, 'orbit-capture'); node.current = capture;
      let pending = false;
      capture.port.onmessage = event => {  if (!pending && gen === generation.current) { pending = true; void window.orbit.voiceAudio(new Uint8Array(event.data)).catch(() => { setError('音频传输失败，请重试。'); void stop(); }).finally(() => { pending = false; }); } };
      context.createMediaStreamSource(stream).connect(capture); capture.connect(context.destination);
      await window.orbit.voiceStart(wake);
    } catch (e) { if (gen === generation.current) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '无法启动麦克风。'); await stop(); } }
  }
  return { state, error, lines, start, stop, silence };
}
