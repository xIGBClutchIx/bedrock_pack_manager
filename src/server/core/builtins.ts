/** Packs that ship with Bedrock Dedicated Server itself, recognised by folder name. */

const BUILTIN_FOLDER = /^(?:vanilla(?:_[\w.]+)?|chemistry(?:_[\d.]+)?|editor|experimental_\w+|server(?:_\w+)?_library)$/i;

export const isBuiltinFolder = (name: string): boolean => BUILTIN_FOLDER.test(name);

/** Manifest names like "pack.name" or "resourcePack.vanilla_server.name" are translation keys, not titles. */
export const isTranslationKey = (name: string): boolean => /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(name);

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
