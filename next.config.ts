import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";
import { withSerwist } from "@serwist/turbopack";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@rsocko/generic-graph-canvas-shared-workbench"],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.jsdelivr.net',
        pathname: '/gh/homarr-labs/dashboard-icons/**',
      },
    ],
  },
  experimental: {
    useTypeScriptCli: false,
  },
  serverExternalPackages: ["pino", "pino-pretty", "re2", "metascraper", "@metascraper/helpers", "metascraper-author", "metascraper-date", "metascraper-description", "metascraper-image", "metascraper-logo", "metascraper-publisher", "metascraper-title", "metascraper-url", "metascraper-iframe", "metascraper-video"],
  turbopack: {
    root: process.cwd(),
    rules: {
      '*': {
        condition: {
          all: [
            { path: /^vendor\/generic-graph-workbench\// },
            { any: [{ path: '*.ts' }, { path: '*.tsx' }] },
          ],
        },
        loaders: ['./scripts/turbopack-node-next-source-loader.cjs'],
        as: '*.js',
      },
    },
  },
  async redirects() {
    return [
      { source: '/portfolio', destination: '/projects', permanent: true },
      { source: '/portfolio/:id', destination: '/projects/:id', permanent: true },
      { source: '/waves', destination: '/projects', permanent: true },
      { source: '/api/portfolio', destination: '/api/projects-overview', permanent: true },
    ];
  },
};

export default withSerwist(withBundleAnalyzer(nextConfig));
