import { describe, expect, it } from 'vitest';
import { BRUSH_RENDER_PROFILES, screenToCanvasCoordinates } from './Canvas';

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
});
