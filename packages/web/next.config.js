const path = require('path')

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // Monorepo: trace from the workspace root so the standalone bundle copies
  // files from packages/shared correctly. Without this, Next 15 sometimes
  // leaves transitive imports unresolvable inside the Docker image.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Make sure the submission markdown is copied into the standalone bundle
  // so the /submission route can read it at request time. Without this Next
  // 15's tracer doesn't pick up co-located non-source files.
  outputFileTracingIncludes: {
    '/submission': ['./app/submission/submission.md'],
  },
  experimental: {
    optimizePackageImports: [
      'framer-motion',
      'lucide-react',
      '@validator-shift/shared',
    ],
  },
}
