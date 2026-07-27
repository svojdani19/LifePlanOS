/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LifePlanOS runs as a standalone app. The Prisma client is generated into
  // src/generated/prisma so it never collides with any other app in this repo.
  experimental: {
    // OCR stack stays external: @napi-rs/canvas is a native addon, tesseract.js
    // spawns worker threads, and pdfjs-dist's legacy build must load unbundled.
    serverComponentsExternalPackages: ["@prisma/client", ".prisma/client", "tesseract.js", "pdfjs-dist", "@napi-rs/canvas"],
    // Startup env validation (src/instrumentation.ts). Next 14 gates the
    // instrumentation hook behind this flag; Next 15 enables it by default.
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
