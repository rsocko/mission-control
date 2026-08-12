// Type declarations for metascraper and its plugins
// metascraper is a CJS-only library without official type definitions

declare module 'metascraper' {
  interface MetascraperResult {
    title?: string;
    description?: string;
    image?: string;
    video?: string;
    url?: string;
    logo?: string;
    author?: string;
    publisher?: string;
    iframe?: string;
    [key: string]: string | undefined;
  }

  interface MetascraperOptions {
    html: string;
    url: string;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type MetascraperRule = Record<string, any>;

  interface MetascraperFactory {
    (opts: { rules: MetascraperRule[] }): (opts: MetascraperOptions) => Promise<MetascraperResult>;
  }

  const factory: MetascraperFactory;
  export default factory;
}

declare module 'metascraper-title' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-description' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-image' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-video' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-url' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-logo' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-author' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-publisher' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
declare module 'metascraper-iframe' {
  const rule: () => Record<string, unknown>;
  export default rule;
}
