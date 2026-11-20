import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173/' });

test('room balance attenuates the opposite channel and preserves media volume and mute', async ({ page }) => {
  await page.route('**/audio-balance-test', route => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<button>播放测试音频</button>'
  }));
  await page.goto('/audio-balance-test');
  const audio = await page.evaluateHandle(async () => {
    const modulePath = '/client/multiview/playbackAudioBalance.ts';
    const { preparePlaybackAudio, setPlaybackAudioBalance, releasePlaybackAudioBalance } = await import(modulePath);
    const player = document.createElement('audio');
    const frames = 8_000;
    const wav = new DataView(new ArrayBuffer(44 + frames * 4));
    const fourCC = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index++) wav.setUint8(offset + index, value.charCodeAt(index));
    };
    fourCC(0, 'RIFF');
    wav.setUint32(4, 36 + frames * 4, true);
    fourCC(8, 'WAVE');
    fourCC(12, 'fmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 2, true);
    wav.setUint32(24, frames, true);
    wav.setUint32(28, frames * 4, true);
    wav.setUint16(32, 4, true);
    wav.setUint16(34, 16, true);
    fourCC(36, 'data');
    wav.setUint32(40, frames * 4, true);
    for (let index = 0; index < frames; index++) {
      wav.setInt16(44 + index * 4, Math.sin(index / frames * Math.PI * 2 * 400) * 13_000, true);
      wav.setInt16(46 + index * 4, Math.sin(index / frames * Math.PI * 2 * 500) * 6_500, true);
    }
    document.body.append(player);
    player.loop = true;
    player.src = URL.createObjectURL(new Blob([wav.buffer], { type: 'audio/wav' }));

    const original = AudioContext.prototype.createChannelMerger;
    const metres: AnalyserNode[] = [];
    AudioContext.prototype.createChannelMerger = function (channels?: number) {
      const merger = original.call(this, channels);
      const split = this.createChannelSplitter(2);
      merger.connect(split);
      for (const index of [0, 1]) {
        const analyser = this.createAnalyser();
        split.connect(analyser, index);
        metres.push(analyser);
      }
      return merger;
    };
    let cleanup = setPlaybackAudioBalance(player, -100);
    document.querySelector('button')!.addEventListener('click', () => {
      preparePlaybackAudio();
      void player.play();
    }, { once: true });
    return {
      balance(value: number) { cleanup?.(); cleanup = setPlaybackAudioBalance(player, value); },
      volume(value: number) { player.volume = value; },
      mute(value: boolean) { player.muted = value; },
      peaks() {
        return metres.map(metre => {
          const data = new Float32Array(metre.fftSize);
          metre.getFloatTimeDomainData(data);
          return data.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
        });
      },
      close() { cleanup?.(); player.pause(); releasePlaybackAudioBalance(player); URL.revokeObjectURL(player.src); }
    };
  });
  await page.getByRole('button', { name: '播放测试音频' }).click();
  const measure = () => audio.evaluate(state => state.peaks().map(peak => Math.round(peak * 10)));
  await expect.poll(measure).toEqual([4, 0]);
  await audio.evaluate(state => state.balance(100));
  await expect.poll(measure).toEqual([0, 2]);
  await audio.evaluate(state => { state.balance(0); state.volume(0.5); });
  await expect.poll(measure).toEqual([2, 1]);
  await audio.evaluate(state => state.mute(true));
  await expect.poll(measure).toEqual([0, 0]);
  await audio.evaluate(state => state.close());
});
