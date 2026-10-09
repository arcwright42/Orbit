class OrbitCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      this.position += 1;
      if (this.position >= ratio) { this.samples.push(input[i]); this.position -= ratio; }
    }
    while (this.samples.length >= 640) {
      const pcm = new ArrayBuffer(1280); const view = new DataView(pcm);
      for (let i = 0; i < 640; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, this.samples[i])) * 32767), true);
      this.samples.splice(0, 640); this.port.postMessage(pcm, [pcm]);
    }
    return true;
  }
}
registerProcessor('orbit-capture', OrbitCapture);
