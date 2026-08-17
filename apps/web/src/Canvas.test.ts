import { describe, expect, it } from 'vitest';
import { BRUSH_RENDER_PROFILES } from './Canvas';

describe('Studio brush engine', () => {
  it('gives every named brush a distinct rendering profile', () => {
    const profiles = Object.values(BRUSH_RENDER_PROFILES).map((profile) => JSON.stringify(profile));
    expect(profiles).toHaveLength(11);
    expect(new Set(profiles).size).toBe(profiles.length);
  });

  it('keeps premium-worthy texture families genuinely different', () => {
    expect(BRUSH_RENDER_PROFILES.marker.texture).toBe('overprint');
    expect(BRUSH_RENDER_PROFILES.charcoal.texture).toBe('fibres');
    expect(BRUSH_RENDER_PROFILES.neon.texture).toBe('glow-core');
  });
});
