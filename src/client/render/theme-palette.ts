import type { ThemeId } from '../../sim/types.js';

/**
 * Shared per-theme palette so the track mesh (road, shoulders, barriers) and
 * the theme scenery (terrain, props, sky) read as one world.
 */
export interface ThemePalette {
  road: string;          // asphalt / paving / space glass
  roadAlt: string;       // secondary tone for texture noise and patches
  roadLine: string;      // centre dashes and edge lines
  curbA: string; curbB: string;
  /** Off-road shoulder / terrain base colour (grass, sand, snow...). */
  ground: string;
  groundAlt: string;
  /** Barrier style drawn at 'wall' and 'offroad' limits. */
  barrier: 'tires' | 'fence' | 'stone' | 'rail' | 'snowbank' | 'wood' | 'neon' | 'hedge';
  barrierA: string; barrierB: string;
  /** What is visible below a 'pit' edge. */
  pit: 'water' | 'lava' | 'void' | 'chasm';
  pitColor: string;
  boostPad: string;
  accent: string;        // banners, flags, start gantry
  night: boolean;
}

export const THEME_PALETTES: Record<ThemeId, ThemePalette> = {
  meadow: {
    road: '#4a4d57', roadAlt: '#5a5e69', roadLine: '#f4f4f0', curbA: '#e63946', curbB: '#f1f1f1',
    ground: '#5fbf4a', groundAlt: '#7fd35c', barrier: 'tires', barrierA: '#2b2b2b', barrierB: '#e63946',
    pit: 'water', pitColor: '#3aa7e0', boostPad: '#ff9f1c', accent: '#ffd23f', night: false,
  },
  beach: {
    road: '#5b5f6b', roadAlt: '#6e7280', roadLine: '#fff6d8', curbA: '#ff5d8f', curbB: '#fff6d8',
    ground: '#f2d49b', groundAlt: '#f7e3b5', barrier: 'wood', barrierA: '#b98552', barrierB: '#f2f2f2',
    pit: 'water', pitColor: '#1fb6d6', boostPad: '#ff7b54', accent: '#00c2d1', night: false,
  },
  canyon: {
    road: '#6b5446', roadAlt: '#7d6252', roadLine: '#ffe7b0', curbA: '#d9480f', curbB: '#f8f0e3',
    ground: '#d9895b', groundAlt: '#e7a577', barrier: 'fence', barrierA: '#8a5a3b', barrierB: '#e9d8b4',
    pit: 'chasm', pitColor: '#6e3b24', boostPad: '#ffb703', accent: '#e76f51', night: false,
  },
  city: {
    road: '#2a2d3a', roadAlt: '#343849', roadLine: '#f7f06d', curbA: '#ff2e88', curbB: '#2de2e6',
    ground: '#3b3f52', groundAlt: '#4a4f66', barrier: 'neon', barrierA: '#1b1d29', barrierB: '#ff2e88',
    pit: 'void', pitColor: '#0b0c16', boostPad: '#2de2e6', accent: '#f7f06d', night: true,
  },
  snow: {
    road: '#56606e', roadAlt: '#6a7482', roadLine: '#ffffff', curbA: '#1f6feb', curbB: '#f5fbff',
    ground: '#eef6fb', groundAlt: '#d7e8f3', barrier: 'snowbank', barrierA: '#f7fbff', barrierB: '#9cc3e6',
    pit: 'chasm', pitColor: '#9fb8cc', boostPad: '#48cae4', accent: '#e63946', night: false,
  },
  jungle: {
    road: '#6d6152', roadAlt: '#7e7160', roadLine: '#f1e3b3', curbA: '#e9c46a', curbB: '#2a9d8f',
    ground: '#3f8f3a', groundAlt: '#57a84a', barrier: 'stone', barrierA: '#8d8b7d', barrierB: '#6b6a5c',
    pit: 'water', pitColor: '#2f8f7a', boostPad: '#f4a261', accent: '#e76f51', night: false,
  },
  volcano: {
    road: '#34302f', roadAlt: '#433d3b', roadLine: '#ffb347', curbA: '#ff4d00', curbB: '#2b2b2b',
    ground: '#4a3a35', groundAlt: '#5e4840', barrier: 'stone', barrierA: '#3b3331', barrierB: '#ff6a00',
    pit: 'lava', pitColor: '#ff5a00', boostPad: '#ffd000', accent: '#ff3d00', night: true,
  },
  galaxy: {
    road: '#1b1446', roadAlt: '#2a1f66', roadLine: '#ffffff', curbA: '#ff4fd8', curbB: '#5ce1ff',
    ground: '#120c30', groundAlt: '#1d1450', barrier: 'neon', barrierA: '#2a1f66', barrierB: '#5ce1ff',
    pit: 'void', pitColor: '#05030f', boostPad: '#ffe600', accent: '#ff4fd8', night: true,
  },
};
