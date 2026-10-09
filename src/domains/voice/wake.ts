import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
interface Stream { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
interface Spotter { createStream(): Stream; isReady(stream: Stream): boolean; decode(stream: Stream): void; getResult(stream: Stream): { keyword: string }; reset(stream: Stream): void }
export class WakeDetector {
  private spotter: Spotter;
  private stream: Stream;
  constructor(dir: string) {
    for (const file of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt', 'keywords.txt']) if (!existsSync(join(dir, file))) throw new Error('请先运行 npm run setup:voice 安装本地唤醒模型。');
    const { KeywordSpotter } = createRequire(join(dir, '../../package.json'))('sherpa-onnx-node');
    this.spotter = new KeywordSpotter({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: join(dir, 'encoder.onnx'), decoder: join(dir, 'decoder.onnx'), joiner: join(dir, 'joiner.onnx') }, tokens: join(dir, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 }, keywordsFile: join(dir, 'keywords.txt') });
    this.stream = this.spotter.createStream();
  }
  accept(pcm: Uint8Array) {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    this.stream.acceptWaveform({ sampleRate: 16000, samples });
    while (this.spotter.isReady(this.stream)) {
      this.spotter.decode(this.stream);
      if (this.spotter.getResult(this.stream).keyword) { this.spotter.reset(this.stream); return true; }
    }
    return false;
  }
}
