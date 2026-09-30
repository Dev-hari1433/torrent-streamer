import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config/env.js';
import { availableQualities, classifyMedia, remuxArguments } from '../src/stream/remuxer.js';
const execute = promisify(execFile);
type Packet = { stream_index: number; pts_time: string; data_hash: string; flags: string };
async function probe(path: string) {
  const { stdout } = await execute(config.FFPROBE_PATH, ['-v', 'error', '-show_packets', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json', path], { maxBuffer: 8 * 1024 ** 2, windowsHide: true });
  return JSON.parse(stdout);
}
async function tones(path: string) {
  const { stderr } = await execute(config.FFMPEG_PATH, ['-hide_banner', '-nostdin', '-copyts', '-i', path, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.04', '-f', 'null', '-'], { windowsHide: true });
  return [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(match => Number(match[1]));
}

test('B-frame MKV preserves audio content timing and original video packets at startup and after seeking', { timeout: 90000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'lumora-sync-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const codec of ['aac', 'ac3']) {
    const input = join(folder, `${codec}.mkv`);
    // Delayed, repeated audio markers expose offset loss and seek-preroll trimming.
    await execute(config.FFMPEG_PATH, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24',
      '-itsoffset', '0.5', '-f', 'lavfi', '-i', "aevalsrc='if(between(mod(t,2),0.25,0.4),0.8*sin(2*PI*1000*t),0)':s=48000",
      '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-bf', '3', '-g', '48', '-c:a', codec, input], { windowsHide: true });
    const source = await probe(input); const info = classifyMedia(input, source);
    const sourcePackets = source.packets as Packet[]; const sourceTones = await tones(input);
    for (const start of [0, 4]) {
      const output = join(folder, `${codec}-${start}.mp4`);
      const result = await execute(config.FFMPEG_PATH, remuxArguments(input, start, info), { encoding: 'buffer', maxBuffer: 8 * 1024 ** 2, windowsHide: true });
      await writeFile(output, result.stdout);
      const packets = (await probe(output)).packets as Packet[];
      const video = packets.filter(packet => packet.stream_index === 0);
      const originalFirst = sourcePackets.find(packet => packet.stream_index === 0 && packet.data_hash === video[0]!.data_hash)!;
      assert.ok(originalFirst); assert.ok(Math.abs(Number(originalFirst.pts_time) - start) < 0.05, 'seek starts at the requested keyframe, not the previous GOP');
      const shift = Number(video[0]!.pts_time) - Number(originalFirst.pts_time);
      for (const packet of video) {
        const original = sourcePackets.find(source => source.stream_index === 0 && source.data_hash === packet.data_hash);
        assert.ok(original, 'original-quality video stays bit-identical');
        assert.ok(Math.abs(Number(packet.pts_time) - Number(original.pts_time) - shift) < 0.002);
      }
      const expected = sourceTones.filter(at => at >= start).map(at => at + shift);
      const actual = await tones(output);
      assert.equal(actual.length, expected.length);
      actual.forEach((at, i) => assert.ok(Math.abs(at - expected[i]!) < 0.025, `${codec} at ${start}s: audio content moved ${at - expected[i]!}s relative to video`));
      if (codec === 'aac') {
        for (const packet of packets.filter(packet => packet.stream_index === 1)) {
          const original = sourcePackets.find(source => source.stream_index === 1 && source.data_hash === packet.data_hash && Math.abs(Number(packet.pts_time) - Number(source.pts_time) - shift) < 0.002);
          assert.ok(original); assert.ok(Math.abs(Number(packet.pts_time) - Number(original.pts_time) - shift) < 0.002, 'audio/video packet clocks share the same offset');
        }
      }
    }
    // Real lower-resolution output, including audio conversion when the input is AAC.
    for (const start of [0, 4]) {
      const output = join(folder, `${codec}-360-${start}.mp4`);
      const result = await execute(config.FFMPEG_PATH, remuxArguments(input, start, info, '360'), { encoding: 'buffer', maxBuffer: 8 * 1024 ** 2, windowsHide: true });
      await writeFile(output, result.stdout); const reduced = await probe(output);
      assert.equal(reduced.streams[0].height, 360); assert.equal(reduced.streams[0].codec_name, 'h264');
      const videoStart = Number(reduced.streams[0].start_time);
      const expected = sourceTones.filter(at => at >= start).map(at => at - start + videoStart);
      const actual = await tones(output); assert.equal(actual.length, expected.length);
      actual.forEach((at, i) => assert.ok(Math.abs(at - expected[i]!) < 0.03, 'quality conversion keeps audio aligned'));
    }
  }
});

test('quality ladder never upscales and rejects unsupported resolutions', () => {
  assert.deepEqual(availableQualities(1080), ['original', '720', '480', '360']);
  assert.deepEqual(availableQualities(240), ['original']);
  const info = classifyMedia('test.mp4', { streams: [{ codec_type: 'video', codec_name: 'h264', height: 480 }] });
  assert.throws(() => remuxArguments('test', 0, info, '720'), /unavailable/);
});
