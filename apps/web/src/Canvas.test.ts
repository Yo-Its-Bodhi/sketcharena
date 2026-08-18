import { describe, expect, it } from 'vitest';
import { BRUSH_RENDER_PROFILES, savedStrokeLayers, screenToCanvasCoordinates } from './Canvas';

describe('Studio brush engine', () => {
  it('gives every named brush a distinct rendering profile', () => {
    const profiles = Object.values(BRUSH_RENDER_PROFILES).map((profile) => JSON.stringify(profile));
    expect(profiles).toHaveLength(11);
    expect(new Set(profiles).size).toBe(profiles.length);
  });

  it('maps a zoomed and rotated stylus position back into stable artwork coordinates', () => {
    const viewport = { zoom: 2, rotation: 90, panX: 40, panY: -20 };
    expect(screenToCanvasCoordinates(500, 300, 500, 300, 400, 200, viewport)).toEqual({ x: .5, y: .5 });
    const rightOfCenter = screenToCanvasCoordinates(500, 500, 500, 300, 400, 200, viewport);
    expect(rightOfCenter.x).toBeCloseTo(.75);
    expect(rightOfCenter.y).toBeCloseTo(.5);
  });

  it('keeps premium-worthy texture families genuinely different', () => {
    expect(BRUSH_RENDER_PROFILES.marker.texture).toBe('overprint');
    expect(BRUSH_RENDER_PROFILES.charcoal.texture).toBe('fibres');
    expect(BRUSH_RENDER_PROFILES.neon.texture).toBe('glow-core');
  });

  it('reconstructs saved layer boundaries, order, blend modes, and erasers', () => {
    const strokes = [
      { id: 'a', tool: 'pencil' as const, color: '#171514', size: 6, points: [{ x: .1, y: .1 }], at: 1, layerId: 'bottom', blendMode: 'normal' as const },
      { id: 'b', tool: 'pencil' as const, color: '#ef476f', size: 8, points: [{ x: .2, y: .2 }], at: 2, layerId: 'top', blendMode: 'screen' as const },
      { id: 'c', tool: 'eraser' as const, color: '#f4f0e8', size: 12, points: [{ x: .3, y: .3 }], at: 3, layerId: 'top', blendMode: 'screen' as const },
    ];
    const layers = savedStrokeLayers(strokes)!;
    expect(layers.map((layer) => layer.id)).toEqual(['bottom', 'top']);
    expect(layers[1]?.blendMode).toBe('screen'); expect(layers[1]?.strokes.map((stroke) => stroke.tool)).toEqual(['pencil', 'eraser']);
  });
});
