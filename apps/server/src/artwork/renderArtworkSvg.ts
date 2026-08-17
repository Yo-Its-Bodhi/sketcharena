import type { ArtworkDocument, Stroke } from '@sketch-arena/protocol';

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function coordinate(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function renderStroke(stroke: Stroke, width: number, height: number): string {
  const opacity = stroke.tool === 'eraser' ? 1 : stroke.opacity ?? 1;
  if (stroke.tool === 'fill') return `<rect width="${width}" height="${height}" fill="${stroke.color}" fill-opacity="${opacity}"/>`;
  const first = stroke.points[0]; const last = stroke.points.at(-1);
  if (!first || !last) return '';
  const color = stroke.tool === 'eraser' ? '#f4f0e8' : stroke.color;
  const style = `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${coordinate(stroke.size * 2)}" stroke-linecap="round" stroke-linejoin="round"`;
  const x1 = first.x * width; const y1 = first.y * height; const x2 = last.x * width; const y2 = last.y * height;
  if (stroke.shape === 'line') return `<line x1="${coordinate(x1)}" y1="${coordinate(y1)}" x2="${coordinate(x2)}" y2="${coordinate(y2)}" ${style}/>`;
  if (stroke.shape === 'rectangle') return `<rect x="${coordinate(Math.min(x1, x2))}" y="${coordinate(Math.min(y1, y2))}" width="${coordinate(Math.abs(x2 - x1))}" height="${coordinate(Math.abs(y2 - y1))}" ${style}/>`;
  if (stroke.shape === 'ellipse') return `<ellipse cx="${coordinate((x1 + x2) / 2)}" cy="${coordinate((y1 + y2) / 2)}" rx="${coordinate(Math.abs(x2 - x1) / 2)}" ry="${coordinate(Math.abs(y2 - y1) / 2)}" ${style}/>`;
  if (stroke.shape === 'triangle') return `<polygon points="${coordinate((x1 + x2) / 2)},${coordinate(y1)} ${coordinate(x2)},${coordinate(y2)} ${coordinate(x1)},${coordinate(y2)}" ${style}/>`;
  if (stroke.shape === 'arrow') {
    const angle = Math.atan2(y2 - y1, x2 - x1); const head = Math.max(18, stroke.size * 3);
    return `<path d="M${coordinate(x1)} ${coordinate(y1)}L${coordinate(x2)} ${coordinate(y2)}M${coordinate(x2)} ${coordinate(y2)}L${coordinate(x2 - head * Math.cos(angle - Math.PI / 6))} ${coordinate(y2 - head * Math.sin(angle - Math.PI / 6))}M${coordinate(x2)} ${coordinate(y2)}L${coordinate(x2 - head * Math.cos(angle + Math.PI / 6))} ${coordinate(y2 - head * Math.sin(angle + Math.PI / 6))}" ${style}/>`;
  }
  const points = stroke.points.map((point) => `${coordinate(point.x * width)},${coordinate(point.y * height)}`).join(' ');
  return `<polyline points="${points}" ${style}/>`;
}

export function renderArtworkSvg(artwork: ArtworkDocument): string {
  const marks = artwork.strokes.map((stroke) => renderStroke(stroke, artwork.width, artwork.height)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.width}" height="${artwork.height}" viewBox="0 0 ${artwork.width} ${artwork.height}"><title>${escapeXml(artwork.title)}</title><rect width="${artwork.width}" height="${artwork.height}" fill="#f4f0e8"/>${marks}</svg>`;
}
