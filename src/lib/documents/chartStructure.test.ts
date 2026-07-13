import { describe, it, expect } from "vitest";
import { stripChartFurniture, learnFurniture } from "@/lib/documents/chartStructure";

// Simulate a large chart: a banner/footer + a flowsheet grid repeated on every
// page, interleaved with a handful of real clinical lines. The stripper must
// remove the repeated furniture, keep the page markers and the clinical lines,
// and never strip a clinically-worded line even when it repeats.
function bigChart(): string {
  const pages: string[] = [];
  for (let i = 1; i <= 60; i++) {
    pages.push(
      [
        `Page ${i} of 60`,
        "Trice,Jennifer Lynne",
        "Phoebe Sumter Medical Center",
        "Intake & Output Start: 10/29/25 16:16",
        "Status: Signed",
        "Date & Time User Device Event Acknowledged",
        i === 10 ? "Pre-op diagnosis: Mechanical loosening right total knee replacement." : "",
        i === 20 ? "Impression: Endotracheal tube terminates 35 mm above the carina." : "",
        i === 30 ? "Oxycodone 15 mg oral every 4 hours as needed for pain." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return pages.join("\n");
}

describe("stripChartFurniture", () => {
  const chart = bigChart();
  const out = stripChartFurniture(chart);

  it("learns the repeated furniture lines", () => {
    const furniture = learnFurniture(chart);
    expect(furniture.has("Trice,Jennifer Lynne")).toBe(true);
    expect(furniture.has("Status: Signed")).toBe(true);
    expect(furniture.has("Date & Time User Device Event Acknowledged")).toBe(true);
  });

  it("removes banners, footers, audit lines, and flowsheet grids", () => {
    expect(out).not.toMatch(/Trice,Jennifer Lynne/);
    expect(out).not.toMatch(/Phoebe Sumter Medical Center/);
    expect(out).not.toMatch(/Intake & Output/);
    expect(out).not.toMatch(/Device Event Acknowledged/);
    // Shrinks the chart substantially.
    expect(out.length).toBeLessThan(chart.length * 0.6);
  });

  it("preserves page markers and every real clinical line", () => {
    expect(out).toMatch(/Page 10 of 60/);
    expect(out).toMatch(/Mechanical loosening right total knee replacement/);
    expect(out).toMatch(/Endotracheal tube terminates 35 mm above the carina/);
    // A clinically-worded line ("…for pain", "…mg") is protected even if repeated.
    expect(out).toMatch(/Oxycodone 15 mg oral every 4 hours/);
  });

  it("leaves a small record untouched (nothing to learn from)", () => {
    const small = "Date of service: 06/12/2024\nChief complaint: knee pain.\nAssessment: osteoarthritis.";
    expect(stripChartFurniture(small)).toBe(small);
  });
});
