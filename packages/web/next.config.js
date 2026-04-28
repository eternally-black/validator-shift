/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    optimizePackageImports: [
      'framer-motion',
      'lucide-react',
      '@validator-shift/shared',
    ],
  },
}
