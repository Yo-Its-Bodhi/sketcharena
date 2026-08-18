import type { ArtworkDocument, BrushStyle, Point, Stroke } from './index.js';

const PAPER = '#f4f0e8';
const PROFILES: Record<BrushStyle, { width: number; alpha: number }> = {
  pencil: { width: .7, alpha: .82 }, ink: { width: .95, alpha: 1 }, marker: { width: 1.55, alpha: .32 }, airbrush: { width: 2.5, alpha: .2 },
  charcoal: { width: 1.15, alpha: .7 }, technical: { width: .42, alpha: 1 }, watercolor: { width: 1.85, alpha: .2 }, pastel: { width: 1.35, alpha: .58 },
  pixel: { width: 1, alpha: 1 }, calligraphy: { width: 1.5, alpha: .95 }, neon: { width: .86, alpha: 1 },
};

function xml(value: string): string { return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!); }
function n(value: number): string { return Number(value.toFixed(3)).toString(); }
function alpha(value: number): string { return n(Math.max(0, Math.min(1, value))); }
function noise(value: number, salt: number): number { const raw = Math.sin(value * 12.9898 + salt * 78.233) * 43_758.5453; return raw - Math.floor(raw); }
function sample(points: Point[], limit: number): Point[] { if (points.length <= limit) return points; if (limit < 2) return [points.at(-1)!]; return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]!); }

function pathData(stroke: Stroke, width: number, height: number, offsetX = 0, offsetY = 0): string {
  const first = stroke.points[0]; const last = stroke.points.at(-1); if (!first || !last) return '';
  let path = `M${n(first.x * width + offsetX)} ${n(first.y * height + offsetY)}`;
  if ((stroke.smoothing ?? 0) > .08 && stroke.points.length > 2) {
    for (let index = 1; index < stroke.points.length - 1; index += 1) { const point = stroke.points[index]!; const next = stroke.points[index + 1]!; path += `Q${n(point.x * width + offsetX)} ${n(point.y * height + offsetY)} ${n((point.x + next.x) * width / 2 + offsetX)} ${n((point.y + next.y) * height / 2 + offsetY)}`; }
    return `${path}L${n(last.x * width + offsetX)} ${n(last.y * height + offsetY)}`;
  }
  return path + stroke.points.slice(1).map((point) => `L${n(point.x * width + offsetX)} ${n(point.y * height + offsetY)}`).join('');
}

