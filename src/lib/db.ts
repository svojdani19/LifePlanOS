import { PrismaClient } from "@/generated/prisma";

// Standard Next.js singleton — avoids exhausting DB connections on hot reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
