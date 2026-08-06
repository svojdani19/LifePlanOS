// Leaf module so both the OCR layer (which clips at this cap) and the
// extraction layer (which must DISCLOSE that clipping) can share the constant
// without an import cycle.
export const MAX_TEXT = 4_000_000; // chars persisted per document (~2,000 pages of dense chart text)
