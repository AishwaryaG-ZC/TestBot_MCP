import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  allowedDevOrigins: [
    'http://127.0.0.1',
    'http://localhost',
  ],
  experimental: {
    // Increase body size limit for Server Actions
    serverActions: {
      bodySizeLimit: '300mb',
    },
    // Increase request body size limit for API routes (fixes truncation)
    proxyClientMaxBodySize: '300mb',
  },
};

export default nextConfig;
