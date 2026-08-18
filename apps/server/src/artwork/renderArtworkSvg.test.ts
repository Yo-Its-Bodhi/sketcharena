import { describe, expect, it } from 'vitest';
import type { ArtworkDocument, BrushStyle, Stroke, StrokeShape } from '@sketch-arena/protocol';
import { renderArtworkSvg } from './renderArtworkSvg.js';

function stroke(id: string, brush: BrushStyle, overrides: Partial<Stroke> = {}): Stroke {
  return { id, tool: 'pencil', brush, color: '#e54b3e', size: 12, opacity: .75, smoothing: .5, points: [{ x: .1, y: .15, pressure: .2 }, { x: .4, y: .5, pressure: .7 }, { x: .85, y: .8, pressure: 1 }], at: 1, ...overrides };
}

function artwork(strokes: Stroke[]): ArtworkDocument {
  return { id: '00000000-0000-4000-8000-000000000001', ownerSessionId: '00000000-0000-4000-8000-000000000002', origin: 'studio', status: 'mint-ready', title: 'Brushes & <shapes>', description: '', canvasRatio: 'square', width: 1200, height: 1200, strokes, createdAt: 1, updatedAt: 1 };
}

describe('canonical artwork SVG renderer', () => {
  it('preserves every brush effect deterministically', () => {
    const brushes: BrushStyle[] = ['pencil', 'ink', 'marker', 'airbrush', 'charcoal', 'technical', 'watercolor', 'pastel', 'pixel', 'calligraphy', 'neon'];
    const input = artwork(brushes.map((brush, index) => stroke(`${brush}-${index}`, brush)));
    const first = renderArtworkSvg(input); const second = renderArtworkSvg(input);
    expect(first).toBe(second);
    expect(first).toContain('<title>Brushes &amp; &lt;shapes&gt;</title>');
    expect(first).toContain('airbrush-soft'); expect(first).toContain('airbrush-dust');
    expect(first).toContain('stroke-dasharray'); expect(first).toContain('watercolor-soft');
    expect(first).toContain('mix-blend-mode:multiply'); expect(first).toContain('neon-glow');
    expect(first).toContain('stroke="#ffffff"'); expect(first.match(/<circle/g)?.length).toBeGreaterThan(10);
    expect(first.match(/<rect/g)?.length).toBeGreaterThan(1);
  });

  it('preserves colours, opacity, pressure, smoothing, fills, and every shape', () => {
    const shapes: StrokeShape[] = ['line', 'rectangle', 'ellipse', 'arrow', 'triangle'];
    const strokes = [stroke('fill', 'ink', { tool: 'fill', color: '#2878ff', opacity: .4, points: [{ x: 0, y: 0 }] }), stroke('smooth', 'ink'), ...shapes.map((item, index) => stroke(`shape-${index}`, 'ink', { shape: item }))];
    const svg = renderArtworkSvg(artwork(strokes));
    expect(svg).toContain('fill="#2878ff" fill-opacity="0.4"');
    expect(svg).toContain('stroke="#e54b3e"'); expect(svg).toContain('stroke-opacity="0.75"');
    expect(svg).toContain('<line '); expect(svg).toContain('<rect x='); expect(svg).toContain('<ellipse '); expect(svg).toContain('<polygon ');
    expect(svg).toContain('Q480 600'); expect(svg.match(/M120 180L1020 960M1020 960L/g)?.length).toBe(1);
  });

  it('keeps layer blend modes and scopes erasing to its own layer and earlier marks', () => {
    const strokes = [
      stroke('bottom', 'ink', { layerId: 'bottom', blendMode: 'normal' }),
      stroke('top-before', 'marker', { layerId: 'top', blendMode: 'screen' }),
      stroke('erase', 'ink', { tool: 'eraser', layerId: 'top', blendMode: 'screen', points: [{ x: .2, y: .2 }, { x: .3, y: .3 }] }),
      stroke('top-after', 'neon', { layerId: 'top', blendMode: 'screen' }),
    ];
    const svg = renderArtworkSvg(artwork(strokes));
    expect(svg).toContain('style="mix-blend-mode:screen"');
    expect(svg).toContain('<mask id="erase-1-0"');
    expect(svg.match(/mask="url\(#erase-1-0\)"/g)).toHaveLength(1);
    expect(svg).not.toContain('erase-0-0');
  });
});
