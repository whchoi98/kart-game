/**
 * Theme → scenery builder registry. Namespace imports keep the registry loading even while a
 * theme module is being reworked; requesting a theme without a builder throws a clear error.
 */
import type { ThemeId } from '../../../sim/types.js';
import type { SceneryBuilder } from '../contracts.js';
import * as meadow from './meadow.js';
import * as beach from './beach.js';
import * as canyon from './canyon.js';
import * as city from './city.js';
import * as snow from './snow.js';
import * as jungle from './jungle.js';
import * as volcano from './volcano.js';
import * as galaxy from './galaxy.js';

type ThemeModule = { buildScenery?: SceneryBuilder };

const MODULES: Record<ThemeId, ThemeModule> = {
  meadow: meadow as ThemeModule, beach: beach as ThemeModule, canyon: canyon as ThemeModule, city: city as ThemeModule,
  snow: snow as ThemeModule, jungle: jungle as ThemeModule, volcano: volcano as ThemeModule, galaxy: galaxy as ThemeModule,
};

export function getSceneryBuilder(theme: ThemeId): SceneryBuilder {
  const build = MODULES[theme]?.buildScenery;
  if (typeof build !== 'function') throw new Error(`Scenery theme '${theme}' has no buildScenery()`);
  return build;
}
