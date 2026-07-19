import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScreenshotTimeline } from '../../src/screenshot-timeline.js';

const SAMPLE_IMAGE = Buffer.from('timeline-image').toString('base64');

describe('ScreenshotTimeline', () => {
  let directory;
  let indexPath;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'timeline-'));
    indexPath = join(directory, 'timeline.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists captures on disk and exposes public metadata', async () => {
    const timeline = new ScreenshotTimeline({
      directory,
      indexPath,
      enabled: true,
      maxEntries: 5,
    });

    const result = await timeline.capture({
      data: SAMPLE_IMAGE,
      reason: 'manual',
      snapshotHash: 'hash-a',
      force: true,
      emit: false,
    });

    expect(result.success).toBe(true);
    expect(result.entry.filename).toMatch(/\.jpg$/);
    expect(result.entry.url).toBe(`/api/timeline/${encodeURIComponent(result.entry.filename)}`);
    expect(result.totalEntries).toBe(1);
  });

  it('prunes older captures when the max entry limit is exceeded', async () => {
    const timeline = new ScreenshotTimeline({
      directory,
      indexPath,
      enabled: true,
      maxEntries: 2,
    });

    await timeline.capture({ data: SAMPLE_IMAGE, snapshotHash: 'hash-a', force: true, emit: false });
    await timeline.capture({ data: Buffer.from('image-b').toString('base64'), snapshotHash: 'hash-b', force: true, emit: false });
    await timeline.capture({ data: Buffer.from('image-c').toString('base64'), snapshotHash: 'hash-c', force: true, emit: false });

    expect(timeline.getSummary().totalEntries).toBe(2);

    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith('.jpg'))).toHaveLength(2);
  });

  it('captures automatically only when the snapshot hash changes', async () => {
    const captureScreenshot = vi.fn(async () => ({
      data: SAMPLE_IMAGE,
      mimeType: 'image/jpeg',
    }));
    let snapshotHash = 'hash-a';

    const timeline = new ScreenshotTimeline({
      directory,
      indexPath,
      enabled: true,
      maxEntries: 5,
      captureScreenshot,
      getSnapshotHash: () => snapshotHash,
    });

    await timeline.init();
    await timeline.tick();
    await timeline.tick();
    snapshotHash = 'hash-b';
    await timeline.tick();

    expect(captureScreenshot).toHaveBeenCalledTimes(2);
    expect(timeline.getSummary().totalEntries).toBe(2);
  });

  it('clears persisted captures and resets the summary', async () => {
    const timeline = new ScreenshotTimeline({
      directory,
      indexPath,
      enabled: true,
      maxEntries: 5,
    });

    await timeline.capture({
      data: SAMPLE_IMAGE,
      snapshotHash: 'hash-a',
      force: true,
      emit: false,
    });
    const result = await timeline.clear();

    expect(result.success).toBe(true);
    expect(result.totalEntries).toBe(0);
    expect(result.cleared).toBe(1);
  });
});
