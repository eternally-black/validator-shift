const path = require('path')

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // Monorepo: trace from the workspace root so the standalone bundle copies
  // files from packages/shared correctly. Without this, Next 15 sometimes
  // leaves transitive imports unresolvable inside the Docker image.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  experimental: {
    optimizePackageImports: [
      'framer-motion',
      'lucide-react',
      '@validator-shift/shared',
    ],
  },
}