function shape(stroke: Stroke, width: number, height: number, attributes: string): string {
  const first = stroke.points[0]; const last = stroke.points.at(-1); if (!first || !last) return '';
  const x1 = first.x * width; const y1 = first.y * height; const x2 = last.x * width; const y2 = last.y * height;
  if (stroke.shape === 'line') return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${attributes}/>`;
  if (stroke.shape === 'rectangle') return `<rect x="${n(Math.min(x1, x2))}" y="${n(Math.min(y1, y2))}" width="${n(Math.abs(x2 - x1))}" height="${n(Math.abs(y2 - y1))}" ${attributes}/>`;
  if (stroke.shape === 'ellipse') return `<ellipse cx="${n((x1 + x2) / 2)}" cy="${n((y1 + y2) / 2)}" rx="${n(Math.abs(x2 - x1) / 2)}" ry="${n(Math.abs(y2 - y1) / 2)}" ${attributes}/>`;
  if (stroke.shape === 'triangle') return `<polygon points="${n((x1 + x2) / 2)},${n(y1)} ${n(x2)},${n(y2)} ${n(x1)},${n(y2)}" ${attributes}/>`;
  if (stroke.shape === 'arrow') { const angle = Math.atan2(y2 - y1, x2 - x1); const head = Math.max(24, stroke.size * 6); const d = `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}M${n(x2)} ${n(y2)}L${n(x2 - head * Math.cos(angle - Math.PI / 6))} ${n(y2 - head * Math.sin(angle - Math.PI / 6))}M${n(x2)} ${n(y2)}L${n(x2 - head * Math.cos(angle + Math.PI / 6))} ${n(y2 - head * Math.sin(angle + Math.PI / 6))}`; return `<path d="${d}" ${attributes}/>`; }
  return '';
}

function scatter(stroke: Stroke, width: number, height: number, size: number, spread: number, density: number, color: string, opacity: number): string {
  return sample(stroke.points, Math.min(650, stroke.points.length)).map((point, index) => Array.from({ length: density }, (_, grain) => { const angle = noise(index, grain) * Math.PI * 2; const radius = noise(index + 17, grain + 13) * size * spread; const dot = Math.max(.7, noise(index + 61, grain + 5) * size * .11); return `<circle cx="${n(point.x * width + Math.cos(angle) * radius)}" cy="${n(point.y * height + Math.sin(angle) * radius)}" r="${n(dot)}" fill="${color}" fill-opacity="${alpha(opacity)}"/>`; }).join('')).join('');
}

function renderMark(stroke: Stroke, width: number, height: number, mask = false): string {
  if (!stroke.points.length) return '';
  const color = mask ? '#000000' : stroke.color; const brush = stroke.tool === 'eraser' ? 'ink' : stroke.brush ?? 'pencil'; const profile = PROFILES[brush]; const opacity = mask ? 1 : (stroke.opacity ?? 1) * profile.alpha;
  if (stroke.tool === 'fill') return `<rect width="${width}" height="${height}" fill="${color}" fill-opacity="${alpha(mask ? 1 : stroke.opacity ?? 1)}"/>`;
  const first = stroke.points[0]!; const pressure = stroke.points.reduce((sum, point) => sum + (point.pressure ?? .5), 0) / stroke.points.length; const base = stroke.size * 2; const scaled = base * profile.width * (brush === 'technical' ? 1 : .72 + pressure * .56);
  const cap = brush === 'marker' || brush === 'pixel' || brush === 'calligraphy' ? 'butt' : 'round'; const style = (value = opacity) => `fill="none" stroke="${color}" stroke-opacity="${alpha(value)}" stroke-linecap="${cap}" stroke-linejoin="${brush === 'calligraphy' ? 'bevel' : 'round'}"`;
  if (stroke.shape && stroke.shape !== 'freehand') return shape(stroke, width, height, `${style()} stroke-width="${n(mask ? base : scaled)}"`);
  if (stroke.points.length === 1) { if (brush === 'pixel') return `<rect x="${n(first.x * width - base / 2)}" y="${n(first.y * height - base / 2)}" width="${n(base)}" height="${n(base)}" fill="${color}" fill-opacity="${alpha(opacity)}"/>`; const outer = `<circle cx="${n(first.x * width)}" cy="${n(first.y * height)}" r="${n(base * profile.width / 2)}" fill="${color}" fill-opacity="${alpha(opacity)}"${brush === 'neon' && !mask ? ' filter="url(#neon-glow)"' : ''}/>`; return brush === 'neon' && !mask ? `${outer}<circle cx="${n(first.x * width)}" cy="${n(first.y * height)}" r="${n(base * .2)}" fill="#ffffff" fill-opacity="${alpha(stroke.opacity ?? 1)}"/>` : outer; }
  if (mask) return `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base)}"/>`;
  if (brush === 'pixel') { const step = Math.max(4, base * .7); return sample(stroke.points, Math.min(900, stroke.points.length)).map((point) => { const x = Math.round(point.x * width / step) * step; const y = Math.round(point.y * height / step) * step; return `<rect x="${n(x - step / 2)}" y="${n(y - step / 2)}" width="${n(step)}" height="${n(step)}" fill="${color}" fill-opacity="${alpha(opacity)}"/>`; }).join(''); }
  if (brush === 'airbrush') { const path = `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * 1.8)}" filter="url(#airbrush-soft)"/>`; const dust = sample(stroke.points, Math.min(700, stroke.points.length)).map((point, index) => Array.from({ length: 4 }, (_, grain) => { const angle = noise(index, grain) * Math.PI * 2; const radius = noise(index + 31, grain + 7) * base * 1.7; const dot = Math.max(.9, noise(index + 91, grain + 2) * base * .18); return `<circle cx="${n(point.x * width + Math.cos(angle) * radius)}" cy="${n(point.y * height + Math.sin(angle) * radius)}" r="${n(dot)}" fill="${color}" fill-opacity="${alpha(opacity)}" filter="url(#airbrush-dust)"/>`; }).join('')).join(''); return path + dust; }
  if (brush === 'charcoal') { const dash = `${n(Math.max(2, base * .42))} ${n(Math.max(2, base * .16))}`; return [-.18, 0, .21].map((offset) => `<path d="${pathData(stroke, width, height, offset * base, Math.sin(offset * 23) * base * .16)}" ${style()} stroke-width="${n(base * 1.05)}" stroke-dasharray="${dash}"/>`).join('') + scatter(stroke, width, height, base, 1.35, 3, color, opacity); }
  if (brush === 'pastel') return `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * 1.25)}" stroke-dasharray="${n(Math.max(2, base * .3))} ${n(Math.max(2, base * .08))}"/>` + scatter(stroke, width, height, base, 1.05, 5, color, opacity);
  if (brush === 'watercolor') return ([[2.05,-.18,.08],[1.65,.16,-.13],[1.2,0,.16]] as const).map(([scale, x, y]) => `<path d="${pathData(stroke, width, height, x * base, y * base)}" ${style()} stroke-width="${n(base * scale)}" filter="url(#watercolor-soft)"/>`).join('');
  if (brush === 'calligraphy') return `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * (1.05 + pressure))}"/><path d="${pathData(stroke, width, height, base * .28, -base * .28)}" fill="none" stroke="#ffffff" stroke-opacity="${alpha(opacity * .52)}" stroke-width="${n(Math.max(2, base * .22))}" stroke-linecap="butt" stroke-linejoin="bevel"/>`;
  if (brush === 'neon') return `<path d="${pathData(stroke, width, height)}" ${style(opacity * .72)} stroke-width="${n(base * 1.45)}" filter="url(#neon-glow)"/><path d="${pathData(stroke, width, height)}" fill="none" stroke="#ffffff" stroke-opacity="${alpha(stroke.opacity ?? 1)}" stroke-width="${n(Math.max(2.4, base * .42))}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (brush === 'marker') return `<g style="mix-blend-mode:multiply"><path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * 1.55)}"/><path d="${pathData(stroke, width, height, base * .11)}" ${style(opacity * .55)} stroke-width="${n(base * 1.12)}"/></g>`;
  if (brush === 'pencil') return `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * (.42 + pressure * .52))}"/>` + [-.22, .25].map((offset) => `<path d="${pathData(stroke, width, height, offset * base, offset * base * .35)}" ${style(opacity * .28)} stroke-width="${n(Math.max(1.1, base * .18))}"/>`).join('');
  const main = `<path d="${pathData(stroke, width, height)}" ${style()} stroke-width="${n(base * (brush === 'technical' ? .42 : .72 + pressure * .58))}"/>`; return brush === 'ink' ? `${main}<circle cx="${n(first.x * width)}" cy="${n(first.y * height)}" r="${n(scaled * .34)}" fill="${color}" fill-opacity="${alpha(opacity)}"/>` : main;
}

