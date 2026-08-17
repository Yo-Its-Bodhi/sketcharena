import type { Point, Stroke } from '@sketch-arena/protocol';

export function sampleStrokePoints(points: Point[], limit: number): Point[] {
  if (points.length <= limit) return [...points];
  if (limit < 2) return [points.at(-1)!];
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]!);
}

export function splitStrokeForTransport(stroke: Stroke, limit: number): Stroke[] {
  const isFreehand = !stroke.shape || stroke.shape === 'freehand';
  if (!isFreehand || stroke.points.length <= limit) return [{ ...stroke, points: [...stroke.points] }];
  if (limit < 2) throw new Error('A transported stroke needs room for at least two points');
  const segments: Stroke[] = [];
  let start = 0;
  while (start < stroke.points.length) {
    const end = Math.min(start + limit, stroke.points.length);
    segments.push({ ...stroke, id: segments.length ? `${stroke.id}-${segments.length}` : stroke.id, points: stroke.points.slice(start, end) });
    if (end === stroke.points.length) break;
    start = end - 1;
  }
  return segments;
}

export function normalizeArtworkStrokes(strokes: Stroke[], limit: number): Stroke[] {
  return strokes.flatMap((stroke) => splitStrokeForTransport(stroke, limit));
}
