import { describe, expect, it } from 'vitest';
import type { Stroke } from '@sketch-arena/protocol';
import { normalizeArtworkStrokes, sampleStrokePoints, splitStrokeForTransport } from './strokeTransport';

function strokeWith(pointCount: number): Stroke {
  return { id: 'long-stroke', tool: 'pencil', color: '#000000', size: 6, at: 0, shape: 'freehand', points: Array.from({ length: pointCount }, (_, index) => ({ x: index / pointCount, y: .5, pressure: .5 })) };
}

describe('long-stroke transport', () => {
  it('segments a continuous gesture without exceeding the server point limit', () => {
    const stroke = strokeWith(600); const segments = splitStrokeForTransport(stroke, 250);
    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => segment.points.length <= 250)).toBe(true);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
    expect(segments[0]!.points.at(-1)).toEqual(segments[1]!.points[0]);
    expect(segments[1]!.points.at(-1)).toEqual(segments[2]!.points[0]);
    expect(segments[2]!.points.at(-1)).toEqual(stroke.points.at(-1));
  });

  it('keeps both ends when sampling an oversized live preview', () => {
    const points = strokeWith(600).points; const sampled = sampleStrokePoints(points, 250);
    expect(sampled).toHaveLength(250); expect(sampled[0]).toEqual(points[0]); expect(sampled.at(-1)).toEqual(points.at(-1));
  });

  it('normalizes a Studio document before it crosses the Vault API boundary', () => {
    const legacyStroke = strokeWith(500); delete legacyStroke.shape;
    const normalized = normalizeArtworkStrokes([strokeWith(600), strokeWith(40), legacyStroke], 250);
    expect(normalized).toHaveLength(7);
    expect(normalized.every((stroke) => stroke.points.length <= 250)).toBe(true);
  });
});
