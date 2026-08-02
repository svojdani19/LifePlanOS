/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LifePlanOS runs as a standalone app. The Prisma client is generated into
  // src/generated/prisma so it never collides with any other app in this repo.
  // OCR stack stays external: @napi-rs/canvas is a native addon, tesseract.js
  // spawns worker threads, and pdfjs-dist's legacy build must load unbundled.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "tesseract.js", "pdfjs-dist", "@napi-rs/canvas"],
  // This repository sits beside another lockfile in the desktop workspace.
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
