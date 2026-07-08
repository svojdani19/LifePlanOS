/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LifePlanOS runs as a standalone app. The Prisma client is generated into
  // src/generated/prisma so it never collides with any other app in this repo.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", ".prisma/client"],
  },
};

module.exports = nextConfig;
