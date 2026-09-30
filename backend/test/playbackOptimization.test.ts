import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackWindow } from '../src/torrent/pieceSelector.js';
import playerUtils from '../../frontend/src/lib/player-utils.js';
import captionUtils from '../../frontend/src/lib/captions.js';
import remuxUtils from '../../frontend/src/lib/remux-source.js';
const { containsTime, bufferAhead } = playerUtils;
const { parseCaptions } = captionUtils;
test('prefetch scales to bitrate, increases urgency for a low buffer, and stays memory bounded', () => {
  const rate = 2 * 1024 ** 2;
  assert.equal(playbackWindow(rate, 0).urgent, 60 * 1024 ** 2);
  assert.equal(playbackWindow(rate, 30).urgent, 24 * 1024 ** 2);
  assert.equal(playbackWindow(rate, 0).ahead, 180 * 1024 ** 2);
  assert.equal(playbackWindow(100 * rate, 0).ahead, 192 * 1024 ** 2);
  assert.equal(playbackWindow(0, 0).urgent, 25 * 1024 ** 2);
});
test('buffered seek decisions respect disjoint ranges, preroll offsets, and the live edge', () => {
  const ranges = [{ start: 60, end: 75 }, { start: 80, end: 95 }];
  assert.ok(containsTime(ranges, 65)); assert.ok(!containsTime(ranges, 77));
  assert.ok(!containsTime(ranges, 74.95)); assert.equal(bufferAhead(ranges, 65), 10);
  assert.equal(bufferAhead(ranges, 77), 0);
});
test('local subtitles support SRT and VTT timestamps and reject invalid cues', () => {
  assert.deepEqual(parseCaptions('1\n00:01:02,200 --> 00:01:04,500\nHello\nworld\n\n2\n00:00:05,000 --> 00:00:04,000\nInvalid'), [{ start: 62.2, end: 64.5, text: 'Hello\nworld' }]);
  assert.deepEqual(parseCaptions('WEBVTT\n\n00:02.100 --> 00:04.900 align:start\nCaption'), [{ start: 2.1, end: 4.9, text: 'Caption' }]);
});

test('MSE initialization waits for a complete moov and derives the actual AVC profile', () => {
  const moov = Buffer.from('000000176d6f6f760000000f617663430164002800000000', 'hex');
  assert.equal(remuxUtils.avcCodecFromInit(moov.subarray(0, 14)), null);
  assert.equal(remuxUtils.avcCodecFromInit(moov), 'avc1.640028');
  assert.throws(() => remuxUtils.avcCodecFromInit(Buffer.from('000000006d6f6f76', 'hex')), /Invalid MP4/);
});
