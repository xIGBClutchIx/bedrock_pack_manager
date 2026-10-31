/**
 * Packs that ship with Bedrock Dedicated Server itself. Add-ons use folder names like "Vanilla_Tweaks" or
 * "experimental_weapons" too, so a folder name alone is not enough: the manifest has to agree.
 */

const BUILTIN_FOLDER = /^(?:vanilla(?:_[\w.]+)?|chemistry(?:_[\d.]+)?|editor|experimental_\w+|server(?:_\w+)?_library)$/i;

/** The folder is named like one of the game's own packs. On its own this is only a hint. */
export const isBuiltinFolder = (name: string): boolean => BUILTIN_FOLDER.test(name);

/** Manifest names like "pack.name" or "resourcePack.vanilla_server.name" are translation keys, not titles. */
export const isTranslationKey = (name: string): boolean => /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(name);

/** Header UUIDs of packs known to ship with the server. */
const BUILTIN_UUIDS = new Set([
  "fe9f8597-5454-481a-8730-8d070a8e2e58", // behavior_packs/vanilla*
]);

/**
 * A game pack: named like one, and its manifest says so too, either with a known UUID or, like every
 * pack the server ships, with a translation key for a name instead of a real title.
 */
export const isBuiltinPack = (folder: string, manifest: { uuid: string; name: string }): boolean =>
  isBuiltinFolder(folder) && (BUILTIN_UUIDS.has(manifest.uuid.trim().toLowerCase()) || isTranslationKey(manifest.name.trim()));

/** Folders whose presence means "this was meant to be a pack", even without a manifest. */
export const PACK_CONTENT_DIRS = new Set([
  "animation_controllers",
  "animations",
  "attachables",
  "biomes",
  "blocks",
  "entity",
  "entities",
  "feature_rules",
  "features",
  "fogs",
  "font",
  "functions",
  "items",
  "loot_tables",
  "materials",
  "models",
  "particles",
  "recipes",
  "render_controllers",
  "scripts",
  "sounds",
  "spawn_rules",
  "structures",
  "subpacks",
  "texts",
  "textures",
  "trading",
  "ui",
]);
