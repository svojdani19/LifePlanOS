// pdf-parse ships no types for its internal lib entry. We import the lib entry
// directly (instead of the package root) to avoid its debug-mode test-file read.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: unknown;
  }
  const pdfParse: (data: Buffer) => Promise<PdfParseResult>;
  export default pdfParse;
}
