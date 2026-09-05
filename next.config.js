/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Railway builds this from a Dockerfile whose runtime stage copies only
  // `.next/standalone` — a self-contained server carrying just the modules the
  // app actually imports. Without it the image would need the whole
  // node_modules tree, which the OCR stack alone makes enormous.
  output: "standalone",
  // ── Never trace case content into the build output ────────────────────────
  //
  // `uploads/` holds the actual source PDFs — 765 files, 4.5GB of real medical
  // records. Standalone tracing swept the whole directory into
  // `.next/standalone/uploads`, and the Dockerfile copies `.next/standalone`
  // wholesale, so `.dockerignore` does not protect against it: the records
  // would have been baked into an image pushed to a hosting provider.
  //
  // `scripts/` goes too — it is operational tooling (demo reset, re-extraction,
  // retention enforcement) that has no business in a runtime image.
  outputFileTracingExcludes: {
    "*": ["uploads/**", "scripts/**", ".next-dev/**"],
  },
  // LifePlanOS runs as a standalone app. The Prisma client is generated into
  // src/generated/prisma so it never collides with any other app in this repo.
  // OCR stack stays external: @napi-rs/canvas is a native addon, tesseract.js
  // spawns worker threads, and pdfjs-dist's legacy build must load unbundled.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "tesseract.js", "pdfjs-dist", "@napi-rs/canvas"],
  // This repository sits beside another lockfile in the desktop workspace.
  outputFileTracingRoot: __dirname,
  // ── Build output lives OUTSIDE the synced tree ─────────────────────────────
  //
  // The project sits under ~/Desktop, which macOS syncs to iCloud. Sync
  // repeatedly re-materialises files inside the build directory —
  // `build-manifest 2.json`, `cache-life.d 2.ts`, `index.d 2.ts` — and removes
  // or reverts others. The symptoms were intermittent and looked unrelated to
  // each other: a production build failing on `Duplicate identifier`, the same
  // build succeeding on the next run, `prisma generate` output colliding with
  // itself, and the dev server dying with
  //
  //     Error: Cannot find module './1331.js'
  //
  // even though `.next/server/chunks/1331.js` was plainly on disk — because the
  // runtime beside it had been replaced by a production one.
  //
  // Compounding it: `npm run build` and `next dev` shared one directory, so a
  // production build pulled the rug out from under a running dev server.
  //
  // Separating the two directories removes the second cause outright, and it is
  // the one that actually kept killing the dev server. The path stays RELATIVE
  // on purpose: an absolute distDir makes Next write a machine-specific
  // `/var/folders/...` path into tsconfig.json's `include`, which is not
  // something to commit. `.gitignore` already covers `.next*/`.
  //
  // The sync duplicates remain possible; they surface as a build-time
  // `Duplicate identifier` that a rerun clears, and `find . -name "* 2.*"`
  // inside the build dir identifies them.
  distDir: process.env.NODE_ENV === "production" ? ".next" : ".next-dev",
};

module.exports = nextConfig;
