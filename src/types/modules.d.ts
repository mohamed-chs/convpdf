declare module 'markdown-it-footnote' {
  import type { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}
declare module 'markdown-it-deflist' {
  import type { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}
declare module 'markdown-it-abbr' {
  import type { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}
declare module 'markdown-it-mark' {
  import type { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}
declare module 'markdown-it-emoji' {
  import type { PluginWithOptions } from 'markdown-it';
  interface EmojiOptions {
    defs?: Record<string, string>;
    enabled?: string[];
    shortcuts?: Record<string, string | string[]>;
  }
  export const full: PluginWithOptions<EmojiOptions>;
  export const light: PluginWithOptions<EmojiOptions>;
  export const bare: PluginWithOptions<EmojiOptions>;
}
declare module 'markdown-it-emoji/lib/data/full.mjs' {
  const data: Record<string, string>;
  export default data;
}