function renderLayer(strokes: Stroke[], width: number, height: number, layerIndex: number): { defs: string; marks: string } {
  let defs = ''; const marks: string[] = [];
  strokes.forEach((stroke, index) => { if (stroke.tool === 'eraser') return; const laterErasers = strokes.slice(index + 1).filter((candidate) => candidate.tool === 'eraser'); let mask = ''; if (laterErasers.length) { const id = `erase-${layerIndex}-${index}`; defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${laterErasers.map((eraser) => renderMark(eraser, width, height, true)).join('')}</mask>`; mask = ` mask="url(#${id})"`; } marks.push(`<g${mask}>${renderMark(stroke, width, height)}</g>`); });
  return { defs, marks: marks.join('') };
}

export function renderArtworkSvg(title: string, strokes: Stroke[], width = 2400, height = 2400): string {
  const layerOrder: string[] = []; const layers = new Map<string, Stroke[]>(); for (const stroke of strokes) { const key = stroke.layerId ?? '__flat__'; if (!layers.has(key)) { layers.set(key, []); layerOrder.push(key); } layers.get(key)!.push(stroke); }
  let masks = ''; const marks = layerOrder.map((key, index) => { const strokesInLayer = layers.get(key)!; const layer = renderLayer(strokesInLayer, width, height, index); masks += layer.defs; const blend = strokesInLayer[0]?.blendMode; return `<g${blend && blend !== 'normal' ? ` style="mix-blend-mode:${blend}"` : ''}>${layer.marks}</g>`; }).join('');
  const defs = `<defs><filter id="airbrush-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.max(2, Math.min(width, height) / 480))}"/></filter><filter id="airbrush-dust" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter><filter id="watercolor-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.max(1.5, Math.min(width, height) / 960))}"/></filter><filter id="neon-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.max(4, Math.min(width, height) / 260))}" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>${masks}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xml(title)}</title>${defs}<rect width="${width}" height="${height}" fill="${PAPER}"/>${marks}</svg>`;
}

export function renderArtworkDocumentSvg(artwork: Pick<ArtworkDocument, 'title' | 'strokes' | 'width' | 'height'>): string { return renderArtworkSvg(artwork.title, artwork.strokes, artwork.width, artwork.height); }
